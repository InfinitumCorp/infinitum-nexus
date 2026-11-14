import { test } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "./d1.js";
import { LIMITS, capFor, crawlOnce, queueLinks } from "../src/crawl.js";
import { searchIndex } from "../src/search.js";

const page = (title, body) => `<html lang="en"><head><title>${title}</title></head><body><p>${body} ${"Filler words about privacy and browsers. ".repeat(6)}</p></body></html>`;
const ok = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

test("a link to another site queues that site's home page at depth 0", async () => {
  const db = openD1();
  await queueLinks(db, [
    { href: "/deep/a", nofollow: false },
    { href: "https://other.example.net/x/y/z", nofollow: false },
    { href: "https://other.example.net/q", nofollow: false },
  ], "https://home.example.org/start", 3, 0);
  const f = await rows(db, "SELECT url, depth FROM frontier ORDER BY url");
  assert.deepEqual(f, [
    { url: "https://home.example.org/deep/a", depth: 3 },
    { url: "https://other.example.net/", depth: 0 },
  ]);
});

test("caps grow with popularity", () => {
  assert.equal(capFor(null), LIMITS.maxPagesPerHost);
  assert.equal(capFor(5), 2000);
  assert.equal(capFor(5000), 1000);
  assert.equal(capFor(50000), 500);
  assert.equal(capFor(500000), LIMITS.maxPagesPerHost);
});

test("ranked sites are crawled first, and a site at its cap has its queue dropped", async () => {
  const db = openD1();
  const hosts = ["a.example", "b.example", "c.example", "pop.example"];
  for (const h of hosts) {
    await db.batch([
      db.prepare("INSERT INTO hosts (host, robots, robots_at, rank) VALUES (?, ?, ?, ?)").bind(h, JSON.stringify({ groups: [] }), 0, h === "pop.example" ? 10 : null),
      db.prepare("INSERT INTO frontier (url, host, depth, added_at) VALUES (?, ?, 0, 0)").bind(`https://${h}/`, h),
      db.prepare("INSERT INTO frontier (url, host, depth, added_at) VALUES (?, ?, 1, 0)").bind(`https://${h}/more`, h),
    ]);
  }
  // a.example is one page short of its cap.
  await db.prepare("UPDATE hosts SET pages = ? WHERE host = 'a.example'").bind(LIMITS.maxPagesPerHost - 1).run();
  const seen = [];
  const fetch = async (url) => {
    seen.push(new URL(String(url)).host);
    if (String(url).endsWith("/robots.txt")) return new Response("", { status: 404 });
    return ok(page("Home " + new URL(String(url)).host, "Something worth indexing here."));
  };
  const s = await crawlOnce(db, { now: 1e12, fetch, hostsPerRun: 2, seed: false });
  assert.equal(s.hosts, 2);
  assert.equal(seen.filter((h) => h === "pop.example").length >= 1, true, "the ranked site gets a slot");
  // Crawl everyone once more so a.example is reached.
  await crawlOnce(db, { now: 2e12, fetch, hostsPerRun: 10, seed: false });
  const leftA = await rows(db, "SELECT url FROM frontier WHERE host = 'a.example' AND state = 0");
  assert.deepEqual(leftA, [], "a.example hit its cap, so its queue is gone");
  const leftB = await rows(db, "SELECT url FROM frontier WHERE host = 'b.example' AND state = 0");
  assert.equal(leftB.length, 1, "b.example still has work queued");
});

test("on equal text, a page on a well-known site ranks first", async () => {
  const db = openD1();
  const add = async (id, url, rank) => {
    const host = new URL(url).host;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO hosts (host, rank) VALUES (?, ?)").bind(host, rank),
      db.prepare("INSERT INTO pages (id, url, host, title, description, lang, trackers, hash, crawled_at) VALUES (?, ?, ?, 'Sourdough starter guide', 'How to feed a starter', 'en', 0, ?, 0)").bind(id, url, host, "h" + id),
      db.prepare("INSERT INTO pages_fts (rowid, title, description, body) VALUES (?, 'Sourdough starter guide', 'How to feed a starter', 'flour and water daily')").bind(id),
    ]);
  };
  await add(1, "https://tiny.example/s", null);
  await add(2, "https://famous.example/s", 50);
  const urls = (await searchIndex(db, "sourdough starter")).results.map((r) => r.url);
  assert.deepEqual(urls, ["https://famous.example/s", "https://tiny.example/s"]);
});
