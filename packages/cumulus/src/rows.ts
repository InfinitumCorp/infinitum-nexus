/**
 * Mail, FIRM Wallet and the storage quota as Postgres rows (relational storage plan, phase 5).
 *
 * - productRepositories(): the Postgres repositories for the products named in CUMULUS_ROWS, on a
 *   connection the host gives (inside a request, the same transaction as Cumulus://ID's rows).
 * - backfillProductRows(): copy today's in-memory stores (as loaded from their documents) into the
 *   tables, read every entity back and report anything that differs. Safe to repeat.
 */
import { MapQuotaRepository, PgQuotaRepository, migrateQuota, type QuotaRepository, type QuotaStore } from "@infinitum/cloud";
import { PgWalletRepository, migrateWallet, type WalletRepository, type WalletStore } from "@infinitum/firm";
import { PgMailRepository, migrateMail, type CumulusTunnel, type MailRepository, type PostOfficeStore } from "@infinitum/mail";

export type RowProduct = "mail" | "wallet" | "quota";
export const ROW_PRODUCTS: RowProduct[] = ["mail", "wallet", "quota"];

export interface RowsQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** "mail,wallet" -> the products; "" -> none. Unknown names are refused. */
export function parseRowProducts(value: string | undefined): RowProduct[] {
  const names = (value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!ROW_PRODUCTS.includes(n as RowProduct)) throw new Error(`CUMULUS_ROWS: unknown product "${n}" (use ${ROW_PRODUCTS.join(", ")})`);
  return [...new Set(names)] as RowProduct[];
}

export function productRepositories(products: RowProduct[], db: RowsQueryable, schema = "public") {
  return {
    mail: products.includes("mail") ? (tunnel: CumulusTunnel) => new PgMailRepository({ db, schema, tunnel: tunnel.persistent ? tunnel : undefined }) as MailRepository : undefined,
    wallet: products.includes("wallet") ? (new PgWalletRepository({ db, schema }) as WalletRepository) : undefined,
    quota: products.includes("quota") ? (new PgQuotaRepository({ db, schema }) as QuotaRepository) : undefined,
  };
}

export async function migrateProductRows(db: RowsQueryable, products: RowProduct[], schema = "public") {
  if (products.includes("mail")) await migrateMail(db, schema);
  if (products.includes("wallet")) await migrateWallet(db, schema);
  if (products.includes("quota")) await migrateQuota(db, schema);
}

/** JSON with object keys sorted, so a value compares equal after a trip through jsonb. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
}

export interface RowsBackfillReport {
  counts: Record<string, number>;
  mismatches: string[];
}

export interface RowsSource {
  mail?: PostOfficeStore;
  wallet?: WalletStore;
  quota?: QuotaStore;
}

/**
 * Copy the stores into the products' tables at `db` and verify. With a persistent tunnel, mail is
 * sealed as it's written and the tunnel keys are stored too. The stores must hold opened mail.
 */
export async function backfillProductRows(source: RowsSource, db: RowsQueryable, opts: { schema?: string; tunnel?: CumulusTunnel; onProgress?: (line: string) => void } = {}): Promise<RowsBackfillReport> {
  const schema = opts.schema ?? "public";
  const counts: Record<string, number> = {};
  const mismatches: string[] = [];
  const say = opts.onProgress ?? (() => {});

  if (source.mail) {
    await migrateMail(db, schema);
    const repo = new PgMailRepository({ db, schema, tunnel: opts.tunnel?.persistent ? opts.tunnel : undefined });
    for (const [address, cid] of source.mail.addresses) {
      if (!(await repo.claimAddress(address, cid))) mismatches.push(`address ${address} already belongs to another account in the table`);
    }
    for (const box of source.mail.mailboxes.values()) {
      await repo.mailbox(box.cid); // so the write is compared against what is already there
      await repo.putMailbox(box);
    }
    for (const job of source.mail.outbound.values()) await repo.putOutbound(job);
    const check = new PgMailRepository({ db, schema, tunnel: opts.tunnel?.persistent ? opts.tunnel : undefined });
    for (const box of source.mail.mailboxes.values()) {
      const back = await check.mailbox(box.cid);
      if (stableJson(back) !== stableJson(box)) mismatches.push(`mailbox ${box.cid} reads back differently`);
    }
    for (const [address, cid] of source.mail.addresses) if ((await check.cidForAddress(address)) !== cid) mismatches.push(`address ${address}`);
    for (const job of source.mail.outbound.values()) if (stableJson(await check.outbound(job.id)) !== stableJson(job)) mismatches.push(`outbound ${job.id}`);
    counts.mailboxes = source.mail.mailboxes.size;
    counts.messages = [...source.mail.mailboxes.values()].reduce((n, b) => n + b.messages.length, 0);
    counts.addresses = source.mail.addresses.size;
    counts.outbound = source.mail.outbound.size;
    say(`mail: ${counts.mailboxes} mailboxes, ${counts.messages} messages`);
  }

  if (source.wallet) {
    await migrateWallet(db, schema);
    const repo = new PgWalletRepository({ db, schema });
    for (const account of source.wallet.accounts.values()) await repo.putAccount(account);
    for (const t of source.wallet.transfers.values()) await repo.putTransfer(t);
    for (const account of source.wallet.accounts.values()) {
      if (stableJson(await repo.account(account.cid)) !== stableJson(account)) mismatches.push(`wallet ${account.cid}`);
      if ((await repo.cidForAddress(account.address)) !== account.cid) mismatches.push(`wallet address ${account.address}`);
      const mine = [...source.wallet.transfers.values()].filter((t) => t.from === account.cid || t.to === account.cid);
      const back = await repo.transfersOf(account.cid, mine.length + 1);
      if (stableJson(back.map((t) => t.id).sort()) !== stableJson(mine.map((t) => t.id).sort())) mismatches.push(`transfers of ${account.cid}`);
    }
    counts.wallets = source.wallet.accounts.size;
    counts.transfers = source.wallet.transfers.size;
    say(`wallet: ${counts.wallets} wallets, ${counts.transfers} transfers`);
  }

  if (source.quota) {
    await migrateQuota(db, schema);
    const repo = new PgQuotaRepository({ db, schema });
    const from = new MapQuotaRepository(source.quota);
    const cids = new Set([...source.quota.usage.keys(), ...source.quota.extraGb.keys()]);
    for (const cid of cids) {
      const usage = await from.usage(cid);
      if (usage) await repo.putUsage(cid, usage);
      await repo.setExtraGb(cid, (await from.extraGb(cid)) ?? 0);
    }
    for (const cid of cids) {
      const none = { mail: 0, cloud: 0 };
      if (stableJson((await repo.usage(cid)) ?? none) !== stableJson((await from.usage(cid)) ?? none)) mismatches.push(`quota ${cid}`);
      if ((await repo.extraGb(cid)) !== (await from.extraGb(cid))) mismatches.push(`extra storage ${cid}`);
    }
    counts.quotas = cids.size;
    say(`quota: ${counts.quotas} people`);
  }
  return { counts, mismatches };
}
