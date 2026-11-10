/**
 * VEIL search: results come from the Brave Search API (an independent index, made for apps
 * like this), fetched by the VEIL server, and are shown on VEIL's own page. The person never
 * loads a search engine's page, and the search API sees VEIL's server, not the person's
 * address. Nothing here is logged or kept.
 */
export const BRAVE_API = "https://api.search.brave.com/res/v1/web/search";
export const MAX_QUERY = 400;
export const PAGE_SIZE = 10;
/** Brave serves at most 10 pages of 20; VEIL pages 10 at a time. */
export const MAX_OFFSET = 9;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text: Brave marks matches with <strong>; VEIL draws text only. */
export function text(html) {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

export function webUrl(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The page number to ask for: 0 for a new search, else what the last answer said. */
export function offsetFrom(next) {
  const n = Number(next?.offset);
  return Number.isInteger(n) && n >= 0 && n <= MAX_OFFSET ? n : 0;
}

/** The API URL for a query and page. */
export function apiUrl(q, offset) {
  const u = new URL(BRAVE_API);
  u.searchParams.set("q", q);
  u.searchParams.set("count", String(PAGE_SIZE));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("safesearch", "moderate");
  u.searchParams.set("text_decorations", "false");
  u.searchParams.set("spellcheck", "true");
  return u.toString();
}

/** VEIL's result list from a Brave web search answer. */
export function fromBrave(data, offset) {
  const results = [];
  for (const r of data?.web?.results ?? []) {
    const url = webUrl(r?.url);
    const title = text(r?.title);
    if (!url || !title || results.some((x) => x.url === url)) continue;
    results.push({ title, url, snippet: text(r?.description) });
  }
  const more = data?.query?.more_results_available === true && offset < MAX_OFFSET && results.length > 0;
  return { results, next: more ? { offset: offset + 1 } : null };
}

/**
 * Fallback when no Brave key is set or Brave fails: Wikipedia's own search API (free, no key).
 * Results are Wikipedia articles only, and the page credits Wikipedia (CC BY-SA).
 */
export const WIKI_API = "https://en.wikipedia.org/w/api.php";
/** Wikimedia asks API clients to name themselves; this names the service, not the person. */
export const WIKI_UA = "VEIL-Search/1.0 (+https://infinitumveil.app)";

export function wikiUrl(q, offset) {
  const u = new URL(WIKI_API);
  for (const [k, v] of Object.entries({
    action: "query", list: "search", format: "json", formatversion: "2", utf8: "1",
    srsearch: q, srlimit: String(PAGE_SIZE), sroffset: String(offset * PAGE_SIZE), srprop: "snippet",
  })) u.searchParams.set(k, v);
  return u.toString();
}

/** VEIL's result list from a Wikipedia search answer. */
export function fromWikipedia(data, offset) {
  const results = [];
  for (const r of data?.query?.search ?? []) {
    const title = text(r?.title);
    if (!title) continue;
    results.push({ title, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")), snippet: text(r?.snippet) });
  }
  const more = Number.isInteger(data?.continue?.sroffset) && offset < MAX_OFFSET && results.length > 0;
  return { results, next: more ? { offset: offset + 1 } : null };
}
