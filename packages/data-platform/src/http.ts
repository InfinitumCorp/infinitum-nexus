// © Infinitum Corporation®. All rights reserved.
/**
 * HTTP surface:
 *
 *   POST /v1/events                  signed product ingestion (see signing.ts)
 *   POST /api/v1/collect/events      same, with the Conjure EventEnvelope (see conjure.ts)
 *   GET  /v1/objects/:type/:id       one ontology object, if the viewer may read it
 *   GET  /v1/search?q=&type=         authorized ontology search
 *   GET  /v1/catalog                 dataset catalog (owners, lineage, quality)
 *   GET  /healthz
 *
 * Read routes need a viewer. `resolveViewer` must verify a Cumulus ID session and map it
 * to (tenant, pseudonymous subject); this module never trusts viewer claims in headers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Platform } from "./index.ts";
import { OBJECT_TYPES, type ObjectType, type Viewer } from "./ontology.ts";
import { fromConjureEnvelope, toConjureResponse, type ConjureRegion } from "./conjure.ts";

export interface HttpOptions {
  resolveViewer: (req: IncomingMessage) => Promise<Viewer | null>;
  maxBodyBytes?: number;
  /** Region this deployment stores (Conjure route). Defaults to US. */
  region?: ConjureRegion;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createHttpHandler(p: Platform, o: HttpOptions) {
  const limit = o.maxBodyBytes ?? 1_000_000;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/api/v1/collect/events") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const body = await readBody(req, limit);
        if (body === null) return send(res, 413, { error: "body too large" });
        const region = o.region ?? "US";
        const r = await p.gateway.ingest(req.headers, body, (raw) => fromConjureEnvelope(raw, region));
        return send(res, r.status, r.error ? { error: r.error } : toConjureResponse(r));
      }
      if (url.pathname === "/v1/events") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const body = await readBody(req, limit);
        if (body === null) return send(res, 413, { error: "body too large" });
        const r = await p.gateway.ingest(req.headers, body);
        return send(res, r.status, r);
      }
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      const viewer = await o.resolveViewer(req);
      if (!viewer) return send(res, 401, { error: "sign in with Cumulus ID" });
      const m = /^\/v1\/objects\/([A-Za-z]+)\/([A-Za-z0-9_.:-]{1,128})$/.exec(url.pathname);
      if (m) {
        const type = m[1] as ObjectType;
        if (!OBJECT_TYPES.includes(type)) return send(res, 404, { error: "not found" });
        const obj = p.ontology.get(viewer, type, m[2]);
        // 404, not 403: do not reveal that an object exists to someone who may not read it.
        if (!obj) return send(res, 404, { error: "not found" });
        return send(res, 200, { object: obj, links: p.ontology.linksOf(viewer, type, m[2]) });
      }
      if (url.pathname === "/v1/search") {
        const q = (url.searchParams.get("q") ?? "").slice(0, 200);
        const t = url.searchParams.get("type");
        if (t && !OBJECT_TYPES.includes(t as ObjectType)) return send(res, 400, { error: "unknown type" });
        return send(res, 200, { results: p.ontology.search(viewer, q, t ? { type: t as ObjectType } : {}) });
      }
      if (url.pathname === "/v1/catalog") {
        return send(res, 200, { datasets: p.catalog.list().map((d) => ({ ...d, lineage: p.catalog.lineage(d.id) })) });
      }
      return send(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  };
}

export function createHttpServer(p: Platform, o: HttpOptions): Server {
  return createServer(createHttpHandler(p, o));
}
