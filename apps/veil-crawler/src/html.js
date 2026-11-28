/**
 * Reads what VEILBot needs from an HTML page: title, description, language, visible text,
 * robots directives, canonical URL, links, and how many known trackers the page loads.
 * Plain string work (no DOM), so it runs the same in Workers and in tests.
 */
import { isBlockedHost } from "../../veil/lib/blocklist.js";

export const MAX_TEXT = 4000;
export const MAX_LINKS = 60;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decode(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s) => decode(s).replace(/\s+/g, " ").trim();

/** Attributes of one tag, lower-cased names. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp("<" + name + "\\b[^>]*>", "gi"))].map((m) => attrs(m[0].slice(name.length + 1, -1)));
}

export function extract(html, pageUrl) {
  const src = String(html ?? "");
  const head = (src.match(/<head\b[\s\S]*?<\/head>/i) || [src.slice(0, 20000)])[0];
  const metas = tags(head, "meta");
  const meta = (name) => metas.find((m) => (m.name || m.property || "").toLowerCase() === name)?.content;

  const robotsMeta = metas
    .filter((m) => ["robots", "veilbot"].includes((m.name || "").toLowerCase()))
    .map((m) => (m.content || "").toLowerCase())
    .join(",");

  let base = pageUrl;
  const baseTag = tags(head, "base")[0];
  if (baseTag?.href) { try { base = new URL(baseTag.href, pageUrl).toString(); } catch { /* keep page URL */ } }

  const canonicalTag = tags(head, "link").find((l) => (l.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  let canonical = null;
  if (canonicalTag?.href) { try { canonical = new URL(canonicalTag.href, base).toString(); } catch { /* ignore */ } }

  // Trackers: third-party scripts, frames and pixels from hosts on VEIL's blocklist.
  const pageHost = new URL(pageUrl).hostname;
  const trackerHosts = new Set();
  for (const [name, attr] of [["script", "src"], ["iframe", "src"], ["img", "src"]]) {
    for (const t of tags(src, name)) {
      try {
        const h = new URL(t[attr], base).hostname;
        if (h !== pageHost && isBlockedHost(h)) trackerHosts.add(h);
      } catch { /* not a URL */ }
    }
  }

  const body = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|head|nav|footer|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const links = [];
  const seen = new Set();
  for (const m of body.matchAll(/<a\b([^>]*)>/gi)) {
    const a = attrs(m[1]);
    if (!a.href || seen.has(a.href)) continue;
    seen.add(a.href);
    links.push({ href: a.href, nofollow: /\bnofollow\b/i.test(a.rel || "") });
    if (links.length >= MAX_LINKS) break;
  }

  const text = squash(body.replace(/<[^>]+>/g, " ")).slice(0, MAX_TEXT);
  const lang = (src.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,12})/i) || [])[1]?.toLowerCase() ?? null;

  return {
    title: squash((head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || meta("og:title") || "").slice(0, 300),
    description: squash(meta("description") || meta("og:description") || "").slice(0, 500),
    lang,
    text,
    noindex: /\b(noindex|none)\b/.test(robotsMeta),
    nofollow: /\b(nofollow|none)\b/.test(robotsMeta),
    canonical,
    base,
    links,
    trackers: trackerHosts.size,
  };
}

/** X-Robots-Tag header: applies to all bots, or to VEILBot when prefixed "veilbot:". */
export function headerRobots(value) {
  const v = String(value ?? "").toLowerCase();
  const mine = v.split(",").map((s) => s.trim()).filter((s) => !/^[a-z0-9_-]+\s*:/.test(s) || s.startsWith("veilbot:")).join(",");
  return { noindex: /\b(noindex|none)\b/.test(mine), nofollow: /\b(nofollow|none)\b/.test(mine) };
}
