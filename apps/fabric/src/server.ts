/**
 * FABRIC++ server.
 * Run: node --experimental-strip-types src/server.ts
 *
 * FABRIC_JWT_ISSUER     default https://id.cumuluscloud.app/realms/cumulus
 * FABRIC_OIDC_CLIENT_ID default fabric
 * FABRIC_PUBLIC_ORIGIN  exact browser origin. Loopback is used when unset.
 * FABRIC_DATA_DIR       SQLite database and generated master key. Default ./data
 * FABRIC_MASTER_KEY     base64 32-byte key. Generated into the data dir when unset.
 * PORT                  default 3020
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createHandler } from "./http.ts";
import { FabricService } from "./service.ts";
import { FabricStore } from "./store.ts";
import { TeamHub } from "./team-http.ts";
import { TeamService } from "./team.ts";

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const masterKey = loadMasterKey(config.dataDir);
const store = new FabricStore(config.databasePath);
const service = new FabricService(store, masterKey);
const hub = new TeamHub();
const team = new TeamService(store, masterKey, { publish: hub.publish });
hub.watch((sub, delta) => team.setConnected(sub, delta));
const ticker = setInterval(() => {
  try {
    team.tick();
  } catch (error) {
    console.warn(`team tick failed: ${error instanceof Error ? error.message : "error"}`);
  }
}, 5_000);
ticker.unref();
let origin = config.publicOrigin;

const server = createServer(createHandler({
  config,
  origin: () => {
    if (!origin) throw new Error("FABRIC++ is not listening yet");
    return origin;
  },
  store,
  service,
  team,
  hub,
  publicDir: join(import.meta.dirname, "..", "public"),
}));

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : config.port;
  if (!origin) origin = `http://127.0.0.1:${port}`;
  if (config.bind !== "127.0.0.1" && config.bind !== "localhost" && origin.startsWith("http://127.0.0.1")) {
    console.warn("FABRIC_PUBLIC_ORIGIN is a loopback URL while the server binds a network interface. Set FABRIC_PUBLIC_ORIGIN to the public https origin.");
  }
  console.log(`FABRIC++ listening on ${origin}`);
});

function shutdown(): void {
  clearInterval(ticker);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function loadMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.FABRIC_MASTER_KEY?.trim();
  if (fromEnv) return decodeKey(fromEnv, "FABRIC_MASTER_KEY");
  const file = join(dataDir, "master.key");
  if (existsSync(file)) return decodeKey(readFileSync(file, "utf8").trim(), "master.key");
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Some volumes ignore mode bits. The key stays in the data directory.
  }
  console.log(`FABRIC++ generated a master key at ${file}`);
  return key;
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
}
