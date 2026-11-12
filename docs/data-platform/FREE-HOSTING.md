# Running the data platform for $0

This plan runs the data platform only on services we already use, on their free plans:
Supabase, Cloudflare, the self-hosted box and GitHub Actions. It needs no new paid account and
no higher spending limit.

## What runs where

| Piece | Where | Cost | Replaces |
|---|---|---|---|
| Event store, full-text search, dataset catalog, DP budget | Existing Supabase project in Ireland (eu-west-1), schema `data_platform` | $0 (the project is already paid for or free) | Hosted OpenSearch, a separate catalog database |
| Privacy gateway (Presidio, quality, DP, collection, search API) | Self-hosted box, `deploy/box/compose.box.yml` | $0 (hardware we already have) | A VM or container service |
| Superset (dashboards, Cumulus ID sign-in) | Same box, same compose file | $0 | Preset |
| Public access | Cloudflare Tunnel (outbound only, no open ports) plus Cloudflare Access | $0 (Zero Trust free plan, up to 50 users) | Load balancer, public IP |
| DataHub catalog UI | Pinned quickstart, started on demand on a laptop or the box (`datahub/quickstart.sh`) | $0 | Acryl DataHub Cloud |
| CI (tests, Conjure, stack smoke) | GitHub-hosted runners on a public repo | $0 | n/a |

The gateway API (`/api/v1/*`) and the Conjure contracts stay the same. Only the storage
backend changes: with `DATABASE_URL` set, the gateway uses Postgres for the catalog, events,
search and DP budget (`cumulus_privacy/pgstore.py`). Without it, it uses the file plus OpenSearch
backends from the local dev stack.

## Why Postgres instead of OpenSearch

At today's volume, Postgres full-text search (`tsvector`, GIN index, the `simple` configuration so
no language stemming leaks across tenants) handles the search we need: filtering by
product, tenant, type and object, a time range, and a text match, with stable keyset paging. It
runs in the Supabase project we already have, in Ireland, so data residency doesn't change.
Move a region to OpenSearch when one of these happens: search latency on the events table goes
over about 300 ms at p95, the table outgrows the free database (see the limits below), or we need
relevance ranking. `PostgresEventIndex` accepts the same query body as the OpenSearch backend, so
moving needs no API change.

## Limits to watch

- **Supabase free plan:** 500 MB per database, and a project pauses after 7 days with no
  activity. The gateway writes every day (events plus the daily retention purge), so an active
  platform doesn't pause. Retention is enforced per dataset (`retentionDays` in the spec) by
  `data_platform.purge_expired_events()`. The gateway runs it once a day; pg_cron also runs it
  when that extension is enabled (step 7).
- **Guards so the free database can't overflow.** These are in the gateway and set in the box
  profile:

  | Setting | Default | When reached |
  |---|---|---|
  | `PLATFORM_STORAGE_LIMIT_MB` | 450 | New events get 503 `StorageQuotaReached` with `Retry-After` |
  | `PLATFORM_DAILY_EVENT_QUOTA` (per product, per UTC day) | 200,000 | 429 `IngestQuotaExceeded` with `Retry-After` set to UTC midnight |
  | `PLATFORM_MAX_BATCH` (events per request) | 1,000 | 413 |

  `GET /api/v1/health` reports `storage: ok | nearly_full | full`. `nearly_full` starts at 80%
  of the limit. Products keep refused events and send them again later; event IDs make that
  safe.
- **The box** is the one single point of failure. While it is offline, collection and dashboards
  are down, but no data is lost, because events live in Supabase. Products must retry
  `POST /api/v1/collect` (event IDs make retries safe).
- **Cloudflare Access free plan:** 50 users. That covers internal dashboards. Products call the
  gateway with their own bearer tokens, so put the API hostname behind an Access *service token*
  or leave Access off that hostname. Never put it behind an interactive login.
- **Russia (Yandex Cloud) and US data** are out of scope here. This plan covers the EU region. A RU
  gateway with `PLATFORM_REGION=RU` needs its own database in Russia. Yandex Managed PostgreSQL
  costs money, so decide that separately.

## Fallback if the box can't host the gateway

Google Cloud Run's always-free tier (2 million requests, 180,000 vCPU-seconds and 360,000
GiB-seconds a month, in US regions only) can run the same gateway image, with `DATABASE_URL`
pointing at Supabase. Two catches:

- Cloud Run needs a billing account attached, even at $0.
- Presidio with spaCy needs about 1 GiB of memory and has a cold start of several seconds.

So this needs William's OK before anything is created. The ready template is
`infra/data-platform/deploy/cloudrun/service.yaml`. It runs one instance at most, scales to
zero, and takes its secrets from Secret Manager (free for up to 6 active secret versions).
Cloud Run throttles CPU between requests, so the gateway's background daily purge won't run
reliably there. Enable pg_cron (step 7) before you use it.

## Steps for William (not done: each one touches production or an account)

1. **Create the database role.** In the Supabase SQL editor, create the role once, with a strong
   password that you keep in your password manager and never commit:
   `create role data_platform_gateway login noinherit password '<generated>';`
2. **Apply the migration.** Apply `supabase/migrations/20261113_data_platform.sql` after the role
   exists, because the grants and policies are created only when the role is present. Running
   the migration again is safe.
3. **Create the tunnel.** In Cloudflare Zero Trust, go to Networks > Tunnels > Create a tunnel
   (type cloudflared). Copy its token into `deploy/box/.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Add
   these public hostnames:
   - `bi.<domain>` → `http://superset:8088`, with an Access application that allows only our
     team.
   - `data-api.<domain>` → `http://privacy-gateway:8090`.
4. **Register Superset in Cumulus ID.** Register Superset as a Cumulus ID client with redirect URI
   `https://bi.<domain>/oauth-authorized/cumulus`.
5. **Start the stack on the box.**
   - Copy the example env file: `cp infra/data-platform/deploy/box/.env.example infra/data-platform/deploy/box/.env`
   - Fill in the values in that `.env`, then run `chmod 600` on it.
   - Run `bash infra/data-platform/deploy/box/box.sh up`. The script first checks the `.env`:
     - every required value is set;
     - the tokens are long enough;
     - the database URL uses TLS and the restricted role (never `postgres`).

     Then it builds, starts the stack and prints its health.
   - Day to day, use the same script: `box.sh status`, `box.sh logs [service]`, `box.sh update`
     (fast-forward pull and restart) and `box.sh down`.
6. **Optional: connect dashboards.** Create the read-only role:
   `create role data_platform_reader login noinherit password '<generated>';`

   Re-run the migration, then add the database in Superset (Settings > Database Connections)
   with that role's pooler URL. Build charts on `data_platform.events_bi`. That role:
   - can't read the pseudonym, the text or the payload;
   - can't read the privacy budget;
   - can't write anything.
7. **Optional: schedule retention in the database.** In Supabase, enable the `pg_cron` extension
   (Database > Extensions; free), then re-run the migration. It schedules the purge every day
   at 03:17 UTC, but only if the role running the migration can bypass RLS. Otherwise it prints
   a notice and the gateway keeps doing the purge. Check that it ran with
   `select * from cron.job_run_details order by start_time desc limit 5;`.

Steps 1–3 change production systems, so nothing here has been run.

## Right to erasure

When a person asks to be forgotten, products call the `ErasureService` (`conjure/platform.yml`):

- `POST /api/v1/erasure/subjects` with `{"cid": "<Cumulus ID>"}` and the product's own token.
  It deletes that product's events about the person, in every tenant.
- `POST /api/v1/erasure/subjects/all-products` with the pipeline token. It deletes the
  person's events from every product. Call it when someone deletes their Cumulus ID.

Events store only a keyed pseudonym of the CID, so the gateway pseudonymizes the CID it
receives and deletes on that. Both calls return `{"deleted": n}` and are safe to repeat.
Rotating `PRIVACY_PSEUDONYM_KEY` breaks this matching for older events, so don't rotate it
without first erasing the events or re-keying them.

## Security notes

- The gateway connects as `data_platform_gateway`. That role can't update events (they are
  append-only) and has no access outside the `data_platform` schema. Row-level security is
  forced on, so the Supabase `anon` and `authenticated` API roles see nothing.
- Superset reads as `data_platform_reader`. That role is read-only and has column-level grants
  only: it sees no pseudonyms, text or payloads.
- Every event is redacted by Presidio before it is written. No raw text reaches Supabase.
- No ports are open on the box. The tunnel only dials out.
