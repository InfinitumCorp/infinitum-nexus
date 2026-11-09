# CONJURE™ product prediction backend

Infinitum Corporation® — backend-only, private, opt-in scenario rehearsal.

## Which company model was found

The authoritative implementation is CONJURE in `InfinitumCorp/infinitum-corporation-site`, branch `scalvs-forecasts`, commit `860e1664276f9a14fcff89ade1907dd8a3154b87` (tree `ffedfa0d9a89b582e006093dbf3ed2542f21ec80`). The site was read only; no site/Vercel files were changed or deployed.

This change ports the company-owned `scalvs/api/_conjure.js` HTTP client/state machine and adapts `scalvs/src/forecaster.js` and the implemented product brands from `scalvs/src/data.js` into `@infinitum/conjure`. Product questions are intentionally rewritten for synthetic nonhuman technical review, rather than audience/persona forecasting. CONJURE orchestrates ontology generation, graph construction, simulation preparation/execution and report generation through a separately operated MiroFish engine. No trained company weights, calibrated time-series estimator or physical prognostics model was found in this source.

Only CONJURE is used by this integration. No ZERKALO or ARGUS model integration remains. Existing Nexus CRM scoring and its older independent Conjure simulator are preserved, not represented as the newly found company model and not invoked by `/api/predict`.

## Real data paths and product scope

All 26 implemented canonical registry products have a shared organization-capacity profile: `firm`, `daemon`, `architect`, `veil`, `spectre`, `slug`, `scalvs`, `tokens`, `pollen`, `orbis`, `odin`, `metatron`, `hrvst`, `flower`, `firmament`, `fabric`, `eon`, `eidetic`, `cumulus-exchange`, `argus`, `aether`, `firm-wallet`, `cumulus-mail`, `cumulus`, `cloud`, `conjure`. Registry-only products/THRONE and aliases are excluded.

| Profile | Products | Actual input | What CONJURE rehearses |
| --- | --- | --- | --- |
| storage | All 26 above | Authenticated Labyrinth organization snapshot bytes, enforced organization quota, repository/commit/audit counts | Capacity/load and mitigation assumptions; one snapshot is not growth-rate forecasting |
| telemetry | DAEMON, SLUG, ORBIS, POLLEN, Flower | Selected immutable `logs/<unit>/<log>.json` system-status battery samples | Battery-diagnostic uncertainties and maintenance scenarios; not remaining-useful-life prediction |
| delivery | Any implemented product with a compatible archived outbox | Selected `ingest/<source>/<event>.json` pending/delivered/attempt counts and oldest pending age | Delivery/backlog scenarios; no dispatcher, event payload or live automatic retry |
| orbital | Firmament Network, ORBIS | Selected offline `orbital/{passes,budgets,schedules}/<id>.json` result summaries | Pass/contact/link-budget assumption review; no SGP4 replacement, measured RF model or satellite tasking |
| cyber | ODIN, +SPCTR, VEIL | Bounded numeric checkpoints computed by `cyberSignals(statusCodes)` and persisted through `record` | Cyber incident/load/mitigation scenarios; no vulnerability exploitation or calibrated attack probabilities |
| exercise | E(O)N | Bounded numeric checkpoints computed by `exerciseSignals(checkResults)` and persisted through `record` | Aggregate exercise outcome assumptions; no missions, targets or operational commands |

Artifacts are selected explicitly by an authenticated operator at an immutable source commit. These are archive/client-asserted measurements, not cryptographically authenticated hardware truth. Only numeric aggregates and fixed profile context reach the engine; coordinates, names, IDs, raw content, telemetry trajectories and arbitrary prompts do not. Storage counts are organization-wide, not a per-product disk-metering claim. Other products do not gain bespoke domain forecasting merely by having the shared capacity profile.

This is an actual shared backend/API integration, NOT automatic prediction in every app, frontend, worker or existing telemetry loop. Products must opt in and submit an approved scenario. No UI was added.

## Authentication, consent and state

`POST /api/predict/<product>` requires an explicit real CID/delegated bearer, organization membership, current Labyrinth read/write scopes, existing Labyrinth paid entitlement, and a **separate CONJURE entitlement**. CID login never grants either plan. Every create additionally requires `consent:true` for aggregate processing. Product writes remain under `products/<product>/...`.

Workflow state is server-owned, HMAC-signed and stored privately in Labyrinth at `conjure/jobs/<id>.json`; clients cannot supply engine project/task/simulation IDs. CAS head checks and a durable pre-request `inflight` claim prevent concurrent/replayed kickoff effects, including through multiple service instances sharing the same storage authority. CID/consent/entitlements are rechecked after awaited work. Read-only observation and stop also require current authority.

