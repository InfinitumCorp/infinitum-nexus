# Infinitum Deployment Checklist

## Spectre (+SPCTR™) and Cumulus://ID

Production is the Cloudflare Worker `cumulus-id` (app `apps/spectre`) on https://id.cumuluscloud.app. It is the Sign in with Cumulus://ID issuer. The same deploy serves the CRM. Do not rotate `FIRMAMENT_SIGNER_KEY`. Do not deploy from this checklist until someone asks: the command below is the one to run.

- [x] Full server in `apps/spectre/src/server/app.ts` (see `apps/spectre/src/server/RESTORE-APP.md`)
- [x] METATRON scoring (default-on via main.ts)
- [x] Research, agents, prospect, and execution routes
- [x] Ask Spectre uses the free Workers AI binding `AI`, then `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY`, then the existing not-connected message
- [x] Social sign-in fetch is called as a plain function (Workers `Illegal invocation`)
- [x] Social OAuth returns to `https://ru.id.cumuluscloud.app` when that mirror started the flow (`x-spctr-mirror`)
- [x] ei·det·ic returns "not configured" (no identity source). Payments and the $SPCTR token stay off
- [x] Worker state: `NexusStore` Durable Object. Supabase `nexus-store` remains the Vercel path
- [ ] Deploy the Worker (not done by the branch that added the AI binding)

### Worker env and secret names

Names only. The `AI` binding and `NEXUS_STATE` Durable Object are in `apps/spectre/wrangler.jsonc`. They are not secrets.

Required secret: `FIRMAMENT_SIGNER_KEY`.

Required var (already in wrangler.jsonc): `SPECTRE_ORIGIN`.

Optional secrets and vars. The feature stays off when the name is unset:

`CID_OIDC_SIGNING_KEY`, `SPECTRE_EXTRA_ORIGINS`, `NEXUS_STORE_URL`, `NEXUS_STORE_KEY`, `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`, `OMNIROUTE_SMART_MODEL`, `OMNIROUTE_FAST_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `CHATGPT_CLIENT_ID`, `CHATGPT_CLIENT_SECRET`, `CHATGPT_ISSUER`, `COGNITO_CLIENT_SECRET`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `CUMULUS_ROOT_DOMAIN`, `CUMULUS_ID_HOST`, `CUMULUS_KEYCLOAK_REALM`, `CUMULUS_CLOUD_HOST`, `CUMULUS_MAIL_HOST`, `CUMULUS_MAIL_ORIGIN`, `USE_METATRON`, `RESEND_API_KEY`, `MAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `CRON_SECRET`, `CONJURE_URL`, `CONJURE_PRODUCT_KEY`, `LBRNTH_ENDPOINT`, `CID_DIRECTORY_KEY_SHA256`.

`NEXUS_STORE_KEY` is only for the Vercel/Supabase path. The Worker does not read it.

### Deploy command

From the repository root, after `pnpm install`:

```sh
node apps/spectre/scripts/build-cloudflare.mjs && (cd apps/spectre && npx wrangler deploy)
```

Check the build without publishing:

```sh
node apps/spectre/scripts/build-cloudflare.mjs && (cd apps/spectre && npx wrangler deploy --dry-run)
```

OpenID Connect details: [docs/cumulus-id.md](docs/cumulus-id.md). `CID_OIDC_SIGNING_KEY` stays optional.

Vercel (`node apps/spectre/scripts/build-vercel.mjs`) is the alternate host. It needs `SPECTRE_ORIGIN`, `FIRMAMENT_SIGNER_KEY`, `NEXUS_STORE_URL`, and `NEXUS_STORE_KEY`. It has no Workers AI binding; set `OMNIROUTE_BASE_URL` or `OMNIROUTE_API_KEY` there if Ask Spectre should answer.

## Architect (:\ARCHITECT\\)
- [x] `pnpm --filter @infinitum/architect typecheck`
- [ ] Deploy via Docker or Vercel

## FIRM
- [ ] `pnpm --filter @infinitum/firm compile`
- [ ] Set RPC URL and private key env vars
- [ ] `pnpm --filter @infinitum/firm deploy`
- [ ] `pnpm --filter @infinitum/firm anchor` (if anchoring)

## General
- [ ] All tests pass: `pnpm test`
- [ ] Update PRODUCT-DELIVERY.md status after deploy
