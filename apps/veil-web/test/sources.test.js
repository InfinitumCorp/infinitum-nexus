import { test } from "node:test";
import assert from "node:assert/strict";
import { blend, decodeRaw, fromHackerNews, fromMojeek, fromStackOverflow, fromYandexXml, hnUrl, mojeekUrl, sameKey, soUrl, yandexBody } from "../src/sources.js";
import worker from "../src/worker.js";

// Shape of Yandex's XML answer (trimmed).
const yandexXml = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch version="1.0"><response><found priority="all">1200</found><results><grouping>
<group><doc id="a"><url>https://www.torproject.org/</url><domain>www.torproject.org</domain>
<title><hlword>Tor</hlword> Project &amp; Anonymity</title><headline>Defend yourself.</headline></doc></group>
<group><doc id="b"><url>https://ru.wikipedia.org/wiki/Tor</url><title>Tor — Википедия</title>
<passages><passage>Свободное <hlword>ПО</hlword></passage><passage>для анонимности</passage></passages></doc></group>
<group><doc id="c"><url>javascript:alert(1)</url><title>Bad</title></doc></group>
</grouping></results></response></yandexsearch>`;

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

test("reads Yandex's XML answer, including Cyrillic text", () => {
  assert.equal(decodeRaw(b64("Привет")), "Привет");
  const { results, next } = fromYandexXml(yandexXml, 0);
  assert.deepEqual(results, [
    { title: "Tor Project & Anonymity", url: "https://www.torproject.org/", snippet: "Defend yourself." },
    { title: "Tor — Википедия", url: "https://ru.wikipedia.org/wiki/Tor", snippet: "Свободное ПО … для анонимности" },
  ]);
  assert.deepEqual(next, { offset: 1 });
  assert.equal(fromYandexXml("<yandexsearch/>", 0).next, null);
});

test("asks Yandex's Russian index for Russian queries, its international one otherwise", () => {
  assert.equal(yandexBody("tor browser", 0, "f").query.searchType, "SEARCH_TYPE_COM");
  const ru = yandexBody("браузер тор", 2, "folder1");
  assert.equal(ru.query.searchType, "SEARCH_TYPE_RU");
  assert.equal(ru.query.page, "2");
  assert.equal(ru.folderId, "folder1");
});

test("reads Mojeek's JSON answer and pages from 1", () => {
  const data = { response: { status: "OK", head: { results: 500 }, results: [
    { url: "https://mojeek.com/", title: "Mojeek", desc: "Independent search" },
    { url: "ftp://x/", title: "Bad", desc: "" },
  ] } };
  assert.deepEqual(fromMojeek(data, 0), { results: [{ title: "Mojeek", url: "https://mojeek.com/", snippet: "Independent search" }], next: { offset: 1 } });
  const u = new URL(mojeekUrl("a b", 1, "k"));
  assert.equal(u.searchParams.get("s"), "11");
  assert.equal(u.searchParams.get("fmt"), "json");
});

test("blends sources: shared pages rise and list every source", () => {
  assert.equal(sameKey("https://www.a.org/x/"), sameKey("http://a.org/x"));
  const { results, next } = blend([
    { source: "yandex", results: [{ title: "Only Y", url: "https://y.example/", snippet: "" }, { title: "A", url: "https://www.a.org/", snippet: "" }], next: null },
    { source: "brave", results: [{ title: "A", url: "https://a.org", snippet: "from brave" }], next: { offset: 1 } },
  ]);
  assert.equal(results[0].title, "A");
  assert.deepEqual(results[0].sources, ["yandex", "brave"]);
  assert.equal(results[0].snippet, "from brave");
  assert.equal(results.length, 2);
  assert.deepEqual(next, { offset: 1 });
});

const post = (body) => new Request("https://infinitumveil.app/api/search", { method: "POST", body: JSON.stringify(body) });

test("the Worker asks every source with a key and blends; a failing source is skipped", async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith("https://searchapi.api.cloud.yandex.net/")) {
      assert.equal(init.headers.Authorization, "Api-Key yk");
      assert.equal(JSON.parse(init.body).folderId, "fid");
      return Response.json({ rawData: b64(yandexXml) });
    }
    if (u.startsWith("https://api.mojeek.com/")) return new Response("down", { status: 500 });
    if (u.startsWith("https://api.search.brave.com/")) return Response.json({ web: { results: [{ title: "Tor", url: "https://torproject.org", description: "b" }] } });
    throw new Error("unexpected " + u);
  };
  try {
    const res = await worker.fetch(post({ q: "tor" }), { YANDEX_SEARCH_KEY: "yk", YANDEX_FOLDER_ID: "fid", BRAVE_SEARCH_KEY: "bk", MOJEEK_SEARCH_KEY: "mk" });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data.sources, ["yandex", "brave"]);
    assert.deepEqual(data.results[0].sources, ["yandex", "brave"]);
    assert.equal(asked.length, 5, "three keyed sources and the two free ones; never Wikipedia");
    assert.ok(!data.results.some((r) => r.url.includes("wikipedia.org")), "Wikipedia results are taken out");
    assert.ok(!JSON.stringify(data).includes("yk"));
  } finally {
    globalThis.fetch = real;
  }
});

test("VEIL's own index is asked first, and nothing fills in from Wikipedia", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/wiki/i.test(String(url))) throw new Error("Wikipedia must never be asked");
    throw new Error("unexpected " + url);
  };
  const index = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ url: "https://zoo.example.org/", title: "Zoo zebras", description: "Our zebras", snip: "" }] }) }) }),
  };
  try {
    const data = await (await worker.fetch(post({ q: "zebra" }), { VEIL_INDEX: index })).json();
    assert.deepEqual(data.sources, ["veil"]);
    assert.equal(data.results[0].url, "https://zoo.example.org/");
    assert.deepEqual(data.results[0].sources, ["veil"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("reads Hacker News stories; text posts link to the discussion", () => {
  const data = { nbPages: 3, hits: [
    { objectID: "1", title: "Debian 14 released", url: "https://www.debian.org/News/", points: 512, num_comments: 200 },
    { objectID: "2", title: "Ask HN: Debian or Arch?", url: null, points: 40, num_comments: 90 },
    { objectID: "3", title: "Bad", url: "javascript:alert(1)", points: 50, num_comments: 1 },
  ] };
  const { results, next } = fromHackerNews(data, 0);
  assert.deepEqual(results.map((r) => r.url), [
    "https://www.debian.org/News/",
    "https://news.ycombinator.com/item?id=2",
    "https://news.ycombinator.com/item?id=3",
  ]);
  assert.equal(results[0].snippet, "Hacker News · 512 points · 200 comments");
  assert.deepEqual(next, { offset: 1 });
  assert.match(hnUrl("tor", 2), /tags=story/);
  assert.match(hnUrl("tor", 2), /page=2/);
});

test("reads Stack Overflow, one result per question, and adds the optional key", () => {
  const data = { has_more: true, items: [
    { question_id: 10, item_type: "question", title: "How do I &amp; why?", excerpt: "Use <span class=\"highlight\">apt</span>" },
    { question_id: 10, item_type: "answer", title: "How do I &amp; why?", excerpt: "answer text" },
    { question_id: 11, item_type: "answer", title: "Second", excerpt: "x" },
  ] };
  const { results, next } = fromStackOverflow(data, 0);
  assert.deepEqual(results, [
    { title: "How do I & why?", url: "https://stackoverflow.com/questions/10", snippet: "Use apt" },
    { title: "Second", url: "https://stackoverflow.com/questions/11", snippet: "x" },
  ]);
  assert.deepEqual(next, { offset: 1 });
  assert.doesNotMatch(soUrl("q", 0), /key=/);
  assert.match(soUrl("q", 0, "abc"), /key=abc/);
  assert.match(soUrl("q", 1), /page=2/);
});

test("specialist sources rank below general ones and don't drive paging", () => {
  const { results, next } = blend([
    { source: "stackoverflow", results: [{ title: "SO", url: "https://stackoverflow.com/questions/1" }], next: { offset: 1 } },
    { source: "wikipedia", results: [{ title: "W1", url: "https://en.wikipedia.org/wiki/A" }, { title: "W2", url: "https://en.wikipedia.org/wiki/B" }], next: null },
  ]);
  assert.deepEqual(results.map((r) => r.title), ["W1", "W2", "SO"]);
  assert.equal(next, null);
});

test("Stack Overflow results must match the search", () => {
  const data = { items: [
    { question_id: 1, title: "Read a cell in pandas", excerpt: "dataframe", tags: ["python"] },
    { question_id: 2, title: "Pizza dough rises too fast", excerpt: "yeast" },
    { question_id: 3, title: "Update a table", excerpt: "remove one pizza dough recipe" },
  ] };
  assert.deepEqual(fromStackOverflow(data, 0, "pizza dough recipe").results.map((r) => r.url), ["https://stackoverflow.com/questions/2"]);
  assert.equal(fromStackOverflow(data, 0, "").results.length, 3);
});

test("an answer's own weight overrides its source's", () => {
  const { results } = blend([
    { source: "veil", weight: 0.5, results: [{ title: "Passing mention", url: "https://a.example/" }] },
    { source: "wikipedia", results: [{ title: "About it", url: "https://en.wikipedia.org/wiki/X" }] },
  ]);
  assert.deepEqual(results.map((r) => r.title), ["About it", "Passing mention"]);
});
