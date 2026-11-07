import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CidLabyrinth } from "@infinitum/lbrnth";
import { droneBackend } from "./backend.ts";

/** Explicit bearer only. origin is operator configuration, never derived from Host/forwarded headers. */
export async function serveNodeDroneBackend(req: IncomingMessage, res: ServerResponse, auth: CidLabyrinth | undefined, origin: string | undefined): Promise<void> {
  const unavailable = () => {res.writeHead(503, {"content-type":"application/json", "cache-control":"no-store"}); res.end('{"error":"unavailable"}');};
  if (!auth || !origin) return unavailable();
  let url: URL;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) return unavailable();
    url = new URL(req.url ?? "/", base);
    if (url.origin !== base.origin) return unavailable();
  } catch { return unavailable(); }
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const init: RequestInit & {duplex:"half"} = {method:req.method ?? "GET", headers, duplex:"half"};
    if (req.method !== "GET" && req.method !== "HEAD") init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    const response = await droneBackend(auth)(new Request(url, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { return unavailable(); }
}