There is no distributed transaction or exactly-once promise. Deadline, crash, revoked permission or unrelated concurrent head changes may leave an unresolved inflight claim. Do not delete/reset that claim and replay a kickoff: operator reconciliation with the engine is required; no recovery API is shipped. Storage adapters must share a single authoritative CAS implementation; independently loaded storage snapshots are not a distributed lock. Job lifetime is 24 hours, at most 16 jobs/product/repository, 128 operations/job, four concurrent operations/service and one bounded engine request/advance.

All new results declare `dataSaleAllowed:false`, `calibrated:false`, `simulationOnly:true`, `requiresOperatorReview:true`, `reportIsUntrusted:true`. There is no data-sale/export integration. Existing defense/identity/network exchange exclusions remain unchanged; processing consent is NOT consent to sell data. The flag is policy metadata, not DRM preventing a separately authorized repository reader from copying content.

Reports are untrusted generated text, not instructions or validated probabilities. No report is executed or fed into an actuator, command signer or scheduling decision. No facial recognition, biometrics, identified-person profiling/tracking, weapon/targeting/strike functionality, real satellite tasking or operational vehicle commands are included.

## API and operator configuration

The existing CID-backed Node host optionally mounts `/api/predict/` outside its legacy transaction-retry machinery. No configured engine means HTTP 503, never demo reports. Use `@infinitum/conjure/forecaster` (also re-exported by `@infinitum/conjure-backend/client`) for explicit start/advance/resume (load)/stop/record calls. No automatic polling or retries. `ConjureService` may be embedded by another backend.

Operator-only environment:

- `CONJURE_URL`: trusted HTTPS engine origin; HTTP only for literal loopback. No path, query, userinfo or redirects. Requests cannot select the origin.
- `CONJURE_TOKEN`: optional private engine-gateway bearer, never the client's CID bearer. Configure a protected private network/authenticated gateway; a tokenless remote engine is not recommended.
- `CONJURE_STATE_KEY`: persistent 32-byte random HMAC key encoded as 64 hex characters; obtain/store with the operator's secret manager. Do not rotate without planning state reconciliation. No key-generation command or real secret is committed.
- `CONJURE_ENTITLED_ORGS`: operator-maintained allowlist of paid CONJURE organization IDs. Empty means deny all. This is a trusted manual billing authority, NOT automated payment verification. A custom backend may instead inject its authoritative synchronous `entitled(org,"CONJURE")` callback.
- Existing CID/Labyrinth operator configuration and explicit per-product consent/provisioning are also required; the CONJURE config grants none of these automatically.

Example request bodies (replace symbolic heads with actual response IDs):

```json
{"action":"create","repo":"archive","id":"capacity","expectedHead":null,"consent":true,"source":{"kind":"storage"},"rounds":5}
```

```json
{"action":"advance","repo":"archive","id":"capacity","expectedHead":"<64-hex-current-head>"}
```

```json
{"action":"record","repo":"archive","id":"health","expectedHead":null,"kind":"cyber","metrics":{"requests":100,"failures":3,"denied":2}}
```

For archive profiles, `source` is `{kind,commit,paths}` with 1–16 bounded allowlisted relative paths from the same product. Cyber/exercise producers are library helpers for existing service callers to invoke; no automatic capture of all HTTP traffic or exercise outcomes is claimed. HTTP requires JSON, same-origin when Origin is present, no cookie-only credentials; body <=64 KiB. Engine responses are <=1 MiB and reports <=60,000 characters; timeouts/errors are sanitized.

## Provenance, verification and gaps

See `packages/conjure/NOTICE.md`. Company wrapper code is not MiroFish source. MiroFish is identified upstream as **AGPL-3.0**, operated separately; no AGPL implementation is copied/vendored here. HTTP separation is not a legal determination that AGPL obligations disappear: operators must review upstream license/source-offer/network-use obligations, any modifications and configured model-provider terms before operating it. This change adds no external runtime dependency and makes no new MIT/Apache claim for the engine.

Tests use the published source's HTTP contract with scripted responses, actual passkey-backed CID sessions, Labyrinth state, archived outbox artifacts, and real local HTTP routes. They verify every implemented product's capacity-to-engine data path, source projection, full eleven-request state machine, independent plans, consent/revocation, signatures, CAS and uncertain effects. No deployed MiroFish/LLM/provider was contacted, no credits spent, no model forecast accuracy/calibration established. A production engine deployment, real-provider compatibility test, billing automation, recovery tooling, cross-process distributed coordination and independent review remain prerequisites/gaps. No merge/deploy is authorized.

### Local verification for this stacked change

- Full workspace: **592 tests passed, zero failures** (78 added: 8 model-contract, 67 new-backend, 1 quota/CID, 2 host HTTP; all legacy tests preserved).
- `pnpm typecheck`: all workspace projects passed.
- `pnpm audit --prod --audit-level=low`: no known production vulnerabilities.
- Semgrep `p/typescript` + `p/security-audit`, metrics disabled: **89 applicable rules, 26 changed/new TypeScript files, zero findings and zero scan errors**.
- `git diff --check`: clean. These are local checks, not GitHub CI or independent code review.
