/**
 * Per-person METATRON records. Provider secrets are only ever stored sealed (see vault.ts).
 * FileUserStore writes atomically (temp file + rename) and serializes writes; a Postgres
 * implementation on Cumulus Database can replace it behind the same interface.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Sealed } from "./vault.ts";
import type { PaperState } from "./broker.ts";
import type { Policy, OrderIntent, Origin } from "./guardrails.ts";
import type { AgentConfig } from "./agents.ts";

export interface Connection {
  id: string;
  itemId: string;
  institution: string;
  sealed: Sealed;
  cursor: string;
  createdAt: string;
  status: "ok" | "login_required" | "error";
  lastSyncAt?: string;
}

export interface StoredTxn {
  id: string;
  connectionId: string;
  accountId: string;
  date: string;
  name: string;
  /** Positive = money out, negative = money in (Plaid's convention). */
  amount: number;
  currency: string | null;
  pending: boolean;
  category: string | null;
}

export type AccountRef = "paper" | "broker";

export interface OrderResult extends OrderIntent {
  ok: boolean;
  clientOrderId: string;
  brokerOrderId?: string;
  status?: string;
  filledAvgPrice?: number | null;
  error?: string;
}

export interface Approval {
  id: string;
  origin: Origin;
  agentId?: string;
  account: AccountRef;
  orders: OrderIntent[];
  note: string;
  status: "pending" | "executed" | "partial" | "failed" | "declined" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  results?: OrderResult[];
}

export interface OrderLogEntry {
  at: string;
  day: string;
  account: AccountRef;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  origin: Origin;
}

export interface UserRecord {
  cid: string;
  connections: Connection[];
  txns: StoredTxn[];
  broker?: { provider: "alpaca"; paper: boolean; sealed: Sealed; addedAt: string };
  paper: PaperState;
  policy: Policy;
  agents: AgentConfig[];
  approvals: Approval[];
  orderLog: OrderLogEntry[];
}

export interface UserStore {
  get(cid: string): Promise<UserRecord | undefined>;
  put(record: UserRecord): Promise<void>;
  /** Finds the owner of a Plaid item, for webhooks. */
  findByItem(itemId: string): Promise<UserRecord | undefined>;
}

export class MemoryUserStore implements UserStore {
  protected users = new Map<string, UserRecord>();
  async get(cid: string) {
    const u = this.users.get(cid);
    return u ? structuredClone(u) : undefined;
  }
  async put(record: UserRecord) {
    this.users.set(record.cid, structuredClone(record));
  }
  async findByItem(itemId: string) {
    for (const u of this.users.values()) if (u.connections.some((c) => c.itemId === itemId)) return structuredClone(u);
    return undefined;
  }
}

export class FileUserStore extends MemoryUserStore {
  private readonly path: string;
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super();
    this.path = path;
  }

  private async load() {
    if (this.loaded) return;
    try {
      const obj = JSON.parse(await readFile(this.path, "utf8")) as Record<string, UserRecord>;
      for (const [k, v] of Object.entries(obj)) this.users.set(k, v);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  async get(cid: string) {
    await this.load();
    return super.get(cid);
  }

  async findByItem(itemId: string) {
    await this.load();
    return super.findByItem(itemId);
  }

  async put(record: UserRecord) {
    await this.load();
    await super.put(record);
    const snapshot = JSON.stringify(Object.fromEntries(this.users));
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = this.path + ".tmp";
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.chain;
  }
}
