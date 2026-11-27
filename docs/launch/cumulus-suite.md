# Cumulus://Suite launch checklist

Status as of 2026-11-27. Products: Cumulus://ID (`id.cumuluscloud.app`, `apps/spectre`), Cumulus://Mail
(`mail.cumuluscloud.app`, `apps/cumulus-mail`), Cumulus://Cloud / Drive (`drive.cumuluscloud.app`,
`InfinitumCorp/cumulus-exchange`), FIRM Wallet (`apps/firm-wallet`), and the Russia issuer
(`InfinitumCorp/cumulus-id-ru`).

## Done

| Area | State |
|---|---|
| Supabase (project `ivqiskeziohbbtkcvlun`) | Migrations `20261115`–`20261124` applied 2026-11-20; every function checked identical to `supabase/migrations`; `nexus-store` redeployed (version 3). A rolled-back dry run of the first claim copied mail (9 mailboxes, 28 messages), wallet (9), quota (9) and matched the ID rows. |
| Drive on Supabase | `cumulus-drive` bucket private, 50 MB per file, no storage policies, no auth hook; the `drive` function (version 4) matches `cumulus-exchange` main. |
| Mail config | `CUMULUS_STORE=gateway`, `CUMULUS_ROWS=mail,wallet,quota,drive` (#278), tested end to end in `apps/cumulus-mail/src/production-config.http.test.ts`. |
| Auto deploy | Deploys the `cumulus-id` Worker from the live-UI bundle (#280, Wrangler pinned in #297) and then Mail with `cf deploy` (#281), from main once CI is green. Both dry-run cleanly. |
| Account bar | `/id/bar.js` embedded in the ID Worker bundle (#279); served after the next deploy. |
| Fixes since 11-18 | Drive rows and race fixes (#260–#268), alias and identity fixes (#272), quota and payment fixes (#273, #274), one needless document write a minute (#294), single-server Mail files and Drive (#295), Node CSP styles (#296). |
| Browser checks (2026-11-27) | Mail: sign-up, welcome mail, send and open, Drive folder, document save and reload, wallet, sign out and in. ID: create, dashboard, sign out and in. Drive console: upload and reload. FIRM Wallet pages load without errors. |
| Russia issuer | `cumulus-id-ru` pins main `54402d8` (#4). |

## Blocking launch (needs a person)

1. **Cloudflare secrets for this repository.** Auto deploy still logs "CLOUDFLARE_API_TOKEN is not set for
   this repository; nothing deployed." In GitHub: InfinitumCorp, Settings, Secrets and variables,
   **Actions**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must list `infinitum-nexus` (or "All
   repositories"). Then run Auto deploy once by hand (Actions, Auto deploy, Run workflow). Until then
   nothing merged since 2026-11-20 is live: the ID site still shows Amazon Cognito sign-in (#256) and
   `/id/bar.js` answers 404.
2. **Russia issuer**: `ssh cumulus-id-russia 'bash -s' < scripts/setup.sh` from `cumulus-id-ru`.
3. **Drive console deploy**: follow `cloud/DEPLOY.md` in `cumulus-exchange` (Worker, DNS, smoke test); the
   Supabase part is done.

## After the first deploy, check

- `select product, document_version, copied from cumulus_rows.claims;` lists cid (matched), mail, wallet,
  quota; `select cumulus_rows.compare_with_documents();` says `"same": true` right after.
- `nexus_docs.version` for `cumulus-mail` stops climbing about once a minute (#294).
- `https://id.cumuluscloud.app/id/bar.js` answers 200 with the bytes in `apps/spectre/live-ui/id/bar.js`.
- Rollback: `docs/plans/relational-storage.md`, "Cutover runbook".

## Decisions for the owner

- **grok.com script on the Drive console.** Production builds load
  `https://grok.com/grok-app-builder/extensions.js` unless `VITE_GROK_EXTENSIONS=0`
  (`cumulus-exchange/scripts/grok-pwa-shared.mjs`). A third-party script on the page that holds people's
  files; turning it off changes the website, so it waits for approval.
- **Cloudflare Web Analytics on id.cumuluscloud.app.** The injected beacon
  (`static.cloudflareinsights.com`) is blocked by the Worker's Content Security Policy. Either turn the
  automatic injection off in the Cloudflare dashboard, or allow that host in `static-policy.ts`.
- **Message paging in Mail** needs a change to the Mail page (reads still load a whole mailbox).

## Known gaps (not blocking)

- Mail attachment files are never deleted (forwarded mail shares them, so it needs reference counting,
  and sealed messages hide which keys they use).
- A scheduled send that fails after the draft became a Sent copy says "waiting in Drafts"; the main cause
  (quota) is checked first since #273.
