# Cumulus data platform: dev stack

This directory holds the running pieces. The design, licenses and adopt/defer decisions are in
[docs/data-platform/ARCHITECTURE.md](../../docs/data-platform/ARCHITECTURE.md).

| Path | What |
|---|---|
| `privacy-gateway/` | Python service. Uses Presidio for redaction, runs Deequ-style quality suites and makes Google DP releases. Also runs catalog, collection and search. Serves `conjure/privacy.yml` and `conjure/platform.yml` |
| `smoke/` | End-to-end check of catalog, collection and search against the running stack |
| `conjure/` | Palantir Conjure API definitions for the product ↔ data platform contracts |
| `docker-compose.yml` | Privacy gateway and OpenSearch. Profile `bi` adds Superset (Cumulus ID sign-in) |
| `search/` | OpenSearch events index template and bootstrap |
| `superset/` | Superset image and `superset_config.py` |
| `datahub/` | Pinned DataHub quickstart and ingestion recipes |
| `deploy/box/` | $0 production profile: gateway and Superset on the self-hosted box, storage in Supabase (`DATABASE_URL`), Cloudflare Tunnel; `box.sh` checks the `.env`, starts, updates and reports health. See [FREE-HOSTING.md](../../docs/data-platform/FREE-HOSTING.md) |
| `deploy/cloudrun/` | Template for the Cloud Run always-free fallback (not created; needs William's OK) |

## Run it

Needs Docker with Compose v2. All ports bind to 127.0.0.1.

```bash
cd infra/data-platform
cp .env.example .env   # fill every empty value with: python -c "import secrets;print(secrets.token_hex(32))"
docker compose up -d --build --wait privacy-gateway opensearch
docker compose run --rm opensearch-init
docker compose --profile bi up -d --build superset   # optional: Superset on http://localhost:8088
bash datahub/quickstart.sh                            # optional: DataHub on http://localhost:9002 (about 8 GB RAM)
```

Try the gateway:

```bash
curl -s http://127.0.0.1:8090/api/v1/redact -H "Authorization: Bearer $PRIVACY_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"destination":"AI","records":[{"note":"Call Jane Doe at jane@example.com"}]}'
```

## Tests

```bash
cd infra/data-platform/privacy-gateway
python -m pip install -r requirements-dev.txt   # Python 3.12 or 3.13
python -m pytest
```

On Windows, the Google DP noise test is skipped, because `python-dp` has no Windows wheels. It
runs in CI and in the container. The GitHub workflow `Data platform` runs the tests, compiles
the Conjure definitions, and boots the stack (gateway, OpenSearch and Superset) on every PR that
touches this directory.
