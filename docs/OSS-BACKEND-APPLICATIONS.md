# Public backend source applications

Infinitum Corporation® — checked 2026-11-07. New branch stacked on drone archive
PR #27; repository-only work. No website, Vercel, merge, spend or production action.

> Scope note: this document records PR #28. The subsequent, strictly offline
> Firmament/ORBIS numerical planning backend is documented separately in
> [ORBITAL-PLANNING.md](ORBITAL-PLANNING.md); historical exclusions/counts below
> describe the earlier PR, not the follow-up.

## Implemented, not just surveyed

| Source code actually read | License/revision | Applied backend capability | Files |
|---|---|---|---|
| [Tesla fleet-telemetry Producer](https://github.com/teslamotors/fleet-telemetry/blob/bb7c8a931e46da3b3eb6d20a67541c8f755f1ee6/telemetry/producer.go) and [serializer acknowledgement/dispatch](https://github.com/teslamotors/fleet-telemetry/blob/bb7c8a931e46da3b3eb6d20a67541c8f755f1ee6/telemetry/serializer.go) | Apache-2.0; `bb7c8a931e46da3b3eb6d20a67541c8f755f1ee6` | Independent TS dispatcher seam, explicit storage-versus-delivery acknowledgement, source binding, retry budget and idempotent receipt/outbox records. Not Tesla protocol compatibility. | `event-ingest/src/service.ts`, `tls.ts`, `adapters.ts` |
| [Apple SwiftMetrics handlers/factory](https://github.com/apple/swift-metrics/blob/2c13e7385089ea705ee3009ea6cbe41db843930e/Sources/CoreMetrics/Metrics.swift) | Apache-2.0; `2c13e7385089ea705ee3009ea6cbe41db843930e` | Independent replaceable counter/recorder sink; fixed names, no payload/identity dimensions, observer-failure isolation. No Swift locks or runtime ported. | `event-ingest/src/metrics.ts` |
| [Palantir go-baseapp middleware](https://github.com/palantir/go-baseapp/blob/a7849556cb6502cc67a7dd8e462959fb1c6ad35d/baseapp/middleware.go) and [metrics](https://github.com/palantir/go-baseapp/blob/a7849556cb6502cc67a7dd8e462959fb1c6ad35d/baseapp/metrics.go) | Apache-2.0; `a7849556cb6502cc67a7dd8e462959fb1c6ad35d` | Independent request/error/response-class instrumentation and middleware boundary. Deliberately no forwarded-identity trust or raw request logging. | `event-ingest/src/tls.ts`, `metrics.ts` |
| [Meta Folly TokenBucket](https://github.com/facebook/folly/blob/main/folly/TokenBucket.h) | Apache-2.0; current public file read on review date | Independent single-process refill/burst limiter per explicitly enrolled certificate. Not a copy of Folly's atomic C++ implementation. | `event-ingest/src/metrics.ts`, `tls.ts` |
| DJI [CommonTopicRequest](https://github.com/dji-sdk/DJI-Cloud-API-Demo/blob/bef525cb92772b06786c1e033719a6fa1b94bcc5/cloud-sdk/src/main/java/com/dji/sdk/mqtt/CommonTopicRequest.java), TopicOsdRequest and OsdDock | MIT; `bef525cb92772b06786c1e033719a6fa1b94bcc5` | Offline envelope/OSD topic compatibility for selected temperature/humidity/dock-presence diagnostics. Location, control and task fields discarded. No broker connection, request/reply implementation or demo application port. | `event-ingest/src/adapters.ts` |
| [Planet SDK response metadata model](https://github.com/planetlabs/planet-client-python/blob/9b5e50b4faeb6d2c5a87c568b702c7abe0eabcd9/planet/models.py) and public catalog context | Apache-2.0; `9b5e50b4faeb6d2c5a87c568b702c7abe0eabcd9` | Generic local catalog-manifest helper preserves provider, dataset, asserted checksum, declared data-license ID and attribution. New design, not copied SDK code or a Planet/STAC parser. No imagery operations. | `event-ingest/src/catalog.ts` |
| Existing PX4/MAVSDK research from [PR #27 notes](DRONE-BACKEND.md) | BSD-3-Clause; revisions in prior notes | Existing receive-only bounded MAVLink decoder reused to create selected archive-event DTOs. No new flight-stack code imported. | `drone-backend/src/ingest.ts` |

All production TypeScript here is independently written. Full upstream applications
were not transplanted. Source-pattern attributions, Apache license text, unmodified
SwiftMetrics NOTICE and DJI MIT license are preserved under
`packages/event-ingest/NOTICE` and `licenses/`. No new external runtime package was
added. These notices do not assert vendor endorsement or grant rights to data/APIs.

DJI explicitly [ended maintenance of its demo in April 2025](https://developer.dji.com/doc/cloud-api-tutorial/en/)
and warns against deploying it directly. Only the limited public message-envelope
shape was used, not its server/auth/storage implementation.

## Product-level result

| Products | Concrete new code | Not claimed |
|---|---|---|
| DAEMON, SLUG, ORBIS, POLLEN, Flower | Namespace-pinned real mTLS archive client, source/repo binding and selected existing MAVLink observation DTO | No flight control, device transport, operational link behavior or swarm coordination |
| Cumulus Cloud | `createCloudArchiveClient`; receipt/outbox-backed explicitly selected artifacts; generic catalog manifests may be submitted | No automatic external data ingestion or public sharing |
| HRVST | `createHrvstArchiveClient` | No automatic capture/export or consent bypass |
| METATRON | `createMetatronArchiveClient` | No new predictive-maintenance model or operational analytics |
| FABRIC | `createFabricArchiveClient` | No communication interception, message decryption or automatic upload |
| AETHER | `createAetherArchiveClient` | No radio/mesh routing or resilience changes |
| Other safe listed archive products | Generic Node client when operator explicitly binds the product/repo | SDK availability is not runtime/GUI/hardware adoption |

Actual mTLS tests cover all ten directly integrated product namespaces. Client
factories are callable exports from the real libraries, not registry-only entries.
Nothing starts listening or exports data on library import.

## Other requested technology companies: candid disposition

| Company | Public candidate / license evidence | Disposition |
|---|---|---|
| Google | [gax-nodejs](https://github.com/googleapis/gax-nodejs), [license](https://github.com/googleapis/gax-nodejs/blob/master/LICENSE), now also surfaced under google-cloud-node | Apache candidate for API retry/middleware. The direct old retry-source URL returned 404; no Google implementation was copied or claimed applied. Existing explicit retry budget is independently implemented above. |
| Microsoft | [TypeScript](https://github.com/microsoft/TypeScript), [Apache-2.0 license](https://raw.githubusercontent.com/microsoft/TypeScript/main/LICENSE.txt) | Existing workspace TypeScript 5.9.3 compiler retained and used for all new typed interfaces/typechecks; no unrelated platform dependency added. |
| Amazon | [aws-sdk-js-v3](https://github.com/aws/aws-sdk-js-v3), [Apache-2.0 license](https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/LICENSE) | Reviewed modular SDK candidate; no AWS account, billable resource or concrete AWS dispatcher created. Dispatcher contract permits later authorized provider adapters. |
| NVIDIA | [DCGM](https://github.com/NVIDIA/DCGM), [Apache-2.0 license](https://github.com/NVIDIA/DCGM/blob/master/LICENSE) | GPU telemetry candidate, not applicable to a gateway with no GPU inventory. No NVIDIA runtime, perception or ML code added. |
| Tesla vehicle-command / liblithium | [vehicle-command](https://github.com/teslamotors/vehicle-command), [liblithium](https://github.com/teslamotors/liblithium) | Not imported. No authenticated device-command/control capability implemented in this combat-related context. |
| Anduril, SpaceX, Mach | [Prior source/licensing review](DRONE-BACKEND.md) | Lattice restricted SDK excluded; Starlink GPL/router source excluded; no verified public Mach source to reuse. No proprietary/leaked code sought. |

Facial recognition, biometric identification, person re-identification and tracking
of individuals are excluded from every product; no facial-recognition vendor code
or datasets were imported. Operational obstacle avoidance, mission deconfliction,
combat sensor fusion, weapon control, navigation, strike, targeting and EW-capability
work is not included. Generic retrospective archival is the scope implemented.

## Ten requested satellite-company candidates

This is the requested ten-company research shortlist, **not a verified market-share
or revenue ranking**. Public code licenses and imagery/data licenses are different.
A missing verified repository here is not proof that a company has no public code.

| Company | Public source found / license evidence | Decision |
|---|---|---|
| Planet | [planet-client-python](https://github.com/planetlabs/planet-client-python), Apache-2.0; pinned source above | Reviewed; independent local metadata/provenance helper only. No imagery SDK copied. |
| Maxar | [Maxar-Corp/maxar-geospatial-platform](https://github.com/Maxar-Corp/maxar-geospatial-platform), search surfaced MIT SDK | Candidate, not imported; current per-file licensing and credentialed service rights must be verified before use. |
| Spire Global | No company satellite-SDK implementation/license verified in this review | No reuse; **SPIFFE/SPIRE is unrelated** and was not substituted as Spire Global code. |
| Capella | [capellaspace/console-client](https://github.com/capellaspace/console-client), [capella-reader](https://github.com/capellaspace/capella-reader); MIT candidates | Not imported. [Open dataset registry](https://github.com/awslabs/open-data-registry/blob/main/datasets/capella_opendata.yaml) separately specifies CC-BY-4.0 data. |
| BlackSky | No official permissively licensed SDK verified; third-party API profiles are not company source | No reuse or private customer API access attempted. |
| Iridium | No official relevant source/license verified in this review | No community/unaffiliated driver substituted as company code. |
| Rocket Lab | No official relevant permissive backend repository verified in this review | No reuse or orbital/vehicle-control implementation. |
| Satellogic | [telluric](https://github.com/satellogic/telluric), [MIT license](https://github.com/satellogic/telluric/blob/v0.15.0/LICENSE) | Geospatial/raster candidate only; no imagery/perception code imported. |
| ICEYE | [iceye-ltd/icecube](https://github.com/iceye-ltd/icecube), [MIT license](https://github.com/iceye-ltd/icecube/blob/main/LICENSE) | SAR datacube candidate only; no ML/annotations/imagery code imported. |
| Umbra | Public open-data/STAC context; [community umbra-py](https://github.com/reesehammer/umbra-py) explicitly says it is unaffiliated | No official permissive SDK verified. CC-BY data is not blanket software permission; no community source misattributed to Umbra. |

No commercial satellite API, dataset bucket, imagery scene or company credential
was accessed. No satellite operational code, TLE/orbit propagation, ground-station
scheduling, link-budget/routing or imagery-targeting pipeline was implemented.
The catalog helper records **caller-asserted** checksum/license/attribution; it does
not retrieve the asset, verify its bytes, determine legal rights or remove any
upstream attribution obligations.

## Verification and operational limits

Tests exercise real opaque CID sessions, persistent encrypted storage restart,
failed saves, duplicate/conflicting events, quotas, dispatcher failures/timeouts,
revocation during delivery, source/product/org isolation and real TLS handshakes
with temporary test CAs/certs. No production credential was used or committed.
Final verification: **475 tests pass** across 27 test-bearing projects, including
**25 event-ingest tests** (six real-mTLS cases) and **one new drone DTO test**;
all workspace typechecks pass. Semgrep `p/typescript` + `p/security-audit`: zero
findings, 89 applicable rules across all 24 changed/new TypeScript files, no scan
errors. All commands exited 0.

Remaining work: deployment, durable multi-writer storage, backup/KMS operations,
real certificate enrollment/revocation operations, ingress/WAF controls, driver
integration with a real broker, explicit retry scheduling/cleanup and independent
security review. Storage receipts are not downstream success; at-least-once delivery
requires consumer deduplication and cannot promise distributed exactly-once behavior.
