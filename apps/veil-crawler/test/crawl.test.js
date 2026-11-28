import { test } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "./d1.js";
import { LIMITS, UA, crawlOnce } from "../src/crawl.js";
import { searchIndex } from "../src/search.js";

const page = (title, body, extra = "") => `<html lang="en"><head><title>${title}</title>${extra}</head><body><p>${body} ${"Filler words about privacy and browsers. ".repeat(6)}</p></body></html>`;

function web(routes) {
  const log = [];
  const fetch = async (url, init) => {
    log.push({ url: String(url), ua: init.headers["User-Agent"] });
    const r = routes[String(url)];
    if (!r) return new Response("nope", { status: 404 });
    if (typeof r === "function") return r();
    if (r.redirect) return new Response(null, { status: 301, headers: { location: r.redirect } });
    return new Response(r.body, { status: r.status || 200, headers: { "content-type": r.type || "text/html; charset=utf-8", ...(r.headers || {}) } });
  };
  return { fetch, log };
}

async function start(db, url, now) {
  const host = new URL(url).hostname;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO hosts (host) VALUES (?)").bind(host),
    db.prepare("INSERT INTO frontier (url, host, depth, added_at) VALUES (?, ?, 0, ?)").bind(url, host, now),
  ]);
}

test("crawls politely, obeys robots.txt, indexes, and search finds it", async () => {
  const db = openD1();
  const A = "https://alpha.example.org";
  const { fetch, log } = web({
    [A + "/robots.txt"]: { body: "User-agent: *\nDisallow: /secret\nCrawl-delay: 20\n", type: "text/plain" },
    [A + "/"]: { body: page("Alpha home", `Welcome to the zebra garden. <a href="/a">A</a> <a href="/secret/x">S</a> <a href="https://beta.example.net/">B</a> <a href="/old">Old</a> <a rel="nofollow" href="/nf">NF</a>`) },
    [A + "/a"]: { body: page("Alpha article", "Quantum zebra research notes.") },
    [A + "/old"]: { redirect: A + "/a" },
    "https://beta.example.net/robots.txt": { status: 404, body: "" },
    "https://beta.example.net/": { body: page("Beta", "Busy site", '<meta name="robots" content="noindex">') },
  });
  await start(db, A + "/", 0);

  let s = await crawlOnce(db, { now: 0, fetch, seed: false });
  assert.equal(s.indexed, 1);
  assert.ok(log.every((l) => l.ua === UA), "always says it is VEILBot");
  const queued = (await db.prepare("SELECT url FROM frontier WHERE state = 0 ORDER BY url").all()).results.map((r) => r.url);
  assert.deepEqual(queued, [A + "/a", A + "/old", A + "/secret/x", "https://beta.example.net/"]);

  // Same moment: alpha's crawl delay (20 s) has not passed; only beta is crawled.
  const before = log.length;
  s = await crawlOnce(db, { now: 1000, fetch, seed: false });
  assert.equal(s.noindex, 1);
  assert.ok(log.slice(before).every((l) => !l.url.startsWith(A)), "alpha not contacted again before its delay");

  // After the delay, alpha's pages one per round; /secret is never fetched.
  for (let t = 1; t <= 6; t++) await crawlOnce(db, { now: t * 21_000, fetch, seed: false });
  assert.ok(!log.some((l) => l.url.includes("/secret")), "robots.txt Disallow obeyed");
  assert.ok(!log.some((l) => l.url.endsWith("/nf")), "nofollow links not followed");
  assert.equal(log.filter((l) => l.url.endsWith("/robots.txt")).length, 2, "robots.txt fetched once per host");

  const found = await searchIndex(db, "zebra");
  assert.deepEqual(found.results.map((r) => r.title).sort(), ["Alpha article", "Alpha home"]);
  assert.equal((await searchIndex(db, "quantum zebra")).results[0].title, "Alpha article");
  assert.equal((await searchIndex(db, "beta busy")).results.length, 0, "noindex page not in the index");
  assert.equal((await searchIndex(db, '") OR 1=1; --')).results.length, 0, "query text is never SQL or FTS syntax");
});

