/**
 * infinitumveil.app: static files (public/) are served before this code runs. This Worker
 * answers two calls for VEIL's own search page (public/search.html), which the web app and
 * the Android app's bundled start page both use:
 *
 * - POST /api/search: web results. They come first from VEIL's own index (VEILBot,
 *   apps/veil-crawler, D1 binding VEIL_INDEX), then from every web search API VEIL has a key
 *   for, asked at the same time and blended (sources.js): Yandex (YANDEX_SEARCH_KEY +
 *   YANDEX_FOLDER_ID), Brave (BRAVE_SEARCH_KEY) and Mojeek (MOJEEK_SEARCH_KEY), plus two free
 *   sources that need no key, Hacker News and Stack Overflow.
 * - POST /api/ask: VEIL Answers (answer.js). The same search, then the best pages are read
 *   (VEIL's index already holds their text; other pages are fetched once, briefly) and Workers
 *   AI (binding AI) writes a short answer citing them as [1], [2]… It streams back as
 *   newline-separated JSON events, so the answer appears as it is written.
 *
 * Nothing comes from Wikipedia or its mirrors (answer.js isWiki), and nothing sends the person
 * to another search engine: results and answers are drawn on VEIL's own page. Keys are Worker
 * secrets, never sent to the browser. The query travels in the POST body, so it never appears
 * in a URL or request log, and the Worker keeps nothing. CORS is open because the Android
 * app's start page is a file:// page.
 */
import { MAX_QUERY, offsetFrom, apiUrl, fromBrave } from "./search.js";
import { searchIndex } from "../../veil-crawler/src/search.js";
import {
  YANDEX_API, blend, decodeRaw, fromHackerNews, fromMojeek, fromStackOverflow, fromYandexXml, hnUrl, mojeekUrl, soUrl, yandexBody,
} from "./sources.js";
import {
  MAX_SOURCES, MODEL, bestPassage, buildMessages, cleanHistory, noWiki, pageText, parseRelated, readSse, relatedMessages, replyText, searchPlan,
} from "./answer.js";

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

async function readBody(request) {
  try { return JSON.parse(await request.text()); } catch { return null; }
}

/** Every source at once, Wikipedia-family results removed, blended into one list. */
export async function gather(q, offset, env) {
  const asks = [];
  if (env?.VEIL_INDEX) asks.push(ask("veil", () => searchIndex(env.VEIL_INDEX, q, offset)));
  if (env?.YANDEX_SEARCH_KEY && env?.YANDEX_FOLDER_ID) asks.push(ask("yandex", () => yandex(q, offset, env)));
  if (env?.BRAVE_SEARCH_KEY) asks.push(ask("brave", () => brave(q, offset, env.BRAVE_SEARCH_KEY)));
  if (env?.MOJEEK_SEARCH_KEY) asks.push(ask("mojeek", () => mojeek(q, offset, env.MOJEEK_SEARCH_KEY)));
  asks.push(ask("hackernews", () => hackerNews(q, offset)));
  asks.push(ask("stackoverflow", () => stackOverflow(q, offset, env?.STACKEXCHANGE_KEY)));
  const answers = (await Promise.all(asks)).map(noWiki).filter((a) => a && a.results.length);
  return { sources: answers.map((a) => a.source), ...blend(answers) };
}

async function search(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request" }, 400);
  const q = typeof body.q === "string" ? body.q.trim().slice(0, MAX_QUERY) : "";
  if (!q) return json({ error: "Type something to search for." }, 400);
  return json({ q, ...(await gather(q, offsetFrom(body.next), env)) });
}

// ---------------- VEIL Answers ----------------

const PAGE_TIMEOUT_MS = 3500;
const PAGE_CHARS = 600_000;
const READER_UA = "VEIL-Answers/1.0 (+https://infinitumveil.app/bot)";

