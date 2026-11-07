# Explicit archive ingestion and delivery

By **Infinitum Corporation®**. Backend-only library, not a deployed service.

`@infinitum/event-ingest` applies reviewed public backend patterns to selected
historical artifacts and diagnostics. It does not operate aircraft, vehicles,
radios, satellites or weapons. No biometric identification, facial recognition,
person re-identification or tracking is implemented.

## What is real

- `ArchiveIngest`: authenticated immutable event/outbox records in Labyrinth;
  canonical content hashes, stable source/event IDs, conflict detection, explicit
  storage receipts, explicit dispatcher retry and separate delivered state.
- `createArchiveServer`: real Node HTTPS server object with mandatory TLS 1.3,
  CA-verified client certificates and explicit SHA-256 fingerprint bindings.
  It does **not** call listen or deploy anything.
- `createArchiveClient`: real Node mTLS HTTP client; pinned product namespace,
  trusted server CA, hostname verification, fresh opaque CID bearer per request,
  fixed origin, no redirect following, ten-second deadline and bounded responses.
- HTTP and MQTT archive-dispatch adapters. MQTT takes a host-supplied publisher
  which must resolve after broker acknowledgement; no broker/client SDK is bundled.
  Topics must be fixed under `archives/`; vehicle command-topic namespaces are refused.
- Replaceable fixed-cardinality counters/recorder sink plus bounded per-peer token
  bucket. Metrics never receive event payloads, credentials, IDs, URLs or labels.
- Offline `djiDiagnosticEvent`: parses a **subset** of saved DJI-style OSD JSON,
  retaining temperature/humidity/dock-presence fields only. It does not connect to
  DJI, subscribe to a broker, respond to requests or accept command/reply topics.
- `catalogManifestEvent`: local provider/dataset/checksum/license/attribution
  record. No imagery is queried, downloaded, located, analyzed or redistributed.

## Storage and identity contract

Construct `ArchiveIngest` with the authoritative host's existing `CidLabyrinth`.
No CID database, bearer, device identity or organization is inferred from JSON or
proxy headers. All operations reauthenticate current sessions/directory membership,
read/write consent, org roles and separate LBRNTH plan authority through Labyrinth.
Repository-only CID-derived credentials remain parent-revocable.

Records live at `products/<product>/ingest/<source>/<event-id>.json` in a private
operator-selected repository. A receipt is returned only after configured
`storage.save()` succeeds. **Durability depends on that configured storage**: use
persistent encrypted/transactional storage in production, not MemoryStorage or
ephemeral Vercel files. Encrypted-storage restart recovery is covered by tests.

Gateway certificate bindings pin source **and** product-to-repository mapping.
A valid cert alone grants neither CID identity nor repository access; a valid CID
bearer alone cannot pass mTLS. Source/product/repo claims in the HTTP body are
rejected. Certificates must chain to the operator CA and match an allowed leaf
fingerprint. An optional trusted `isPeerEnabled` callback supports live deny; no
certificate provisioning, CRL/OCSP or rotation workflow is invented here.

## API

Service methods:

- `submit(token, product, source, repo, event)` → storage receipt.
- `receipt(token, product, source, repo, eventId)` → current receipt snapshot.
- `deliver(token, product, source, repo, eventId)` → explicit dispatcher attempt.

The mTLS route is `POST /api/archive-ingest/<product>`, JSON only:

```json
{"action":"submit","event":{"id":"selected-1","kind":"archive","payload":{"selected":true}}}
```

`receipt` and `deliver` accept only `action` and `id`. No source/repo/token in URLs.
No ambient cookies, Origin-bearing browser calls, forwarded identity headers or
compressed request bodies are accepted. The server configuration maps peer
fingerprints to `{source, repositories: {product: repoId}}`.

An event has `id` (1–64 safe ASCII characters), `kind` (`archive` or `diagnostic`),
JSON `payload` and optional canonical ISO `observedAt`. No command/event execution
exists. The same ID/content in the same source/product/repository is idempotent;
reusing an ID with different content is a conflict. A receipt's `commitId` is a
snapshot containing that receipt, not necessarily the original insertion commit.
Records can be versioned by dispatch state; payload/content hash remains fixed.
An authorized writer using lower-level Labyrinth APIs can still intentionally edit
or delete records; this is not protection against a malicious authorized owner.

