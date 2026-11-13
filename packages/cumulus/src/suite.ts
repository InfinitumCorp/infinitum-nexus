import { CidLabyrinth } from "@infinitum/lbrnth";
import type { CidLabyrinthOptions } from "@infinitum/lbrnth";
/**
 * The Cumulus account suite. Build it once and every Infinitum product gets the same account:
 *
 *   Cumulus://ID      sign-in (passkeys, MFA, social, SSO)
 *   Cumulus://Mail    username@cumuluscloud.app, provisioned the moment the CID is created
 *   Cumulus://Cloud   Drive storage
 *   FIRM Wallet       opened with the account; payments can be sent by mail
 *   Free tier         15 GB shared by Mail and Cloud, plus Mail, Cloud and Wallet at no cost
 *
 * Mail is the account backbone, like Gmail for a Google account: security notices from
 * sign-ins, Cloud share notices and wallet receipts all arrive in the person's Cumulus inbox.
 * It is not a product listed on the public site; people reach it from inside the other products.
 */
import { CidService, CidStore, FREE_ENTITLEMENTS, cumulusDomains, deriveCidSecretKey, type CidConfig, type CidEvent, type Account } from "@infinitum/cid";
import { CloudStore, QuotaStore, StorageQuota, formatBytes, type QuotaRepository } from "@infinitum/cloud";
import { WalletAccounts, WalletStore, WalletError, type WalletRepository, type WalletTransfer } from "@infinitum/firm";
import { CumulusTunnel, PostOffice, PostOfficeStore, TunnelStore, openMailStore, type MailRepository } from "@infinitum/mail";
import type { Ledger, Signer } from "@infinitum/firmament";

export interface CumulusStores {
  cid: CidStore;
  mail: PostOfficeStore;
  wallet: WalletStore;
  quota: QuotaStore;
  suite: SuiteStore;
  /** Cumulus Tunnel keys (private keys wrapped with the master key). */
  tunnel: TunnelStore;
}

/** Suite-level state: devices already seen per CID, so only new devices trigger a sign-in alert. */
export class SuiteStore {
  knownDevices = new Map<string, string[]>();
}

export function emptyCumulusStores(): CumulusStores {
  return { cid: new CidStore(), mail: new PostOfficeStore(), wallet: new WalletStore(), quota: new QuotaStore(), suite: new SuiteStore(), tunnel: new TunnelStore() };
}

export interface CumulusConfig extends Omit<CidConfig, "store" | "onEvent" | "ledger" | "signer"> {
  /** Opt-in: trusted client billing plus durable encrypted storage; no free LBRNTH access. */
  labyrinth?: Omit<CidLabyrinthOptions, "clock">;
  ledger: Ledger;
  signer: Signer;
  stores?: Partial<CumulusStores>;
  /** Where people open their mail, used in notices. Default https://mail.cumuluscloud.app */
  mailOrigin?: string;
  /**
   * 32-byte Cumulus Tunnel master key. With it, account keys and sealed mailboxes survive restarts.
   * Without it, mail between Cumulus accounts is still sealed in transit, with keys kept in memory.
   */
  masterKey?: Buffer;
  /**
   * Keep Mail, FIRM Wallet or the storage quota somewhere other than the in-memory stores (for
   * example Postgres rows, see rows.ts). Mail is given the suite's tunnel, which seals its messages.
   */
  repositories?: {
    mail?: (tunnel: CumulusTunnel) => MailRepository;
    wallet?: WalletRepository;
    quota?: QuotaRepository;
  };
}

const METHOD_LABEL: Record<string, string> = {
  passkey: "passkey",
  "security-key": "security key",
  sso: "organization single sign-on",
  "passkey+totp": "passkey and authenticator code",
};
const methodLabel = (m: string) =>
  METHOD_LABEL[m] ?? (m.startsWith("social:") ? `Continue with ${m.slice(7).replace("+totp", " and authenticator code")}` : m);

