/**
 * FIRM Wallet accounts: every Cumulus://ID gets a FIRM Wallet on the free tier, the same way
 * it gets a Cumulus://Mail address. Balances here are the in-ecosystem account ledger
 * (settled to Base by the FIRM contracts); each transfer is reported through `record`
 * so it lands on Firmament Network as a "payment" entry.
 *
 * Amounts are decimal strings ("12.5") and are kept as integer micro-units, so no
 * floating-point rounding ever touches a balance.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { MapWalletRepository, type WalletRepository } from "./repository.ts";

export const WALLET_ASSETS = ["FIRM", "USDC"] as const;
export type WalletAsset = (typeof WALLET_ASSETS)[number];

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

export class WalletError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WalletAccount {
  cid: string;
  /** EVM-style address shown to people, derived from the wallet key. */
  address: string;
  publicKeyPem: string;
  createdAt: string;
  /** Micro-units as strings, so the store stays JSON-safe. */
  balances: Record<WalletAsset, string>;
}

export interface WalletTransfer {
  id: string;
  from: string | null; // null = credit into the ecosystem (settlement, payout)
  to: string;
  asset: WalletAsset;
  amount: string; // decimal string
  memo: string;
  at: string;
  /** Firmament entry hash, when recorded. */
  ledgerHash?: string;
}

export class WalletStore {
  accounts = new Map<string, WalletAccount>();
  byAddress = new Map<string, string>();
  transfers = new Map<string, WalletTransfer>();
}

export interface WalletAccountsOptions {
  store?: WalletStore;
  /** Where wallets and transfers live; defaults to MapWalletRepository over `store` (in memory). */
  repository?: WalletRepository;
  clock?: () => Date;
  /** Write the transfer to Firmament; returns the entry hash. */
  record?: (transfer: WalletTransfer) => Promise<string | undefined> | string | undefined;
}

export function parseAmount(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new WalletError("invalid_amount", "Amounts look like 12 or 12.50 (up to 6 decimals)");
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(DECIMALS, "0"));
}

export function formatAmount(units: bigint): string {
  const whole = units / UNIT;
  const frac = (units % UNIT).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function assertAsset(asset: string): asserts asset is WalletAsset {
  if (!(WALLET_ASSETS as readonly string[]).includes(asset)) throw new WalletError("unknown_asset", `FIRM Wallet holds ${WALLET_ASSETS.join(" and ")}`);
}

export class WalletAccounts {
  readonly store: WalletStore;
  /** Every read and write of wallet data goes through here. */
  readonly repo: WalletRepository;
  private readonly clock: () => Date;
  private readonly recordFn?: WalletAccountsOptions["record"];

  constructor(opts: WalletAccountsOptions = {}) {
    this.store = opts.store ?? new WalletStore();
    this.repo = opts.repository ?? new MapWalletRepository(this.store);
    this.clock = opts.clock ?? (() => new Date());
    this.recordFn = opts.record;
  }

  /** Open the wallet for a CID. Safe to call again; returns the existing wallet. */
  async open(cid: string): Promise<WalletAccount> {
    const existing = await this.repo.account(cid);
    if (existing) return existing;
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const address = `0x${createHash("sha256").update(publicKeyPem).digest("hex").slice(-40)}`;
    // The private key is never kept by the server. Signing for on-chain settlement happens on the
    // person's device (passkey-wrapped key in FIRM Wallet); this record only holds the public half.
    const account: WalletAccount = {
      cid,
      address,
      publicKeyPem,
      createdAt: this.clock().toISOString(),
      balances: { FIRM: "0", USDC: "0" },
    };
    await this.repo.putAccount(account);
    return account;
  }

  get(cid: string): Promise<WalletAccount | undefined> {
    return this.repo.account(cid);
  }

  cidForAddress(address: string): Promise<string | undefined> {
    return this.repo.cidForAddress(address.toLowerCase());
  }

  async balances(cid: string): Promise<Record<WalletAsset, string>> {
    const account = await this.require(cid);
    return { FIRM: formatAmount(BigInt(account.balances.FIRM)), USDC: formatAmount(BigInt(account.balances.USDC)) };
  }

  history(cid: string, limit = 50): Promise<WalletTransfer[]> {
    return this.repo.transfersOf(cid, limit);
  }

  private async require(cid: string): Promise<WalletAccount> {
    const account = await this.repo.account(cid);
    if (!account) throw new WalletError("no_wallet", "This Cumulus://ID has no FIRM Wallet yet");
    return account;
  }

  /** Money coming into the ecosystem: a Data Exchange payout, a settled deposit. Not a user action. */
  async credit(cid: string, asset: string, amount: string, memo: string): Promise<WalletTransfer> {
    assertAsset(asset);
    const units = parseAmount(amount);
    if (units <= 0n) throw new WalletError("invalid_amount", "Amount must be more than zero");
    const account = await this.require(cid);
    const before = { ...account, balances: { ...account.balances } };
    account.balances[asset] = (BigInt(account.balances[asset]) + units).toString();
    return this.log({ from: null, to: cid, asset, amount: formatAmount(units), memo }, [account], [before]);
  }

  /** Send from one FIRM Wallet to another. All-or-nothing. */
  async transfer(fromCid: string, toCid: string, asset: string, amount: string, memo = ""): Promise<WalletTransfer> {
    assertAsset(asset);
    if (fromCid === toCid) throw new WalletError("same_wallet", "You can't send to your own wallet");
    const units = parseAmount(amount);
    if (units <= 0n) throw new WalletError("invalid_amount", "Amount must be more than zero");
    // Read (and, on Postgres, lock) the two wallets in a fixed order, so opposite payments can't deadlock.
    const [first, second] = fromCid < toCid ? [fromCid, toCid] : [toCid, fromCid];
    const a = await this.require(first);
    const b = await this.require(second);
    const [from, to] = first === fromCid ? [a, b] : [b, a];
    const balance = BigInt(from.balances[asset]);
    if (balance < units) throw new WalletError("insufficient_funds", `Not enough ${asset}. Balance: ${formatAmount(balance)}`);
    const before = [{ ...from, balances: { ...from.balances } }, { ...to, balances: { ...to.balances } }];
    from.balances[asset] = (balance - units).toString();
    to.balances[asset] = (BigInt(to.balances[asset]) + units).toString();
    return this.log({ from: fromCid, to: toCid, asset, amount: formatAmount(units), memo: memo.slice(0, 140) }, [from, to], before);
  }

  /**
   * Save the new balances, record the transfer on Firmament, then keep it in the history. If the
   * ledger refuses the record, the balances are put back and no history is kept.
   */
  private async log(input: Omit<WalletTransfer, "id" | "at">, changed: WalletAccount[], before: WalletAccount[]): Promise<WalletTransfer> {
    const transfer: WalletTransfer = { id: `tx_${randomUUID()}`, at: this.clock().toISOString(), ...input };
    for (const a of changed) await this.repo.putAccount(a);
    try {
      const hash = await this.recordFn?.(transfer);
      if (hash) transfer.ledgerHash = hash;
    } catch (err) {
      for (const a of before) await this.repo.putAccount(a);
      throw err;
    }
    await this.repo.putTransfer(transfer);
    return transfer;
  }
}
