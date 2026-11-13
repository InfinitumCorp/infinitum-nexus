# Evaluations: Opacus, Hudi and Metacat

These are the three projects from the data-platform list that we evaluated but did not adopt.
Each section covers:
- what the project does;
- what it would replace or add in our stack as built (see [ARCHITECTURE.md](ARCHITECTURE.md));
- the measurable trigger that makes adoption worth it, and what adoption would cost under the $0 hosting plan ([FREE-HOSTING.md](FREE-HOSTING.md));
- the first steps when the trigger fires.

Some components named here are in open pull requests: ingest quality checks (#191),
`catalog_sync.py` (#194) and `event_release.py` (#200).

Military and defense products (AETHER, Infinitum Defense, E(O)N military, ARGUS military) are
out of scope for all three, as for the rest of the platform.

## Summary

| Project | Decision | Trigger to revisit | Cost when adopted |
|---|---|---|---|
| Opacus (DP-SGD training) | Defer | We train or fine-tune a model on personal records whose outputs leave the tenant | GPU time. $0 only on our own hardware |
| Apache Hudi (lakehouse tables) | Defer | Events outgrow the Supabase free tier, or erasure must reach a large file history | Object storage (Cloudflare R2 free tier: 10 GB) plus Spark or Flink compute |
| Metacat (federated metadata) | Do not adopt | Live metadata reads across several warehouses we do not ingest | One more JVM service to run |

---

## 1. Opacus

**What it is.** Meta's library for training PyTorch models with differentially private
stochastic gradient descent (DP-SGD). It clips each example's gradient, adds Gaussian noise and
tracks the privacy spend (epsilon at a chosen delta) with an accountant. Apache-2.0.

**Where it would sit.** In a training job, not in the gateway. The gateway's Google DP releases
(`dp.py`, `event_release.py`) protect aggregate statistics. Opacus protects a trained model's
weights, so that the model cannot memorise any one person's records.

**Why not now.**
- No Cumulus model is trained or fine-tuned on personal data. Models are external (through
  OmniRoute and open models), and what they see is redacted by the gateway's `AI` destination
  before it leaves.
- Redaction covers inference. DP-SGD only matters once a model *learns* from records.

**Trigger: adopt when all three hold.**
1. A training or fine-tuning job reads people's records (e.g. +SPCTR deal notes, Mail
   content), even after redaction.
2. The resulting model, or its outputs, reach anyone outside the tenant whose records it saw
   (another tenant, the Data Exchange, a public model).
3. The useful signal is itself personal, so redacting inputs would destroy it.

If only (1) holds, train per tenant and keep the model inside the tenant instead. That needs no
DP and gives better utility.

**Requirements when adopted.**
- Consent: only records with `AI_IMPROVEMENT` consent go into training. This is the same consent
  set the collector already stores per event.
- Privacy unit: the person (CID pseudonym), not the row. Bound each person's rows per epoch
  (user-level DP), the way `dp.release` bounds contributions.
- Budget: target ε ≤ 8 at δ = 1/N (N = number of people in the training set). Record ε, δ, the
  clipping norm and the noise multiplier in the model's DataHub entry, next to the dataset
  lineage.
- Utility check: train the same model without DP on a non-personal or synthetic proxy, and
  compare. Ship only if the accuracy loss is acceptable for the use case.
- Hosting: DP-SGD needs per-example gradients. That costs roughly 1.5–3× the memory and time of
  normal training. On the $0 plan this means our own GPU box. Rented GPUs need William's OK.

**First steps.** Pin `opacus` together with the matching `torch` version. Write the training job
against `PrivacyEngine.make_private_with_epsilon`. Add a test that checks the accountant's ε on a
toy dataset, and a membership-inference smoke test.

---

## 2. Apache Hudi

**What it is.** A table format and services layer for data lakes:
- record-level upserts and deletes on Parquet files in object storage;
- incremental queries ("what changed since commit X");
- copy-on-write and merge-on-read tables;
- compaction and clustering.

Writers are Spark, Flink or Java. Readers include Spark, Trino and Presto. Apache-2.0.

**Where it would sit.** Behind the gateway, as the long-term event store. Supabase Postgres
would then keep only recent events and the catalog.

**Why not now.** The platform is sized for the free tier, and the free tier is enough:
- Events live in Supabase Postgres (`data_platform.events`), with full-text search and retention
  purges. The gateway stops intake at 450 MB (`PLATFORM_STORAGE_LIMIT_MB`) to stay under the
  500 MB free database.
- Erasure is a single indexed `DELETE ... WHERE cid = ...` (`Eraser`, GDPR Art. 17). It is
  immediate and complete because there are no files to rewrite.
- A lakehouse adds object storage, a Spark or Flink runtime, compaction schedules and a query
  engine. None of these is free to run, and none is needed at this volume.

**Trigger: revisit when any of these holds.**
1. **Volume:** the storage guard trips, or retention would have to drop below the
   `retentionDays` products registered. That means the free database is too small for the
   retained history.
2. **History:** an analytics question needs more history than Postgres can hold cheaply, such as
   multi-year benchmarks for the Data Exchange.
3. **Change data:** products need incremental feeds ("events changed since T") for downstream
   jobs at a rate Postgres logical replication can't serve.

**Options at that point.** Compare, don't assume Hudi:

| | Hudi | Apache Iceberg | Delta Lake |
|---|---|---|---|
| Strength | Upsert- and delete-heavy CDC, built-in table services | Widest engine support, clean spec | Best inside Databricks/Spark |
| Record-level GDPR delete | Native (merge-on-read delete blocks, later compacted) | Position/equality deletes, rewritten by maintenance | Deletion vectors, then `VACUUM` |
| Fit for us | Good if most writes are corrections and erasures | Good if many engines must read | Weak without Databricks |

**Requirements when adopted.**
- Region: EU tables in an EU-jurisdiction bucket (Cloudflare R2 EU jurisdiction, or S3
  eu-west-1 per the "data stays in Ireland" rule). RU tables in Yandex Object Storage. Never
  mixed.
- Erasure: `Eraser` must also issue a Hudi delete keyed by CID pseudonym. The pseudonym is only
  *erased* once compaction has rewritten the files that held it, and retention cleaning has
  removed old file versions. Erasure is reported complete only after that, and recorded in the
  Firmament ledger.
- Quality: the Deequ-style suite (`quality.run_suite` and the ingest checks) runs inside the
  write job. A failing batch is not committed.
- Catalog: tables are registered in DataHub with the same physical-lineage URNs that
  `catalog_sync.py` already emits for Postgres.
- Cost: R2's free tier is 10 GB of storage with no egress fees. Compute is the real cost. A
  nightly Spark job on the self-hosted box is $0. Managed EMR or Dataproc needs William's OK.

**First steps.** Prototype one dataset (`spectre.deal.stage_changed`) as a merge-on-read table
on R2:
- measure write amplification and the time for a full erasure;
- query it from Trino or DuckDB;
- only then plan the migration.

---

## 3. Metacat

**What it is.** Netflix's federated metadata service. Instead of copying metadata into its own
store, it answers live by calling connectors (Hive, Postgres, MySQL, Redshift, S3, Snowflake).
It adds a thin layer of its own (tags, definitions) and publishes change events. Apache-2.0.
Java service, API only, no UI.

**Comparison with what we run.**

| Need | DataHub (adopted) | Metacat |
|---|---|---|
| Ownership, glossary terms, classification tags | Yes. We push them on every `registerDataset` | Tags only |
| Lineage | Yes. Logical (`upstream`) and physical (`catalog_sync.py`) | No |
| Search and browse UI for people | Yes | No (API only) |
| Live view of source schemas | Through ingestion recipes | Native, which is its main idea |
| Community and release pace | Very active | Low activity |
| Fits the $0 plan | Quickstart on demand, catalog replayed from Supabase | One more always-on JVM service |

**Decision: do not adopt.** DataHub already covers everything Metacat would give us except live
federation. Live federation only pays off when there are several warehouses we can't or won't
ingest. We have one store (Supabase Postgres). Our catalog's source of truth is the gateway's own
dataset specs, which `catalog_sync.py` replays into DataHub whenever it starts.

**What we keep from it.** Metacat's connector idea: if a source ever has to be read live rather
than ingested, write it as a DataHub source with a connector-style interface (list, get schema,
get partitions). Don't run a second metadata service.

**Revisit if** several warehouses (e.g. a Hudi or Iceberg lake plus Postgres plus a partner
warehouse) all need one live metadata API that DataHub ingestion can't keep fresh enough.
