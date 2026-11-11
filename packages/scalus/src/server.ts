/**
 * SCALVS.ai runtime.
 *
 *   PORT              listen port, default 3020. 0 lets the operating system choose.
 *   SCALVS_ORIGIN     public origin, default https://scalvs.app
 *   SCALVS_AUDIENCE   Cumulus ID token audience, default scalvs
 *   OMNIROUTE_BASE_URL or OMNIROUTE_API_KEY enables POST /v1/llm/run.
 *   The request body cannot choose the model host. See packages/ai.
 *
 *   Every route except GET /health requires Authorization: Bearer <Cumulus ID JWT>.
 *   The token issuer is https://id.cumuluscloud.app/realms/cumulus. Signing keys
 *   are discovered from that issuer.
 *
 *   pnpm --filter @infinitum/scalus start
 *   pnpm --filter @infinitum/scalus build && node packages/scalus/dist/server.js
 */
import { loadConfig } from "./config.ts";
import { createScalvsServer } from "./http.ts";

function readConfig() {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : "invalid configuration");
    process.exit(1);
  }
}

const config = readConfig();
const server = createScalvsServer({
  origin: config.origin,
  audience: config.audience,
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

server.on("error", (err: unknown) => {
  console.error(err instanceof Error ? err.message : "server error");
  process.exit(1);
});

server.listen(config.port, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(JSON.stringify({ event: "listening", service: "scalvs", origin: config.origin, port }));
});

function shutdown() {
  server.closeIdleConnections();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
