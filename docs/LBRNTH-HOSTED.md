# Hosted Labyrinth (Postgres + Cloud Run)

By **Infinitum Corporation®**. This is the authoritative, durable Labyrinth service that the
product relays point `LBRNTH_ENDPOINT` at. It replaces the single-writer encrypted file for
hosted use. Nothing in this document has been run against production by this change.

## Shape

```
browser ── rchtch.app (ARCHITECT Worker) ──┐  bearer relay, product pinned
browser ── id.cumuluscloud.app (CID)  ─────┤  CID cookie forwarded as bearer (same CID store)
browser ── mail.cumuluscloud.app ──────────┘  explicit bearer only
                     │ POST /api/labyrinth
                     ▼
        Labyrinth host (Google Cloud Run, apps/lbrnth-host)
          │ live identity                         │ encrypted envelopes, bearers, plans
          ▼                                       ▼
 id.cumuluscloud.app/api/id/labyrinth-directory   Supabase Postgres, schema lbrnth
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

## Configuration

| Where | Name | Value |
|---|---|---|
| Cloud Run secret | `LBRNTH_MASTER_KEY` | canonical base64, 32 bytes; keep an offline copy |
| Cloud Run secret | `DATABASE_URL` | Supabase **session pooler** URL (IPv4), port 5432 |
| Cloud Run secret | `CID_DIRECTORY_KEY` | random service key, 48+ characters |
| Cloud Run env (optional) | `DATABASE_CA_PEM`, `CID_DIRECTORY_URL`, `LBRNTH_ENTITLED_ORGS` | |
| CID Worker secret | `CID_DIRECTORY_KEY_SHA256` | hex SHA-256 of `CID_DIRECTORY_KEY` |
| CID, Mail, ARCHITECT | `LBRNTH_ENDPOINT` | `https://<cloud-run-host>/api/labyrinth` |

Generate secrets by piping, never printing or typing them, for example
`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | gcloud secrets create lbrnth-master-key --data-file=-`.

## Deploy (each step needs William's explicit OK)

1. Apply `supabase/migrations/20261111_lbrnth_store.sql` to the Supabase project.
2. Create the three secrets in Secret Manager. Put the directory key's SHA-256 on the
   `cumulus-id` Worker as `CID_DIRECTORY_KEY_SHA256`.
3. Build and deploy, from the repository root:
   ```sh
   gcloud artifacts repositories create labyrinth --repository-format=docker --location=europe-north1
   gcloud builds submit --config deploy/lbrnth-host/cloudbuild.yaml .
   gcloud run deploy lbrnth-host --image europe-north1-docker.pkg.dev/$PROJECT/labyrinth/lbrnth-host:latest \
     --region europe-north1 --allow-unauthenticated --min-instances 0 --max-instances 3 --concurrency 20 \
     --set-secrets LBRNTH_MASTER_KEY=lbrnth-master-key:latest,DATABASE_URL=lbrnth-database-url:latest,CID_DIRECTORY_KEY=lbrnth-cid-directory-key:latest
   ```
   `--allow-unauthenticated` only opens the Labyrinth API itself, which demands a CID bearer.
4. Redeploy `cumulus-id` with this change and `LBRNTH_ENDPOINT`. Set `LBRNTH_ENDPOINT` on Mail
   and on the ARCHITECT Worker (rchtch.app).
5. Add the client org's entitlement row, then check: `/health` says configured, `POST
   /api/labyrinth` without a bearer is 401, and Save to Labyrinth plus the Saved tab work.

No DNS change is needed: relays call the `run.app` URL server to server.

## Limits

- The host serializes requests per instance and rebuilds its in-memory SDK when another
  instance commits; `--max-instances 3` keeps conflicts rare. Capacity limits are unchanged
  (256 orgs, 32 MiB per org, 128 MiB total).
- Rate limits are per instance and reset when an instance restarts.
- Browsers in Russia reach the relays (rchtch.app, id.cumuluscloud.app), not the host. Those
  are Cloudflare-hosted, so Russian reachability still depends on them; the Cloud Run host only
  removes the storage blocker.
- Migrating an existing file snapshot is not automated; none is in production use.
