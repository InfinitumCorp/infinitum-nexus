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
order is: merge +SPCTR's OpenID Connect client mode (built, off by default; see "+SPCTR as a
client" below), then run (a) to (d) in one window, with (d) setting `SPECTRE_AUTH=oidc`. Running
(d) without it leaves +SPCTR with its own, diverging account store.

The new issuer does not serve these routes that the nexus Worker serves on `id.cumuluscloud.app`
today. They move with +SPCTR in step (d), and their callers must be pointed at the new host:
`/api/auth/*` and the CRM API, `/api/labyrinth` and `/labyrinth` (the hosted Labyrinth relay;
`packages/lbrnth-openclaw` defaults to `https://id.cumuluscloud.app/api/labyrinth`),
`/api/id/labyrinth-directory` (the hosted Labyrinth's `RemoteCidDirectory` URL, see
`docs/LBRNTH-HOSTED.md`), `/api/drones/*` and `/api/veil/*`. Organizations (`orgId`, org SSO)
are not in the new issuer's store; the export carries each account's `orgId` and `federated`, and
a top-level `organizations` list, so they can be re-created or dropped deliberately.

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
`{ format: "cumulus-id.export", version: 1, issuer, exportedAt, counts, accounts: [...], organizations: [...] }`,
one entry per account with its `authenticators`, `identities`, `grants` and confirmed `totp` nested
inside. `organizations` (added to version 1; importers that predate it ignore it) is sorted by id:
`{ id: "org_<uuid>", name, admins: ["cid_..."], sso: { issuer, audience, emailDomain } | null }`.
The organization's SSO signing keys (`jwks`) are not exported: the new issuer re-discovers them
from `sso.issuer`.

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
The branch `cumulus-id-cutover-spectre-route` holds one commit that changes `apps/spectre/wrangler.jsonc` (route and
`SPECTRE_ORIGIN`). Deploy it only in this step: deploying it earlier takes `id.cumuluscloud.app`
away from the live issuer. The `infinitumcorporation.ai` zone must be on the Cloudflare account
for the custom domain.

In the same deploy, set `SPECTRE_AUTH=oidc` (a plain var in `apps/spectre/wrangler.jsonc`, not a
secret; add it to the route commit). +SPCTR then signs people in at the new issuer as client
`spectre`, and the passkey, MFA and social sign-in routes answer 404. `CID_ISSUER` and
`CID_CLIENT_ID` default to `https://id.cumuluscloud.app/realms/cumulus` and `spectre`; set them only
to test against another issuer. Without `SPECTRE_AUTH=oidc`, social sign-in providers (Google,
Cognito) would need `https://spectre.infinitumcorporation.ai/api/auth/oauth/<provider>/callback`
registered, and passkeys bound to `id.cumuluscloud.app` would not work there.

At the same time, delete `CID_OIDC_SIGNING_KEY` from the `cumulus-id` (+SPCTR) Worker:
`npx wrangler secret delete CID_OIDC_SIGNING_KEY`. Otherwise two hosts sign tokens with the same
issuer string and key, and +SPCTR could mint tokens for accounts the new issuer does not have.
The wrangler commit also drops `SPECTRE_EXTRA_ORIGINS`: `ru.id.cumuluscloud.app` is not under the
new relying-party id, and the Worker refuses to start with a mirror outside it.

## +SPCTR as a client

+SPCTR can sign in as the OpenID Connect client `spectre` of the standalone issuer. It is **off by
default**: with `SPECTRE_AUTH` unset, +SPCTR runs Cumulus://ID in process exactly as before, so this
code is safe to deploy before the cut-over.

