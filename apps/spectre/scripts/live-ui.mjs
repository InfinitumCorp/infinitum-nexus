/**
 * Inventory of the public files https://id.cumuluscloud.app serves today.
 * References are taken from the documents themselves. A path that is not referenced and is not
 * a file in public/ is not invented. A referenced path that is not HTTP 200 fails the inventory.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Where the pages were captured (and where references resolve). */
export const LIVE_ORIGIN = "https://id.cumuluscloud.app";

/**
 * Where this Worker serves them now. At the Cumulus://ID cut-over id.cumuluscloud.app moved to the new issuer
 * (InfinitumCorp/cumulus-id) and these pages moved with +SPCTR to its own host.
 */
export const SERVED_ORIGIN = "https://spectre.infinitumcorporation.ai";

const ASSET = /\.(?:html|css|js|mjs|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json|webmanifest|txt|map)$/i;

export function repoPublicPaths(publicDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push("/" + relative(publicDir, p).split("\\").join("/"));
    }
  };
  walk(publicDir);
  return out.sort();
}

/** Drop comments so an example path in a file header is not treated as a file the page loads. */
export function stripComments(text, kind) {
  if (!/javascript|\.m?js$/.test(kind)) return text;
  let out = "";
  let i = 0;
  let mode = "code";
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (mode === "code" && two === "/*") { mode = "block"; i += 2; continue; }
    if (mode === "block" && two === "*/") { mode = "code"; i += 2; continue; }
    if (mode === "code" && two === "//") { mode = "line"; i += 2; continue; }
    if (mode === "line" && (text[i] === "\n" || text[i] === "\r")) { mode = "code"; out += text[i]; i++; continue; }
    if (mode === "code" && (text[i] === '"' || text[i] === "'" || text[i] === "`")) {
      const quote = text[i];
      out += quote;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { out += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (mode === "code") out += text[i];
    i++;
  }
  return out;
}

/** Same-origin asset paths named by this document, plus dynamic path prefixes that are not /api/. */
export function extractAssetRefs(filePath, text, contentType = "") {
  const refs = new Set();
  const dynamic = new Set();
  const add = (raw) => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("#") || raw.startsWith("mailto:")) return;
    let url;
    try { url = new URL(raw, LIVE_ORIGIN + (filePath.startsWith("/") ? filePath : `/${filePath}`)); }
    catch { return; }
    if (url.origin !== LIVE_ORIGIN) return;
    if (url.pathname.startsWith("/api/")) return;
    if (url.pathname.includes("${")) return;
    refs.add(url.pathname);
  };
  const kind = `${contentType} ${filePath}`;
  text = stripComments(text, kind);
  if (/html|^\/$/.test(kind)) {
    for (const match of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
    for (const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of match[1].split(",")) add(part.trim().split(/\s+/)[0]);
    }
  }
  if (/css/.test(kind)) {
    for (const match of text.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)) add(match[1]);
    for (const match of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(match[1]);
  }
  if (/javascript|\.m?js$/.test(kind)) {
    for (const match of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) add(match[1]);
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1]);
    for (const match of text.matchAll(/["'](\/[^"'?#]+\.(?:html|css|js|mjs|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json|webmanifest|txt|map))["']/g)) add(match[1]);
    for (const match of text.matchAll(/["'`](\/(?!api\/)[^"'`\n]*\$\{)/g)) dynamic.add(match[1]);
  }
  return { refs: [...refs].filter((path) => path === "/" || ASSET.test(path)).sort(), dynamic: [...dynamic].sort() };
}

async function getBytes(origin, path) {
  const response = await fetch(origin + path, { redirect: "manual" });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type") || "",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

/**
 * @param {string} origin
 * @param {string[]} seeds paths to request. Referenced assets are followed. Non-200 seeds are excluded.
 */
export async function collectLiveUi(origin, seeds) {
  const files = new Map();
  const excluded = [];
  const queue = [...new Set(seeds)];
  const queued = new Set(queue);
  while (queue.length) {
    const path = queue.shift();
    if (files.has(path)) continue;
    const hit = await getBytes(origin, path);
    if (hit.status !== 200 || hit.location) {
      excluded.push({ path, status: hit.status, location: hit.location });
      continue;
    }
    const storeAs = path === "/" ? "/index.html" : path;
    const found = extractAssetRefs(storeAs, hit.body.toString("utf8"), hit.contentType);
    if (found.dynamic.length) {
      throw new Error(`Unresolved dynamic public path in ${path}: ${found.dynamic.join(", ")}`);
    }
    files.set(storeAs, {
      path: storeAs,
      urlPath: path === "/" ? "/" : path,
      sha256: hit.sha256,
      bytes: hit.body.length,
      contentType: hit.contentType.split(";")[0].trim(),
      body: hit.body,
      refs: found.refs,
    });
    for (const ref of found.refs) {
      const key = ref === "/" ? "/index.html" : ref;
      if (!files.has(key) && !queued.has(ref)) {
        queued.add(ref);
        queue.push(ref);
      }
    }
  }
  for (const file of files.values()) {
    for (const ref of file.refs) {
      const key = ref === "/" ? "/index.html" : ref;
      if (!files.has(key)) throw new Error(`${file.path} references ${ref}, which was not retrieved`);
    }
  }
  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
