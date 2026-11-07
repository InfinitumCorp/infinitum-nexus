import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VeilControl } from "./control.ts";
import { veilHttp } from "./http.ts";

function unavailable(res: ServerResponse) {
  if (res.headersSent) return;
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
  res.end('{"error":"unavailable","deviceWide":false}');
}

/**
 * Mount on the Cumulus ID host so the existing `spctr_session` cookie is presented.
 * `origin` is operator configuration, never taken from Host or forwarded headers.
 */
export async function serveNodeVeil(
  req: IncomingMessage,
  res: ServerResponse,
  control: VeilControl | undefined,
  origin: string | undefined,
): Promise<void> {
  if (!control || !origin) return unavailable(res);
  let url: URL;
  try {
    const base = new URL(origin);
    const local = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.protocol !== "https:" && !local) return unavailable(res);
    url = new URL(req.url ?? "/", base);
    if (url.origin !== base.origin) return unavailable(res);
  } catch {
    return unavailable(res);
  }
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const init: RequestInit & { duplex?: "half" } = { method: req.method ?? "GET", headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const response = await veilHttp(control)(new Request(url, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    unavailable(res);
  }
}
