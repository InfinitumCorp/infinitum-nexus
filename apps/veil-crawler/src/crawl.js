/**
 * One crawl round: pick hosts whose politeness clock has run out, fetch one page from each
 * (after checking robots.txt), index it, and queue its links. Runs from a cron every minute,
 * so a host is contacted at most once per round and never faster than its crawl delay.
 */
import { extract, headerRobots } from "./html.js";
import { ALLOW_ALL, MAX_ROBOTS_BYTES, isAllowed, parseRobots } from "./robots.js";
import { SEEDS, neverCrawl } from "./seeds.js";
import { crawlable, hostOf, robotsPath } from "./url.js";

export const UA = "Mozilla/5.0 (compatible; VEILBot/1.0; +https://infinitumveil.app/bot)";
export const LIMITS = Object.freeze({
  hostsPerRun: 60,
  minDelayS: 10,                 // never faster than one request per 10 s per host
  robotsTtlMs: 24 * 3600e3,      // robots.txt re-read daily
  robotsRetryMs: 3600e3,         // robots.txt unreachable: try the host again in an hour
  busyBackoffMs: 30 * 60e3,      // 429/503 without Retry-After
  fetchTimeoutMs: 15e3,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  maxDepth: 3,                   // clicks from a site's home page (each site counts its own depth)
  maxPagesPerHost: 200,          // for sites outside the Tranco list; popular sites get more (capFor)
  maxQueued: 1_000_000,
  minText: 150,
  rankedShare: 2 / 3,            // of each round's hosts, this share goes to popular (ranked) sites
  countEveryMs: 3600e3,          // the queue is recounted hourly, not every round (D1 rows read)
});

/** How many pages VEILBot keeps from a site, by its Tranco rank (null = not in the list). */
export function capFor(rank) {
  if (rank == null) return LIMITS.maxPagesPerHost;
  if (rank <= 1000) return 2000;
  if (rank <= 10000) return 1000;
  if (rank <= 100000) return 500;
  return LIMITS.maxPagesPerHost;
}
const CAP_SQL = `CASE WHEN h.rank <= 1000 THEN 2000 WHEN h.rank <= 10000 THEN 1000 WHEN h.rank <= 100000 THEN 500 ELSE ${LIMITS.maxPagesPerHost} END`;

const HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "Accept-Language": "en;q=0.9,*;q=0.5" };

async function readCapped(res, max) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) { await reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - at); all.set(part, at); at += part.length; if (at >= all.length) break; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function retryAfterMs(res, fallback) {
  const v = res.headers.get("retry-after");
  if (!v) return fallback;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(Math.max(s * 1000, 60e3), 24 * 3600e3);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(Math.max(t - Date.now(), 60e3), 24 * 3600e3) : fallback;
}

/** Queue seeds when nothing is left to crawl. */
export async function ensureSeeds(db, now) {
  const left = await db.prepare("SELECT 1 FROM frontier WHERE state = 0 LIMIT 1").first();
  if (left) return 0;
  const stmts = [];
  for (const s of SEEDS) {
    const url = crawlable(s);
    if (!url) continue;
    const host = hostOf(url);
    stmts.push(db.prepare("INSERT OR IGNORE INTO hosts (host) VALUES (?)").bind(host));
    stmts.push(db.prepare("INSERT OR IGNORE INTO frontier (url, host, depth, added_at) VALUES (?, ?, 0, ?)").bind(url, host, now));
  }
  await db.batch(stmts);
  return stmts.length / 2;
}

async function robotsFor(db, h, now, fetchFn) {
  if (h.robots && now - h.robots_at < LIMITS.robotsTtlMs) return JSON.parse(h.robots);
  let robots;
  try {
    const res = await fetchFn(`https://${h.host}/robots.txt`, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(10e3) });
    if (res.ok) robots = parseRobots(await readCapped(res, MAX_ROBOTS_BYTES));
    else if (res.status >= 400 && res.status < 500) robots = ALLOW_ALL; // no robots.txt: allowed (RFC 9309)
    else robots = null; // 5xx: treat as "do not crawl" for now
  } catch {
    robots = null;
  }
  if (!robots) {
    await db.prepare("UPDATE hosts SET next_at = ?, errors = errors + 1 WHERE host = ?").bind(now + LIMITS.robotsRetryMs, h.host).run();
    return null;
  }
  await db.prepare("UPDATE hosts SET robots = ?, robots_at = ? WHERE host = ?").bind(JSON.stringify(robots), now, h.host).run();
  return robots;
}

