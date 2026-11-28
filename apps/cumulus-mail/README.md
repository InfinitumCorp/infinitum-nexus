# Cumulus://Mail

The mailbox that comes with every Cumulus://ID, the way Gmail comes with a Google account.
Sign up in any Infinitum product and you get `username@cumuluscloud.app`, Cumulus://Cloud storage
and a FIRM Wallet, all on the free tier. The account suite is in `@infinitum/cumulus`; mailbox rules
are in `@infinitum/mail`. This app serves them.

**Unlisted.** Mail is not on the public site. Every response sends `X-Robots-Tag: noindex`,
`robots.txt` disallows everything, and people reach it from inside other products (the account
menu in +SPCTR, links in notices).

```sh
node --experimental-strip-types apps/cumulus-mail/src/server.ts
```

Open http://localhost:3010 and sign in with a passkey.

| Variable | Purpose |
|---|---|
| `PORT` | Listener, default 3010 |
| `MAIL_ORIGIN` | Public origin; passkeys are bound to it |
| `CUMULUS_ROOT_DOMAIN` | Mail-address domain, default `cumuluscloud.app` |
| `CUMULUS_ID_HOST` | Cumulus://ID host, default `id.cumuluscloud.app`. Issuer is `https://id.cumuluscloud.app/realms/cumulus` |
| `CUMULUS_KEYCLOAK_REALM` | Keycloak realm, default `cumulus`. JWKS is `https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs` |
| `CUMULUS_CLOUD_HOST` | Cumulus://Cloud host, default `cloud.cumuluscloud.app` |
| `CUMULUS_MAIL_HOST` | Cumulus://Mail host, default `mail.cumuluscloud.app` |
| `MAIL_DATA_DIR` | Where stores and the Firmament ledger live, default `./data` |
| `OMNIROUTE_API_KEY` | Turns on SCALVS briefs and Clean suggestions on open-weight models (see `packages/ai` for backup hosts) |
| `CUMULUS_ID_ISSUER` | Upstream mode: issuer origin, e.g. `https://id.cumuluscloud.app`. Mail then signs people in there and keeps the issuer's cid; it never creates an ID itself. See docs/cumulus-id.md |
| `CUMULUS_MAIL_MASTER_KEY` | Base64 32-byte Cumulus Tunnel master key. Without it, one is created at `MAIL_DATA_DIR/tunnel-master.key`; in production set it from a secrets manager instead |
| `SCALVS_MODEL` | Model for SCALVS Clean, default `claude-opus-5-5` |
| Social sign-in | Same variables as +SPCTR; callback `{MAIL_ORIGIN}/api/auth/oauth/{provider}/callback` |
| `MAIL_BILLING` | `off` turns off `/api/billing/*` and every call to the revenue API (copies Stripe doesn't serve, such as Russia). On by default |
| `MAIL_INBOUND_PORT`, `MAIL_INBOUND_TOKEN` / `MAIL_INBOUND_TOKEN_FILE`, `MAIL_INBOUND_AUTHSERV_ID` | Node mode: outside mail from Postfix. See below |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD` (secret), `MAIL_SMTP_SECURE`, `MAIL_SMTP_HELO` | Node mode: outside mail out through an SMTP relay. See below |

Mail also serves `/api/id/*`, the original "Sign in with Cumulus://ID" routes. Those stay
as a compatible alias: a button whose issuer is `https://mail.cumuluscloud.app` keeps
working, including the copy of `public/id/button.js` hosted here (its default issuer is
still Mail). The cid those routes see is Mail's own store.

The source of truth for a cid issued at `id.cumuluscloud.app` is that Worker's NexusStore.
Mail does not read that store. To share one cid with the ID host, point the button at
`https://id.cumuluscloud.app` and call that host's token and userinfo endpoints.
See [docs/cumulus-id.md](../../docs/cumulus-id.md).

## Node mode with Postfix (self-hosted, e.g. the Russia server)

Hosted Mail receives outside mail through the Cloudflare Worker's `email()` and sends it through
Email Sending. A self-hosted copy (`src/server.ts`, files under `MAIL_DATA_DIR`) has neither, so it
uses Postfix in front and an SMTP relay behind. Without the variables below, outside mail to it
is never received and mail from it to outside addresses stays queued.

```sh
MAIL_ORIGIN=https://mail.example.ru MAIL_DATA_DIR=/var/lib/cumulus-mail \
MAIL_BILLING=off \
MAIL_INBOUND_PORT=3011 MAIL_INBOUND_TOKEN_FILE=/etc/cumulus-mail/inbound.token \
MAIL_INBOUND_AUTHSERV_ID=mx.example.ru \
MAIL_SMTP_HOST=smtp.relay.example MAIL_SMTP_PORT=587 MAIL_SMTP_USER=... MAIL_SMTP_PASSWORD=... \
node --experimental-strip-types src/server.ts
```

**In (Postfix -> Mail).** Postfix takes mail on port 25, OpenDKIM and OpenDMARC (with
`SPFSelfValidate true`) check it, and a pipe transport runs `scripts/postfix-deliver.ts`, which
POSTs the raw message to `http://127.0.0.1:$MAIL_INBOUND_PORT/inbound` (bound to loopback only,
with the token from `MAIL_INBOUND_TOKEN(_FILE)`, 16+ characters; make the token file readable by the
pipe user and the Mail user only). The script needs only Node, no packages. Its exit code tells
Postfix what to do: 0 delivered, 67 no such mailbox (bounce), 69 refused for good, such as a DMARC
failure or a forged Cumulus sender (bounce), 75 Mail is down or busy (keep it queued and retry).

`/etc/postfix/main.cf` (the parts that matter):

```
myhostname = mx.example.ru
relay_domains = cumuluscloud.app                  # the mail domain (CUMULUS_ROOT_DOMAIN)
transport_maps = hash:/etc/postfix/transport      # cumuluscloud.app  cumulus:
cumulus_destination_recipient_limit = 1           # one recipient per delivery
message_size_limit = 26214400                     # Mail accepts up to 30 MB raw
smtpd_milters = inet:127.0.0.1:8891, inet:127.0.0.1:8893   # OpenDKIM, then OpenDMARC
non_smtpd_milters = $smtpd_milters
milter_default_action = tempfail                  # never deliver unchecked mail
header_checks = regexp:/etc/postfix/header_checks
```

`/etc/postfix/header_checks` (required: strip any Authentication-Results a sender wrote with our id;
headers the milters add aren't subject to header_checks):

```
/^Authentication-Results:\s*mx\.example\.ru\b/  IGNORE
```

`/etc/postfix/master.cf`:

```
cumulus unix - n n - - pipe flags=Rq user=cumulus-mail
  argv=/usr/bin/node --experimental-strip-types /opt/cumulus-mail/apps/cumulus-mail/scripts/postfix-deliver.ts
  --url http://127.0.0.1:3011/inbound --token-file /etc/cumulus-mail/inbound.token -- ${sender} ${recipient}
```

Set `AuthservID mx.example.ru` in both `opendkim.conf` and `opendmarc.conf` (and `TrustedAuthservIDs`
in OpenDMARC), the same value as `MAIL_INBOUND_AUTHSERV_ID`. Mail reads the Authentication-Results
with that id from our hop only (down to the previous hop's Received line), merges them, and refuses
the message when DMARC failed (`inboundAuthFromMta` in `@infinitum/mail`). Leave `RejectFailures`
off in OpenDMARC so Mail makes that call and the reason reaches the sender. Mail to an unknown
address is accepted by Postfix and then bounced; a recipient check at RCPT time is a later step.
After setup, send a test message from outside and check that it shows as verified.

**Out (Mail -> relay).** With `MAIL_SMTP_HOST` set, Mail drains the outbound queue every 30
seconds through SMTP submission (`src/smtp.ts`, Node built-ins only), because Yandex Cloud
blocks outbound port 25. Port 587 uses STARTTLS and 465 TLS from the start (`MAIL_SMTP_SECURE`
overrides). Mail signs in (AUTH PLAIN or LOGIN) only over TLS, and won't send over plain SMTP
except to a relay on this machine (127.0.0.1, ::1, localhost). The relay must be allowed by the
domain's SPF record and should DKIM-sign for it. A 5xx about the message (an unknown recipient,
say) bounces to the sender; 4xx, network errors and bad relay credentials are retried
(`OUTBOUND_MAX_ATTEMPTS`). Keep `MAIL_SMTP_PASSWORD` in the server's secrets, never in a repo.

**Billing.** Set `MAIL_BILLING=off` where Stripe isn't available: `/api/billing/*` then answers
404 and Mail never calls the revenue API. With billing on, Node mode keeps the CID -> billing org
links in memory only (`server.ts` passes no `billingStore`), so they are rebuilt on the next
purchase after a restart; hosted mode saves them with the shared state.

## What's in it

- **Sign-in with Cumulus://ID.** Passkeys, authenticator-app MFA, social sign-in. Access needs the
  `cumulus-mail` grant, so revoking Mail in the CID permissions dashboard cuts it off at once.
- **Real delivery.** Mail between Cumulus addresses lands in the recipient's inbox and threads
  replies. Unknown Cumulus addresses bounce. Mail to outside addresses is queued and sent by
  Cloudflare Email Sending (hosted) or an SMTP relay (Node mode, below).
- **Login security mail.** Sign-ins from a new device, new or removed keys, MFA changes, linked
  providers and "signed out everywhere" each send a notice from `security@cumuluscloud.app`.
  Product sender names (`security`, `wallet`, `cloud`, `welcome`, `postmaster`, …) are reserved and
  can't be registered.
- **Shared 15 GB.** Mail and Cloud draw from one quota. A full account can't send; a full recipient bounces.
- **FIRM Wallet.** Every CID's wallet opens with the account. Send USDC or FIRM directly, or attach a
  payment to a message (one Cumulus recipient). The money moves first and all at once, so a message
  never shows a payment that failed. Each payment is a Firmament `payment` entry (amounts and wallet
  IDs only, no mail content). The server never holds wallet private keys.

- **Your address is your Cumulus://ID.** `name@cumuluscloud.app` and `name` sign in to the same account,
  in Mail and in every other Infinitum product.
- **Cumulus Tunnel.** Mail between Cumulus accounts is sealed to the recipient (X25519 + AES-256-GCM) and
  signed by the sender (Ed25519). The recipient's copy comes only out of that envelope, and the reader shows
  "sealed and sender verified". Keys are created with the Cumulus://ID, so nobody manages a key. Private keys
  are stored wrapped with the master key, and mailboxes are written to disk with subjects, bodies and files
  sealed to their owner (routing metadata stays readable). Because the platform holds the keys, this protects
  mail in transit and at rest but is not end-to-end against the operator; device-held keys are the next step.
- **SCALVS Clean.** Sorts mail into people, newsletters, notices, receipts and bounces. Rules archive
  read newsletters and old notices and trash old bounces, on their own at most once an hour. "Ask SCALVS" runs
  a SCALVS.ai agent (`@infinitum/scalus`) that proposes clean-ups; nothing moves until you approve.
  Mute a sender and their future mail skips the inbox. Every clean-up can be undone. Starred mail,
  unread mail from people, payments and security notices are never moved automatically, and deleting
  forever is off unless you turn on "Empty Trash".
- **Layout.** Gmail's pattern (Compose, folders, Primary and Updates tabs, one-line rows, the thread
  opening in place of the list, a compose window) in the Infinitum look shared with +SPCTR.

## Local test data

`scripts/dev-seed.ts` creates two test accounts with a virtual passkey and prints a local session
cookie, so the signed-in app can be checked without a hardware key. It refuses https origins.

## Install it (web and Android)

**Web app.** Mail is an installable web app: `manifest.webmanifest`, icons and a service worker
(`public/sw.js`) that caches only the app shell. Mail itself (`/api/*`) is never cached. In Chrome,
use **Install app**; on Android, **Add to Home screen**. The Compose shortcut opens `/?compose=1`.

**Android app.** `android/` is a small native launcher, `app.cumuluscloud.mail`, that opens Mail in a
Chrome Custom Tab. That's the full browser engine, so passkey sign-in with Cumulus://ID works the same
as on the web. It also handles `mailto:` links by opening the composer. It builds with the plain SDK
tools, so no Gradle is needed:

```bash
MAIL_URL=https://mail.cumuluscloud.app bash apps/cumulus-mail/android/build-apk.sh
adb install -r apps/cumulus-mail/android/build/cumulus-mail.apk
```

To test against a local server, build with `MAIL_URL=http://localhost:3010` and run
`adb reverse tcp:3010 tcp:3010`. Without `KEYSTORE`, `KEY_ALIAS` and `KEY_PASS`, the APK is signed
with the local debug key. Use a release key for Play Store builds.

Icons come from `scripts/make-icons.py` (Pillow), which draws the same "://" mark as `public/icon.svg`.
