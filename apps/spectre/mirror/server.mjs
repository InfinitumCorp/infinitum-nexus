// +SPCTR mirror for networks that freeze connections to Cloudflare and AWS after ~16 KB (Russian ISPs).
// Runs on Google Cloud Run (europe-north1), which those networks leave alone, and streams every
// request to the real site. Deploy: gcloud run deploy spctr-mirror --source apps/spectre/mirror
// --region europe-north1 --allow-unauthenticated
//
// COOKIE_JAR=1 is for running behind Firebase Hosting (service `cumulus-id-ru`, see README.md).
// Firebase Hosting forwards only one cookie, `__session`, so the mirror packs Cumulus ID's cookies
// (spctr_session, the OAuth/OIDC state and the return address) into it on the way out and unpacks
// them on the way in. Without it, cookies pass through unchanged.
import { createServer } from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = process.env.UPSTREAM ?? "https://id.cumuluscloud.app";
const COOKIE_JAR = process.env.COOKIE_JAR === "1";
const JAR = "__session";
const JAR_MAX_AGE = 30 * 86400;
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-authenticate", "host", "content-length", "content-encoding"]);

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function unpackJar(value) {
  if (!value) return {};
  try {
    const jar = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return jar && typeof jar === "object" && !Array.isArray(jar) ? jar : {};
  } catch {
    return {};
  }
}

export const packJar = (jar) => Buffer.from(JSON.stringify(jar), "utf8").toString("base64url");

/** Applies upstream Set-Cookie headers to the jar: Max-Age<=0, a past Expires or an empty value removes. */
export function applySetCookies(jar, setCookies, now = Date.now()) {
  const next = { ...jar };
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const gone = attrs.some((a) => {
      const [k, v = ""] = a.split("=").map((s) => s.trim());
      if (/^max-age$/i.test(k)) return Number(v) <= 0;
      if (/^expires$/i.test(k)) return Date.parse(v) < now;
      return false;
    });
    if (gone || value === "") delete next[name];
    else next[name] = value;
  }
  return next;
}

/** Cookie header for upstream: the jar's cookies win over loose ones; the jar itself is not sent. */
export function upstreamCookie(header) {
  const cookies = parseCookies(header);
  const jar = unpackJar(cookies[JAR]);
  delete cookies[JAR];
  return { jar, header: Object.entries({ ...cookies, ...jar }).map(([k, v]) => `${k}=${v}`).join("; ") };
}

export function jarSetCookie(jar) {
  return Object.keys(jar).length
    ? `${JAR}=${packJar(jar)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${JAR_MAX_AGE}`
    : `${JAR}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function createHandler({ upstream = UPSTREAM, cookieJar = COOKIE_JAR } = {}) {
  return async (req, res) => {
    try {
      if (req.url === "/__mirror/health") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end("ok");
      }
      const self = `https://${String(req.headers["x-forwarded-host"] ?? req.headers.host).split(",")[0].trim()}`;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-forwarded") && v !== undefined) headers[k] = v;
      let jar = {};
      if (cookieJar) {
        const c = upstreamCookie(req.headers.cookie);
        jar = c.jar;
        if (c.header) headers.cookie = c.header;
        else delete headers.cookie;
      }
      if (headers.origin === self) headers.origin = upstream;
      headers["x-spctr-mirror"] = self; // so sign-in with Google returns here, not to the throttled host
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
      const up = await fetch(upstream + req.url, { method: req.method, headers, body, duplex: "half", redirect: "manual" });
      const out = {};
      up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "set-cookie") out[k] = v; });
      if (out.location?.startsWith(upstream)) out.location = self + out.location.slice(upstream.length);
      const cookies = up.headers.getSetCookie?.() ?? [];
      if (cookies.length) {
        if (cookieJar) {
          out["set-cookie"] = jarSetCookie(applySetCookies(jar, cookies));
          out["cache-control"] = "private, no-store"; // never let the CDN keep a response that sets a cookie
        } else out["set-cookie"] = cookies;
      }
      res.writeHead(up.status, out);
      if (up.body && req.method !== "HEAD") Readable.fromWeb(up.body).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Upstream unavailable");
    }
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  createServer(createHandler()).listen(Number(process.env.PORT ?? 8080));
}
