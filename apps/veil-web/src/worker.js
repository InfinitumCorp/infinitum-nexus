/**
 * infinitumveil.app: static files (public/) are served before this code runs. This Worker
 * only answers POST /api/search for VEIL's own results page (public/search.html), which the
 * web app and the Android app's bundled start page both use.
 *
 * Results come from the Brave Search API. Its key is the Worker secret BRAVE_SEARCH_KEY,
 * never sent to the browser. The query travels in the POST body, so it never appears in a
 * URL or request log, and the Worker keeps nothing. CORS is open because the Android app's
 * start page is a file:// page.
 */
import { MAX_QUERY, apiUrl, fromBrave, offsetFrom } from "./search.js";

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
  const key = env?.BRAVE_SEARCH_KEY;
  if (!key) return json({ error: "VEIL search isn't switched on yet. Try again later." }, 503);
  const offset = offsetFrom(body.next);
  let res;
  try {
    res = await fetch(apiUrl(q, offset), {
      headers: { "Accept": "application/json", "X-Subscription-Token": key },
    });
  } catch {
    return json({ error: "Search is unreachable right now. Try again." }, 502);
  }
  if (res.status === 429) return json({ error: "Search is busy right now. Try again in a moment." }, 503);
  if (!res.ok) return json({ error: "Search didn't answer. Try again." }, 502);
  let data;
  try { data = await res.json(); } catch { return json({ error: "Search didn't answer properly. Try again." }, 502); }
  return json({ q, ...fromBrave(data, offset) });
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