| Variable | Default | |
|---|---|---|
| `SPECTRE_AUTH` | unset (in-process Cumulus://ID) | `oidc` turns on client mode. Set at cut-over step (d). |
| `CID_ISSUER` | `https://id.cumuluscloud.app/realms/cumulus` | Discovery and JWKS are read from here. |
| `CID_CLIENT_ID` | `spectre` | Registered in `InfinitumCorp/cumulus-id` `src/clients.ts` with origin `https://spectre.infinitumcorporation.ai`. |

No client secret: `spectre` is a public client and every code exchange is bound by PKCE S256.

In client mode (`apps/spectre/src/server/cid-oidc-client.ts` and `app.ts`):

- `GET /api/auth/login` (`?prompt=create` opens account creation at the issuer) redirects to the
  issuer's `authorize` with PKCE S256, `state` and `nonce`. The verifier and nonce stay on the
  server (CID store `issuerLogins`, keyed by the SHA-256 of `state`, 10 minutes, single use); the
  browser holds only `state` in an HttpOnly, SameSite=Lax cookie (`Secure` on https) scoped to
  `/api/auth`.
- `GET /api/auth/callback` checks `state` against the cookie and the server copy, exchanges the
  code at the token endpoint (form-encoded, `client_id`, no secret), verifies the ES256 ID token
  against the issuer's JWKS (`iss`, `aud` = `spectre`, `exp`, `nonce`), and issues +SPCTR's own
  session cookie for `sub`. The session is an ordinary in-process CID session, so request
  authentication, the `spectre` CRM grant (granted the same way sign-up does), workspaces
  (`orgId ?? cid`), the hosted Labyrinth relay and `/api/id/labyrinth-directory` keep working on
  the in-process store unchanged. A cid seen for the first time gets a local account record built
  from the claims (`preferred_username`, `email`, `handle`); an existing one (from before the
  cut-over) keeps its username, organization and data.
- `POST /api/auth/signout` ends the local session and returns `logoutUrl`, the issuer's `logout`
  with `id_token_hint`; the page then sends the browser there.
- The passkey, MFA and social sign-in routes answer 404. `/api/me/identities` returns
  `manageAt: https://id.cumuluscloud.app/account`, and the page shows one "Sign in with
  Cumulus://ID" button plus "Create a Cumulus://ID" instead of the passkey form.

Organizations follow the issuer: with the `profile` scope its ID tokens carry `org_id`
(`org_<uuid>`, the same ids as the export), `org_name` and `org_role` (`admin` | `member`). On each
sign-in +SPCTR creates the local organization if it is missing (marked `source: "issuer"`), puts the
account in it (so the CRM workspace is the organization's), and adds or removes the account from
the local admins to match `org_role`. A token without `org_id` clears the account's organization
only when that organization came from the issuer; an organization that exists only here is left
alone. Org SSO settings are not carried by the token. The product IdP routes (`/api/id/*`, `/realms/cumulus/*`) are still registered on +SPCTR's
host; after step (d) nothing should point at them, and with `CID_OIDC_SIGNING_KEY` deleted the
`/realms/` routes are off.

## The account bar in nexus product pages

Every nexus web UI people use carries the Cumulus://ID account bar (`<div data-cumulus-bar>`) at
the right of its header: +SPCTR, VEIL web (index and search), CNDCTR, FABRIC, $FIRM Wallet,
Cumulus://Mail and Drive, and the :\ARCHITECT\ Podium. Their CSPs allow scripts only from
`'self'`, so they load a vendored copy of `public/id/bar.js` from `InfinitumCorp/cumulus-id`: the
canonical copy is `packages/ui/cumulus-bar.js`, `packages/ui/copies.json` lists the copies, `node
packages/ui/scripts/sync.mjs` rewrites them and the `@infinitum/ui` tests fail if one drifts. The
Podium has no CSP and loads `https://id.cumuluscloud.app/id/bar.js`. Apps with their own server
session (+SPCTR, CNDCTR, FABRIC, Mail) pass `data-signin`, set `data-signout` to a `#signout`
fragment that their page turns into the usual same-origin POST, and call
`window.CumulusBar.setProfile(...)`. VEIL web, the Wallet and the Podium use the bar's own tab sign-in.

