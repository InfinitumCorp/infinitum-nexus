/**
 * Cumulus://ID storage for a single server (main.ts: the Russia issuer at ru-id.cumuluscloud.app,
 * local runs). Hosted products use cid-store.ts instead.
 *
 *   CUMULUS_STORE unset or "document"  cid.json in the data directory, as before.
 *   CUMULUS_STORE=postgres             rows in Postgres at CID_DATABASE_URL (schema CID_DATABASE_SCHEMA,
 *                                      default "public"). On the Russia server that is Postgres on the
 *                                      same Yandex machine, reached over its Unix socket with the
 *                                      service's own OS user (peer authentication), so there is no
 *                                      password anywhere: postgresql:///cumulus_id?host=/var/run/postgresql
 *
 * In Postgres mode the tables are created on start, and the first start with empty tables copies
 * cid.json into them and checks every row (backfillCid); it refuses to start if anything differs.
 * cid.json is then left as it was (no longer written), so CUMULUS_STORE=document is the rollback.
 * One process per database: each write commits on its own, as the in-memory store saved per request.
 */
import { PgCidRepository, backfillCid, migrateCid, type CidRepository, type CidStore } from "@infinitum/cid";

export interface LocalCidStorage {
  /** For createCumulus; undefined in document mode. */
  repository?: CidRepository;
  /** Stores not to write back to the data directory (cid in Postgres mode). */
  skipFiles: string[];
  describe: string;
  close(): Promise<void>;
}

export async function localCidStorage(fileStore: CidStore, env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.log): Promise<LocalCidStorage> {
  const mode = (env.CUMULUS_STORE ?? "document").trim().toLowerCase();
  if (mode === "document" || mode === "") return { skipFiles: [], describe: "cid.json", close: async () => {} };
  if (mode !== "postgres") throw new Error(`CUMULUS_STORE must be "document" or "postgres" on a single server, not "${env.CUMULUS_STORE}"`);
  const url = env.CID_DATABASE_URL;
  if (!url) throw new Error("CUMULUS_STORE=postgres needs CID_DATABASE_URL (e.g. postgresql:///cumulus_id?host=/var/run/postgresql)");
  const schema = env.CID_DATABASE_SCHEMA || "public";
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    await migrateCid(pool, schema);
    const repository = new PgCidRepository({ db: pool, schema });
    const existing = await repository.allAccounts();
    if (!existing.length && fileStore.accounts.size) {
      const report = await backfillCid(fileStore, repository);
      if (report.mismatches.length || report.sourceHash !== report.targetHash) {
        throw new Error(`cid.json -> Postgres copy differs (${report.mismatches.length} mismatches, first: ${report.mismatches[0] ?? "hash"}); not starting`);
      }
      log(`Cumulus://ID: copied cid.json into Postgres (${report.counts.accounts} accounts, ${report.counts.authenticators} keys, ${report.counts.sessions} sessions, ${report.counts.grants} grants), every row verified`);
    }
    // The in-memory store is no longer the source of truth; drop it so nothing reads stale data.
    for (const v of Object.values(fileStore)) if (v instanceof Map) v.clear();
    return { repository, skipFiles: ["cid"], describe: `Postgres (schema ${schema})`, close: () => pool.end() };
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}