export class CumulusSuite {
  readonly labyrinth?: CidLabyrinth;
  readonly stores: CumulusStores;
  readonly cid: CidService;
  readonly mail: PostOffice;
  readonly tunnel: CumulusTunnel;
  readonly wallets: WalletAccounts;
  readonly quota: StorageQuota;
  readonly cloud: CloudStore;
  private readonly ledger: Ledger;
  private readonly signer: Signer;
  readonly mailOrigin: string;
  private readonly cloudOrigin: string;

  constructor(config: CumulusConfig) {
    const empty = emptyCumulusStores();
    this.stores = { ...empty, ...config.stores } as CumulusStores;
    this.ledger = config.ledger;
    this.signer = config.signer;
    const domains = cumulusDomains();
    this.mailOrigin = (config.mailOrigin ?? domains.origins.mail).replace(/\/$/, "");
    this.cloudOrigin = domains.origins.cloud;
    const clock = config.clock;

    const repos = config.repositories ?? {};
    this.quota = new StorageQuota({ store: this.stores.quota, repository: repos.quota, freeGb: FREE_ENTITLEMENTS.storageGb });
    this.wallets = new WalletAccounts({
      store: this.stores.wallet,
      repository: repos.wallet,
      clock,
      record: async (t) => (await this.recordPayment(t)).hash,
    });
    this.tunnel = new CumulusTunnel({ store: this.stores.tunnel, masterKey: config.masterKey, clock });
    const mailRepository = repos.mail?.(this.tunnel);
    if (this.tunnel.persistent && !mailRepository) openMailStore(this.stores.mail, this.tunnel); // mailboxes are sealed on disk
    this.mail = new PostOffice({ store: this.stores.mail, repository: mailRepository, quota: this.quota, payments: this.wallets, clock, tunnel: this.tunnel });
    this.cloud = new CloudStore({
      quota: this.quota,
      notifier: { shared: ({ owner, recipient, key }) => this.cloudShared(owner, recipient, key) },
    });
    const { stores: _s, mailOrigin: _m, masterKey: _k, labyrinth: _l, repositories: _r, ...cidConfig } = config;
    // Authenticator-app seeds are sealed at rest: with the given key, else one derived from the master key.
    const secretKey = config.secretKey ?? (config.masterKey ? deriveCidSecretKey(config.masterKey) : undefined);
    this.cid = new CidService({ ...cidConfig, secretKey, store: this.stores.cid, onEvent: (e) => this.onCidEvent(e) });
    if (config.labyrinth) this.labyrinth = new CidLabyrinth(this.cid.syncView(), { ...config.labyrinth, clock });
  }

  private recordPayment(t: WalletTransfer) {
    // Amounts and wallet IDs only; names and mail content never go on the ledger.
    return this.ledger.append(
      { type: "payment", product: "firm-wallet", actor: t.from ?? "settlement", subject: t.to, payload: { tx: t.id, asset: t.asset, amount: t.amount } },
      this.signer,
    );
  }

  /* ---------------- Provisioning: every CID gets the whole free tier ---------------- */

  /** Give an account its mailbox and wallet. Runs on account creation; safe to call again (backfills older CIDs). */
  async provision(account: Account) {
    const fresh = !await this.mail.has(account.cid);
    await this.mail.provision({ cid: account.cid, address: account.mailAddress, name: account.username });
    const wallet = await this.wallets.open(account.cid);
    if (fresh) {
      await this.mail.notify(account.cid, "welcome", {
        subject: "Welcome to your Cumulus://ID",
        body: [
          `Hi ${account.username},`,
          "",
          "Your Cumulus://ID is ready, and it already comes with:",
          "",
          `• Cumulus://Mail at ${account.mailAddress} (${this.mailOrigin})`,
          `• Cumulus://Cloud storage: ${FREE_ENTITLEMENTS.storageGb} GB, shared between Mail and Cloud (${this.cloudOrigin})`,
          `• A FIRM Wallet: ${wallet.address}`,
          "• SCALVS.ai and :\\ARCHITECT\\ on the free plan, and the METATRON dashboard",
          "",
          "One account signs you in to every Infinitum product. Security notices, Cloud shares and wallet receipts will arrive here.",
          "",
          "Your mail is never scanned for advertising.",
          "",
          "Cumulus",
        ].join("\n"),
      });
    }
    return { mailbox: (await this.mail.view(account.cid)).me, wallet: { address: wallet.address } };
  }

