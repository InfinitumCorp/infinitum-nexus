# @infinitum/data-platform

The Cumulus data platform. It contains the collection SDK, the collection gateway, the policy service, the lakehouse, pipelines, the catalog and the Infinitum Ontology.

**Milestone 1 is done** and covered by [`src/milestone.test.ts`](src/milestone.test.ts). A Cumulus://Cloud upload produces an event. The event reaches the lakehouse exactly once. It then appears as an ontology object that only authorized people can read. When the file is deleted, it disappears from every derived table and index.

```
product backend ── Collector (sdk.ts) ──signed POST──▶ Gateway (gateway.ts)
                                                        │ auth · replay · quota
                                                        │ envelope + contract + PII checks
                                                        │ PolicyService (authoritative records)
                                                        │ pseudonymize subject + cid fields
                                                        ▼
                         Lakehouse raw zone (exactly once) ─▶ Pipeline ─▶ normalized ─▶ curated
                                                                          └▶ Ontology + search index
```

## Guarantees

- **Raw Cumulus IDs are never stored.** The gateway replaces the subject and every `cid` payload field with a tenant-scoped HMAC pseudonym.
- **The server decides permissions.** A client cannot set `subject_id`, `classification`, `policy_ref` or `received_at`. The gateway derives them from tenancy, policy records and opt-ins.
- **No content collection.** Contracts list the allowed fields. A fixed denylist rejects content fields such as body, text, password and token. A value-level PII scan rejects personal data that is put into an allowed field.
- **Each event is stored once.** Deduplication is keyed by (tenant, event_id). SDK retries reuse the same ids, and the Cloud adapter derives ids from (file, version, action).
- **Deletion means deletion.** `file.deleted` removes the object from the normalized zone, the curated zone, the ontology, links and the search index. It also expires every older snapshot, so time travel cannot bring the data back. The raw zone keeps only the deletion tombstone.
- **Military products are excluded.** AETHER, ARGUS, E(O)N and ODIN are refused by credentials, policy records, `decide()` and a SQL check constraint.

## Ideas adopted from open-source data platforms

The ideas were adopted in-house as small TypeScript modules with no runtime dependencies. No third-party repositories are vendored.

| Source | Idea | Here |
|---|---|---|
| LinkedIn DataHub | Dataset inventory with owners, lineage, classification and a glossary | `catalog.ts` |
| Microsoft Presidio | Pattern recognizers plus validators (Luhn, IBAN mod-97) for PII | `pii.ts` (detect and redact) |
| AWS Deequ | Declarative data checks: completeness, uniqueness, range, freshness and row count | `quality.ts`, run on every curated rebuild |
| Apache Hudi | Incremental upserts and deletes per record | `table.ts` / `lakehouse.ts` (copy-on-write purge) |
| Elasticsearch | An inverted index filtered by permission at query time | `Ontology.search` |
| Google differential-privacy | Bounded contributions, Laplace noise, a privacy budget and suppression | `privacy.ts` |
| Palantir Conjure | One typed contract between products and the platform | `envelope.ts` + `schemas.ts` |

Integration notes for the larger systems:

- **Superset** can sit on the curated zone and be embedded in Cumulus. Grant it curated datasets only, never raw.
- **Metacat**: use its connector pattern as a reference only. Do not run it alongside DataHub.
- **Opacus**: use it only when a model is trained on curated data and the use case justifies differential-privacy training.
- **Elasticsearch licensing**: Elasticsearch is now under AGPL, SSPL or the Elastic License. If a hosted search cluster is needed, OpenSearch (Apache-2.0) avoids that question.

## Use

```ts
import { createPlatform, MemoryCredentials, FileObjectStore } from "@infinitum/data-platform";
import { Collector } from "@infinitum/data-platform/sdk";
```

- **Server.** Use `createPlatform({ store, tenancy, credentials, pseudonymSecret })` with `createHttpServer(platform, { resolveViewer })`.
  - `resolveViewer` must verify a Cumulus ID session.
  - `pseudonymSecret` and the credential secrets come from the secret manager, never from source.
- **Product backends.** Use `new Collector({ endpoint, keyId, secret, product })`, then call `track(...)` and `flush()`.
  - Browser and mobile clients send through their own backend after Cumulus ID sign-in. They never hold a product credential.
- **R2 or S3.** Use `new S3ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, prefix })` as the `store`.
  - Requests are signed with SigV4 using only built-in Node APIs; the signer is tested against AWS's published example.
  - Table commits use conditional writes (`If-Match` / `If-None-Match`), so several gateway instances can share one bucket without losing commits.
- **Exchange.** `prepareOffer(...)` turns an exportable curated dataset into privacy-protected aggregate counts, never rows.
  - It is refused unless the catalog marks the dataset exportable and not restricted, its latest quality report passed, and every contributing tenant's policy record allows export.
- **Postgres.** `migrations/0001_ontology_policy.sql` creates the policy records, opt-ins, credential references, the ontology serving tables with row-level security, and the deletion log.

## Not yet

- Cross-process deduplication in the raw zone. Commits are safe across processes, but two gateways that receive the same event at the same moment can both store it. The pipeline's normalized-zone check still counts it once.
- Parquet data files (the table format already records `file_format`).
- A Postgres-backed `PolicyService`, ontology store and Cumulus ID tenancy directory.
- Contracts for the rest of the products' events.
- Publishing offers into `@infinitum/data-exchange` (consent records and revenue share live there).
- Contracts for the other products' events. HRVST is not covered yet; it needs a decision on whether it belongs on the platform at all.
