# VEIL web app

A static PWA (no framework) for infinitumveil.app. It is hosted as a Cloudflare Worker with static assets (`cloudflare.config.ts`, `wrangler.config.ts`, assets in `public/`).

- Downloads: the Android APK and the Chrome extension zip (`public/downloads/`).
- Tor connection check (links to the Tor Project's own check page). VEIL for Android has Tor built in.
- Link cleaner using the extension's tracker list.
- The $VEIL rewards summary and the ecosystem apps.
- The page also ships inside the Android app as its offline Hub. It detects when it runs there and switches to in-app mode.

`node scripts/build.js` regenerates `public/lib/trackers.js` (from `apps/veil/lib/privacy.js`) and the icons. Security headers are in `public/_headers`: strict CSP, `no-referrer`, `nosniff`, `X-Frame-Options: DENY`, HSTS, and the APK content type.

## Deploy (needs approval: production)

    pnpm --filter @infinitum/veil-web deploy     # build.js + cf deploy -> Worker "infinitum-veil-web"

**Live layout (since 2026-11-11).** The same Worker also serves the Infinitum product site (built in the separate site-build project, outputs/veil-site). One deploy carries both:

- `/`: the VEIL landing page, plus 404.html, robots.txt, sitemap.xml, llms.txt, assets/cumulus-id.js and icons/ (from the site build);
- `/start/`: this folder's `public/` (start page, `search.html`, `search.js`, lib/, icons/), with download links made absolute (`/downloads/...`);
- `/bot`: `public/bot.html`;
- `/downloads/*.apk`: served by `src/worker.js` from the private R2 bucket `veil-downloads` (binding `DOWNLOADS`). The real APK (about 10 MB with Tor for arm64, 28 MB with all three CPU types) is over the static-asset size cap, so it is never in the merged folder: upload it to the bucket (key `veil-browser.apk`). The extension zip stays a static file in `/downloads/`;
- `POST /api/search` and `POST /api/ask`: `src/worker.js`, with the D1 binding `VEIL_INDEX` and the Workers AI binding `AI`.

Deploying only this folder, or only the site build, removes the other half. The search box then falls back to an old copy that leaves VEIL. Always deploy the merged folder.

## Search sources

`/api/search` (`src/worker.js`) asks every search API it has a key for at the same time,
blends the answers (`src/sources.js`), and shows which source found each result. Keys are
Worker secrets and never reach the browser:

| Source | Secrets | Get a key |
|---|---|---|
| Yandex | `YANDEX_SEARCH_KEY`, `YANDEX_FOLDER_ID` | Yandex Cloud Search API: an API key with the `search-api.webSearch.user` role, and its folder ID |
| Brave | `BRAVE_SEARCH_KEY` | Brave Search API |
| Mojeek | `MOJEEK_SEARCH_KEY` | Mojeek Search API |

Set one with `npx wrangler secret put <NAME> --name infinitum-veil-web`.

These sources need no key and are always asked:

| Source | What it adds |
|---|---|
| VEIL index | Pages VEILBot has crawled (`apps/veil-crawler`, D1 `VEIL_INDEX`). Ranked first. |
| Hacker News | Algolia's HN Search API: up to 4 stories with 10+ points. |
| Stack Overflow | Stack Exchange API: up to 4 questions whose title or tags match the search (CC BY-SA). About 300 searches a day without a key; a free app key from stackapps.com, set as the plain variable `STACKEXCHANGE_KEY`, raises that to 10,000. |

Hacker News and Stack Overflow are specialist, so their results count for half in the
blend and never decide paging.
Google, Bing and DuckDuckGo have no general web search API open to new customers, and VEIL
does not scrape their result pages. VEIL never sends a search to another engine's page.

**No Wikipedia.** VEIL never asks Wikipedia, and every result from Wikipedia, its sister
projects (Wikidata, Wiktionary…) or its mirrors (Wikiwand…) is removed from every source
(`src/answer.js` `isWiki`). VEILBot doesn't crawl them either.

## VEIL Answers (`POST /api/ask`)

The search page answers like Perplexity: the question, the sources found, a short answer that
cites them as [1], [2]…, related questions, and a follow-up box. Web results sit under the
first answer.

1. **Search.** The question's keywords (question and filler words dropped) go to every source
   above. If nothing matches, VEIL retries with fewer words. Follow-ups such as "and on
   Android?" are searched together with the previous question.
2. **Read.** The top 6 results are read. Pages in VEIL's index are read from the index (VEILBot
   already stored their text), so nothing is fetched again. Other pages are fetched once
   (3.5 s timeout, `VEIL-Answers/1.0` user agent), and only the passage that best matches the
   question is kept.
3. **Answer.** Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, or the plain variable
   `ANSWER_MODEL`) writes the answer from those passages only, citing each fact. It streams to
   the page as newline-separated JSON events: `sources`, `results`, `text`…, `related`,
   `done` (or `error`). With nothing found, VEIL says so without calling the model.

Workers AI is billed per use (it has a free daily allowance). Every answer makes two model
calls: the answer, and the related questions.
