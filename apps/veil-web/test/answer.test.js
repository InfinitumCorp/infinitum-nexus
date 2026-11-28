import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestPassage, buildMessages, cleanHistory, deltaOf, isWiki, noWiki, pageText, parseRelated, readSse, replyText, searchPlan, searchQuery,
} from "../src/answer.js";
import worker from "../src/worker.js";

test("Wikipedia, its sister sites and mirrors are recognised", () => {
  for (const u of ["https://en.wikipedia.org/wiki/Tor", "https://ru.m.wikipedia.org/wiki/x", "https://www.wikidata.org/", "https://www.wikiwand.com/en/Tor", "https://en.wiktionary.org/wiki/a"]) {
    assert.ok(isWiki(u), u);
  }
  for (const u of ["https://www.torproject.org/", "https://wiki.archlinux.org/", "https://notwikipedia.org.example.com/", "not a url"]) {
    assert.ok(!isWiki(u), u);
  }
  assert.deepEqual(noWiki({ source: "brave", results: [{ url: "https://en.wikipedia.org/wiki/A" }, { url: "https://a.example/" }] }).results, [{ url: "https://a.example/" }]);
  assert.equal(noWiki(null), null);
});

test("page text keeps the article and drops scripts, menus and footers", () => {
  const html = `<html><head><title>x</title><style>.a{}</style></head><body>
    <nav>Home | About</nav><script>alert(1)</script>
    <article><h1>Tor &amp; you</h1><p>${"Tor hides your address. ".repeat(30)}</p><p>Second paragraph.</p></article>
    <footer>© 2026</footer></body></html>`;
  const t = pageText(html);
  assert.ok(t.startsWith("Tor & you"));
  assert.ok(t.includes("Second paragraph."));
  assert.ok(!/alert|Home \| About|©/.test(t));
});

test("the best passage is the paragraph that matches the question", () => {
  const filler = "Unrelated filler text about something else entirely. ".repeat(8);
  const text = [filler, filler, "To install Tor Browser on Linux, download the tarball and run start-tor-browser.", filler, filler].join("\n");
  const p = bestPassage(text, "install tor browser linux", 300);
  assert.ok(p.includes("start-tor-browser"));
  assert.ok(p.length <= 300);
  assert.equal(bestPassage("short", "x"), "short");
});

test("follow-ups carry context; history is trimmed", () => {
  const h = cleanHistory([{ q: "What is Tor?", a: "A network." }, { q: 1 }, null]);
  assert.deepEqual(h, [{ q: "What is Tor?", a: "A network." }]);
  assert.equal(searchQuery("on Android?", h), "tor android");
  assert.equal(searchQuery("how do onion services publish their descriptors to the network", h), "onion services publish descriptors network");
  assert.equal(searchQuery("How does Rust async await work?", []), "rust async await");
  assert.equal(searchQuery("what is it?", []), "what is it", "all filler: search the words anyway");
  assert.deepEqual(searchPlan("and how is it different from threads?", [{ q: "how does rust async await work", a: "…" }]),
    ["rust async await threads", "threads"]);
  assert.deepEqual(searchPlan("best self-hosted password manager for linux servers", []),
    ["self hosted password manager linux servers", "self hosted password", "self hosted"]);
  assert.equal(cleanHistory(Array.from({ length: 9 }, (_, i) => ({ q: "q" + i, a: "a" })))[0].q, "q6");
  assert.deepEqual(cleanHistory("nope"), []);
});

test("the prompt numbers the sources and forbids Wikipedia", () => {
  const m = buildMessages("What is Tor?", [{ title: "Tor Project", url: "https://torproject.org", passage: "Tor is free software." }], [{ q: "hi", a: "hello" }]);
  assert.equal(m[0].role, "system");
  assert.match(m[0].content, /Never mention Wikipedia/);
  assert.deepEqual(m.slice(1, 3).map((x) => x.role), ["user", "assistant"]);
  assert.match(m.at(-1).content, /\[1\] Tor Project\nURL: https:\/\/torproject\.org\nTor is free software\./);
  assert.match(m.at(-1).content, /Question: What is Tor\?$/);
});

