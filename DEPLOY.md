# Infinitum Deployment Checklist

## Spectre (+SPCTR™)
- [x] Restore full `apps/spectre/src/server/app.ts` (see `apps/spectre/src/server/RESTORE-APP.md`)
- [x] Confirm METATRON scoring (default-on via main.ts)
- [x] Research and query agent endpoints wired
- [x] Prospect and execution endpoints + UI buttons
- [x] Search, activities, pipeline stats, filters (amount/industry/stage/sort), contact research, metrics breakdown
- [x] Deal rehearsal endpoint + UI, fact deduplication, activity kind filter, industry metrics, export button
- [x] Research activity logging, avg probability, activity summary, research coverage
- [x] lastResearch timestamp, closingBefore filter, truncated research titles
- [x] Research confidence scores, search timeout, /api/research/status, improved agent routing, research error handling
- [x] Research snippets as facts, /api/research/history endpoint
- [x] Average research confidence in /api/research/status
- [x] Tightened snippet fact limits in research parser
- [x] Low-confidence fact count in /api/research/status
- [x] High-confidence fact count in /api/research/status
- [x] minConfidence filter on /api/companies
- [x] totalFacts count in /api/research/status
- [x] Research recommendations and prioritized queue endpoints + UI
- [x] Queue process and remove endpoints + buttons
- [x] Queue stats endpoint + UI
- [x] Auto-done on successful queue research
- [x] Confidence filter UI on Accounts
- [x] AI fact count and last research time on account research section
- [x] `pnpm --filter @infinitum/spectre typecheck`
- [x] Hosted storage: Supabase (`supabase/migrations`, `supabase/functions/nexus-store`) with atomic per-request saves
- [x] Vercel build: `node apps/spectre/scripts/build-vercel.mjs` (Build Output API; project root = repo root, install command skipped)
- [ ] Vercel env: `SPECTRE_ORIGIN`, `FIRMAMENT_SIGNER_KEY`, `NEXUS_STORE_URL`, `NEXUS_STORE_KEY` (+ optional `ANTHROPIC_API_KEY`, social sign-in)
- [ ] Deploy to Vercel

## Conductor (/CNDCTR/)
- [x] `pnpm --filter @infinitum/conductor typecheck`
- [ ] Deploy via Docker or Vercel

## METATRON (apps/metatron)
- [x] Server: Plaid linking, Alpaca/paper trading, guardrails, approvals, agents, Firmament audit
- [x] Tests: `node --test --experimental-strip-types apps/metatron/src/*.test.ts`
- [ ] Env: `METATRON_VAULT_KEY`, `FIRMAMENT_SIGNER_KEY`, `PUBLIC_ORIGIN`, `METATRON_ALLOWED_ORIGINS`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_COUNTRY_CODES` (+ optional `ALPACA_DATA_KEY_ID`/`ALPACA_DATA_SECRET`)
- [ ] Mount in the Cumulus://ID host with `cidAuth(cid)`; register `{PUBLIC_ORIGIN}/webhooks/plaid` with Plaid
- [ ] Refresh `pnpm-lock.yaml` (`pnpm install`) to include `@infinitum/metatron-app`

## FIRM
- [ ] `pnpm --filter @infinitum/firm compile`
- [ ] Set RPC URL and private key env vars
- [ ] `pnpm --filter @infinitum/firm deploy`
- [ ] `pnpm --filter @infinitum/firm anchor` (if anchoring)

## General
- [ ] All tests pass: `pnpm test`
- [ ] Update PRODUCT-DELIVERY.md status after deploy
