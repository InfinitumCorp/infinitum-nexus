/**
 * CNDCTR (Conductor) server.
 *
 * CNDCTR_JWT_ISSUER       default https://id.cumuluscloud.app/realms/cumulus
 * CNDCTR_OIDC_CLIENT_ID   audience, default cndctr
 * CNDCTR_JWKS_URI         default {issuer}/protocol/openid-connect/certs
 * CNDCTR_PUBLIC_ORIGIN    exact browser origin. Loopback is used when unset.
 *                          Production: https://cndctr.app
 * CNDCTR_BIND             default 127.0.0.1. Containers set 0.0.0.0.
 * PORT                    default 3011
 *
 * /health is public. /api/perform requires a Cumulus ID JWT or a browser session.
 * Production: pnpm build && pnpm start
 * Local source: pnpm dev
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, MemoryStore } from "@infinitum/firmament";
import { registerDefaultInstruments } from "@infinitum/architect/perform";
import { loadConfig } from "./config.ts";
import { createHandler } from "./http.ts";
import { loadGeoRouting } from "./geo-config.ts";

loadGeoRouting(process.env.DATA_DIR ?? "data");

const config = loadConfig(process.env);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(moduleDir, "..", "public");
const ledger = new Ledger(new MemoryStore());
let origin = config.publicOrigin;

registerDefaultInstruments();

const server = createServer(createHandler({
  config,
  origin: () => {
    if (!origin) throw new Error("CNDCTR is not listening yet");
    return origin;
  },
  ledger,
  publicDir,
}));

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : config.port;
  if (!origin) origin = `http://127.0.0.1:${port}`;
  if (config.bind !== "127.0.0.1" && config.bind !== "localhost" && origin.startsWith("http://127.0.0.1")) {
    console.warn("CNDCTR_PUBLIC_ORIGIN is a loopback URL while the server binds a network interface. Set CNDCTR_PUBLIC_ORIGIN to https://cndctr.app.");
  }
  console.log(`CNDCTR listening on ${origin}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
