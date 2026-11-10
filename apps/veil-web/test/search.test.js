import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, decodeEntities, fromBrave, fromWikipedia, offsetFrom, text, wikiUrl } from "../src/search.js";
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

test("the Worker answers only POST /api/search and needs a query", async () => {
  assert.equal((await worker.fetch(new Request("https://infinitumveil.app/other"), {})).status, 404);
  assert.equal((await worker.fetch(new Request("https://infinitumveil.app/api/search"), {})).status, 405);
  const pre = await worker.fetch(new Request("https://infinitumveil.app/api/search", { method: "OPTIONS" }), {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal((await worker.fetch(post({ q: "  " }), { BRAVE_SEARCH_KEY: "k" })).status, 400);
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

// Shape of a Wikipedia search answer (trimmed).
const wiki = {
  continue: { sroffset: 10, continue: "-||" },
  query: { search: [
    { title: "Tor (network)", snippet: "free <span class=\"searchmatch\">overlay</span> network &amp; more" },
    { title: "", snippet: "no title" },
  ] },
};

test("turns a Wikipedia answer into VEIL results", () => {
  assert.deepEqual(fromWikipedia(wiki, 0), {
    results: [{ title: "Tor (network)", url: "https://en.wikipedia.org/wiki/Tor_(network)", snippet: "free overlay network & more" }],
    next: { offset: 1 },
  });
  assert.equal(fromWikipedia({ query: wiki.query }, 0).next, null);
  assert.deepEqual(fromWikipedia({}, 0), { results: [], next: null });
  const u = new URL(wikiUrl("a b", 2));
  assert.equal(u.searchParams.get("srsearch"), "a b");
  assert.equal(u.searchParams.get("sroffset"), "20");
});

test("with no key, or when Brave fails, the Worker answers from Wikipedia", async () => {
  const real = globalThis.fetch;
  const asked = [];
  try {
    globalThis.fetch = async (url, init) => { asked.push(String(url)); return Response.json(wiki); };
    let res = await worker.fetch(post({ q: "tor" }), {});
    let data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.source, "wikipedia");
    assert.equal(data.results[0].title, "Tor (network)");
    assert.ok(asked[0].startsWith("https://en.wikipedia.org/w/api.php"));

    asked.length = 0;
    globalThis.fetch = async (url) => { asked.push(String(url)); return String(url).includes("brave") ? new Response("", { status: 429 }) : Response.json(wiki); };
    res = await worker.fetch(post({ q: "tor" }), { BRAVE_SEARCH_KEY: "k" });
    data = await res.json();
    assert.equal(data.source, "wikipedia");
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

test("when every source fails, the person gets a friendly message", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 429 });
    let res = await worker.fetch(post({ q: "x" }), { BRAVE_SEARCH_KEY: "k" });
    assert.equal(res.status, 503);
    globalThis.fetch = async () => { throw new Error("down"); };
    res = await worker.fetch(post({ q: "x" }), {});
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = real;
  }
});