test("related questions are cleaned up", () => {
  assert.deepEqual(parseRelated("1. How does Tor work?\n- Is Tor legal?\nnot a question\n\"Who runs Tor relays?\"\nExtra one?"), ["How does Tor work?", "Is Tor legal?", "Who runs Tor relays?"]);
  assert.deepEqual(parseRelated(undefined), []);
});

test("reads Workers AI streams in both formats", async () => {
  assert.equal(deltaOf({ response: "a" }), "a");
  assert.equal(deltaOf({ choices: [{ delta: { content: "b" } }] }), "b");
  assert.equal(deltaOf(null), "");
  const enc = new TextEncoder();
  const stream = new ReadableStream({ start(c) {
    c.enqueue(enc.encode('data: {"response":"Hel'));
    c.enqueue(enc.encode('lo"}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  } });
  const parts = [];
  assert.equal(await readSse(stream, (t) => parts.push(t)), "Hello world");
  assert.deepEqual(parts, ["Hello", " world"]);
  assert.equal(replyText({ response: "x" }), "x");
  assert.equal(replyText({ choices: [{ message: { content: "y" } }] }), "y");
});

const ask = (body) => new Request("https://infinitumveil.app/api/ask", { method: "POST", body: JSON.stringify(body) });
const events = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

/** A stand-in D1 database: searches find one page, and its indexed text is there to read. */
const index = {
  prepare: (sql) => ({ bind: () => ({ all: async () => (sql.includes("pages_fts f ON")
    ? { results: [{ url: "https://zoo.example.org/zebras", body: "Zebras have black and white stripes.\nEach zebra's stripes are unique." }] }
    : { results: [{ url: "https://zoo.example.org/zebras", title: "Zebras at the zoo", description: "About zebras", snip: "" }] }) }) }),
};

function fakeAi(seen) {
  return {
    run: async (model, input) => {
      seen.push({ model, input });
      if (!input.stream) return { response: "Why do zebras have stripes?\nAre all zebras striped alike?" };
      const enc = new TextEncoder();
      return new ReadableStream({ start(c) {
        c.enqueue(enc.encode('data: {"response":"Every zebra\'s stripes are unique "}\n\n'));
        c.enqueue(enc.encode('data: {"response":"[1]."}\n\ndata: [DONE]\n\n'));
        c.close();
      } });
    },
  };
}

test("/api/ask streams sources, results, the cited answer and related questions", async () => {
  const real = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("offline"); };
  try {
    const seen = [];
    const res = await worker.fetch(ask({ q: "zebra stripes" }), { VEIL_INDEX: index, AI: fakeAi(seen) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /ndjson/);
    const ev = await events(res);
    assert.deepEqual(ev.map((e) => e.type), ["sources", "results", "text", "text", "related", "done"]);
    assert.deepEqual(ev[0].sources, [{ n: 1, title: "Zebras at the zoo", url: "https://zoo.example.org/zebras", site: "zoo.example.org", snippet: "About zebras" }]);
    assert.equal(ev.filter((e) => e.type === "text").map((e) => e.t).join(""), "Every zebra's stripes are unique [1].");
    assert.deepEqual(ev[4].questions, ["Why do zebras have stripes?", "Are all zebras striped alike?"]);
    const prompt = seen.find((s) => s.input.stream).input.messages.at(-1).content;
    assert.match(prompt, /Each zebra's stripes are unique/, "the answer is grounded in VEIL's indexed text");
    assert.ok(!fetched.some((u) => u.includes("zoo.example.org")), "indexed pages aren't fetched again");
    assert.ok(!fetched.some((u) => /wiki/i.test(u)));
  } finally {
    globalThis.fetch = real;
  }
});

test("/api/ask without AI still returns sources and results, then says so", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const ev = await events(await worker.fetch(ask({ q: "zebra" }), { VEIL_INDEX: index }));
    assert.deepEqual(ev.map((e) => e.type), ["sources", "results", "error"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("/api/ask with nothing found answers plainly, without calling the AI", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const seen = [];
    const ev = await events(await worker.fetch(ask({ q: "qwzx" }), { AI: fakeAi(seen) }));
    assert.deepEqual(ev.map((e) => e.type), ["sources", "results", "text", "done"]);
    assert.equal(seen.length, 0);
    assert.deepEqual(await events(await worker.fetch(ask({ q: "  " }), {})), [{ type: "error", message: "Type a question." }]);
  } finally {
    globalThis.fetch = real;
  }
});
