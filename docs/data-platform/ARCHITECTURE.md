# Cumulus data platform: open-source components

Status: first slice implemented on this branch. Nothing here is deployed, and no paid cloud
resource was created.

This maps the ten open-source projects on the plan to Cumulus. For each it says what the
project does for us, where it runs, whether we adopt it now or defer it, and its license. The
running code is in [`infra/data-platform/`](../../infra/data-platform/README.md).

## Summary

| # | Project | Decision | License | Where it runs | In this branch |
|---|---|---|---|---|---|
| 1 | LinkedIn DataHub | **Adopt now** | Apache-2.0 | Dev: pinned quickstart. Hosted: US servers, metadata only | Quickstart script, ingestion recipes, `CatalogService` pushing specs to DataHub |
| 2 | Microsoft Presidio | **Adopt now** | MIT | Inside the privacy gateway, next to each data region | Redaction for analytics, AI and Exchange, with tests |
| 3 | AWS Deequ | **Defer** (no Spark yet). Use its check vocabulary now | Apache-2.0 | Later: the Spark lakehouse jobs | Deequ-style quality suites in the gateway, with tests |
| 4 | Apache Hudi (Uber) | **Defer** | Apache-2.0 | Later: lakehouse tables on object storage | Design notes only |
| 5 | Apache Superset (Airbnb) | **Adopt now** | Apache-2.0 | Dev: compose profile `bi`. Hosted: US servers, reading EU data | Image with Cumulus ID sign-in and embedding config |
| 6 | Elasticsearch | **Replace with OpenSearch** | Elasticsearch: AGPL-3.0 / SSPL / Elastic License 2.0. OpenSearch: Apache-2.0 | Dev: compose. Hosted: next to each data region | OpenSearch with the events index template; `CollectionService` and `SearchService` |
| 7 | Netflix Metacat | **Evaluate only**. Do not run alongside DataHub | Apache-2.0 | Not deployed | Comparison below |
| 8 | Google Differential Privacy | **Adopt now** for outbound aggregate releases | Apache-2.0 | Inside the privacy gateway | DP count and sum with a privacy budget, with tests |
| 9 | Meta Opacus | **Defer** until a model trains on personal data | Apache-2.0 | Later: training jobs | Criteria below |
| 10 | Palantir Conjure | **Adopt now** for API definitions only | Apache-2.0 | Build time | Contracts for the privacy gateway, collection, catalog and search |

All ten are Apache-2.0 or MIT except Elasticsearch, so they are safe to use as dependencies in
a commercial product. We use each one as a pinned image or package, and none of their source
is copied into this repository.

## How data moves

```
 Products (+SPCTR, Mail, FABRIC, Architect, ...)          people sign in with Cumulus ID
      |  Conjure CollectionService (service token, per product)
      v
 Collection gateway (packages/data-platform, Workers)  -- schema + consent check
      |
      v
 Operational store: Supabase Postgres, eu-west-1 (Ireland)    RU tenants: Yandex Cloud copy
      |                         |                                   |
      | DataHub ingestion       | events                            | outbound batches
      | (metadata only)         v                                   v
      v                   OpenSearch (per-tenant aliases)    PRIVACY GATEWAY
   DataHub catalog              ^                             1. Presidio redaction
   owners, lineage,             | SearchService               2. quality suite (Deequ checks)
   classification,              |                             3. DP release (Google DP)
   glossary                 product search UIs                     |
      ^                                                  +---------+-----------+
      |                                                  v         v           v
      +------------ lineage ------------------ Superset (ANALYTICS)  AI agents   Data Exchange
                                               dashboards, SQL,     (AI)        (EXCHANGE)
                                               embedded in products
```

Rules this enforces:

1. **Nothing leaves a product for analytics, an AI agent or the Exchange without passing the
   privacy gateway.** The gateway's `prepareExport` redacts, then runs the dataset's quality
   suite on the redacted rows, and releases the batch only if both pass.
2. **Data stays in its region.** Records stay in Ireland (Supabase eu-west-1), and Russian
   tenants stay in Yandex Cloud. Compute can run on US servers (Cloudflare), but the gateway
   and OpenSearch must run in the same region as the data they process. DataHub holds only
   metadata, so one catalog can cover every region.
3. **The Exchange gets aggregates, not people.** Exchange releases are either redacted rows
   that pass a second scan or DP aggregates charged to a privacy budget.

## 1. DataHub: catalog (adopt now)

