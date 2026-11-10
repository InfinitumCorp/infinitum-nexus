# VEILBot: VEIL's own web crawler and index

Status: design, not built. Owner: VEIL. Last updated 2026-11-11.

## Why

VEIL search answers from the Brave Search API when it has a key, and from Wikipedia when it
doesn't (`apps/veil-web/src/worker.js`). Both are someone else's index: they can change
terms, raise prices or cut us off, and the Wikipedia fallback only finds Wikipedia articles.
An index of our own makes VEIL search independent, and lets us rank for privacy (sites
with fewer trackers rank higher), something no rented index does.

## Goals and non-goals

Goals:
- Crawl the public web politely and lawfully, and build an index VEIL search can answer from.
- Run on what we already run: Cloudflare Workers, Queues, Durable Objects, R2 and D1.
- Keep VEIL's privacy promise: queries are never logged, and the index holds public pages
  only.
- Start small and useful (millions of pages), with a path to more.

Non-goals (for now):
- A Google-sized index. Billions of pages is a later, very different budget.
- Crawling behind logins, paywalls, CAPTCHAs or bot checks. VEILBot never gets around them.
- Images, video, or running page JavaScript (text HTML only in phase 1).

## Rules VEILBot always follows

These are hard requirements, enforced in code and tested, not settings.

1. **Says who it is.** User-Agent `VEILBot/1.0 (+https://infinitumveil.app/bot)`. The `/bot`
   page explains what VEILBot is, how to block it, and how to contact us. Never a browser UA.
2. **Obeys robots.txt** (RFC 9309): rules for `VEILBot` first, then `*`. Fetched at most once
   a day per host and cached. If robots.txt answers 5xx or times out, the host is not crawled.
   `Crawl-delay` is honoured.
3. **Obeys page-level opt-outs:** `noindex` and `nofollow` in `<meta name="robots">` and the
   `X-Robots-Tag` header. `noindex` pages are dropped from the index, including on recrawl.
4. **Polite:** one request at a time per host, at least 5 seconds apart (or Crawl-delay,
   whichever is longer). Backs off on 429 and 503 and respects `Retry-After`.
5. **Stops when told:** any site can opt out on `/bot` or by email. Opt-outs take effect within
   24 hours, and VEIL removes their pages from the index.
6. **No bypassing:** no proxies or rotating IPs to get around blocks, no CAPTCHA solving, no
   logins. A block is a no.
7. **Public pages only:** skip URLs with session tokens, `?token=`, `/login`, `/account` and
   similar; never store form data or cookies. Pages are stored only to build the index.

Also consider joining Cloudflare's verified bots program and signing requests (Web Bot Auth)
once VEILBot has steady traffic, so sites can trust it is really us.

## Architecture

```
seed lists ──► Frontier (Durable Object per host) ──► fetch queue (Queues)
                     ▲                                      │
                     │ new links                            ▼
                     │                              Fetcher Worker
                     │                         robots ✓ ─ fetch ─ parse
                     │                                      │
                     └────────── Parser Worker ◄────────────┘
                                     │ text, title, links, tracker count
                                     ▼
                          R2: raw pages (compressed)
                                     │
                          Indexer (scheduled Worker)
                                     ▼
                  D1 shards: full-text index (FTS5) + page facts
                                     ▲
       VEIL search Worker ── /api/search ── fan-out query, merge, rank
```

### Frontier: one Durable Object per host

Each host (`example.com`) gets a Durable Object holding its URL queue, robots.txt cache,
last-fetch time, error count and opt-out flag. That gives per-host politeness for free:
the object releases one URL at a time on an alarm, spaced by the crawl delay. A global
coordinator only decides how many hosts are active, so total crawl speed scales with the
number of hosts, not by hitting any one host harder.

URL priority inside a host: pages linked from many hosts first, then shallow paths, then
pages not crawled in a while.

### Fetcher

A Queue consumer Worker takes a batch of URLs (each from a different host) and for each:
- checks robots.txt (from the host object; fetches it if stale),
- fetches with the VEILBot UA, a 15-second timeout, and a 2 MB body cap,
- accepts only `text/html` with a 2xx status; follows up to 5 redirects, each checked
  against robots.txt,
