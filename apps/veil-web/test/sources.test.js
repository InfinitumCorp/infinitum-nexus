import { test } from "node:test";
import assert from "node:assert/strict";
import { blend, decodeRaw, fromMojeek, fromYandexXml, mojeekUrl, sameKey, yandexBody } from "../src/sources.js";
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
    assert.equal(asked.length, 3);
    assert.ok(!JSON.stringify(data).includes("yk"));
  } finally {
    globalThis.fetch = real;
  }
});