## Delivery semantics — not exactly once

`stored: true` acknowledges storage only; `delivery: pending` is **not** downstream
success. No automatic external dispatch is performed on submit. A host/operator
must explicitly call deliver for selected records; no background queue scanner,
remote scheduler, Kafka service or MQTT daemon is started.

Before invoking a dispatcher, the service persists an attempt, enforcing live
write permissions and plan authority. Only a successful dispatcher resolution and
subsequent authorized commit mark the record delivered. Failed/timeout delivery
returns pending (HTTP 202) with its attempt count; errors do not expose downstream
bodies or credentials. Concurrent dispatch of one record is excluded in this
service instance, with a 32-dispatch global cap.

A crash/revocation after downstream acceptance but before the delivered commit can
cause a repeat. Stable SHA-256 idempotency keys are supplied to dispatchers; the
consumer must honor them. Delivery is **at least once**, not transactional with the
external broker. A timed-out callback must honor AbortSignal; uncooperative drivers
may continue work and retries may duplicate. No cancellation or distributed
exactly-once guarantee is claimed. Default retry budget: five, maximum ten;
exhausted records require operator recovery, not an infinite retry loop.

## Limits and observability

HTTP body/response 64 KiB; canonical stored record/event JSON 32 KiB; nesting eight;
2,048 JSON nodes; arrays 1,024 elements; object 256 fields. Default 128 records per
source/product/repository (configurable lower only), preserving receipts until
explicit operator archival/cleanup. Defaults: five requests/second, burst ten per
configured certificate; 128 configured peers, 32 active requests and 64 sockets.
TLS/header/body/dispatch deadlines are bounded. Existing Labyrinth org/audit quotas
and single-active-writer restrictions also apply. Per-process limits do not replace
fleet-wide ingress/WAF quotas, DDoS protection or distributed concurrency control.

Metrics have fixed names, no arbitrary dimensions and an operator-only snapshot.
Sink exceptions are isolated from committed storage and delivery decisions. There
is no public metrics port or automatic telemetry export.

## Product integration

Direct namespace-pinned client exports were added to existing libraries:

| Products | Callable API |
|---|---|
| DAEMON, SLUG, ORBIS, POLLEN, Flower | `createDroneArchiveClient`; `droneArchiveEvent` normalizes selected old MAVLink observations |
| Cumulus Cloud | `createCloudArchiveClient` |
| HRVST | `createHrvstArchiveClient` (explicit caller-selected artifacts only) |
| METATRON | `createMetatronArchiveClient` |
| FABRIC | `createFabricArchiveClient` (no message capture/decryption added) |
| AETHER | `createAetherArchiveClient` (no routing/link-control changes) |

These clients are **Node/server-side**, not browser/native-device mTLS onboarding.
Actual mTLS tests exercise all ten direct product namespaces. Other listed
`ARCHIVE_PRODUCTS` can use the generic client when the operator explicitly binds
that product/repository; that is reusable SDK availability, not runtime adoption.
No private artifact is automatically sent to the public Data Exchange.

## Provenance and remaining gaps

[NOTICE](NOTICE), [licenses](licenses/) and
[research/application matrix](../../docs/OSS-BACKEND-APPLICATIONS.md) distinguish
implemented patterns from surveyed but unused repositories. No new external
runtime dependency or upstream application source was vendored.

Operator work remains: production listener/service hosting, real storage/billing,
certificate issuance/rotation/revocation operations, trusted gateway enrollment,
external broker/HTTP deployment, legal data-access rights, retry scheduling,
retention/cleanup and independent security review. Hardware interoperability,
full Tesla/DJI/STAC compatibility, predictive models, orbital mechanics,
communications resilience and operational mission functions are not claimed.

Run `pnpm --filter @infinitum/event-ingest test` and `typecheck`. Tests create and
remove temporary local test certificates; no production credentials are used.
