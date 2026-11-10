/**
 * VEIL search sources beyond Brave: Yandex (Yandex Cloud Search API) and Mojeek (Mojeek
 * Search API). Both are official, paid APIs with their own keys, set as Worker secrets.
 * VEIL asks every source that has a key at the same time and blends the answers.
 */
import { MAX_OFFSET, PAGE_SIZE, decodeEntities, text, webUrl } from "./search.js";

// ---------------- Yandex ----------------

export const YANDEX_API = "https://searchapi.api.cloud.yandex.net/v2/web/search";

/** Russian-language queries search Yandex's Russian index; everything else its international one. */
export function yandexBody(q, offset, folderId) {
  const ru = /[Ѐ-ӿ]/.test(q);
  return {
    query: { searchType: ru ? "SEARCH_TYPE_RU" : "SEARCH_TYPE_COM", queryText: q, page: String(offset), familyMode: "FAMILY_MODE_MODERATE" },
    groupSpec: { groupMode: "GROUP_MODE_DEEP", groupsOnPage: String(PAGE_SIZE), docsInGroup: "1" },
    maxPassages: "2",
    l10n: ru ? "LOCALIZATION_RU" : "LOCALIZATION_EN",
    folderId,
    responseFormat: "FORMAT_XML",
  };
}

function tag(xml, name) {
  const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">"));
  return m ? m[1] : "";
}

/** Base64 rawData (UTF-8 XML) to a string. */
export function decodeRaw(raw) {
  const bin = atob(String(raw ?? ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** VEIL results from Yandex's XML answer. */
export function fromYandexXml(xml, offset) {
  const results = [];
  for (const m of xml.matchAll(/<doc(?:\s[^>]*)?>([\s\S]*?)<\/doc>/g)) {
    const doc = m[1];
    const url = webUrl(decodeEntities(tag(doc, "url").trim()));
    const title = text(tag(doc, "title"));
    if (!url || !title || results.some((r) => r.url === url)) continue;
    const passages = [...doc.matchAll(/<passage(?:\s[^>]*)?>([\s\S]*?)<\/passage>/g)].map((p) => text(p[1]));
    results.push({ title, url, snippet: text(tag(doc, "headline")) || passages.join(" … ") });
  }
  const found = Number(tag(xml, "found-docs") || tag(xml, "found")) || 0;
  const more = results.length > 0 && offset < MAX_OFFSET && found > (offset + 1) * PAGE_SIZE;
  return { results, next: more ? { offset: offset + 1 } : null };
}

// ---------------- Mojeek ----------------

export const MOJEEK_API = "https://api.mojeek.com/search";

export function mojeekUrl(q, offset, key) {
  const u = new URL(MOJEEK_API);
  u.searchParams.set("q", q);
  u.searchParams.set("api_key", key);
  u.searchParams.set("fmt", "json");
  u.searchParams.set("t", String(PAGE_SIZE));
  u.searchParams.set("s", String(offset * PAGE_SIZE + 1)); // 1-based
  u.searchParams.set("safe", "1");
  return u.toString();
}

export function fromMojeek(data, offset) {
  const results = [];
  for (const r of data?.response?.results ?? []) {
    const url = webUrl(r?.url);
    const title = text(r?.title);
    if (!url || !title || results.some((x) => x.url === url)) continue;
    results.push({ title, url, snippet: text(r?.desc) });
  }
  const total = Number(data?.response?.head?.results) || 0;
  const more = results.length > 0 && offset < MAX_OFFSET && total > (offset + 1) * PAGE_SIZE;
  return { results, next: more ? { offset: offset + 1 } : null };
}

// ---------------- Blending ----------------

/** The same page from two sources: ignore scheme, "www.", trailing slash and the fragment. */
export function sameKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search;
  } catch {
    return url;
  }
}

/**
 * Reciprocal rank fusion: each source votes 1/(60 + rank) for its results, pages found by
 * several sources rise, and each result lists which sources found it.
 * `answers` is [{ source, results, next }].
 */
export function blend(answers) {
  const byKey = new Map();
  for (const { source, results } of answers) {
    results.forEach((r, i) => {
      const key = sameKey(r.url);
      const hit = byKey.get(key);
      if (hit) {
        hit.score += 1 / (60 + i);
        if (!hit.sources.includes(source)) hit.sources.push(source);
        if (!hit.snippet && r.snippet) hit.snippet = r.snippet;
      } else {
        byKey.set(key, { ...r, sources: [source], score: 1 / (60 + i) });
      }
    });
  }
  const results = [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...r }) => r);
  const next = answers.map((a) => a.next).find(Boolean) || null;
  return { results, next };
}
