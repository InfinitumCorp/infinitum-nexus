import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, decodeEntities, fromBrave, offsetFrom, text } from "../src/search.js";
import worker from "../src/worker.js";

// Shape of a Brave Search API web answer (trimmed).
const answer = {
  query: { original: "tor browser", more_results_available: true },
  web: {
    results: [
      { title: "Tor Project | Anonymity Online", url: "https://www.torproject.org/", description: "Download <strong>Tor Browser</strong> to experience real private browsing." },
      { title: "Download &amp; install", url: "https://download.torproject.org/", description: "" },
      { title: "Bad", url: "javascript:alert(1)", description: "x" },
      { title: "Dup", url: "https://www.torproject.org/", description: "dup" },
      { title: "", url: "https://empty.example/", description: "no title" },
    ],
  },
};

test("turns a Brave answer into VEIL results, text only", () => {
  const { results, next } = fromBrave(answer, 0);
  assert.deepEqual(results, [
    { title: "Tor Project | Anonymity Online", url: "https://www.torproject.org/", snippet: "Download Tor Browser to experience real private browsing." },
    { title: "Download & install", url: "https://download.torproject.org/", snippet: "" },
  ]);
  assert.deepEqual(next, { offset: 1 });
  assert.equal(fromBrave(answer, 9).next, null);
  assert.equal(fromBrave({ query: { more_results_available: false }, web: answer.web }, 0).next, null);
  assert.deepEqual(fromBrave({}, 0), { results: [], next: null });
});

test("helpers", () => {
  assert.equal(decodeEntities("&#x27;a&#39; &lt;b&gt; &amp;amp;"), "'a' <b> &amp;");
  assert.equal(text("<strong>a</strong>  b"), "a b");
  assert.equal(offsetFrom({ offset: 3 }), 3);
  assert.equal(offsetFrom({ offset: 99 }), 0);
  assert.equal(offsetFrom({ offset: "x" }), 0);
  assert.equal(offsetFrom(null), 0);
  const u = new URL(apiUrl("a b", 2));
  assert.equal(u.searchParams.get("q"), "a b");
  assert.equal(u.searchParams.get("offset"), "2");
});

const post = (body) => new Request("https://infinitumveil.app/api/search", { method: "POST", body: JSON.stringify(body) });

test("the Worker answers only POST /api/search and needs a query and a key", async () => {
  assert.equal((await worker.fetch(new Request("https://infinitumveil.app/other"), {})).status, 404);
  assert.equal((await worker.fetch(new Request("https://infinitumveil.app/api/search"), {})).status, 405);
  const pre = await worker.fetch(new Request("https://infinitumveil.app/api/search", { method: "OPTIONS" }), {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal((await worker.fetch(post({ q: "  " }), { BRAVE_SEARCH_KEY: "k" })).status, 400);
  const noKey = await worker.fetch(post({ q: "tor" }), {});
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /isn't switched on/);
});

test("the Worker asks Brave with the secret key and returns VEIL results", async () => {
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return Response.json(answer); };
  try {
    const res = await worker.fetch(post({ q: "tor browser", next: { offset: 2 } }), { BRAVE_SEARCH_KEY: "secret-test-key" });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.results.length, 2);
    assert.deepEqual(data.next, { offset: 3 });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(data).includes("secret-test-key"));
    const u = new URL(sent.url);
    assert.equal(u.origin + u.pathname, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(u.searchParams.get("q"), "tor browser");
    assert.equal(u.searchParams.get("offset"), "2");
    assert.equal(sent.init.headers["X-Subscription-Token"], "secret-test-key");
  } finally {
    globalThis.fetch = real;
  }
});

test("rate limits and failures become a friendly message", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 429 });
    let res = await worker.fetch(post({ q: "x" }), { BRAVE_SEARCH_KEY: "k" });
    assert.equal(res.status, 503);
    globalThis.fetch = async () => { throw new Error("down"); };
    res = await worker.fetch(post({ q: "x" }), { BRAVE_SEARCH_KEY: "k" });
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = real;
  }
});
