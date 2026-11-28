#!/usr/bin/env node
// Seed VEILBot with popular sites from the Tranco list (https://tranco-list.eu, a research
// ranking of the top 1M sites that averages several sources and resists manipulation).
//
//   node scripts/tranco.mjs <top-1m.csv> <how-many> <out-dir> [list-id]
//
// Writes SQL files of about 1 MB (D1 caps one statement at 100 KB, so rows go in blocks of
// 400). Each site's rank is set on both the bare domain and its www. host, and its home page
// is queued at depth 0. Apply them with: cf d1 execute veil-index --remote --file <file>
// Sites VEILBot never crawls (seeds.js NEVER) and adult sites are left out.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { neverCrawl } from "../src/seeds.js";
import { crawlable, hostOf } from "../src/url.js";

const ADULT = /(porn|xxx|xvideo|xhamster|sex|hentai|onlyfans|camgirl|chaturbate|stripchat|bongacams|nude|erotic|escort|brazzers|redtube|youporn|spankbang|livejasmin)/i;
const BLOCK = 400;
const PER_FILE = 6000; // domains per file, about 1 MB of SQL

export function pickDomains(csv, n) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    if (out.length >= n) break;
    const m = /^(\d+),([a-z0-9.-]+)$/i.exec(line.trim());
    if (!m) continue;
    const rank = Number(m[1]);
    const domain = m[2].toLowerCase();
    if (ADULT.test(domain) || neverCrawl(domain) || neverCrawl("www." + domain)) continue;
    const home = crawlable(`https://${domain}/`);
    if (!home || hostOf(home) !== domain) continue;
    out.push({ rank, domain, home });
  }
  return out;
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export function toSql(domains) {
  const parts = [];
  for (let i = 0; i < domains.length; i += BLOCK) {
    const b = domains.slice(i, i + BLOCK);
    const hosts = b.flatMap((d) => [`(${q(d.domain)},${d.rank})`, `(${q("www." + d.domain)},${d.rank})`]);
    parts.push(`INSERT INTO hosts (host, rank) VALUES ${hosts.join(",")} ON CONFLICT(host) DO UPDATE SET rank = excluded.rank;`);
    parts.push(`INSERT OR IGNORE INTO frontier (url, host, depth, added_at) VALUES ${b.map((d) => `(${q(d.home)},${q(d.domain)},0,0)`).join(",")};`);
  }
  return parts.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const [csvPath, howMany, outDir, listId = ""] = process.argv.slice(2);
  if (!csvPath || !howMany || !outDir) {
    console.error("usage: node scripts/tranco.mjs <top-1m.csv> <how-many> <out-dir> [list-id]");
    process.exit(2);
  }
  const domains = pickDomains(readFileSync(csvPath, "utf8"), Number(howMany));
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  for (let i = 0; i < domains.length; i += PER_FILE) {
    const name = join(outDir, `tranco-${String(++files).padStart(3, "0")}.sql`);
    writeFileSync(name, `-- Tranco ${listId} ranks ${domains[i].rank}..${domains[Math.min(i + PER_FILE, domains.length) - 1].rank}\n` + toSql(domains.slice(i, i + PER_FILE)));
  }
  console.log(`${domains.length} sites in ${files} files (top rank ${domains[0]?.rank}, last ${domains.at(-1)?.rank})`);
}
