// downloads.cumuluscloud.app: the page comes from static assets; /files/* streams installers from R2.

const TYPES = {
  exe: "application/vnd.microsoft.portable-executable",
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  AppImage: "application/vnd.appimage",
  deb: "application/vnd.debian.binary-package",
  apk: "application/vnd.android.package-archive",
  json: "application/json; charset=utf-8",
};

export const fileName = (pathname) => {
  const m = /^\/files\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(pathname);
  return m && !m[1].includes("..") ? m[1] : null;
};

const encoder = new TextEncoder();
async function authorized(request, env) {
  if (!env.UPLOAD_TOKEN) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [a, b] = await Promise.all([given, env.UPLOAD_TOKEN].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Publishing (publish.mjs), in parts so big installers survive a shaky connection:
 *   POST /upload/<name>?action=create                 -> { uploadId }
 *   PUT  /upload/<name>?uploadId=..&part=N  (body)    -> { partNumber, etag }
 *   POST /upload/<name>?action=complete&uploadId=..   body { parts: [...] }
 *   PUT  /upload/<name>?action=simple       (body)    small files such as manifest.json
 * Needs the UPLOAD_TOKEN secret; without it the endpoint doesn't exist.
 */
async function upload(request, env, name, url) {
  if (!(await authorized(request, env))) return new Response("Not found", { status: 404 });
  const action = url.searchParams.get("action");
  const json = (v) => Response.json(v);
  const type = TYPES[name.split(".").pop()] || "application/octet-stream";
  if (request.method === "PUT" && action === "simple") {
    await env.DOWNLOADS.put(name, request.body, { httpMetadata: { contentType: type } });
    return json({ ok: true });
  }
  if (request.method === "POST" && action === "create") {
    const mp = await env.DOWNLOADS.createMultipartUpload(name, { httpMetadata: { contentType: type } });
    return json({ uploadId: mp.uploadId });
  }
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return new Response("Missing uploadId", { status: 400 });
  const mp = env.DOWNLOADS.resumeMultipartUpload(name, uploadId);
  if (request.method === "PUT") {
    const part = Number(url.searchParams.get("part"));
    if (!Number.isInteger(part) || part < 1 || part > 10000) return new Response("Bad part", { status: 400 });
    return json(await mp.uploadPart(part, request.body));
  }
  if (request.method === "POST" && action === "complete") {
    const { parts } = await request.json();
    const obj = await mp.complete(parts);
    return json({ ok: true, size: obj.size });
  }
  if (request.method === "DELETE") { await mp.abort(); return json({ ok: true }); }
  return new Response("Bad request", { status: 400 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const up = /^\/upload\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(url.pathname);
    if (up && !up[1].includes("..")) return upload(request, env, up[1], url);
    // Stable links (/get/windows, /get/android, ...) point at the current version of each installer.
    const get = /^\/get\/([a-z0-9-]{1,40})$/.exec(url.pathname);
    if (get) {
      const manifest = await env.DOWNLOADS.get("manifest.json").then((o) => (o ? o.json() : null)).catch(() => null);
      const file = manifest?.files?.find((f) => f.key === get[1]);
      // Relative, so it works both here and under mail.cumuluscloud.app/download/.
      return file
        ? new Response(null, { status: 302, headers: { location: `../files/${encodeURIComponent(file.name)}`, "cache-control": "no-cache" } })
        : new Response("That download isn't available yet.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (!url.pathname.startsWith("/files/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const name = fileName(url.pathname);
    if (!name) return new Response("Not found", { status: 404 });

    const isManifest = name === "manifest.json";
    const obj = request.method === "HEAD"
      ? await env.DOWNLOADS.head(name)
      : await env.DOWNLOADS.get(name, { range: request.headers, onlyIf: request.headers });
    if (!obj) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    const ext = name.split(".").pop();
    headers.set("content-type", TYPES[ext] || "application/octet-stream");
    headers.set("etag", obj.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("x-content-type-options", "nosniff");
    headers.set("access-control-allow-origin", "*");
    if (isManifest) {
      headers.set("cache-control", "no-cache");
    } else {
      // Installer names carry their version, so a name's bytes never change.
      headers.set("cache-control", "public, max-age=86400");
      headers.set("content-disposition", `attachment; filename="${name}"`);
    }

    if (request.method === "HEAD") {
      headers.set("content-length", String(obj.size));
      return new Response(null, { headers });
    }
    if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers }); // onlyIf failed: not modified
    if (obj.range && request.headers.has("range")) {
      const { offset = 0, length = obj.size - offset } = obj.range;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      headers.set("content-length", String(length));
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set("content-length", String(obj.size));
    return new Response(obj.body, { headers });
  },
};
