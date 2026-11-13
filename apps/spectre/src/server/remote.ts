import type { Entry, LedgerStore } from "@infinitum/firmament";
import { toSnapshot, applySnapshot } from "./persist.ts";

/**
 * Hosted state for serverless (Vercel): the Firmament ledger and the CID and Spectre stores
 * live in Supabase, reached through the private `nexus-store` edge function.
 *
 * Each request: sync() pulls new ledger entries and any store that changed elsewhere, the
 * request runs in memory, then commit() saves the new ledger entries and changed stores in
 * ONE database transaction that checks nobody else saved first. On a conflict the request
 * is re-run on fresh state, so concurrent users never overwrite each other.
 */

export class ConflictError extends Error {
  constructor() {
    super("Someone else saved at the same moment");
  }
}

export interface DocRow {
  id: string;
  version: number;
  data: Record<string, unknown>;
}

/** The gateway's two operations. Implemented over HTTP in production and in memory in tests. */
export interface NexusGateway {
  load(since: number, versions: Record<string, number>): Promise<{ entries: Entry[]; docs: DocRow[] }>;
  /**
   * Throws ConflictError if any expected version is stale or a ledger seq is taken, or (with `rows`)
   * if a Cumulus://ID row changed since the request read it. Everything is saved or nothing is.
   */
  commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[], rows?: unknown[]): Promise<Record<string, number>>;
  /** Cumulus://ID row lookups (nexus-store "cid.read"). Only gateways that hold the rows have it. */
  readRows?(ops: unknown[]): Promise<unknown[]>;
}

