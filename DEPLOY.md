# Infinitum Deployment Checklist

## Spectre (+SPCTR™) and Cumulus://ID

Production is the Cloudflare Worker `cumulus-id` (app `apps/spectre`) on https://id.cumuluscloud.app. It is the Sign in with Cumulus://ID issuer until the cut-over below moves the issuer to `InfinitumCorp/cumulus-id`. The same deploy serves the CRM. Do not rotate `FIRMAMENT_SIGNER_KEY`. Do not deploy from this checklist until someone asks: the command below is the one to run.

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

`CID_OIDC_SIGNING_KEY`, `SPECTRE_EXTRA_ORIGINS`, `NEXUS_STORE_URL`, `NEXUS_STORE_KEY`, `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`, `OMNIROUTE_SMART_MODEL`, `OMNIROUTE_FAST_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `CHATGPT_CLIENT_ID`, `CHATGPT_CLIENT_SECRET`, `CHATGPT_ISSUER`, `COGNITO_CLIENT_SECRET`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `CUMULUS_ROOT_DOMAIN`, `CUMULUS_ID_HOST`, `CUMULUS_KEYCLOAK_REALM`, `CUMULUS_CLOUD_HOST`, `CUMULUS_MAIL_HOST`, `CUMULUS_MAIL_ORIGIN`, `USE_METATRON`, `RESEND_API_KEY`, `MAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `CRON_SECRET`, `CONJURE_URL`, `CONJURE_PRODUCT_KEY`, `LBRNTH_ENDPOINT`, `CID_DIRECTORY_KEY_SHA256`, `CID_EXPORT_KEY_SHA256`, `SPECTRE_AUTH`, `CID_ISSUER`, `CID_CLIENT_ID`.

`SPECTRE_AUTH` (unset by default) set to `oidc` makes +SPCTR an OpenID Connect client of the standalone Cumulus://ID issuer, with `CID_ISSUER` (default `https://id.cumuluscloud.app/realms/cumulus`) and `CID_CLIENT_ID` (default `spectre`). Unset, sign-in stays in process. Set it only at cut-over step (d) below.

`CID_EXPORT_KEY_SHA256` turns on `POST /api/id/export` (the account export for the issuer move). Set it only during the cut-over below and delete it afterwards.

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

### Cumulus://ID cut-over to InfinitumCorp/cumulus-id (prepared, not done)

The issuer moves to its own repository and Worker, `InfinitumCorp/cumulus-id` (`cumulus-id-v2` until the cut-over). +SPCTR moves to `https://spectre.infinitumcorporation.ai`. A person runs every step: they are production deploys, secrets and route/DNS changes. Full procedure and caveats: [docs/cumulus-id.md](docs/cumulus-id.md#moving-the-issuer-to-infinitumcorpcumulus-id).

- [ ] First: merge +SPCTR's OpenID Connect client mode (client `spectre`; see docs/cumulus-id.md, "+SPCTR as a client"). It is off until `SPECTRE_AUTH=oidc` is set, so it is safe to deploy before the move.
- [ ] (a) Deploy `cumulus-id-v2` from `InfinitumCorp/cumulus-id` on workers.dev, no routes, with the same `CID_OIDC_SIGNING_KEY` and `CID_RP_ID=id.cumuluscloud.app`.
- [ ] (b) Deploy this Worker with the export route, set `CID_EXPORT_KEY_SHA256`, `POST /api/id/export` with `x-cid-export-key`, run the importer in `InfinitumCorp/cumulus-id`, compare counts, then delete the secret and the export file.
- [ ] (c) Move the `id.cumuluscloud.app` custom domain from `cumulus-id` to `cumulus-id-v2`, and point the `ru.id.cumuluscloud.app` mirror at the new Worker.
- [ ] (d) Merge and deploy branch `cumulus-id-cutover-spectre-route` (one wrangler commit), which moves this Worker to `spectre.infinitumcorporation.ai`. Only at cut-over: deployed earlier it takes `id.cumuluscloud.app` away from the live issuer. Set `SPECTRE_AUTH=oidc` in the same deploy (plain var); `CID_ISSUER` and `CID_CLIENT_ID` default to `https://id.cumuluscloud.app/realms/cumulus` and `spectre`. Without it, +SPCTR keeps its own diverging account store after the move and its passkeys stop working on the new host.

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
