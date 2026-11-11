import type { IncomingMessage, ServerResponse } from "node:http";
import { labyrinthProduct, proxyLabyrinthRequest } from "@infinitum/lbrnth-client";

export interface LabyrinthProxyOptions {
  /**
   * ONLY on the authoritative Cumulus://ID host, whose own session cookie is a token of the
   * same CID store the Labyrinth service checks: forward that cookie's token as the bearer
   * when the request carries no Authorization header. An invalid explicit header never falls
   * back. Other relays must leave this unset.
   */
  cookieToken?: string;
  /** Keep a valid `product` from the request body instead of pinning `product` (authoritative CID host only). */
  productFromBody?: boolean;
}

/** Explicit user-selected artifact transport only; never auto-exports product records. */
export async function serveNodeLabyrinthProxy(req: IncomingMessage, res: ServerResponse, endpoint: string | undefined, product: string, options: LabyrinthProxyOptions = {}): Promise<void> {
  const fail = (status: number) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "Labyrinth request denied or not configured" })); };
  if (!endpoint) return fail(503);
  if (req.method !== "POST") return fail(405);
  const explicit = req.headers.authorization;
  const authorization = explicit !== undefined ? explicit : options.cookieToken ? `Bearer ${options.cookieToken}` : undefined;
  if (!authorization || !/^Bearer [^\s]{1,512}$/.test(authorization)) return fail(401);
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += Buffer.byteLength(chunk); if (length > 2 * 1024 * 1024) return fail(413); chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks).toString("utf8");
  let pinned = product;
  if (options.productFromBody) {
    try {
      const requested = (JSON.parse(body) as { product?: unknown }).product;
      if (typeof requested === "string") pinned = labyrinthProduct(requested);
    } catch { /* malformed JSON or unknown product: keep the pinned product; the relay rejects bad JSON */ }
  }
  const headers = new Headers({ authorization });
  for (const key of ["content-type", "x-labyrinth"]) { const value = req.headers[key]; if (typeof value === "string") headers.set(key, value); }
  const response = await proxyLabyrinthRequest(new Request("https://product.invalid/api/labyrinth", { method: "POST", headers, body }), endpoint, pinned);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
}
