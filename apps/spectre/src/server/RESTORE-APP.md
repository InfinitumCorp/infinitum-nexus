# +SPCTR server

The HTTP app is `app.ts`. It is the Cumulus://ID issuer and the +SPCTR CRM: passkeys, social sign-in, OpenID Connect (when `CID_OIDC_SIGNING_KEY` is set), ledger-backed records, research, and the AI team. METATRON scoring is on unless `USE_METATRON` is set to something other than `1`.

Run it locally from the repository root:

```sh
node apps/spectre/src/server/main.ts
```

Open http://localhost:3000. Ask Spectre stays "not connected" until `OMNIROUTE_BASE_URL` or `OMNIROUTE_API_KEY` is set. The production Worker uses the free Workers AI binding first and only then those OmniRoute variables.

## Production

The live host is the Cloudflare Worker `cumulus-id` at https://id.cumuluscloud.app. State is the `NexusStore` Durable Object. Do not rotate `FIRMAMENT_SIGNER_KEY`. Deploy steps and the command are in the repository `DEPLOY.md`. This file does not deploy anything.

`https://ru.id.cumuluscloud.app` is a mirror (`SPECTRE_EXTRA_ORIGINS`). Passkeys work there because it shares the issuer host as rpId. Social sign-in returns to that mirror when the mirror sends `x-spctr-mirror: https://ru.id.cumuluscloud.app`. Any other value is ignored.

## Intentionally off

- ei·det·ic has no identity source. `matchIdentity` and `recordConsent` return `ei·det·ic is not configured`. They do not invent matches or consent receipts.
- Live payments are not wired.
- The $SPCTR token is not issued or transferred by this app.

## Environment and secret names

Names only. Values stay in `wrangler secret` or the host environment, never in git.

Worker binding (not a secret): `AI` (Cloudflare Workers AI, free daily allowance). Durable Object binding: `NEXUS_STATE`.

Required for the Worker: `FIRMAMENT_SIGNER_KEY`, `SPECTRE_ORIGIN`.

Required for the Vercel/Supabase path instead of the Durable Object: `NEXUS_STORE_URL`, `NEXUS_STORE_KEY`.

Optional, feature stays off when unset:

- `CID_OIDC_SIGNING_KEY`
- `SPECTRE_EXTRA_ORIGINS`
- `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`, `OMNIROUTE_SMART_MODEL`, `OMNIROUTE_FAST_MODEL`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
- `CHATGPT_CLIENT_ID`, `CHATGPT_CLIENT_SECRET`, `CHATGPT_ISSUER`
- `COGNITO_CLIENT_SECRET`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `COGNITO_REGION`, `COGNITO_USER_POOL_ID`
- `CUMULUS_ROOT_DOMAIN`, `CUMULUS_ID_HOST`, `CUMULUS_KEYCLOAK_REALM`, `CUMULUS_CLOUD_HOST`, `CUMULUS_MAIL_HOST`, `CUMULUS_MAIL_ORIGIN`
- `USE_METATRON`
- `RESEND_API_KEY`, `MAIL_FROM`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- `CRON_SECRET`
- `CONJURE_URL`, `CONJURE_PRODUCT_KEY`
- `LBRNTH_ENDPOINT`, `CID_DIRECTORY_KEY_SHA256`
