# Cumulus://ID issuer

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

## Upstream mode: one issuer for Mail (and Cloud)

Set `CUMULUS_ID_ISSUER=https://id.cumuluscloud.app` on a product built on
`@infinitum/cumulus` and it stops issuing IDs of its own:

- `/api/auth/cid/start` sends the person to
  `<issuer>/api/id/authorize` (code + PKCE, state bound to an HttpOnly cookie). The callback
  `/api/auth/cid/callback` trades the code at `<issuer>/api/id/token` server to server, checks
  the profile strictly, revokes the issuer token, and signs the person in to Mail with a local
  session.
- The local account is a mirror that keeps the issuer's **cid**, so the mailbox, Cloud quota and
  FIRM Wallet line up with every other product. `CidService.adoptUpstreamAccount` does this, and
  records `account.adopted` on Firmament.
- `createAccount`, a first-time social sign-in and a first-time SSO member are refused with
  `signup_at_issuer`. `/api/auth/cid/start?create=1` opens the issuer's sign-up (`prompt=create`).
- Mail's `/api/id/*` alias answers `307` to the same path on the issuer, so buttons that still
  point at `mail.cumuluscloud.app` get the issuer's cid. POST bodies are kept.
- Accounts created on Mail before the switch keep signing in with their passkey. They are
  **never** merged with an issuer account automatically: if `sam` exists on Mail under one cid and
  on the issuer under another, issuer sign-in for `sam` is refused with `username_conflict`.
  Those accounts need a deliberate migration (see below).

### Cutover checklist for Mail

1. Count Mail-only accounts and the usernames that also exist on the issuer (the conflicts).
2. Decide the migration for the conflicts (move the mailbox to the issuer's cid, or reserve
   the username on the issuer for the Mail owner) before announcing the switch.
3. Set `CUMULUS_ID_ISSUER=https://id.cumuluscloud.app` on the Mail deployment and redeploy.
4. Check: `GET https://mail.cumuluscloud.app/api/auth/issuer` returns the issuer, and
   `POST /api/auth/signup` answers `400 signup_at_issuer`.

Mail's sign-in page is not changed by this mode yet: it has no button for `/api/auth/cid/start`,
and its local sign-up form answers `signup_at_issuer`. Update the page (separately approved)
before setting `CUMULUS_ID_ISSUER` in production.

Known limits: signing out everywhere at the issuer does not yet end Mail's local sessions, and
MFA is enforced at the issuer only (a mirrored account has no local authenticator code).

## Deploy cumulus-id

No DNS change is required. The Worker route is already `id.cumuluscloud.app`.

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