export class HttpGateway implements NexusGateway {
  private readonly url: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  constructor(url: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.key = key;
    // Call fetch as a plain function: Workers throw "Illegal invocation" when it runs with this = HttpGateway.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }
  private async call<T>(body: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nexus-key": this.key },
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new ConflictError();
    const text = await res.text();
    if (!res.ok) throw new Error(`Data store error ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }
  load(since: number, versions: Record<string, number>) {
    return this.call<{ entries: Entry[]; docs: DocRow[] }>({ op: "load", since, versions });
  }
  commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[], rows?: unknown[]) {
    return this.call<Record<string, number>>({ op: "commit", entries, docs, ...(rows?.length ? { cid: rows } : {}) });
  }
  async readRows(ops: unknown[]) {
    return (await this.call<{ results: unknown[] }>({ op: "cid.read", ops })).results;
  }
}

/** Ledger store backed by the remote state: appends are buffered until the request commits. */
export class RemoteLedgerStore implements LedgerStore {
  committed: Entry[] = [];
  pending: Entry[] = [];
  async append(entry: Entry) {
    this.pending.push(entry);
  }
  async last() {
    return this.pending[this.pending.length - 1] ?? this.committed[this.committed.length - 1];
  }
  async all() {
    return [...this.committed, ...this.pending];
  }
}

/**
 * Phase 0 of docs/plans/relational-storage.md: how big each whole-store document is and how often
 * concurrent requests collide. Byte counts and counters only; never any content.
 */
export interface StoreStats {
  transactions: number;
  /** Commits refused because another instance saved first (each one re-runs the request). */
  conflicts: number;
  /** Requests that still conflicted after every re-run and failed. */
  exhausted: number;
  commits: number;
  /** Participant commits that failed after the ledger was saved (should stay 0; alert on it). */
  participantFailures?: number;
  /** Cumulus://ID row writes saved with the ledger (CUMULUS_STORE=gateway), and the commits that carried them. */
  rowWrites?: number;
  rowCommits?: number;
  /** Per document: bytes written in total, size at the last write, and the largest size seen. */
  docs: Record<string, { writes: number; bytesWritten: number; lastBytes: number; maxBytes: number }>;
}

/**
 * Another store that must commit or roll back with each request (e.g. Cumulus://ID's Postgres rows,
 * see PgRequestScope in @infinitum/cid). begin() runs before the request; commit() only after the
 * ledger and documents were saved; rollback() whenever they weren't, including before a re-run.
 */
export interface TransactionParticipant {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export class RemoteState {
  /** Counters since this instance started. */
  readonly stats: StoreStats = { transactions: 0, conflicts: 0, exhausted: 0, commits: 0, docs: {} };
  /** Where metrics lines go. Default console.log; null turns them off. */
  metricsLog: ((line: string) => void) | null = (line) => console.log(line);
  /** A metrics line every this many transactions (and on every conflict). */
  metricsEvery = 100;
  readonly ledgerStore = new RemoteLedgerStore();
  private readonly gateway: NexusGateway;
  private readonly docs: Record<string, object>;
  private versions: Record<string, number> = {};
  /** Serialized state as last loaded or saved, to detect changes and to roll back. */
  private baseline: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();
  /** Stores that commit and roll back with each request. Set before the first request. */
  participants: TransactionParticipant[] = [];
  /**
   * Row writes saved by the gateway in the same transaction as the ledger and documents
   * (Cumulus://ID rows behind nexus-store). Read at commit; the source resets itself via begin/rollback.
   */
  rows: { pending(): unknown[] } | null = null;

  /** @param docs named stores to keep in sync, e.g. { cid: cidStore, spectre: spectreStore } */
  constructor(gateway: NexusGateway, docs: Record<string, object>) {
    this.gateway = gateway;
    this.docs = docs;
    for (const [id, store] of Object.entries(docs)) {
      this.versions[id] = 0;
      this.baseline[id] = JSON.stringify(toSnapshot(store));
    }
  }

  async sync() {
    const since = this.ledgerStore.committed.length ? this.ledgerStore.committed[this.ledgerStore.committed.length - 1].seq : -1;
    const { entries, docs } = await this.gateway.load(since, this.versions);
    this.ledgerStore.committed.push(...entries.sort((a, b) => a.seq - b.seq));
    for (const row of docs) {
      const store = this.docs[row.id];
      if (!store) continue;
      applySnapshot(store, row.data);
      this.versions[row.id] = row.version;
      this.baseline[row.id] = JSON.stringify(row.data);
    }
  }

  /** Undo in-memory changes from a request that failed or must be re-run. */
  rollback() {
    this.ledgerStore.pending = [];
    for (const [id, store] of Object.entries(this.docs)) {
      if (JSON.stringify(toSnapshot(store)) !== this.baseline[id]) applySnapshot(store, JSON.parse(this.baseline[id]));
    }
  }

  async commit() {
    const changed: { id: string; expected: number; data: Record<string, unknown> }[] = [];
    const serialized: Record<string, string> = {};
    for (const [id, store] of Object.entries(this.docs)) {
      const data = toSnapshot(store);
      const json = JSON.stringify(data);
      if (json !== this.baseline[id]) {
        changed.push({ id, expected: this.versions[id], data });
        serialized[id] = json;
      }
    }
    const entries = this.ledgerStore.pending;
    const rows = this.rows?.pending() ?? [];
    if (!changed.length && !entries.length && !rows.length) return;
    const versions = await (rows.length ? this.gateway.commit(entries, changed, rows) : this.gateway.commit(entries, changed));
    this.stats.commits++;
    if (rows.length) {
      this.stats.rowWrites = (this.stats.rowWrites ?? 0) + rows.length;
      this.stats.rowCommits = (this.stats.rowCommits ?? 0) + 1;
    }
    for (const d of changed) {
      const bytes = Buffer.byteLength(serialized[d.id]!, "utf8");
      const s = (this.stats.docs[d.id] ??= { writes: 0, bytesWritten: 0, lastBytes: 0, maxBytes: 0 });
      s.writes++;
      s.bytesWritten += bytes;
      s.lastBytes = bytes;
      s.maxBytes = Math.max(s.maxBytes, bytes);
    }
    this.ledgerStore.committed.push(...entries);
    this.ledgerStore.pending = [];
    for (const [id, v] of Object.entries(versions)) {
      this.versions[id] = v;
      if (serialized[id]) this.baseline[id] = serialized[id];
    }
  }

  /** One JSON line with the counters, tagged so it can be filtered in Workers/Vercel logs. */
  private emit(reason: string) {
    if (!this.metricsLog) return;
    try {
      this.metricsLog(JSON.stringify({ metric: "nexus-store", reason, ...this.stats }));
    } catch {
      // Metrics must never break a request.
    }
  }

  /**
   * Run one request: sync, run, commit. Requests within one instance are serialized so they
   * never interleave on the shared in-memory state. On a save conflict, re-run (up to twice).
   *
   * If the request itself fails (a wrong code, a refused sign-in), whatever it recorded before
   * failing is still saved, as in local mode: audit entries like "signin.failed" must not vanish.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const attempt = async (retries: number): Promise<T> => {
      const begun: TransactionParticipant[] = [];
      const rollbackParticipants = async () => {
        for (const p of begun.splice(0)) await p.rollback().catch(() => undefined);
      };
      try {
        for (const p of this.participants) {
          await p.begin();
          begun.push(p);
        }
        await this.sync();
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          outcome = { ok: true, value: await fn() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        await this.commit();
        // The ledger and documents are saved: now the participants. A failure here leaves them
        // behind the ledger, which can't be undone any more; it is reported, never silent.
        for (const p of begun.splice(0)) {
          try {
            await p.commit();
          } catch (err) {
            this.stats.participantFailures = (this.stats.participantFailures ?? 0) + 1;
            this.emit("participant-commit-failed");
            await rollbackParticipants();
            throw err;
          }
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } catch (err) {
        await rollbackParticipants();
        if (err instanceof ConflictError) {
          this.rollback();
          this.stats.conflicts++;
          this.emit("conflict");
          if (retries > 0) return attempt(retries - 1);
          this.stats.exhausted++;
          throw new Error("The data store is busy. Please try again.");
        }
        // Handler errors were already committed above; anything else (e.g. the store is down)
        // leaves memory out of step with the database, so drop the unsaved changes.
        this.rollback();
        throw err;
      }
    };
    this.stats.transactions++;
    if (this.metricsEvery > 0 && this.stats.transactions % this.metricsEvery === 0) this.emit("periodic");
    const run = this.queue.then(() => attempt(2));
    this.queue = run.catch(() => undefined);
    return run;
  }
}


/** In-memory gateway with the same rules as the database function (tests, local runs). */
export class MemoryGateway implements NexusGateway {
  entries: Entry[] = [];
  docs = new Map<string, DocRow>();
  async load(since: number, versions: Record<string, number>) {
    return {
      entries: structuredClone(this.entries.filter((e) => e.seq > since)),
      docs: structuredClone([...this.docs.values()].filter((d) => d.version !== (versions[d.id] ?? 0))),
    };
  }
  async commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]) {
    for (const d of docs) if ((this.docs.get(d.id)?.version ?? 0) !== d.expected) throw new ConflictError();
    const taken = new Set(this.entries.map((e) => e.seq));
    if (entries.some((e) => taken.has(e.seq))) throw new ConflictError();
    const out: Record<string, number> = {};
    for (const d of docs) {
      const version = d.expected + 1;
      this.docs.set(d.id, { id: d.id, version, data: structuredClone(d.data) });
      out[d.id] = version;
    }
    this.entries.push(...structuredClone(entries));
    return out;
  }
}
