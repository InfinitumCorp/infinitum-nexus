# Hosted Labyrinth (Postgres, Yandex Cloud)

By **Infinitum Corporation®**. This is the authoritative, durable Labyrinth service that the
product relays point `LBRNTH_ENDPOINT` at. It replaces the single-writer encrypted file for
hosted use.

## Shape

```
browser ── rchtch.app (ARCHITECT Worker) ──┐  bearer relay, product pinned
browser ── id.cumuluscloud.app (CID)  ─────┤  CID cookie forwarded as bearer (same CID store)
browser ── mail.cumuluscloud.app ──────────┘  explicit bearer only
                     │ POST /api/labyrinth
                     ▼
        Labyrinth host (Yandex labyrinth-russia, apps/lbrnth-host)
          │ live identity                         │ encrypted envelopes, bearers, plans
          ▼                                       ▼
 id.cumuluscloud.app/api/id/labyrinth-directory   local Postgres, schema lbrnth
```

- **Identity.** Cumulus://ID stays the only sign-in. People without a Cumulus ID create one in
  the normal CID sign-in flow; the host has no passcode, account or session of its own. Every
  request resolves the presented token live through the CID directory route, a key-protected
  server-to-server endpoint on the CID Worker. It answers only for the LBRNTH app.
- **Bearers.** `token` issues a 15-minute repository-only `lbrnth_…` bearer. Only its SHA-256,
  CID, org, parent session id and expiry are stored (`lbrnth.delegations`); never the bearer or
  the CID token. Signing out of CID or losing the org ends it immediately on every instance.
- **Plan check.** Access needs an active row in `lbrnth.entitlements` (operator or a future
  billing webhook) or the operator allowlist `LBRNTH_ENTITLED_ORGS`. Consent never buys a plan.
- **Onboarding.** `organization` (first CID org), `consent` and `provision` work through the
  host. On id.cumuluscloud.app the existing `/labyrinth` workspace drives them with the CID cookie.
- **Storage.** `PostgresStorage`: one AES-256-GCM envelope per org under its own HKDF key (as the
  file adapter), additional data binding org id and revision. Each request is one unit of work:
  refresh → resolve caller → run the SDK → commit changed envelopes and bearer rows in one
  transaction with a revision compare-and-swap. A database trigger forbids deletes and any
  revision change other than +1. On a conflict nothing is written and the request re-runs.
  Responses are sent only after the commit.

## Where it runs (since 2026-11-12)

The host runs on the Yandex Cloud server `labyrinth-russia` (ru-central1-e) at
`https://lbrnth.cumuluscloud.app`, with Postgres on the same server. Server setup, TLS, backups
and checks live in [InfinitumCorp/labyrinth-ru](https://github.com/InfinitumCorp/labyrinth-ru),
which pins a commit of this repository. The earlier Cloud Run service and Supabase `lbrnth`
schema were retired on 2026-11-12. Both were empty.

| Where | Name | Value |
|---|---|---|
| Server `/etc/lbrnth/master-key` | `LBRNTH_MASTER_KEY` | generated on the server once; keep an offline copy |
| Server `/etc/lbrnth/db-password` | `DATABASE_URL` | local Postgres over loopback (no TLS needed) |
| Server `/etc/lbrnth/cid-directory-key` | `CID_DIRECTORY_KEY` | piped from Secret Manager `lbrnth-cid-directory-key` |
| Server (optional) | `LBRNTH_ENTITLED_ORGS` | `/etc/lbrnth/entitled-orgs` |
| CID Worker secret | `CID_DIRECTORY_KEY_SHA256` | hex SHA-256 of `CID_DIRECTORY_KEY` |
| CID, Mail, ARCHITECT secret | `LBRNTH_ENDPOINT` | `https://lbrnth.cumuluscloud.app/api/labyrinth` |

`lbrnth.cumuluscloud.app` is a DNS-only A record to the server's IP, which is dynamic until a
static IP is attached. If it changes, update the record and re-run setup.

The relays use `fetch(..., { redirect: "manual" })` and refuse 3xx. Cloudflare Workers reject
`redirect: "error"` outright (#138).

## Deploy or upgrade

See the labyrinth-ru README. In short: bump the pinned commit, upload that commit's tarball to
the server (GitHub is often unreachable from Russia), run `scripts/setup.sh` over SSH, and
check with `scripts/check.sh`. Grant a plan with an `insert into lbrnth.entitlements` on the
server.

## Limits

- One instance serializes requests; it still rebuilds its in-memory SDK if another instance
  commits. Capacity limits are unchanged
  (256 orgs, 32 MiB per org, 128 MiB total).
- Rate limits reset when the service restarts.
- Browsers in Russia reach the relays (rchtch.app, id.cumuluscloud.app), not the host. Those
  are Cloudflare-hosted, so Russian reachability still depends on them. The data itself is
  stored in Russia.
- Migrating an existing file snapshot is not automated; none is in production use.
