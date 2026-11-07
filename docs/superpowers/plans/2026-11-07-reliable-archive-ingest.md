# Reliable Archive Ingest Plan

**Goal:** Apply reviewed permissive backend patterns to explicit, generic archival data, not vehicle operations.
**Base:** PR #27; new branch feat/reliable-archive-ingest.
**Architecture:** Existing CID/Labyrinth writes form an immutable outbox and receipt ledger. Independent TypeScript source implements Tesla-style ack stages/dispatcher seam, Apple-style low-cardinality metrics, and Palantir-style bounded middleware. A direct mTLS server authenticates a source certificate AND an opaque CID/repository bearer. Selected DJI diagnostic JSON can be normalized offline; no broker or device-control integration.

- [x] Review/pin source and licenses; preserve Apache license/NOTICE and DJI MIT attribution. No proprietary, GPL, unlicensed or operational combat code.
- [x] Write failing event/receipt tests, then implement canonical bounded events, idempotent durable receipts and explicit retryable outbox dispatch. Ack storage only after successful Labyrinth CAS; dispatch acknowledgement is separate. No exactly-once promise.
- [x] Write actual TLS tests, then implement mandatory mTLS + fingerprint/source/repository binding, CID checks, request limits, token-safe errors and secure Node client.
- [x] Add pluggable low-cardinality metrics and dispatcher interfaces; inject faults and verify callback failures never erase durable records.
- [x] Add explicit drone archive DTO adapter and reusable typed clients for other existing product artifacts; no automatic background exports.
- [x] Add safe offline DJI diagnostic-envelope normalization only; reject command/reply topics and discard location/control fields.
- [x] Run complete workspace tests/typecheck/Semgrep. Document per-capability source/license and honest compatibility/deployment gaps. Open stacked PR only, never deploy, merge or touch the site.

Verification: 475 workspace tests pass; all typechecks pass; Semgrep 0 findings over 24 changed/new TypeScript files. PR creation follows this tested implementation commit.
