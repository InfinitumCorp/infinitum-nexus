/**
 * Copy Cumulus://ID from the `cid` document into PostgreSQL tables (relational-storage phase 3).
 *
 *   node --experimental-strip-types packages/cid/src/backfill-cli.ts [--write] [--schema cumulus_id]
 *        (--snapshot cid.json | --from-nexus-docs)
 *
 * Source, one of:
 *   --snapshot FILE      the `cid` document as JSON (e.g. exported with
 *                        `select data from nexus_docs where id = 'cid'`)
 *   --from-nexus-docs    read it from the nexus_docs table at NEXUS_DATABASE_URL
 * Target: CID_DATABASE_URL (the Postgres that will hold the tables).
 *
 * Reverse (rollback to the document): --to-snapshot FILE writes the rows at CID_DATABASE_URL back out as
 * a `cid` document (cid.json format), atomically, and checks it the same way.
 *
 * Without --write it is a dry run: it checks the document and prints counts, and touches nothing.
 * With --write it creates the tables if needed, upserts every entity (safe to repeat), reads each
 * one back and exits non-zero if anything differs. Nothing switches over: products keep using the
 * document until CUMULUS_STORE=postgres is set (phase 4). Connection strings come from the
 * environment only, so they never appear in shell history or process listings.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { backfillCid, checkCidStore, cidStoreFromRepository, cidStoreFromSnapshot } from "./backfill.ts";
import { PgCidRepository, migrateCid } from "./postgres.ts";

const { values } = parseArgs({
  options: {
    snapshot: { type: "string" },
    "from-nexus-docs": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "to-snapshot": { type: "string" },
    schema: { type: "string", default: "public" },
  },
});

const { default: pg } = await import("pg");

async function loadSnapshot(): Promise<Record<string, unknown>> {
  if (values.snapshot) return JSON.parse(readFileSync(values.snapshot, "utf8"));
  if (values["from-nexus-docs"]) {
    const url = process.env.NEXUS_DATABASE_URL;
    if (!url) throw new Error("--from-nexus-docs needs NEXUS_DATABASE_URL");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query("SELECT data FROM nexus_docs WHERE id = 'cid'");
      if (!rows.length) throw new Error("nexus_docs has no 'cid' row");
      return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
    } finally {
      await client.end();
    }
  }
  throw new Error("Give a source: --snapshot FILE or --from-nexus-docs");
}

if (values["to-snapshot"]) {
  const url = process.env.CID_DATABASE_URL;
  if (!url) throw new Error("--to-snapshot needs CID_DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const store = await cidStoreFromRepository(new PgCidRepository({ db: pool, schema: values.schema }));
    const check = checkCidStore(store);
    for (const p of check.problems.slice(0, 50)) console.log(`problem: ${p}`);
    const snapshot: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(store)) snapshot[k] = v instanceof Map ? { __map: [...v.entries()] } : v;
    const tmp = `${values["to-snapshot"]}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(tmp, values["to-snapshot"]);
    console.log(JSON.stringify({ step: "to-snapshot", counts: check.counts, problems: check.problems.length, file: values["to-snapshot"] }));
    process.exitCode = check.problems.length ? 2 : 0;
  } finally {
    await pool.end();
  }
  process.exit();
}

const store = cidStoreFromSnapshot(await loadSnapshot());
const check = checkCidStore(store);
console.log(JSON.stringify({ step: "check", counts: check.counts, skippedOneTime: check.skippedOneTime, problems: check.problems.length }));
for (const p of check.problems.slice(0, 50)) console.log(`problem: ${p}`);
if (check.problems.length) process.exit(2);
if (!values.write) {
  console.log("Dry run: nothing written. Add --write to copy into CID_DATABASE_URL.");
  process.exit(0);
}

const url = process.env.CID_DATABASE_URL;
if (!url) throw new Error("--write needs CID_DATABASE_URL");
const pool = new pg.Pool({ connectionString: url, max: 4 });
try {
  await migrateCid(pool, values.schema);
  const report = await backfillCid(store, new PgCidRepository({ db: pool, schema: values.schema }), { onProgress: (l) => console.log(l) });
  console.log(JSON.stringify({ step: "verify", written: report.written, mismatches: report.mismatches.length, sourceHash: report.sourceHash, targetHash: report.targetHash }));
  for (const m of report.mismatches.slice(0, 50)) console.log(`mismatch: ${m}`);
  process.exitCode = report.mismatches.length || report.sourceHash !== report.targetHash ? 3 : 0;
} finally {
  await pool.end();
}
