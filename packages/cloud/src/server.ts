/**
 * Cumulus://Cloud Drive.
 * Run: node --experimental-strip-types src/server.ts
 *
 * Bytes are stored on the local filesystem. Metadata is in PostgreSQL.
 * Sign-in is a Cumulus://ID session. See README.md for environment variables.
 * This process keeps CID sessions in memory; production should pass the suite's CidService.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CidService, cumulusDomains, readCumulusDomain, upstreamIssuerFromEnv } from "@infinitum/cid";
import { Ledger, MemoryStore, generateSigner } from "@infinitum/firmament";
import { cidAuth, issuerAuth, type DriveAuth } from "./drive/auth.ts";
import { readDriveConfig } from "./drive/config.ts";
import { MasterKey } from "./drive/crypto.ts";
import { migrate, openPool } from "./drive/db.ts";
import { createDriveApp } from "./drive/http.ts";
import { LocalFsBlobStore } from "./drive/local-driver.ts";
import { DriveRepo } from "./drive/repo.ts";
import { DriveService } from "./drive/service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const config = readDriveConfig(process.env, { dataDir: join(here, "..", "data") });
if (!config.dataDir) throw new Error("CUMULUS_CLOUD_DATA_DIR is required");
mkdirSync(config.dataDir, { recursive: true });

const pool = openPool(config.databaseUrl);
await migrate(pool);
const master = MasterKey.fromEnv(process.env);
const service = new DriveService({
  repo: new DriveRepo(pool),
  blobs: new LocalFsBlobStore(config.dataDir),
  master,
  maxUploadBytes: config.maxUploadBytes,
  chunkSize: config.chunkSize,
  partSize: config.partSize,
});

const signer = generateSigner();
const ledger = new Ledger(new MemoryStore(), { authorizedSigners: [signer.publicKey] });
const cid = new CidService({
  ledger,
  signer,
  rpId: "localhost",
  origins: [`http://${config.host}:${config.port}`],
});

// With CUMULUS_ID_ISSUER (as on Cumulus://Mail), Drive accepts the issuer's access tokens and keeps
// no accounts of its own. Without it, the in-memory CID above signs people in, for local use only.
const idOrigin = upstreamIssuerFromEnv(process.env);
const auth: DriveAuth = idOrigin
  ? issuerAuth({ issuer: `${idOrigin}${new URL(cumulusDomains().issuer).pathname}` })
  : cidAuth(cid);

const cumulus = readCumulusDomain();
const app = createDriveApp({
  service,
  auth,
  rateLimit: config.rateLimit,
  rateWindowMs: config.rateWindowMs,
  publicOrigin: cumulus.cloudOrigin,
  allowedOrigins: cumulus.origins,
});

const timer = setInterval(() => {
  void service.expireUploads().catch(() => {
    console.error("Cumulus://Cloud upload expiry failed");
  });
}, 60_000);
timer.unref();

// Orphan sweep (bytes left by a crash between the write and the database commit). Off unless
// CUMULUS_CLOUD_ORPHAN_SWEEP=delete; "report" only logs what it would remove.
const sweepMode = (process.env.CUMULUS_CLOUD_ORPHAN_SWEEP ?? "off").trim().toLowerCase();
if (sweepMode === "delete" || sweepMode === "report") {
  const sweep = () =>
    service.sweepOrphanBlobs({ dryRun: sweepMode !== "delete" })
      .then(async (r) => {
        if (r.orphans.length || r.temps.length) console.log(`Cumulus://Cloud orphan sweep (${sweepMode}): ${r.orphans.length} objects, ${r.temps.length} temp files, ${r.deleted} removed`);
        if (sweepMode === "delete") {
          const fixed = await service.reconcileQuotas();
          if (fixed.length) console.log(`Cumulus://Cloud quota reconcile: ${fixed.length} owner(s) corrected`);
        }
      })
      .catch(() => console.error("Cumulus://Cloud orphan sweep failed"));
  setTimeout(() => void sweep(), 5 * 60_000).unref();
  setInterval(() => void sweep(), 6 * 60 * 60_000).unref();
}

app.server().listen(config.port, config.host, () => {
  console.log(`Cumulus://Cloud Drive listening on http://${config.host}:${config.port} (public ${cumulus.cloudOrigin}, local filesystem, encryption ${master ? "on" : "off"}, sign-in ${idOrigin ? `Cumulus://ID tokens from ${idOrigin}` : "local CID"})`);
});
