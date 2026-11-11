import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { serveLabyrinthHost } from "@infinitum/lbrnth";
import type { LabyrinthHost } from "@infinitum/lbrnth";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * The Cloud Run service. Only three paths exist:
 *   POST /api/labyrinth   the authoritative Labyrinth API (bearer only, no cookies, no CORS)
 *   GET  /healthz         liveness; says whether the API is configured, never why not
 *   everything else       404
 * Product relays (ARCHITECT, Cumulus ID, Mail) call it server to server, so no browser
 * origin is ever allowed.
 */
export function labyrinthHostServer(host: LabyrinthHost | undefined): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const path = (req.url ?? "/").split("?")[0];
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return send(200, { ok: true, configured: Boolean(host) });
    if (path === "/api/labyrinth") {
      serveLabyrinthHost(req, res, host).catch(err => {
        console.error("Labyrinth host: request failed", err instanceof Error ? err.message : err);
        if (!res.headersSent) send(500, { error: "Labyrinth unavailable" });
        else res.end();
      });
      return;
    }
    send(404, { error: "Not found" });
  });
}
