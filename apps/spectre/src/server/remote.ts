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
  /** Throws ConflictError if any expected version is stale or a ledger seq is taken. */
  commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]): Promise<Record<string, number>>;
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
  commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]) {
    return this.call<Record<string, number>>({ op: "commit", entries, docs });
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

export class RemoteState {
  readonly ledgerStore = new RemoteLedgerStore();
  private readonly gateway: NexusGateway;
  private readonly docs: Record<string, object>;
  private versions: Record<string, number> = {};
  /** Serialized state as last loaded or saved, to detect changes and to roll back. */
  private baseline: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();

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
    if (!changed.length && !entries.length) return;
    const versions = await this.gateway.commit(entries, changed);
    this.ledgerStore.committed.push(...entries);
    this.ledgerStore.pending = [];
    for (const [id, v] of Object.entries(versions)) {
      this.versions[id] = v;
      if (serialized[id]) this.baseline[id] = serialized[id];
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
      try {
        await this.sync();
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          outcome = { ok: true, value: await fn() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        await this.commit();
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } catch (err) {
        if (err instanceof ConflictError) {
          this.rollback();
          if (retries > 0) return attempt(retries - 1);
          throw new Error("The data store is busy. Please try again.");
        }
        // Handler errors were already committed above; anything else (e.g. the store is down)
        // leaves memory out of step with the database, so drop the unsaved changes.
        this.rollback();
        throw err;
      }
    };
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