DataHub holds the inventory of datasets, with their owners, lineage, classifications
(`PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `PERSONAL`, `SPECIAL_CATEGORY`), glossary terms and
business definitions. It is the system of record for the `DatasetSpec` in
[`conjure/platform.yml`](../../infra/data-platform/conjure/platform.yml). Each dataset's field
rules (`KEEP`, `TEXT`, `PSEUDONYMIZE`, `DROP`) are what the privacy gateway applies on export,
so the catalog and the redaction policy cannot drift apart.

- **Dev:** `bash infra/data-platform/datahub/quickstart.sh` installs CLI `acryl-datahub==1.7.0.20`
  and starts server `v1.7.0.1`. It needs about 8 GB of RAM, so it is kept out of the core
  compose file. A manual CI job (`workflow_dispatch` with `datahub: true`) boots it on a free
  runner.
- **Ingestion:** `datahub/recipes/supabase-postgres.yml` loads schemas and lineage from Postgres
  with a read-only metadata role. Profiling is off because it reads rows.
  `datahub/recipes/opensearch.yml` loads the event index mappings.
- **Catalog replay:** `python -m cumulus_privacy.catalog_sync` (or, on the box,
  `docker compose exec privacy-gateway python -m cumulus_privacy.catalog_sync`). DataHub runs on
  demand, so it starts empty, while the catalog of record lives in Supabase. The sync pushes
  every stored spec with:
  - owners: `team-*` names become DataHub groups, anything else is a person;
  - classification tags, the schema and glossary terms;
  - spec lineage.

  It then links each logical dataset to the physical tables the Postgres recipe ingests: each
  dataset → `data_platform.events` → `data_platform.events_bi`. It reads metadata only, never
  event rows. If DataHub refuses one spec, the rest are still pushed.
- **Not done yet:** ingesting from Superset. DataHub's Superset source signs in with a Superset
  password, and Superset here accepts only Cumulus ID. It is deferred until Cumulus ID can issue
  a service (client-credentials) token that Superset accepts. The `CatalogService` server
  (`PUT /datasets/{name}` writing to DataHub through its REST emitter) is defined in Conjure
  is implemented: specs are saved locally first, then pushed as DataHub aspects (properties,
  ownership, classification tags per field, schema, lineage, glossary terms). The manual DataHub
  CI job pushes a spec and reads it back from GMS.
- **Hosting:** to decide later. Self-host (Kafka, MySQL and OpenSearch, about 3 small VMs) or use
  Acryl's paid DataHub Cloud. Either needs William's OK, because both cost money.

## 2. Presidio: PII redaction (adopt now, implemented)

`infra/data-platform/privacy-gateway/cumulus_privacy/redaction.py` uses Presidio as a library
(`presidio-analyzer` and `presidio-anonymizer` 2.2.366, spaCy `en_core_web_sm` 3.8.0). It
recognizes Presidio's built-in entities plus two of ours: `CUMULUS_ID` (`cid_…`) and `SECRET`
(AWS, GitHub, Stripe and Slack keys, JWTs, private keys).

| Destination | Personal data becomes | `PSEUDONYMIZE` fields | Extra rule |
|---|---|---|---|
| `ANALYTICS` | Keyed HMAC-SHA256 pseudonym, e.g. `<EMAIL_ADDRESS:3f9a…>`. Stable, so dashboards can count and join | Pseudonym | Card numbers, IBANs, SSNs, secrets and crypto addresses are always removed, never pseudonymized |
| `AI` | Type tag, e.g. `<PERSON>` | `<FIELD>` tag | Secrets always removed |
| `EXCHANGE` | Type tag | Dropped, so data can't be linked across tenants | Re-scanned after redaction. Any record that still has PII blocks the whole batch (fail closed) |

Pseudonyms are keyed per destination, so a pseudonym in one release can't be matched against
any other release. Phone numbers use a lower score threshold (0.35), because Presidio scores a
bare number at 0.4, and missing a number is the worse error here.

**Limits:**
- The spaCy model is English. Russian names won't be found as `PERSON` until a Russian model
  (`ru_core_news_sm`) is added for RU tenants. Pattern entities such as email, phone, card and
  IBAN work in any language.
- The small model trades some `PERSON` and `LOCATION` recall for size. Set
  `PRESIDIO_SPACY_MODEL=en_core_web_lg` in production.

## 3. Deequ: data quality (defer the engine, adopt the checks)

Deequ runs on Apache Spark on the JVM. Cumulus has no Spark today. Its data lives in Postgres,
Durable Objects and Workers, so adding a Spark cluster just to run checks isn't worth it yet.

What we adopted now is Deequ's vocabulary, in `quality.py`: completeness, uniqueness (Deequ's
definition), range compliance, allowed values, freshness, size, and anomaly detection on
metric history (Deequ's `RelativeRateOfChangeStrategy`). Suites are data (`QualitySuite` in
Conjure), so a suite maps one to one onto Deequ `VerificationSuite` checks later. The TS
package `packages/data-platform/src/quality.ts` (on another branch) uses the same check names
for in-Worker rebuilds.

**When to adopt Deequ itself:** when Hudi or Spark tables exist (see 4). Then the same suites run
as Deequ checks inside the Spark jobs, and the metrics repository feeds anomaly detection.

## 4. Hudi: lakehouse (defer)

Hudi gives incremental upserts, corrections and deletes on files in object storage. The right
time to adopt it is when analytics volume outgrows Postgres plus OpenSearch, or when we need
record-level deletes across a large history (GDPR erasure). Neither is true yet.

When we adopt it:
- Table format: Hudi Merge-on-Read tables on S3-compatible storage. Use Cloudflare R2 for EU
  data (R2's EU jurisdiction) and Yandex Object Storage for RU.
- Writers: Spark, or Flink for streaming. Deequ checks run in the same jobs.
- Erasure: a Hudi delete keyed by CID pseudonym, recorded in the Firmament ledger.
- Alternatives to weigh at that point: Apache Iceberg (wider engine support) and Delta Lake.
  Hudi is best at upsert-heavy CDC from Postgres.

## 5. Superset: dashboards and embedded analytics (adopt now)

The `bi` compose profile builds `apache/superset:6.1.0`, adds the Postgres driver and authlib,
and loads [`superset_config.py`](../../infra/data-platform/superset/superset_config.py):

- **Sign-in is Cumulus ID only.** It uses OIDC against
  `https://id.cumuluscloud.app/realms/cumulus` (`CUMULUS_ID_ISSUER`, which can point at the
  Russia mirror) with PKCE. The username is the CID `sub`, and accounts are never joined by
  email. Cumulus ID groups map to roles: `data-platform-admins` → Admin and `data-analysts` →
  Alpha. Anyone else gets Gamma. There is no Superset password. People without a Cumulus ID
  create one from the Cumulus ID sign-in page and come back signed in.
