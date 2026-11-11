// +SPCTR mirror for networks that freeze connections to Cloudflare and AWS after ~16 KB (Russian ISPs).
// Runs on Google Cloud Run (europe-north1), which those networks leave alone, and streams every
// request to the real site. Deploy: gcloud run deploy spctr-mirror --source apps/spectre/mirror
// --region europe-north1 --allow-unauthenticated
import { createServer } from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = process.env.UPSTREAM ?? "https://id.cumuluscloud.app";
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-authenticate", "host", "content-length", "content-encoding"]);

createServer(async (req, res) => {
  try {
    const self = `https://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-forwarded") && v !== undefined) headers[k] = v;
    if (headers.origin === self) headers.origin = UPSTREAM;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body, duplex: "half", redirect: "manual" });
    const out = {};
    up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "set-cookie") out[k] = v; });
    if (out.location?.startsWith(UPSTREAM)) out.location = self + out.location.slice(UPSTREAM.length);
    const cookies = up.headers.getSetCookie?.() ?? [];
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(up.status, out);
    if (up.body && req.method !== "HEAD") Readable.fromWeb(up.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" }).end("Upstream unavailable");
  }
}).listen(Number(process.env.PORT ?? 8080));
