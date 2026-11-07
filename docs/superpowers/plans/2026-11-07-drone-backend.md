# Drone Backend Implementation Plan

**Goal:** Receive-only backend for DAEMON, SLUG, ORBIS, POLLEN and Flower.
**Architecture:** A Fetch API handler composes real CidLabyrinth sessions, org-scoped repositories and explicit CAS artifact writes. Independent bounded MAVLink decoding normalizes selected historical observations. No planning or control is provided.
**Tech Stack:** Node 22.18+, TypeScript, node:test, existing CID/Labyrinth/autonomy.

## Global constraints
No site edits, deployment, merge, firmware, weapons, targeting or outbound vehicle control. No GPL source imports or vendoring. Infinitum Corporation®.

## Task 1 — MAVLink observations
- [x] Create `packages/drone-backend/src/mavlink.test.ts`; assert v1/v2 decoding, signed/unknown/CRC/truncation rejection and units.
- [x] Run `pnpm --filter @infinitum/drone-backend test` and observe missing-module failure.
- [x] Implement `mavlink.ts`: `decodeTelemetry(bytes: Uint8Array): Observation[]`, 64 complete frames/32 KiB maximum, HEARTBEAT, SYS_STATUS, GLOBAL_POSITION_INT only. Verify CRC_EXTRA, zero-fill v2 truncation; reject unsupported signatures.
- [x] Run tests and typecheck.

## Task 2 — Authenticated archival API
- [x] Create `backend.test.ts` with real passkey sessions; inventory, telemetry, lineage, malformed inputs, org/product isolation, consent/plan/session revocation and stale-head denial.
- [x] Implement `backend.ts`: `droneBackend(auth: CidLabyrinth): (request: Request) => Promise<Response>`, with explicit bearer, streaming body cap and pinned URL namespaces.
- [x] Persist bounded observation artifacts and inventory with explicit expectedHead CAS. Preserve historical registration references; never treat CRC/source IDs as authentication.
- [x] Add Node adapter and mount in existing +SPCTR CID host; test over actual HTTP.

## Task 3 — Documentation and verification
- [x] Scope reviewed after combat-related steering: keep generic retrospective archival/admin only. Do not add mission validation/control, sensor fusion, deconfliction, swarm or EW communications capabilities; do not modify existing autonomy.
- [x] Document source provenance, license boundaries, high-level public platform inventory and requested-company survey in `docs/DRONE-BACKEND.md`.
- [x] Run final workspace tests/typecheck and Semgrep: 449 tests pass; all typechecks pass; 0 findings across 9 TypeScript files.
- [ ] Commit and push branch; open stacked PR against `feat/lbrnth-integrations`. Never merge or deploy.