- **Embedded analytics:** `EMBEDDED_SUPERSET` is on. A product backend mints a guest token
  (5 minutes) and embeds the dashboard with the Superset embedded SDK.
  `CUMULUS_EMBED_ORIGINS` sets `frame-ancestors`.
- Superset reads only datasets that went through `prepareExport(ANALYTICS)`. It never reads
  raw product tables.
- **Amplitude:** Superset is an internal tool, so the Amplitude rule doesn't apply.

## 6. Elasticsearch → OpenSearch (adopt OpenSearch)

**License flag:** Elasticsearch is offered under AGPL-3.0, SSPL-1.0 or Elastic License 2.0.
AGPL's network clause and SSPL's service clause are a real risk for a product we host for
customers. ELv2 forbids providing it as a managed service. OpenSearch is the Apache-2.0 fork
with the same query DSL, so we use it.

- Dev: `opensearchproject/opensearch:3.9.0`, single node, bound to 127.0.0.1. The security
  plugin is off locally only.
- [`search/events-template.json`](../../infra/data-platform/search/events-template.json)
  defines the strict mapping: tenant, product, event type, object, time, a `text` field and a
  `flat_object` payload. Products search through `SearchService`. The server always adds the
  tenant filter and the caller's product, so a product's token can never read another
  product's events. The search token is a page cursor (`search_after`), not an offset.
- What gets indexed is the redacted event (`prepareExport(ANALYTICS)` output), not the raw one.
- Hosted: self-host next to each data region, or use AWS OpenSearch Service in us-east-2. The
  AWS option would put EU data in the US, so only metadata-free indexes could go there. That
  needs William's OK.

## 7. Metacat: evaluation only

Metacat (Netflix) is a federated metadata API. It doesn't copy metadata. It answers live by
calling connectors (Hive, Postgres, MySQL, Redshift, S3, Snowflake), and it publishes change
events.

| | DataHub | Metacat |
|---|---|---|
| Model | Pull and push ingestion into its own graph | Live federation through connectors |
| Lineage, ownership, glossary, classification | Built in, with UI | Not its focus. Only tags and definitions |
| UI | Full search and browse UI | API only |
| Activity | Very active, large community | Low release activity |
| Fit for Cumulus | The catalog people use | An idea worth borrowing: connector-style live reads |

**Decision:** run DataHub only. What we take from Metacat is its connector architecture. If a
source must be read live rather than ingested, we write a DataHub source in Metacat's connector
style. Reconsider only if live federated reads across many warehouses become a requirement.

