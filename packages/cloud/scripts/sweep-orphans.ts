/**
 * Find (and with --delete, remove) Cumulus://Cloud bytes that no file version or upload points at.
 *
 *   node --experimental-strip-types scripts/sweep-orphans.ts            # report only
 *   node --experimental-strip-types scripts/sweep-orphans.ts --delete   # remove them
 *   --grace-hours=N   only consider objects older than N hours (default 24, minimum 1)
 *
 * Reads CUMULUS_CLOUD_DATABASE_URL and CUMULUS_CLOUD_DATA_DIR like the server.
 */
import { join } from "node:path";
import { readDriveConfig } from "../src/drive/config.ts";
import { openPool } from "../src/drive/db.ts";
import { LocalFsBlobStore } from "../src/drive/local-driver.ts";
import { DriveRepo } from "../src/drive/repo.ts";
import { DriveService } from "../src/drive/service.ts";

const args = process.argv.slice(2);
const del = args.includes("--delete");
const graceArg = args.find((a) => a.startsWith("--grace-hours="));
const graceHours = graceArg ? Number(graceArg.split("=")[1]) : 24;
const config = readDriveConfig(process.env, { dataDir: join(import.meta.dirname, "..", "data") });
if (!config.dataDir) throw new Error("CUMULUS_CLOUD_DATA_DIR is required");

const pool = openPool(config.databaseUrl);
try {
  const service = new DriveService({ repo: new DriveRepo(pool), blobs: new LocalFsBlobStore(config.dataDir) });
  const r = await service.sweepOrphanBlobs({ dryRun: !del, graceMs: graceHours * 3_600_000 });
  for (const key of r.orphans) console.log(`${del ? "removed" : "orphan"}  ${key}`);
  for (const key of r.temps) console.log(`${del ? "removed" : "temp"}    ${key}`);
  console.log(`${r.scanned} objects checked, ${r.orphans.length} orphaned, ${r.temps.length} temp files, ${r.deleted} removed${del ? "" : " (report only; pass --delete to remove)"}`);
} finally {
  await pool.end();
}