test("a busy site (503) keeps its page queued and is left alone for a while", async () => {
  const db = openD1();
  const C = "https://gamma.example.org";
  const { fetch, log } = web({
    [C + "/robots.txt"]: { status: 404, body: "" },
    [C + "/"]: { status: 503, body: "busy", headers: { "retry-after": "600" } },
  });
  await start(db, C + "/", 0);
  assert.equal((await crawlOnce(db, { now: 0, fetch, seed: false })).busy, 1);
  assert.equal((await db.prepare("SELECT state FROM frontier").first()).state, 0);
  const n = log.length;
  await crawlOnce(db, { now: 300_000, fetch, seed: false });
  assert.equal(log.length, n, "not contacted again before Retry-After");
});

test("robots.txt that errors (5xx) means: do not crawl that host yet", async () => {
  const db = openD1();
  const D = "https://delta.example.org";
  const { fetch, log } = web({ [D + "/robots.txt"]: { status: 500, body: "" }, [D + "/"]: { body: page("D", "d") } });
  await start(db, D + "/", 0);
  assert.equal((await crawlOnce(db, { now: 0, fetch, seed: false }))["robots-unreachable"], 1);
  assert.ok(!log.some((l) => l.url === D + "/"));
});

test("exact duplicates are indexed once, and blocked (opted-out) hosts are never shown", async () => {
  const db = openD1();
  const E = "https://echo.example.org";
  const same = page("Same", "Identical yak content");
  const { fetch } = web({
    [E + "/robots.txt"]: { status: 404, body: "" },
    [E + "/"]: { body: same.replace("<p>", '<p><a href="/copy">c</a>') },
    [E + "/copy"]: { body: same.replace("<p>", '<p><a href="/copy">c</a>') },
  });
  await start(db, E + "/", 0);
  await crawlOnce(db, { now: 0, fetch, seed: false });
  await crawlOnce(db, { now: 60_000, fetch, seed: false });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM pages").first()).n, 1);
  assert.equal((await searchIndex(db, "yak")).results.length, 1);
  await db.prepare("UPDATE hosts SET blocked = 1 WHERE host = ?").bind("echo.example.org").run();
  assert.equal((await searchIndex(db, "yak")).results.length, 0);
});

test("limits are sane", () => {
  assert.ok(LIMITS.minDelayS >= 10 && LIMITS.maxDepth <= 3 && LIMITS.maxBytes <= 2 * 1024 * 1024);
});

test("index search needs every word, and prefers pages about it", async () => {
  const db = openD1();
  const add = async (id, url, title, description, body) => {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO hosts (host) VALUES (?)").bind(new URL(url).host),
      db.prepare("INSERT INTO pages (id, url, host, title, description, lang, trackers, hash, crawled_at) VALUES (?, ?, ?, ?, ?, 'en', 0, ?, 0)").bind(id, url, new URL(url).host, title, description, "h" + id),
      db.prepare("INSERT INTO pages_fts (rowid, title, description, body) VALUES (?, ?, ?, ?)").bind(id, title, description, body),
    ]);
  };
  await add(1, "https://ai.example.com/", "Adaptive AI", "Learns all the time", "we order pizza on fridays");
  await add(2, "https://food.example.com/dough", "Pizza dough recipe", "Flour, water, yeast", "knead the dough");
  await add(3, "https://blog.example.com/p", "Weekend notes", "Kitchen diary", "my pizza dough recipe from grandma");
  const titles = async (q) => (await searchIndex(db, q)).results.map((r) => r.title);
  assert.deepEqual(await titles("pizza dough recipe"), ["Pizza dough recipe"], "a page about it beats a passing mention");
  assert.deepEqual(await titles("grandma pizza"), ["Weekend notes"], "all words on the page, when none is about it");
  assert.equal((await searchIndex(db, "grandma pizza")).weight, 0.5, "passing mentions are weighted down");
  assert.equal((await searchIndex(db, "pizza dough recipe")).weight, undefined);
  assert.deepEqual(await titles("pizza quantum"), [], "no 'any one word' fallback");
});