/** Page text VEILBot already indexed, by URL. */
async function indexedText(db, urls) {
  if (!db || !urls.length) return new Map();
  const marks = urls.map(() => "?").join(",");
  try {
    const { results } = await db
      .prepare(`SELECT p.url AS url, f.body AS body FROM pages p JOIN pages_fts f ON f.rowid = p.id WHERE p.url IN (${marks})`)
      .bind(...urls).all();
    return new Map(results.map((r) => [r.url, r.body]));
  } catch {
    return new Map();
  }
}

/** A public page's readable text, read once with a short timeout and a size cap; null if it can't be read. */
async function liveText(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || /^[\d.]+$|^\[|^localhost$/i.test(u.hostname)) return null;
    const res = await fetch(u, {
      headers: { "User-Agent": READER_UA, "Accept": "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "") || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = "";
    while (html.length < PAGE_CHARS) {
      const { value, done } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return pageText(html);
  } catch {
    return null;
  }
}

function site(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** The top results with the passage of each page that best answers the question. */
async function readSources(results, q, env) {
  const top = results.slice(0, MAX_SOURCES);
  const fromIndex = await indexedText(env?.VEIL_INDEX, top.filter((r) => r.sources?.includes("veil")).map((r) => r.url));
  return Promise.all(top.map(async (r) => {
    const text = fromIndex.get(r.url) ?? (await liveText(r.url));
    return { title: r.title, url: r.url, site: site(r.url), snippet: r.snippet || "", passage: text ? bestPassage(text, q) : r.snippet || "" };
  }));
}

function answer(request, env) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const out = writable.getWriter();
  const send = (event) => out.write(enc.encode(JSON.stringify(event) + "\n")).catch(() => {});

  (async () => {
    try {
      const body = await readBody(request);
      const q = typeof body?.q === "string" ? body.q.trim().slice(0, MAX_QUERY) : "";
      if (!q) { await send({ type: "error", message: "Type a question." }); return; }
      const history = cleanHistory(body.history);

      let found = { sources: [], results: [], next: null };
      for (const tryQ of searchPlan(q, history)) {
        found = await gather(tryQ, 0, env);
        if (found.results.length) break;
      }
      const sources = await readSources(found.results, q, env);
      await send({ type: "sources", sources: sources.map(({ title, url, site, snippet }, i) => ({ n: i + 1, title, url, site, snippet })) });
      await send({ type: "results", from: found.sources, results: found.results, next: found.next });

      if (!sources.length) {
        await send({ type: "text", t: "VEIL didn't find pages about this yet. Try different words, or ask it another way." });
        await send({ type: "done" });
        return;
      }
      if (!env?.AI) {
        await send({ type: "error", message: "Answers aren't switched on here yet. The web results below are VEIL's own." });
        return;
      }
      const model = env.ANSWER_MODEL || MODEL;
      const related = env.AI.run(model, { messages: relatedMessages(q, sources), max_tokens: 120, temperature: 0.6 })
        .then((r) => parseRelated(replyText(r))).catch(() => []);
      const stream = await env.AI.run(model, { messages: buildMessages(q, sources, history), stream: true, max_tokens: 900, temperature: 0.2 });
      await readSse(stream, (t) => send({ type: "text", t }));
      await send({ type: "related", questions: await related });
      await send({ type: "done" });
    } catch {
      await send({ type: "error", message: "The answer stopped early. Try again." });
    } finally {
      out.close().catch(() => {});
    }
  })();

  return new Response(readable, { headers: { ...HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

// ---------------- Sources ----------------

const SOURCE_TIMEOUT_MS = 6000;

/** One source's answer, or null if it fails or is slow (the others still answer). */
async function ask(source, run) {
  try {
    const a = await run();
    return a ? { source, ...a } : null;
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

async function hackerNews(q, offset) {
  const res = await get(hnUrl(q, offset), { headers: { "Accept": "application/json" } });
  return res && fromHackerNews(await res.json(), offset);
}

async function stackOverflow(q, offset, key) {
  const res = await get(soUrl(q, offset, key), { headers: { "Accept": "application/json" } });
  return res && fromStackOverflow(await res.json(), offset, q);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search" || url.pathname === "/api/ask") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return url.pathname === "/api/ask" ? answer(request, env) : search(request, env);
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
