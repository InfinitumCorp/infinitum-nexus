# VEILBot (veil-crawler)

VEIL's own web crawler and search index. Design: `docs/VEIL-CRAWLER.md`. Public page for site
owners: https://infinitumveil.app/bot (`apps/veil-web/public/bot.html`).

- `src/crawl.js`: one crawl round, run by a cron every minute. Picks up to 30 sites whose
  politeness clock has run out and fetches one page from each. It checks robots.txt (re-read
  daily) first and never asks a site more often than every 10 s or its `Crawl-delay`. It
  backs off on 429/503, follows only same-site redirects, and reads HTML only (2 MB cap).
- `src/robots.js` (RFC 9309), `src/url.js` (public pages only: no IPs, logins, carts,
  session links or downloads), `src/html.js` (text, links, robots meta, canonical, trackers
  counted with VEIL's blocklist), `src/seeds.js` (start sites; Wikipedia, search engines and
  social networks are never crawled).
- `src/search.js`: full-text search over the index (D1 FTS5, BM25; pages with fewer
  trackers rank higher). infinitumveil.app binds the same D1 database (`VEIL_INDEX`) and asks
  it first in `/api/search`.
- `migrations/0001_init.sql`: the schema.

Tests: `node --test test/` (Node 22.5+, uses the built-in SQLite as a stand-in for D1).

Go live (production: needs approval): create and migrate the `veil-index` D1 database
(`cf d1 migrations apply veil-index --remote`), then `cf deploy` here and in `apps/veil-web`.
Pause crawling with the Worker variable `CRAWL_PAUSED=1`. Opt a site out with
`UPDATE hosts SET blocked = 1 WHERE host = '<host>'`.