  /** Backfill: provision every existing CID that doesn't have a mailbox or wallet yet. */
  async provisionAll(): Promise<number> {
    let n = 0;
    for (const account of await this.cid.allAccounts()) {
      if (!await this.mail.has(account.cid) || !(await this.wallets.get(account.cid))) {
        await this.provision(account);
        n++;
      }
    }
    return n;
  }

  /* ---------------- Login security notices ---------------- */

  private async onCidEvent(e: CidEvent) {
    if (e.event === "account.created") {
      await this.provision(await this.cid.getAccount(e.cid));
      return;
    }
    if (!await this.mail.has(e.cid)) return;
    const when = `${new Date(e.at).toUTCString().replace("GMT", "UTC")}`;
    const footer = "\n\nIf this wasn't you, open your Cumulus://ID, sign out everywhere and remove any key you don't recognize. Every change is also recorded on Firmament Network.\n\nCumulus://ID security";
    const send = (subject: string, lines: string[]) =>
      this.mail.notify(e.cid, "security", { subject, body: [...lines, footer].join("\n") });

    switch (e.event) {
      case "session.created": {
        const device = String(e.detail.device ?? "Unknown device");
        const seen = this.stores.suite.knownDevices.get(e.cid) ?? [];
        if (seen.includes(device)) return;
        this.stores.suite.knownDevices.set(e.cid, [...seen, device].slice(-20));
        if (seen.length === 0) return; // the first device is the one that created the account
        await send("New sign-in to your Cumulus://ID", [`Your Cumulus://ID was used to sign in on a new device.`, "", `When: ${when}`, `Device: ${device}`, `Method: ${methodLabel(String(e.detail.method))}`]);
        return;
      }
      case "authenticator.added":
        // The first key is the one made while signing up; only later keys are worth an alert.
        if ((await this.cid.listAuthenticators(e.cid)).length <= 1 && !(await this.cid.linkedIdentities(e.cid)).length) return;
        await send(`New ${e.detail.kind === "security-key" ? "security key" : "passkey"} on your Cumulus://ID`, [`A ${e.detail.kind === "security-key" ? "security key" : "passkey"} named “${e.detail.label}” was added.`, "", `When: ${when}`]);
        return;
      case "authenticator.removed":
        await send("A sign-in key was removed", [`“${e.detail.label}” can no longer sign in to your Cumulus://ID.`, "", `When: ${when}`]);
        return;
      case "mfa.enabled":
        await send("Two-step verification is on", ["An authenticator app now protects your Cumulus://ID.", "", `When: ${when}`]);
        return;
      case "mfa.disabled":
        await send("Two-step verification was turned off", ["Your Cumulus://ID no longer asks for an authenticator code.", "", `When: ${when}`]);
        return;
      case "identity.linked":
        await send(`${e.detail.provider} can now sign in to your Cumulus://ID`, [`Continue with ${e.detail.provider} was linked to your account.`, "", `When: ${when}`]);
        return;
      case "identity.unlinked":
        await send(`${e.detail.provider} was unlinked`, [`Continue with ${e.detail.provider} can no longer sign in to your account.`, "", `When: ${when}`]);
        return;
      case "session.revoked_all":
        await send("You were signed out everywhere", [`${e.detail.count} session(s) were signed out by ${e.detail.by}.`, "", `When: ${when}`]);
        return;
    }
  }

  /* ---------------- Cloud ---------------- */

  private async cloudShared(owner: string, recipient: string, key: string) {
    const from = (await this.mail.has(owner)) ? await this.mail.addressOf(owner) : "Someone";
    await this.mail.notify(recipient, "cloud", {
      subject: `${from} shared “${key}” with you`,
      body: `${from} shared a file with you on Cumulus://Cloud.\n\nFile: ${key}\n\nOpen it at ${this.cloudOrigin}. Only your Cumulus://ID can see it.\n\nCumulus://Cloud`,
    });
  }

