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
import { CidService } from "@infinitum/cid";
import { Ledger, MemoryStore, generateSigner } from "@infinitum/firmament";
import { cidAuth } from "./drive/auth.ts";
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

const app = createDriveApp({
  service,
  auth: cidAuth(cid),
  rateLimit: config.rateLimit,
  rateWindowMs: config.rateWindowMs,
});

const timer = setInterval(() => {
  void service.expireUploads().catch(() => {
    console.error("Cumulus://Cloud upload expiry failed");
  });
}, 60_000);
timer.unref();

app.server().listen(config.port, config.host, () => {
  console.log(`Cumulus://Cloud Drive listening on http://${config.host}:${config.port} (local filesystem, encryption ${master ? "on" : "off"})`);
});
