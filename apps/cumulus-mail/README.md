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
| `MAIL_DATA_DIR` | Where stores and the Firmament ledger live, default `./data` |
| `XAI_API_KEY` | Turns on SCALVS briefs |
| `CUMULUS_MAIL_MASTER_KEY` | Base64 32-byte Cumulus Tunnel master key. Without it, one is created at `MAIL_DATA_DIR/tunnel-master.key`; in production set it from a secrets manager instead |
| `ANTHROPIC_API_KEY` | Turns on SCALVS Clean suggestions (without it, Clean suggests from its rules) |
| `SCALVS_MODEL` | Model for SCALVS Clean, default `claude-opus-5-5` |
| Social sign-in | Same variables as +SPCTR; callback `{MAIL_ORIGIN}/api/auth/oauth/{provider}/callback` |

## What's in it

- **Sign-in with Cumulus://ID.** Passkeys, authenticator-app MFA, social sign-in. Access needs the
  `cumulus-mail` grant, so revoking Mail in the CID permissions dashboard cuts it off at once.
- **Real delivery.** Mail between Cumulus addresses lands in the recipient's inbox and threads
  replies. Unknown Cumulus addresses bounce. Outside addresses are queued for the outbound relay
  (`PostOffice.outboundQueue()`); the SMTP bridge itself is not built yet.
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
