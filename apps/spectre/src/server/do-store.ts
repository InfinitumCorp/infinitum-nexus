import type { Entry } from "@infinitum/firmament";
import type { DocRow } from "./remote.ts";

/**
 * The nexus-store rules (see supabase/migrations/20261104_nexus_store.sql) over a SQLite
 * database, so +SPCTR / Cumulus://ID can keep its state in a Cloudflare Durable Object on the
 * Workers free plan instead of the Supabase function. Same contract as MemoryGateway:
 * ledger entries are append-only, and a commit fails as a whole if any store changed since the
 * caller loaded it or a ledger seq is already taken.
 */

/** The part of Durable Object SQL storage (ctx.storage.sql) used here. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export type CommitResult = { ok: true; versions: Record<string, number> } | { ok: false; conflict: true };

export function initSchema(sql: SqlLike) {
  sql.exec("CREATE TABLE IF NOT EXISTS nexus_ledger (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS nexus_docs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)");
}

export function loadState(sql: SqlLike, since: number, versions: Record<string, number>): { entries: Entry[]; docs: DocRow[] } {
  const entries = sql
    .exec("SELECT entry FROM nexus_ledger WHERE seq > ? ORDER BY seq", since)
    .toArray()
    .map((r) => JSON.parse(String(r.entry)) as Entry);
  const docs = sql
    .exec("SELECT id, version, data FROM nexus_docs")
    .toArray()
    .filter((r) => Number(r.version) !== (versions[String(r.id)] ?? 0))
    .map((r) => ({ id: String(r.id), version: Number(r.version), data: JSON.parse(String(r.data)) as Record<string, unknown> }));
  return { entries, docs };
}

/**
 * Checks everything first and only then writes, inside `transaction`, so a conflict
 * leaves the database untouched.
 */
export function commitState(
  sql: SqlLike,
  entries: Entry[],
  docs: { id: string; expected: number; data: Record<string, unknown> }[],
  transaction: <T>(fn: () => T) => T,
): CommitResult {
  return transaction((): CommitResult => {
    const current = (id: string) => {
      const row = sql.exec("SELECT version FROM nexus_docs WHERE id = ?", id).toArray()[0];
      return row ? Number(row.version) : 0;
    };
    for (const d of docs) if (current(d.id) !== d.expected) return { ok: false, conflict: true };
    const seqs = new Set<number>();
    for (const e of entries) {
      if (seqs.has(e.seq)) return { ok: false, conflict: true };
      seqs.add(e.seq);
      if (sql.exec("SELECT 1 AS taken FROM nexus_ledger WHERE seq = ?", e.seq).toArray().length) return { ok: false, conflict: true };
    }
    const versions: Record<string, number> = {};
    for (const d of docs) {
      const version = d.expected + 1;
      sql.exec(
        "INSERT INTO nexus_docs (id, version, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data",
        d.id, version, JSON.stringify(d.data),
      );
      versions[d.id] = version;
    }
    for (const e of entries) sql.exec("INSERT INTO nexus_ledger (seq, entry) VALUES (?, ?)", e.seq, JSON.stringify(e));
    return { ok: true, versions };
  });
}
