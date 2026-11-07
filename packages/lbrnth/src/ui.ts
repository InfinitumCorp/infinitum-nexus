import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Public shell only. All private data is fetched through the host's CID-authenticated API. */
export async function serveNodeLabyrinthUI(req: IncomingMessage, res: ServerResponse, product: "spectre" | "cumulus-mail" = "spectre"): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const assets: Record<string, [string, string]> = {
    "/labyrinth": ["index.html", "text/html; charset=utf-8"],
    "/labyrinth/": ["index.html", "text/html; charset=utf-8"],
    "/labyrinth/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/labyrinth/assets/style.css": ["style.css", "text/css; charset=utf-8"],
  };
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
  const asset = assets[path];
  if (!asset) { res.writeHead(404); res.end(); return; }
  try {
    let bytes = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
    if (asset[0] === "index.html") bytes = Buffer.from(bytes.toString("utf8").replace('data-product="spectre"', `data-product="${product}"`));
    res.writeHead(200, { "content-type": asset[1], "content-length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(500); res.end("Labyrinth UI unavailable"); }
}
