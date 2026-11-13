/**
 * FIRM Wallet on PostgreSQL (relational storage plan, phase 5): one row per wallet and per transfer.
 *
 * Wallet reads take a row lock (SELECT … FOR UPDATE). Inside a request's transaction (PgRequestScope in
 * @infinitum/cid, which this repository can share), two payments from the same wallet therefore run one
 * after the other, and neither can spend a balance the other already spent. WalletAccounts locks the
 * two wallets of a transfer in a fixed order, so opposite payments can't deadlock. Outside a
 * transaction each query commits on its own, as the in-memory store saved per request.
 *
 * The connection is passed in (a `pg` Pool, Hyperdrive, or a request scope); the package gains no
 * driver dependency. Nothing uses this unless WalletAccounts is given one.
 */
import type { WalletAccount, WalletTransfer } from "./accounts.ts";
import type { WalletRepository } from "./repository.ts";

/** The part of a `pg` Pool, Client or request scope this repository needs. */
export interface WalletQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function walletSchemaSql(schema = "public"): string {
  if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  const t = (n: string) => `"${schema}".${n}`;
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";
CREATE TABLE IF NOT EXISTS ${t("wallet_accounts")} (
  seq bigserial,
  cid text PRIMARY KEY,
  address text NOT NULL UNIQUE,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t("wallet_transfers")} (
  id text PRIMARY KEY,
  from_cid text,
  to_cid text NOT NULL,
  at text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_transfers_from ON ${t("wallet_transfers")} (from_cid, at DESC) WHERE from_cid IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_transfers_to ON ${t("wallet_transfers")} (to_cid, at DESC);
`;
}

/** Create the tables under a transaction-scoped advisory lock (several servers may start at once). */
export async function migrateWallet(db: WalletQueryable, schema = "public"): Promise<void> {
  await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('firm-wallet-migrate')); ${walletSchemaSql(schema)} COMMIT;`);
}

export class PgWalletRepository implements WalletRepository {
  readonly #db: WalletQueryable;
  readonly #schema: string;

  constructor(options: { db: WalletQueryable; schema?: string }) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#schema = schema;
  }

  #q(sql: string, params: unknown[] = []) {
    return this.#db.query(sql.replace(/\bT\.(\w+)/g, `"${this.#schema}".$1`), params);
  }

  async account(cid: string): Promise<WalletAccount | undefined> {
    const { rows } = await this.#q("SELECT data FROM T.wallet_accounts WHERE cid = $1 FOR UPDATE", [cid]);
    return rows[0]?.data;
  }
  async cidForAddress(address: string): Promise<string | undefined> {
    const { rows } = await this.#q("SELECT cid FROM T.wallet_accounts WHERE address = $1", [address.toLowerCase()]);
    return rows[0]?.cid;
  }
  async putAccount(account: WalletAccount): Promise<void> {
    await this.#q(
      `INSERT INTO T.wallet_accounts (cid, address, data) VALUES ($1, $2, $3)
       ON CONFLICT (cid) DO UPDATE SET address = EXCLUDED.address, data = EXCLUDED.data`,
      [account.cid, account.address, JSON.stringify(account)],
    );
  }
  async transfersOf(cid: string, limit: number): Promise<WalletTransfer[]> {
    const { rows } = await this.#q(
      "SELECT data FROM T.wallet_transfers WHERE from_cid = $1 OR to_cid = $1 ORDER BY at DESC, id DESC LIMIT $2",
      [cid, Math.max(0, Math.floor(limit))],
    );
    return rows.map((r) => r.data);
  }
  async putTransfer(transfer: WalletTransfer): Promise<void> {
    await this.#q(
      `INSERT INTO T.wallet_transfers (id, from_cid, to_cid, at, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [transfer.id, transfer.from, transfer.to, transfer.at, JSON.stringify(transfer)],
    );
  }
}