- hands the body to the parser and reports status and timing back to the host object.

### Parser

Pulls out the title, meta description, visible text, language, canonical URL, outgoing
links (normalised, fragments dropped, `nofollow` respected), and robots directives. Counts
known trackers on the page with VEIL's own blocklist (`apps/veil/lib/blocklist.js`), which
feeds privacy ranking. Near-duplicates are found with a 64-bit SimHash of the text, and
only the canonical copy is indexed.

### Storage

- **R2:** the raw HTML, gzip-compressed, keyed by URL hash. Kept 30 days so the index can be
  rebuilt without recrawling. About 15 KB per page compressed, so 10 million pages ≈ 150 GB.
- **D1, sharded:** N databases (start with 16), each holding a slice of pages by URL hash:
  a `pages` table (url, title, snippet text, host, language, crawled_at, tracker count,
  quality score) and an FTS5 table over title and body text. D1 caps a database at 10 GB,
  so 16 shards hold roughly 10–20 million pages with trimmed body text (the first ~4 KB of
  text per page).

Alternative if D1 gets tight: write index segments (for example Tantivy, compiled to WASM)
to R2 and query them from a Worker. More work, but no per-database cap.

### Query path

`/api/search` sends the query to every D1 shard in parallel (FTS5 BM25, top 20 each),
merges, re-ranks, and returns 10. Brave and Wikipedia stay as fallbacks: when our index
returns too few results, the Worker fills the page from them and the results line says
where results came from.

## Ranking

Score = BM25 text match, then adjusted by:
- **Host authority:** a host-level PageRank computed weekly over the host link graph.
- **Privacy:** fewer trackers on the page ranks higher. This is VEIL's edge; keep it clearly
  explained on the results page.
- **Freshness:** for queries that look time-sensitive.
- **Quality and spam:** penalise thin pages, keyword stuffing, link farms and parked
  domains; drop known malware and phishing hosts.

## Recrawl

Pages that change often (news front pages) are revisited daily; most pages every 2–4 weeks;
pages that never change, less often. Use `ETag` and `Last-Modified` with conditional requests
so unchanged pages cost almost nothing to us and to the site.

## Where to start (seeds)

1. External links from Wikipedia articles (high quality, many languages).
2. A public top-sites ranking such as the Tranco list (top 1 million hosts).
3. Optionally, the Common Crawl host graph to find more hosts, after checking its terms of
   use for commercial use.

## Privacy

- Queries are never logged or stored, same as today. Only aggregate counts (requests per
  minute) for capacity.
- Crawling stores only public pages; no personal data is collected on purpose, and pages
  can be removed on request.
- The `/bot` page and the results page say plainly how VEIL search works.

## Phases

| Phase | Scope | Done when |
|---|---|---|
| 1. Prototype | Frontier, fetcher, parser, 1 D1 shard; crawl 100k pages from Wikipedia links | Our index answers searches on a test page, robots and politeness covered by tests |
| 2. Useful index | 16 shards, host PageRank, SimHash dedupe, recrawl, `/bot` page and opt-out | 5–10 million pages; VEIL search uses our index first, Brave/Wikipedia fill gaps |
| 3. Grow | More shards or R2 index segments, more languages, verified bot | 50 million+ pages; fallback rarely needed |

## Costs and limits to check before building

- Workers subrequest and CPU-time limits per invocation, Queues throughput, Durable Object
  request pricing, R2 storage and D1 row read/write pricing. Check current Cloudflare pricing
  pages; do not rely on this doc's numbers.
- Rough order of magnitude for phase 2 (10 million pages, monthly recrawl): tens to low
  hundreds of US dollars a month, mostly D1 writes and Durable Object requests.

## Legal

Before crawling at scale, have counsel review: terms-of-service exposure, copyright for
stored copies and snippets (keep snippets short), database rights in the EU, and data
protection for any personal data that appears on public pages (removal process under GDPR).
