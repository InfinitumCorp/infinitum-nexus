# Plan: relational storage for Cumulus://ID, Mail, Wallet and Quota

Status: proposal. Nothing here is implemented yet. One decision is needed before work starts (see
[Decision needed](#decision-needed)).

## Problem

Every Cumulus store is a set of in-memory `Map`s (`CidStore`, `PostOfficeStore`, `WalletStore`,
`QuotaStore`, `TunnelStore`, `SuiteStore`). Hosted deployments persist each store as **one JSON
document**:

| Deployment | Where the documents live |
|---|---|
| `id.cumuluscloud.app` (`apps/spectre`, Worker `cumulus-id`) | `NexusStore` Durable Object, SQLite tables `nexus_docs` / `nexus_ledger` (`apps/spectre/src/server/do-store.ts`) |
| `mail.cumuluscloud.app` (`apps/cumulus-mail`, Worker) and the Vercel builds | Supabase `nexus_docs` / `nexus_ledger` behind the `nexus-store` edge function (`supabase/migrations/20261104_nexus_store.sql`) |
| Local servers | JSON snapshot files (`packages/cumulus/src/persist.ts`) |

Each request loads every changed document, runs in memory, then commits every changed document
whole, with an optimistic version check (`RemoteState`, `apps/spectre/src/server/remote.ts`). So:

1. **Every write rewrites the whole store.** A sign-in rewrites the `cid` document with every
   account, session and authenticator in it. Cost grows with the number of users, not with the work
   a request does.
2. **All writers to a store serialize.** Two sign-ins at the same moment conflict on the `cid`
   document and one is re-run. Throughput is bounded by one document.
3. **No queries.** "Sessions of this cid", "mail for this address", usage per owner all mean
   loading the full store.
4. **Mail content is the biggest store.** Mailboxes (sealed subjects, bodies, attachment metadata)
   live in one `mail` document, so it grows fastest.

The Firmament ledger is already one row per entry and is not part of this problem.

## Goals

- One row per entity (account, session, authenticator, grant, mailbox, message, wallet, transfer),
  so a request reads and writes only what it touches.
- No change to what users or products see: same `cid`s, same sessions, same sealed mail.
- A migration that can be verified and rolled back service by service.
- Keep the storage boundary inside `packages/*`, so the planned move of Cumulus://ID to its own
  repository (`product-idp.ts` mentions an export to `InfinitumCorp/cumulus-id`) carries it along.

## Decision needed

Where the tables live. The Workers reach a database differently in each case.

| Option | Fit | Cost / limits | Notes |
|---|---|---|---|
| **A. PostgreSQL, reached from Workers through Hyperdrive** (recommended) | One engine for ID, Mail, Wallet and Cloud Drive, which already uses Postgres (`packages/cloud/migrations`) | Needs a Postgres host. Supabase already holds Mail's and +SPCTR's documents; a managed Postgres in Yandex Cloud would fit the Russia deployments | Real transactions across stores (a payment debits one wallet and credits another; a sign-in writes a session and a ledger entry) |
| B. Cloudflare D1 (SQLite) per service | Native to Workers | Per-database size cap (500 MB on the free plan, 10 GB on paid); Cloud Drive stays on Postgres, so two engines | Simple for ID; Mail content may outgrow one database |
| C. Durable Object SQLite, one object per account | Strong per-account consistency, free plan | Cross-account lookups (username → cid, address → mailbox, credential id → cid) need a separate directory object | Most work; best isolation |

I recommend **A**: Cloud Drive already needs Postgres, and one engine keeps cross-store
transactions simple. Which Postgres host to use (Supabase, Yandex Managed PostgreSQL, or another)
is your call; it decides data residency and cost.

## Design

### 1. Async repositories behind the services

Today `CidService` reads its `Map`s synchronously. A database is asynchronous, so the boundary
becomes an interface per store, with the current `Map` version as one implementation:

```ts
interface CidRepository {
  account(cid: string): Promise<Account | null>;
  cidByUsername(username: string): Promise<string | null>;
  insertAccount(a: Account): Promise<void>;          // fails on a taken username
  session(id: string): Promise<Session | null>;
  sessionByTokenHash(hash: string): Promise<Session | null>;
  insertSession(s: Session): Promise<void>;
  revokeSessions(cid: string, except?: string): Promise<number>;
  // authenticators, grants, orgs, identities, one-time items …
  transaction<T>(fn: (tx: CidRepository) => Promise<T>): Promise<T>;
}
```

Size of the change, measured on `main`:

- 43 call sites outside `packages/cid` call `authenticate`, `can`, `getAccount`, `listSessions` and
  similar synchronously; they live in 8 packages and apps (`lbrnth`, `cloud`, `cumulus-mail`,
  `scalus`, `cumulus`, `veil`, `spectre`, `cid`).
- 8 places read `store.accounts` / `store.byUsername` / `store.sessions` directly; they move to
  repository calls.
- `PostOffice` has 45 methods over `PostOfficeStore`.

### 2. Tables (option A)

| Table | Key | Replaces |
|---|---|---|
| `cid_accounts` | `cid`; unique `username` | `accounts`, `byUsername` |
| `cid_identities` | (`provider`, `subject`) → `cid` | `byIdentity`, `Account.identities` |
| `cid_federation` | (`issuer`, `subject`) → `cid` | `byFederation` |
| `cid_authenticators` | `id`; unique `credential_id` | `authenticators`, `byCredentialId` |
| `cid_sessions` | `id`; unique `token_hash`; index (`cid`) | `sessions`, `byTokenHash` |
| `cid_grants` | (`cid`, `app`) | `grants` |
| `cid_orgs` | `id` | `orgs` |
| `cid_pending` | `key`, `kind`, `expires_at` | `challenges`, `pendingMfa`, `oauthPending`, `deviceHandoffs` (one table with a TTL sweep) |
| `mail_mailboxes` | `cid`; owner, settings | `mailboxes` (metadata) |
| `mail_addresses` | `address` → `cid` | `addresses` |
| `mail_messages` | `id`; index (`cid`, `folder`, `at`) | messages inside each mailbox. Subject, body and attachments stay **sealed** (ciphertext columns), as `at-rest.ts` stores them today |
| `mail_outbound` | `id`; index (`status`) | `outbound` |
| `wallet_accounts`, `wallet_transfers` | `cid` / `id`; unique `address` | `WalletStore` |
| `quota_usage` | (`cid`, `product`) | `QuotaStore` |
| `tunnel_keys` | `cid` | `TunnelStore` (wrapped private keys only) |

`nexus_ledger` stays as it is.

### 3. Phases

| # | Step | Ships | Behavior change |
|---|---|---|---|
| 0 | Measure: log document sizes and conflict re-runs in `RemoteState` | 1 small PR | None |
| 1 | Repository interfaces + `Map` implementation; make the 43 call sites async | 2–3 PRs (ID, then Mail, then Wallet/Quota) | None. Whole test suite unchanged |
| 2 | Postgres implementation of `CidRepository`; run the same CID test suite against both implementations | 1 PR + migration | None until enabled |
| 3 | Backfill script: read the `cid` document, write rows, compare counts and a per-entity hash; dry run first | 1 PR | None |
| 4 | Cut over `cumulus-id` behind a setting (`CUMULUS_STORE=postgres`). Keep `nexus_docs` read-only for a rollback window | Deploy step | ID reads/writes rows |
| 5 | Repeat 2–4 for Mail (largest), then Wallet, Quota, Tunnel | 3–4 PRs | Per service |
| 6 | Remove the document path once every service has run on rows through the rollback window | 1 PR | None |

Each phase keeps the full test suite green and can stop without leaving a half state.

### Hosted on Supabase without a database password: `CUMULUS_STORE=gateway`

Products that already reach Supabase through the `nexus-store` edge function (Mail) don't need a
Postgres connection string at all:

- `supabase/migrations/20261113_cumulus_id_rows.sql` creates the `cumulus_id` tables (not exposed by
  the Data API, RLS on, no grants to `anon`/`authenticated`), `public.cid_read` (whitelisted lookups),
  `public.nexus_commit_cid` (the ledger, documents and the request's ID writes in one transaction;
  every write carries the value the request read, and a row changed since then is a conflict, so the
  request re-runs) and `cumulus_id.refresh_from_document()` (the backfill: replaces the rows with the
  `cid` document's contents in one transaction, leaving the document untouched).
- `nexus-store` gains `op: "cid.read"` and accepts `cid` writes on `commit`; callers that don't send
  them get exactly the old behavior.
- Check at any time: `select cumulus_id.compare_with_document()` says whether the rows match the
  document, and lists the keys that differ.
- Cutover: deploy the edge function, run `select cumulus_id.refresh_from_document()` and set
  `CUMULUS_STORE=gateway` on the product in the same deploy. Rollback: `select
  cumulus_id.restore_document()` (rebuilds the `cid` document from the rows, accounts created since the
  switch included; `supabase/migrations/20261114_cumulus_id_reverse.sql`), then set it back to
  `document`.

The US tables were created and backfilled on 2026-11-12 (9 accounts, 8 passkeys, 7 sessions,
7 grants; every row compared equal to the document). The id.cumuluscloud.app Worker keeps its state in
a Durable Object, not Supabase, and Russia's Yandex Managed PostgreSQL needs Yandex Cloud access;
both are still to do.

### Cutover runbook (Cumulus://ID, phase 4)

1. Pick the Postgres host and create a database. On Cloudflare, put Hyperdrive in front of it and
   bind it to `cumulus-id` and `cumulus-mail` as `CID_DB`; elsewhere set `CID_DATABASE_URL`.
2. Dry run, then copy: `pnpm --filter @infinitum/cid backfill --from-nexus-docs` (needs
   `NEXUS_DATABASE_URL`), then the same with `--write` and `CID_DATABASE_URL`. It creates the tables,
   upserts every entity and exits non-zero unless every row reads back identical.
3. Set `CUMULUS_STORE=postgres` on every product that shares the `cid` document (+SPCTR/Cumulus://ID
   and Mail) in one deploy, right after a final `--write` run. From then on each request's ID writes
   commit in the same step as the ledger (RemoteState participants) and the `cid` document is left
   as it was.
4. Watch the `nexus-store` metrics line: `participantFailures` must stay 0.
5. Rollback: write the rows back out first, so nothing created since the cutover is lost:
   `pnpm --filter @infinitum/cid backfill --to-snapshot cid.json` (single server) or
   `select cumulus_id.restore_document()` (Supabase), then set `CUMULUS_STORE=document` again.

### 4. Risks

- **Sync → async refactor** (phase 1) touches many files. Done per package, with tests unchanged as
  the guard.
- **Sealed mail must stay sealed.** Message rows store ciphertext exactly as `sealMailStore` does
  today; the master key never moves into the database.
- **Ledger ordering.** Entries are appended in the same transaction as the rows they describe, so a
  failed request leaves neither.
- **Rollback.** Until phase 6, the document copy stays available; switching the setting back
  restores the old path.

## Not in scope

- Moving the Cumulus://ID issuer out of `apps/spectre` (separate, needs approval because it serves
  the sign-in website).
- The Cloud S3 driver.
