# Cumulus://ID issuer

> **The issuer is moving to its own repository, `InfinitumCorp/cumulus-id`** (Worker
> `cumulus-id-v2` until cut-over). It keeps the same issuer string, client ids, `/api/id/*`
> routes and `cid_<uuid>` account ids, and stores accounts in Supabase schema `cid`. Until a
> person runs the [cut-over](#moving-the-issuer-to-infinitumcorpcumulus-id) below, everything
> in this file still describes production. `packages/cid` stays in this repository: it is the
> in-process library +SPCTR uses for its own sign-in until +SPCTR signs in as the OpenID Connect
> client `spectre` of the new issuer. Do not delete it.

`id.cumuluscloud.app` (the `cumulus-id` Worker, app `apps/spectre`) is the issuer for
Sign in with Cumulus://ID. A person signs in there with a passkey, Google, or Amazon
Cognito. The first sign-in creates a Cumulus://ID. Products then receive an authorization
code and, when the signing key is set, an ID token whose `sub` is that cid.

The OpenID Connect issuer is `https://id.cumuluscloud.app/realms/cumulus`.
Discovery is served at both:

- `https://id.cumuluscloud.app/realms/cumulus/.well-known/openid-configuration`
- `https://id.cumuluscloud.app/.well-known/openid-configuration`

Both documents name the realm issuer. JWKS is
`https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs`.
Tokens are ES256 (or EdDSA, if that is the key that was loaded). Claims include
`sub` (the cid), `cid`, `username`, `preferred_username`, `handle`, `email`,
`email_verified`, `amr`, and `idp` (`google`, `cognito`, or `passkey`).

## Signing key

OpenID Connect stays off until `CID_OIDC_SIGNING_KEY` is set. Passkey, Google, and
Cognito sign-in still work, and `/api/id/*` still returns an opaque session token.
A missing or unusable key does not stop the Worker from booting.

Generate a key from the repository root. This writes a file and does not print the private key:

```sh
node apps/spectre/scripts/generate-oidc-key.mjs oidc-signing-key.jwk
cd apps/spectre
npx wrangler secret put CID_OIDC_SIGNING_KEY < ../oidc-signing-key.jwk
```

Keep a copy of the file somewhere safe. Deleting the secret turns signed tokens off
again. Do not commit the file (`oidc-signing-key.jwk` is gitignored).

Google and Cognito stay off until their own secrets are set. See `.env.example`.
For the Worker, `wrangler secret put` each of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `COGNITO_CLIENT_SECRET`. The Cognito pool id, region, domain, and client id are
already in `apps/spectre/wrangler.jsonc`.

## Where the cid is stored

The Worker keeps Firmament and the CID store in the `NexusStore` Durable Object
(`NEXUS_STATE`, name `cumulus-id`). That store is the source of truth for a cid
issued at `id.cumuluscloud.app`.

Cumulus://Mail's own ID routes (`mail.cumuluscloud.app/api/id/*`) stay up as an alias
so a button that already points there keeps working on deploy day. Those routes read
Mail's store, not NexusStore. A cid created on Mail is not the cid created on the ID
host.

Mail should treat the ID host as the issuer: send people to
`https://id.cumuluscloud.app` and read `/api/id/userinfo` (or the ID token) from
there. Do not copy NexusStore into Mail's Supabase store.

## Deploy cumulus-id

These steps are for the nexus Worker as it is today, before the cut-over. No DNS change is
required. The Worker route is already `id.cumuluscloud.app`.

```sh
# from the repository root
node apps/spectre/scripts/build-cloudflare.mjs
cd apps/spectre
npx wrangler secret put CID_OIDC_SIGNING_KEY < ../oidc-signing-key.jwk
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

`FIRMAMENT_SIGNER_KEY` must already be set. Do not rotate it as part of this change.
Confirm, after deploy:

```sh
curl -sI https://id.cumuluscloud.app/realms/cumulus/.well-known/openid-configuration
curl -sI https://id.cumuluscloud.app/api/auth/providers
```

Discovery is HTTP 200 only after the signing key is present. `/api/auth/providers`
is HTTP 200 either way. Google appears in that list only after both Google secrets
are set.

## Deploy cumulus-mail

Mail does not need a new secret for this change. Its button file still defaults to
`https://mail.cumuluscloud.app`, and its `/api/id/*` routes are unchanged in behavior.
Redeploy Mail only if you want the comment and `data-issuer` attribute in the hosted
button file. Existing buttons keep calling Mail.

## What each product changes

Load `https://id.cumuluscloud.app/id/button.js` (or copy `apps/spectre/public/id/button.js`)
and set `data-client`. `data-issuer` is optional because that file already defaults to
the ID host. Redirect URIs may be any `https` path on the origins below. The button
returns to the page the person is on.

| Product | `data-client` | Origin the redirect must use |
|---|---|---|
| Infinitum | `infinitum` | `https://infinitumcorporation.ai` (also `www` and `downloads`) |
| Cumulus://Cloud | `cumulus-cloud` | `https://drive.cumuluscloud.app` (also `cloud.cumuluscloud.app`, `cumuluscloud.app`, `www`) |
| Cumulus://Mail | `cumulus-mail` | `https://mail.cumuluscloud.app` (also `ru.mail.cumuluscloud.app`) |
| SCALVS | `scalvs` | `https://scalvs.app`, `https://www.scalvs.app`, `https://ru.scalvs.app` |
| Architect | `architect` | `https://rchtch.app` (also `www`) |
| VEIL | `veil` | `https://infinitumveil.app` (also `www`) |
| VEIL VPN | `veil-vpn` | `https://infinitumveilvpn.app` (also `www`) |
| Fabric | `fabric` | `https://infinitumfabric.app` (callback `/api/auth/callback`) |
| FIRM Wallet | `firm-wallet` | `https://firmwallet.app` (also `www`) |
| Firmament | `firmament` | `https://firmnetwork.app` (also `www`) |
| CNDCTR | `cndctr` | `https://cndctr.app` (callback `/api/auth/callback`) |
| Defense | `defense` | `https://infinitumdefense.com` (also `www`) |

Fabric, CNDCTR, and SCALVS already expect the realm issuer. They do not change their
issuer URL. SCALVS accepts the ES256 access tokens this issuer signs (it still accepts
RS256). Fabric and CNDCTR already accept ES256.

Example:

```html
<span data-cumulus-id></span>
<script src="https://id.cumuluscloud.app/id/button.js" data-client="scalvs" data-issuer="https://id.cumuluscloud.app" defer></script>
```

A page that loads the script from its own origin should copy the file and may omit
`data-issuer`. A page that must keep working against Mail during the rollout leaves
the script pointed at `https://mail.cumuluscloud.app/id/button.js`.

## Moving the issuer to InfinitumCorp/cumulus-id

A person runs this. Every step below is a production deploy, a secret, or a DNS/route change
(//RULES// §7). Nothing in this repository performs it, and the `id.cumuluscloud.app` route in
`apps/spectre/wrangler.jsonc` stays until step (d).

**Read this first.** Today one Worker is both the issuer and +SPCTR. +SPCTR signs people in with
its in-process `CidService` (`packages/cid`) against the `NexusStore` CID store, and its passkeys
are bound to the relying-party id `id.cumuluscloud.app`. After step (c) that store stops receiving
new accounts, and on `spectre.infinitumcorporation.ai` those passkeys no longer work. So the clean
order is: land +SPCTR as the OpenID Connect client `spectre` (not done yet; see "+SPCTR as a
client" below), then run (a) to (d) in one window. Running (d) earlier leaves +SPCTR with its own,
diverging account store.

The new issuer does not serve these routes that the nexus Worker serves on `id.cumuluscloud.app`
today. They move with +SPCTR in step (d), and their callers must be pointed at the new host:
`/api/auth/*` and the CRM API, `/api/labyrinth` and `/labyrinth` (the hosted Labyrinth relay;
`packages/lbrnth-openclaw` defaults to `https://id.cumuluscloud.app/api/labyrinth`),
`/api/id/labyrinth-directory` (the hosted Labyrinth's `RemoteCidDirectory` URL, see
`docs/LBRNTH-HOSTED.md`), `/api/drones/*` and `/api/veil/*`. Organizations (`orgId`, org SSO)
are not in the new issuer's store; the export carries `orgId` and `federated` so they can be
re-created or dropped deliberately.

### (a) Deploy the new Worker beside the old one

From `InfinitumCorp/cumulus-id`: apply its `supabase/migrations` (schema `cid`), set its secrets
(names in its `wrangler.jsonc`), and `npm run deploy`. It deploys as `cumulus-id-v2` on
`workers.dev` with no routes. Use the **same** `CID_OIDC_SIGNING_KEY` as the nexus Worker (same
`kid`), or publish the old public key in its JWKS next to the new one, so ID and access tokens
already issued keep verifying. Keep `CID_RP_ID` = `id.cumuluscloud.app` so existing passkeys
keep working. Check discovery on the `workers.dev` host.

### (b) Export and import accounts

1. Make a one-off key in a local file, outside any repository, and give the nexus Worker only its
   SHA-256 (hex):

   ```sh
   openssl rand -base64 48 | tr -d '\n' > cid-export.key
   (cd apps/spectre && printf %s "$(sha256sum < ../../cid-export.key | cut -d' ' -f1)" | npx wrangler secret put CID_EXPORT_KEY_SHA256)
   ```

   This branch's code must be deployed for the route to exist. With the secret unset,
   `POST /api/id/export` is not registered (404).
2. Export right before step (c), so accounts created in between are not lost:

   ```sh
   curl -sS -X POST https://id.cumuluscloud.app/api/id/export \
     -H "x-cid-export-key: $(cat cid-export.key)" -o cid-export.json
   ```

   The file holds TOTP secrets and linked-account subjects. Treat it like a secret: never
   commit it or paste it into chat, and delete it after the import. It never contains session
   tokens, token hashes, pending challenges, MFA steps or OAuth state, so everyone signs in once
   more on the new issuer. The route answers with no CORS headers and only to the key.
3. In `InfinitumCorp/cumulus-id`, run its importer on the file
   (`npm run import:nexus -- cid-export.json`) and compare its counts with `counts` in the file.
4. Delete the secret: `npx wrangler secret delete CID_EXPORT_KEY_SHA256`. Shred both files.

The format is `exportCidAccounts()` in `packages/cid/src/account-export.ts`:
`{ format: "cumulus-id.export", version: 1, issuer, exportedAt, counts, accounts: [...] }`, one
entry per account with its `authenticators`, `identities`, `grants` and confirmed `totp` nested
inside.

### (c) Move the ID hostnames to the new Worker

- `id.cumuluscloud.app`: remove the custom domain from the `cumulus-id` Worker and add it to
  `cumulus-id-v2` (its `wrangler.jsonc` has the routes commented out for this).
- `ru.id.cumuluscloud.app`: today a mirror of this app outside Cloudflare (`SPECTRE_EXTRA_ORIGINS`;
  see `apps/spectre/src/server/vercel.ts`). Point it at the new Worker (DNS change) and set the new
  Worker's `CID_MIRROR_ORIGINS`.
- `openpgpkey.cumuluscloud.app` (Web Key Directory) is new and optional.

Rollback: move the routes back. The `NexusStore` Durable Object is not changed by the export, so
the old issuer resumes with the state it had at the export.

### (d) Move +SPCTR to spectre.infinitumcorporation.ai

`https://spectre.infinitumcorporation.ai` is already the registered origin of client `spectre`.
A separate commit on the cut-over branch changes `apps/spectre/wrangler.jsonc` (route and
`SPECTRE_ORIGIN`). Deploy it only in this step: deploying it earlier takes `id.cumuluscloud.app`
away from the live issuer. The `infinitumcorporation.ai` zone must be on the Cloudflare account
for the custom domain. Social sign-in providers (Google, Cognito) need
`https://spectre.infinitumcorporation.ai/api/auth/oauth/<provider>/callback` registered while +SPCTR
still signs in in-process.

## +SPCTR as a client (not built yet)

What +SPCTR needs to sign in through the external issuer as client `spectre`. Estimated at
roughly 600 to 900 changed lines, most of it in tests:

- `apps/spectre/src/server/app.ts`, sign-in routes (`/api/auth/signup*`, `/signin*`, `/mfa`,
  `/oauth/:provider/*`, about 100 lines): replace with `/api/auth/login` (redirect to the issuer's
  `authorize` with PKCE S256, `state` and `nonce` in a short cookie) and `/api/auth/callback`
  (exchange the code, verify the ID token against the issuer's JWKS; `verifyIdToken` in
  `packages/cid/src/oidc.ts` already verifies an external issuer's tokens), then set +SPCTR's own
  session cookie keyed by `sub`. `/api/auth/signout` also calls the issuer's `revoke`/`logout`.
- Request authentication (the `cid.authenticate(token)` / `cid.can(..., "spectre", "crm:*")` block
  near the end of `app.ts`, and `ensureGrant`): a small local session table plus local CRM
  permissions, since grants and organizations no longer come from the CID store. `ctx.user.account`
  becomes a profile built from the ID token (`cid`, `username`, `email`, `handle`). Workspaces are
  keyed by `orgId ?? cid` today; with no organizations at the issuer, existing org workspaces need a
  local org table or a mapping.
- `/api/me/identities` and unlink: link to `https://id.cumuluscloud.app/account` instead.
- `apps/spectre/public/app.js` (about 60 lines: passkey ceremonies, MFA prompt, social buttons):
  one "Sign in with Cumulus://ID" button.
- The hosted Labyrinth relay and `/api/id/labyrinth-directory` resolve the +SPCTR cookie through
  the CID store. They need either the issuer's access token plus a directory on +SPCTR's host, or a
  directory at the new issuer. This is the largest open design question.
- Tests: `test-harness.ts` signs up with a virtual passkey and 14 HTTP test files use it. The
  harness needs a fake issuer (authorize, token, JWKS) so `signUp` returns a +SPCTR cookie.
- `main.ts`, `vercel.ts`, `worker.ts`: new variables `CID_ISSUER` and `CID_CLIENT_ID=spectre`.
  `suite.summary(cid)` and the CRM keep working unchanged because they are keyed by the same cid.

