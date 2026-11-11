// Cumulus://Mail Russian mirror: a pass-through to the Mail Worker, run on Cloud Run behind
// Firebase Hosting. Russian networks throttle Cloudflare's free-plan addresses and AWS, but not
// Firebase Hosting's CDN, so phones in Russia reach Mail through
//   phone -> Firebase Hosting (CDN) -> this service -> https://mail.cumuluscloud.app
//
// Firebase Hosting forwards only one cookie, `__session`, so this service packs Mail's cookies
// (cmail_session, cmail_oauth) into it on the way out and unpacks them on the way in.
// No dependencies; Node 22+.
import { createServer } from "node:http";

const UPSTREAM = (process.env.UPSTREAM || "https://mail.cumuluscloud.app").replace(/\/$/, "");
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
const JAR = "__session";
const JAR_MAX_AGE = 30 * 86400;
// Hop-by-hop or rewritten headers that must not be copied as they are.
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "cookie", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-cloud-trace-context", "traceparent", "x-appengine-country"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie", "alt-svc", "nel", "report-to", "server", "cf-ray", "cf-cache-status"]);

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
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

/** Applies upstream Set-Cookie headers to the jar: a cookie with Max-Age<=0 or a past Expires is removed. */
export function applySetCookies(jar, setCookies) {
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
      if (/^expires$/i.test(k)) return Date.parse(v) < Date.now();
      return false;
    });
    if (gone || value === "") delete next[name];
    else next[name] = value;
  }
  return next;
}

/** Points absolute redirects at the mirror, so the browser stays on it. */
export function rewriteLocation(location, publicOrigin) {
  if (!location || !publicOrigin) return location;
  return location.startsWith(UPSTREAM) ? publicOrigin + location.slice(UPSTREAM.length) : location;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export async function handle(req, res) {
  const publicOrigin = PUBLIC_ORIGIN || (req.headers["x-forwarded-host"] ? `https://${String(req.headers["x-forwarded-host"]).split(",")[0].trim()}` : "");
  if (req.url === "/__mirror/health") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    return res.end("ok");
  }
  const cookies = parseCookies(req.headers.cookie);
  const jar = unpackJar(cookies[JAR]);
  delete cookies[JAR];
  const forwardCookies = { ...cookies, ...jar };

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  const cookieHeader = Object.entries(forwardCookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookieHeader) headers.cookie = cookieHeader;
  if (req.headers["x-forwarded-for"]) headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: await readBody(req), redirect: "manual" });
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    return res.end("Mail is unreachable from the mirror right now. Try again shortly.");
  }

  const out = {};
  upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out[k] = v; });
  if (out.location) out.location = rewriteLocation(out.location, publicOrigin);
  const setCookies = upstream.headers.getSetCookie();
  if (setCookies.length) {
    const nextJar = applySetCookies(jar, setCookies);
    out["set-cookie"] = Object.keys(nextJar).length
      ? `${JAR}=${packJar(nextJar)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${JAR_MAX_AGE}`
      : `${JAR}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    // A response that sets a cookie must never be stored by the CDN.
    out["cache-control"] = "private, no-store";
  }
  const body = req.method === "HEAD" ? null : Buffer.from(await upstream.arrayBuffer());
  if (body) out["content-length"] = String(body.length);
  res.writeHead(upstream.status, out);
  res.end(body ?? undefined);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const port = Number(process.env.PORT || 8080);
  createServer((req, res) => handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("mirror error");
  })).listen(port, () => console.log(`mail mirror on :${port} -> ${UPSTREAM}`));
}
