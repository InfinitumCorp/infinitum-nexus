import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Entry } from "@infinitum/firmament";
import { initSchema, loadState, commitState, type SqlLike } from "./do-store.ts";
import { RemoteState, ConflictError, type NexusGateway } from "./remote.ts";

/** node:sqlite behind the same small interface as Durable Object SQL storage. */
function sqlite(): { sql: SqlLike; tx: <T>(fn: () => T) => T } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlLike = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  initSchema(sql);
  return { sql, tx };
}

const entry = (seq: number) => ({ seq, kind: "test" }) as unknown as Entry;

test("commit then load returns new docs and entries only", () => {
  const { sql, tx } = sqlite();
  const r = commitState(sql, [entry(0), entry(1)], [{ id: "cid", expected: 0, data: { a: 1 } }], tx);
  assert.deepEqual(r, { ok: true, versions: { cid: 1 } });
  const all = loadState(sql, -1, {});
  assert.deepEqual(all.entries.map((e) => e.seq), [0, 1]);
  assert.deepEqual(all.docs, [{ id: "cid", version: 1, data: { a: 1 } }]);
  const none = loadState(sql, 1, { cid: 1 });
  assert.deepEqual(none, { entries: [], docs: [] });
});

test("stale version or taken seq is a conflict and writes nothing", () => {
  const { sql, tx } = sqlite();
  commitState(sql, [entry(0)], [{ id: "cid", expected: 0, data: { a: 1 } }], tx);
  assert.deepEqual(commitState(sql, [], [{ id: "cid", expected: 0, data: { a: 2 } }], tx), { ok: false, conflict: true });
  assert.deepEqual(commitState(sql, [entry(0)], [{ id: "spectre", expected: 0, data: {} }], tx), { ok: false, conflict: true });
  const all = loadState(sql, -1, {});
  assert.equal(all.entries.length, 1);
  assert.deepEqual(all.docs.map((d) => d.id), ["cid"]);
});

test("RemoteState works over the SQLite store", async () => {
  const { sql, tx } = sqlite();
  const gateway: NexusGateway = {
    async load(since, versions) {
      return loadState(sql, since, versions);
    },
    async commit(entries, docs) {
      const r = commitState(sql, entries, docs, tx);
      if (!r.ok) throw new ConflictError();
      return r.versions;
    },
  };
  const store = { items: [] as string[] };
  const state = new RemoteState(gateway, { spectre: store });
  await state.transaction(async () => {
    store.items.push("x");
  });
  const other = { items: [] as string[] };
  await new RemoteState(gateway, { spectre: other }).sync();
  assert.deepEqual(other.items, ["x"]);
});