  /** Share a Cloud file by Cumulus address (or CID). */
  async shareFile(ownerCid: string, key: string, recipient: string) {
    const rcpt = recipient.startsWith("cid_") ? recipient : await this.mail.resolve(recipient);
    if (!rcpt) throw new Error("Share with a Cumulus://Mail address");
    return this.cloud.share(key, ownerCid, rcpt);
  }

  /* ---------------- FIRM Wallet ---------------- */

  /** Resolve a Cumulus address, alias or 0x wallet address to a CID. */
  async resolvePayee(to: string): Promise<string | undefined> {
    const value = to.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(value)) return this.wallets.cidForAddress(value);
    return await this.mail.resolve(value);
  }

  /** Send from the wallet directly; both people get a receipt in Cumulus://Mail. */
  async pay(fromCid: string, to: string, asset: string, amount: string, memo = ""): Promise<WalletTransfer> {
    const payee = await this.resolvePayee(to);
    if (!payee) throw new WalletError("unknown_payee", "Send to a Cumulus://Mail address or a FIRM Wallet address");
    const tx = await this.wallets.transfer(fromCid, payee, asset, amount, memo);
    const fromAddr = await this.mail.addressOf(fromCid);
    const toAddr = await this.mail.addressOf(payee);
    const payment = { asset: tx.asset, amount: tx.amount, txId: tx.id, ledgerHash: tx.ledgerHash };
    const note = memo ? `\nNote: ${memo}` : "";
    await this.mail.notify(fromCid, "wallet", { subject: `You sent ${tx.amount} ${tx.asset} to ${toAddr}`, body: `Sent: ${tx.amount} ${tx.asset}\nTo: ${toAddr}${note}\nTransaction: ${tx.id}\nRecorded on Firmament Network.\n\nFIRM Wallet`, payment });
    await this.mail.notify(payee, "wallet", { subject: `${fromAddr} sent you ${tx.amount} ${tx.asset}`, body: `Received: ${tx.amount} ${tx.asset}\nFrom: ${fromAddr}${note}\nTransaction: ${tx.id}\nRecorded on Firmament Network.\n\nFIRM Wallet`, payment });
    return tx;
  }

  /** Money arriving from outside (Data Exchange payout, a settled deposit). */
  async credit(cid: string, asset: string, amount: string, memo: string) {
    const tx = await this.wallets.credit(cid, asset, amount, memo);
    await this.mail.notify(cid, "wallet", { subject: `${tx.amount} ${tx.asset} arrived in your FIRM Wallet`, body: `Received: ${tx.amount} ${tx.asset}\nFrom: ${memo}\nTransaction: ${tx.id}\n\nFIRM Wallet`, payment: { asset: tx.asset, amount: tx.amount, txId: tx.id, ledgerHash: tx.ledgerHash } });
    return tx;
  }

  /* ---------------- One summary for every product's header ---------------- */

  /** What any product shows in its account menu: address, unread mail, storage, wallet. */
  async summary(cid: string) {
    const account = await this.cid.getAccount(cid);
    let wallet = await this.wallets.get(cid);
    if (!await this.mail.has(cid) || !wallet) {
      await this.provision(account);
      wallet = await this.wallets.get(cid);
    }
    const usage = await this.quota.usage(cid);
    return {
      cid,
      username: account.username,
      mailAddress: account.mailAddress,
      plan: "Free",
      entitlements: account.entitlements,
      mail: { unread: await this.mail.unreadCount(cid), url: this.mailOrigin },
      storage: { label: usage.label, pct: usage.pct, mail: formatBytes(usage.byProduct.mail), cloud: formatBytes(usage.byProduct.cloud) },
      wallet: { address: wallet!.address, balances: await this.wallets.balances(cid) },
    };
  }
}

export function createCumulus(config: CumulusConfig): CumulusSuite {
  return new CumulusSuite(config);
}