## 8. Google Differential Privacy (adopt now for outbound releases)

`dp.py` calls Google's C++ library through the official Python binding `python-dp==1.1.5`
(module `pydp`, Laplace `Count` and `BoundedSum`). On top of the library it adds what a correct
release needs:

- **Public partitions.** Group keys are supplied up front. The release refuses to take them
  from the data.
- **Contribution bounding.** Each CID counts in at most `maxPartitions` groups, once per group.
  Its per-group sum is clamped to `[lower, upper]`.
- **A privacy budget per dataset,** persisted to disk. A release that would overspend is refused
  before any noise is drawn, and the refusal spends nothing.
- **Suppression** of groups whose noisy value falls below a set floor.

**Eligible releases:** Exchange aggregate samples, public usage statistics and benchmark reports.
Internal dashboards use exact numbers under access policy.

`python-dp` has Linux and macOS wheels only. Its noise test runs in CI and in the gateway
container. On Windows, the bounding and budget tests run with a no-noise test backend.

## 9. Opacus: DP model training (defer)

Opacus trains PyTorch models with DP-SGD. No Cumulus model trains on personal data today.
Models are external, reached through OmniRoute and open models, and AI context is redacted by
the gateway (`AI` destination). Adopt Opacus when all of these hold:

1. We fine-tune or train a model on data that includes people's records, such as +SPCTR deal
   text or Mail content.
2. The model or its outputs reach anyone outside the data's tenant.
3. Redacting the inputs isn't enough, because the signal itself is personal.

When we adopt it, pin Opacus with PyTorch, set a target epsilon of 8 or less with
δ = 1/(number of people), and record the epsilon in the model card in DataHub.

## 10. Conjure: typed API contracts (adopt now)

[`conjure/privacy.yml`](../../infra/data-platform/conjure/privacy.yml) and
[`conjure/platform.yml`](../../infra/data-platform/conjure/platform.yml) define:

| Service | Base path | Implemented |
|---|---|---|
| `PrivacyGatewayService` (redact, prepareExport, verifyQuality, releaseDp) | `/api/v1` | Yes, in `privacy-gateway`. A contract test checks routes and response fields against the YAML |
| `CollectionService` (ingest events) | `/api/v1/collect` | Yes. Checks each event against its registered schema, product and region, redacts the payload with the dataset's field rules, and indexes it idempotently by `eventId` |
| `CatalogService` (register and get datasets in DataHub) | `/api/v1/catalog` | Yes. A product registers and reads only its own datasets |
| `SearchService` (search events: Postgres full-text on the free tier, or OpenSearch) | `/api/v1/search` | Yes. Tenant and product filters are added on the server |
| `ErasureService` (right to erasure by Cumulus ID) | `/api/v1/erasure` | Yes. A product erases its own events; the pipeline token erases across products |

Products call these three with their own token (`PLATFORM_PRODUCT_TOKENS`), which decides
which product's data a caller can touch. The privacy endpoints keep their separate pipeline
token. Military and defense products are refused at collection. The TS collection gateway in
`packages/data-platform` (other branch) should forward to `CollectionService`.

CI compiles the definitions with the official `conjure` 4.66.0 compiler, with its checksum
pinned, into Conjure IR. Client generators are the next step: `conjure-typescript` for
products, and `conjure-python` for pipelines. Only the API tooling is used, not Palantir
Foundry or Gotham.

**Naming note:** "Conjure™" is also the name of Infinitum's swarm-prediction product
(`packages/conjure`). Palantir's Conjure appears in this repo only as the `.yml` contracts
under `infra/data-platform/conjure/` and the compiler in CI.

## Excluded products

Military and defense products (AETHER, Infinitum Defense, E(O)N military edition, ARGUS
military edition) don't send data to this platform. In particular, they don't send to the
Exchange or to analytics.

## Decisions for William

1. **Hosting.** There is a $0 plan in [FREE-HOSTING.md](FREE-HOSTING.md):
   - Events, search, the catalog and the DP budget go in the existing Supabase project in Ireland.
   - The gateway and Superset run on the self-hosted box, behind a free Cloudflare Tunnel.
   - DataHub runs on demand.

   The managed options (Acryl DataHub Cloud, AWS OpenSearch Service, Preset) still cost money.
   Nothing has been created yet: the production steps wait for William's OK.
2. **Spark lakehouse (Hudi + Deequ).** Deferred until data volume or erasure needs justify it.
3. **Russian NER model** for Presidio on RU tenants.
