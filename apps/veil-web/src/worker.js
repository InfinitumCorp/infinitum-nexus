/**
 * infinitumveil.app: static files (public/) are served before this code runs. This Worker
 * only answers POST /api/search for VEIL's own results page (public/search.html), which the
 * web app and the Android app's bundled start page both use.
 *
 * Results come from every web search API VEIL has a key for, asked at the same time and
 * blended (sources.js): Yandex (YANDEX_SEARCH_KEY + YANDEX_FOLDER_ID), Brave
 * (BRAVE_SEARCH_KEY) and Mojeek (MOJEEK_SEARCH_KEY). Keys are Worker secrets, never sent to
 * the browser. With no keys, or when every source fails, results come from Wikipedia's
 * search API, so search always answers. The query travels in the POST body, so it never appears in a
 * URL or request log, and the Worker keeps nothing. CORS is open because the Android app's
 * start page is a file:// page.
 */
import { MAX_QUERY, WIKI_UA, apiUrl, fromBrave, fromWikipedia, offsetFrom, wikiUrl } from "./search.js";
import { YANDEX_API, blend, decodeRaw, fromMojeek, fromYandexXml, mojeekUrl, yandexBody } from "./sources.js";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

async function search(request, env) {
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json({ error: "Bad request" }, 400); }
  const q = typeof body?.q === "string" ? body.q.trim().slice(0, MAX_QUERY) : "";
  if (!q) return json({ error: "Type something to search for." }, 400);
  const offset = offsetFrom(body.next);
  const asks = [];
  if (env?.YANDEX_SEARCH_KEY && env?.YANDEX_FOLDER_ID) asks.push(ask("yandex", () => yandex(q, offset, env)));
  if (env?.BRAVE_SEARCH_KEY) asks.push(ask("brave", () => brave(q, offset, env.BRAVE_SEARCH_KEY)));
  if (env?.MOJEEK_SEARCH_KEY) asks.push(ask("mojeek", () => mojeek(q, offset, env.MOJEEK_SEARCH_KEY)));
  const answers = (await Promise.all(asks)).filter((a) => a && a.results.length);
  if (answers.length) return json({ q, sources: answers.map((a) => a.source), ...blend(answers) });
  return wikipedia(q, offset);
}

const SOURCE_TIMEOUT_MS = 6000;

/** One source's answer, or null if it fails or is slow (the others still answer). */
async function ask(source, run) {
  try {
    const answer = await run();
    return answer ? { source, ...answer } : null;
  } catch {
    return null;
  }
}

async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  return res.ok ? res : null;
}

async function yandex(q, offset, env) {
  const res = await get(YANDEX_API, {
    method: "POST",
    headers: { "Authorization": "Api-Key " + env.YANDEX_SEARCH_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(yandexBody(q, offset, env.YANDEX_FOLDER_ID)),
  });
  return res && fromYandexXml(decodeRaw((await res.json()).rawData), offset);
}

async function brave(q, offset, key) {
  const res = await get(apiUrl(q, offset), { headers: { "Accept": "application/json", "X-Subscription-Token": key } });
  return res && fromBrave(await res.json(), offset);
}

async function mojeek(q, offset, key) {
  const res = await get(mojeekUrl(q, offset, key), { headers: { "Accept": "application/json" } });
  return res && fromMojeek(await res.json(), offset);
}

async function wikipedia(q, offset) {
  let res;
  try {
    res = await fetch(wikiUrl(q, offset), { headers: { "Accept": "application/json", "User-Agent": WIKI_UA } });
  } catch {
    return json({ error: "Search is unreachable right now. Try again." }, 502);
  }
  if (res.status === 429) return json({ error: "Search is busy right now. Try again in a moment." }, 503);
  if (!res.ok) return json({ error: "Search didn't answer. Try again." }, 502);
  let data;
  try { data = await res.json(); } catch { return json({ error: "Search didn't answer properly. Try again." }, 502); }
  return json({ q, sources: ["wikipedia"], ...fromWikipedia(data, offset) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return search(request, env);
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
