/**
 * VEIL search sources beyond Brave: Yandex (Yandex Cloud Search API) and Mojeek (Mojeek
 * Search API), official paid APIs with their own keys, set as Worker secrets; and two free
 * public APIs that need no key: Hacker News (Algolia's HN Search API) and Stack Overflow
 * (Stack Exchange API, content CC BY-SA). VEIL asks every source at the same time and
 * blends the answers. The free sources are specialist, so they add only their top few
 * results, weighted below the general ones.
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

// ---------------- Hacker News (free, no key) ----------------

export const HN_API = "https://hn.algolia.com/api/v1/search";
export const NICHE_RESULTS = 4;

/** Stories only, with some votes, so the few results HN adds are worth reading. */
export function hnUrl(q, offset) {
  const u = new URL(HN_API);
  u.searchParams.set("query", q);
  u.searchParams.set("tags", "story");
  u.searchParams.set("numericFilters", "points>10");
  u.searchParams.set("hitsPerPage", String(NICHE_RESULTS));
  u.searchParams.set("page", String(offset));
  return u.toString();
}

/** A story links to its page; Ask HN and other text posts link to the discussion. */
export function fromHackerNews(data, offset) {
  const results = [];
  for (const h of data?.hits || []) {
    const discussion = "https://news.ycombinator.com/item?id=" + encodeURIComponent(String(h.objectID ?? ""));
    const url = webUrl(h.url) || (h.objectID ? discussion : null);
    const title = text(h.title || "");
    if (!url || !title) continue;
    const points = Number(h.points) || 0, comments = Number(h.num_comments) || 0;
    results.push({ title, url, snippet: `Hacker News · ${points} points · ${comments} comments` });
  }
  const more = (data?.nbPages ?? 0) > offset + 1 && offset < MAX_OFFSET;
  return { results, next: more && results.length ? { offset: offset + 1 } : null };
}

// ---------------- Stack Overflow (free, no key; CC BY-SA) ----------------

export const SO_API = "https://api.stackexchange.com/2.3/search/excerpts";

/** An optional free app key (STACKEXCHANGE_KEY, not secret) raises the daily limit. */
export function soUrl(q, offset, key) {
  const u = new URL(SO_API);
  u.searchParams.set("q", q);
  u.searchParams.set("site", "stackoverflow");
  u.searchParams.set("order", "desc");
  u.searchParams.set("sort", "relevance");
  u.searchParams.set("pagesize", String(NICHE_RESULTS * 2));
  u.searchParams.set("page", String(offset + 1));
  if (key) u.searchParams.set("key", key);
  return u.toString();
}

/** The searched words (3+ letters), lower case. */
function words(q) {
  return [...new Set((String(q ?? "").toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu) || []))];
}

/**
 * Questions only (an answer's hit links to its question), one result per question. Stack
 * Overflow answers every search, even "pizza dough" (from code samples that mention it), so
 * a question counts only when its title and tags contain at least half of the searched words.
 */
export function fromStackOverflow(data, offset, q = "") {
  const want = words(q);
  const results = [];
  const seen = new Set();
  for (const it of data?.items || []) {
    const id = Number(it.question_id);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    const title = text(it.title || "");
    if (!title) continue;
    const excerpt = text(it.excerpt || "");
    const hay = (title + " " + (it.tags || []).join(" ")).toLowerCase();
    if (want.length && want.filter((w) => hay.includes(w)).length * 2 < want.length) continue;
    results.push({ title, url: "https://stackoverflow.com/questions/" + id, snippet: excerpt.slice(0, 300) });
    if (results.length === NICHE_RESULTS) break;
  }
  const more = Boolean(data?.has_more) && offset < MAX_OFFSET;
  return { results, next: more && results.length ? { offset: offset + 1 } : null };
}

// ---------------- Blending ----------------

/** Specialist sources count for less, so general results lead. */
export const WEIGHTS = { hackernews: 0.5, stackoverflow: 0.5 };

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
 * several sources rise, and each result lists which sources found it. An answer may carry
 * its own `weight` (VEIL's index does, when it found only passing mentions).
 * `answers` is [{ source, results, next }].
 */
export function blend(answers) {
  const byKey = new Map();
  for (const { source, results, weight: w } of answers) {
    const weight = w ?? WEIGHTS[source] ?? 1;
    results.forEach((r, i) => {
      const key = sameKey(r.url);
      const hit = byKey.get(key);
      if (hit) {
        hit.score += weight / (60 + i);
        if (!hit.sources.includes(source)) hit.sources.push(source);
        if (!hit.snippet && r.snippet) hit.snippet = r.snippet;
      } else {
        byKey.set(key, { ...r, sources: [source], score: weight / (60 + i) });
      }
    });
  }
  const results = [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...r }) => r);
  // Paging follows the general sources; specialist ones alone don't make a next page.
  const next = answers.filter((a) => !WEIGHTS[a.source]).map((a) => a.next).find(Boolean) || null;
  return { results, next };
}