/** Fetch a page, following same-host redirects that robots.txt allows. */
async function fetchPage(url, robots, fetchFn) {
  let current = url;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    const res = await fetchFn(current, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs) });
    if (res.status < 300 || res.status >= 400) return { res, url: current };
    const next = crawlable(res.headers.get("location") || "", current);
    if (!next) return { res: null, url: current };
    if (hostOf(next) !== hostOf(current)) return { res: null, url: current, moved: next };
    if (!isAllowed(robots, robotsPath(next))) return { res: null, url: current };
    current = next;
  }
  return { res: null, url: current };
}

async function setState(db, url, state) {
  await db.prepare("UPDATE frontier SET state = ? WHERE url = ?").bind(state, url).run();
}

/**
 * Queue links. A link within the site is queued at `depth`. A link to another site queues that
 * site's home page at depth 0 instead: every site is explored from its own front door, so the
 * crawl keeps spreading across the web instead of dying out three clicks from the seeds.
 */
export async function queueLinks(db, links, base, depth, now, fromHost = hostOf(base)) {
  const stmts = [];
  const seen = new Set();
  for (const l of links) {
    if (l.nofollow) continue;
    let url = crawlable(l.href, base);
    if (!url) continue;
    const host = hostOf(url);
    if (neverCrawl(host)) continue;
    let d = depth;
    if (host !== fromHost) {
      url = crawlable(`https://${host}/`);
      d = 0;
      if (!url) continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    stmts.push(db.prepare("INSERT OR IGNORE INTO hosts (host) VALUES (?)").bind(host));
    stmts.push(db.prepare("INSERT OR IGNORE INTO frontier (url, host, depth, added_at) VALUES (?, ?, ?, ?)").bind(url, host, d, now));
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length / 2;
}

async function indexPage(db, url, host, page, now) {
  const hash = await sha256(page.text);
  const dup = await db.prepare("SELECT url FROM pages WHERE hash = ? AND url <> ? LIMIT 1").bind(hash, url).first();
  if (dup) return false;
  const old = await db.prepare("SELECT id FROM pages WHERE url = ?").bind(url).first();
  const title = page.title || page.description.slice(0, 80) || host;
  if (old) {
    await db.batch([
      db.prepare("UPDATE pages SET title = ?, description = ?, lang = ?, trackers = ?, hash = ?, crawled_at = ? WHERE id = ?")
        .bind(title, page.description, page.lang, page.trackers, hash, now, old.id),
      db.prepare("DELETE FROM pages_fts WHERE rowid = ?").bind(old.id),
      db.prepare("INSERT INTO pages_fts (rowid, title, description, body) VALUES (?, ?, ?, ?)").bind(old.id, title, page.description, page.text),
    ]);
  } else {
    const row = await db.prepare("INSERT INTO pages (url, host, title, description, lang, trackers, hash, crawled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(url, host, title, page.description, page.lang, page.trackers, hash, now).first();
    await db.prepare("INSERT INTO pages_fts (rowid, title, description, body) VALUES (?, ?, ?, ?)").bind(row.id, title, page.description, page.text).run();
  }
  return true;
}

async function unindex(db, url) {
  const old = await db.prepare("SELECT id FROM pages WHERE url = ?").bind(url).first();
  if (!old) return;
  await db.batch([
    db.prepare("DELETE FROM pages_fts WHERE rowid = ?").bind(old.id),
    db.prepare("DELETE FROM pages WHERE id = ?").bind(old.id),
  ]);
}

/** Crawl one page from one host. Returns what happened, for the round's summary. */
export async function crawlHost(db, h, now, fetchFn, room) {
  const job = await db.prepare("SELECT url, depth FROM frontier WHERE host = ? AND state = 0 ORDER BY depth, added_at LIMIT 1").bind(h.host).first();
  if (!job) return "empty";
  const robots = await robotsFor(db, h, now, fetchFn);
  if (!robots) return "robots-unreachable";
  const delayMs = Math.max(LIMITS.minDelayS, robots.delay ?? 0) * 1000;
  await db.prepare("UPDATE hosts SET next_at = ? WHERE host = ?").bind(now + delayMs, h.host).run();
  if (!isAllowed(robots, robotsPath(job.url))) { await setState(db, job.url, 2); return "disallowed"; }

  let got;
  try {
    got = await fetchPage(job.url, robots, fetchFn);
  } catch {
    await setState(db, job.url, 2);
    await db.prepare("UPDATE hosts SET errors = errors + 1 WHERE host = ?").bind(h.host).run();
    return "error";
  }
  if (got.moved) {
    await queueLinks(db, [{ href: got.moved, nofollow: false }], job.url, job.depth, now);
    await setState(db, job.url, 2);
    return "moved";
  }
  const res = got.res;
  if (res && (res.status === 429 || res.status === 503)) {
    await db.prepare("UPDATE hosts SET next_at = ? WHERE host = ?").bind(now + retryAfterMs(res, LIMITS.busyBackoffMs), h.host).run();
    return "busy"; // stays queued
  }
  const type = res?.headers.get("content-type") || "";
  if (!res || !res.ok || !/text\/html|application\/xhtml/i.test(type)) {
    if (res?.status === 404 || res?.status === 410) await unindex(db, got.url);
    await setState(db, job.url, 2);
    return "not-html";
  }

  const html = await readCapped(res, LIMITS.maxBytes);
  const page = extract(html, got.url);
  const header = headerRobots(res.headers.get("x-robots-tag"));
  const noindex = page.noindex || header.noindex;
  const nofollow = page.nofollow || header.nofollow;

  if (!nofollow && job.depth < LIMITS.maxDepth && room > 0) await queueLinks(db, page.links, page.base, job.depth + 1, now);

  const canonical = page.canonical && crawlable(page.canonical);
  let outcome;
  if (noindex) { await unindex(db, got.url); outcome = "noindex"; }
  else if (canonical && canonical !== got.url) {
    await queueLinks(db, [{ href: canonical, nofollow: false }], got.url, job.depth, now);
    outcome = "canonical-elsewhere";
  } else if (page.text.length < LIMITS.minText) outcome = "thin";
  else outcome = (await indexPage(db, got.url, h.host, page, now)) ? "indexed" : "duplicate";

  await setState(db, job.url, 1);
  if (got.url !== job.url) await db.prepare("INSERT OR REPLACE INTO frontier (url, host, depth, added_at, state) VALUES (?, ?, ?, ?, 1)").bind(got.url, h.host, job.depth, now).run();
  const after = await db.prepare("UPDATE hosts SET pages = pages + 1, errors = 0 WHERE host = ? RETURNING pages").bind(h.host).first();
  // A site that reached its cap is never crawled again: drop the rest of its queue.
  if (after && after.pages >= capFor(h.rank)) await db.prepare("DELETE FROM frontier WHERE host = ? AND state = 0").bind(h.host).run();
  return outcome;
}

/** Queued URLs, counted at most hourly (counting a big queue every minute costs D1 reads). */
async function queuedCount(db, now) {
  const m = await db.prepare("SELECT value, at FROM meta WHERE key = 'queued'").first();
  if (m && now - m.at < LIMITS.countEveryMs) return m.value;
  const n = (await db.prepare("SELECT count(*) AS n FROM frontier WHERE state = 0").first()).n;
  await db.prepare("INSERT OR REPLACE INTO meta (key, value, at) VALUES ('queued', ?, ?)").bind(n, now).run();
  return n;
}

const PICK = `SELECT host, robots, robots_at, rank FROM hosts h
  WHERE blocked = 0 AND next_at <= ? AND pages < ${CAP_SQL}
    AND EXISTS (SELECT 1 FROM frontier f WHERE f.host = h.host AND f.state = 0)`;

/** Hosts for this round: popular sites first (by rank), the rest by who has waited longest. */
async function pickHosts(db, now, n) {
  const ranked = (await db.prepare(`${PICK} AND rank IS NOT NULL ORDER BY rank LIMIT ?`).bind(now, Math.ceil(n * LIMITS.rankedShare)).all()).results;
  const taken = new Set(ranked.map((h) => h.host));
  const rest = (await db.prepare(`${PICK} ORDER BY next_at LIMIT ?`).bind(now, n).all()).results.filter((h) => !taken.has(h.host));
  return ranked.concat(rest).slice(0, n);
}

/** One cron round. */
export async function crawlOnce(db, { now = Date.now(), fetch: fetchFn = fetch, hostsPerRun = LIMITS.hostsPerRun, seed = true } = {}) {
  if (seed) await ensureSeeds(db, now);
  const queued = await queuedCount(db, now);
  const room = LIMITS.maxQueued - queued;
  const hosts = await pickHosts(db, now, hostsPerRun);
  const outcomes = await Promise.all(hosts.map((h) => crawlHost(db, h, now, fetchFn, room).catch(() => "error")));
  const summary = {};
  for (const o of outcomes) summary[o] = (summary[o] || 0) + 1;
  return { hosts: hosts.length, queued, ...summary };
}
