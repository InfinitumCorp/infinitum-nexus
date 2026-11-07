# Offline orbital planning — Firmament Network and ORBIS

Infinitum Corporation® — backend-only follow-up stacked on Nexus PR #28.
Nothing was merged or deployed. No site/Vercel files or settings were touched.

## Concrete product capabilities

Both **Firmament Network** (`firmament`) and **ORBIS** (`orbis`) now have callable
`@infinitum/orbital` numerical/backend code, not registry-only descriptions:

| Capability | Implementation | Boundary |
|---|---|---|
| Element ingest | Two 69-column TLE lines with matching numeric catalog IDs, checksum/layout/range/epoch checks; JSON OMM normalized to Earth/TEME/UTC/SGP4 | Unclassified numeric TLE IDs only; no Alpha-5. OMM 3.0 subset, no XML/KVN, covariance or non-Earth models. Caller-supplied elements are not authenticated observations. |
| Propagation | Pinned MIT `satellite.js` 7.1.0, fresh SGP4 record on every call, TEME km and km/s plus approximate geodetic state | Maximum ±7 days from element epoch, not an accuracy guarantee. No live orbit feed or real-time tracking service. |
| Station passes | Bounded elevation-mask sampling, crossing bisection, local peak refinement, azimuth/range, clipped-start/end markers | Offline estimates only, not antenna commands or navigation. Narrow/grazing passes may be missed. |
| Contact proposals | Priority-first greedy scheduling; station **and** satellite conflicts; half-open intervals, turnaround guards, fixed reservations | Not globally optimal. Supplied windows are **not automatically visibility-verified**. No external resource is reserved. |
| Link budgets | Explicit-unit Friis free-space loss, EIRP, received power, kTB noise, SNR and margin | Illustrative, not an operational radio/EW model. No weather, terrain, interference, pointing, coding or equipment calibration. |
| Private catalog | Non-spatial STAC-style Feature item referencing an existing same-product Labyrinth artifact at an immutable commit | Server verifies bytes, SHA-256 and size; observation time/media type are client assertions. No image processing, external asset fetch, public sharing or full STAC conformance claim. |
| Cyber access and artifacts | Existing live Cumulus ID sessions and short-lived repository-only bearers; Labyrinth role/consent and **separate paid-plan checks**; expected-head CAS | No CID/org-string authentication, cookie-only access, automatic consent/role/plan grants, or cross-product paths. |

Everything computed is `simulationOnly` and requires operator review. Nothing
connects to a satellite, antenna, drone, radio, MQTT broker or commercial imagery
API. No firmware, command/signing interface, real satellite tasking, targeting,
weapons, operational communications improvement, facial recognition, biometric
identification, person re-identification or individual tracking was added.

## Package and host

- `packages/orbital/src/orbit.ts`: parsers and SGP4 states.
- `planning.ts`: pure pass/contact/link-budget planners.
- `catalog.ts`: private metadata referencing bytes verified through Labyrinth.
- `backend.ts` / `node.ts`: Fetch adapter and Node bridge.
- `client.ts`: browser-safe explicit-bearer client; no cookies, redirects,
  automatic retries, credential persistence or server-error-body reflection.
- Existing CID host `apps/spectre/src/server/app.ts` mounts
  `POST /api/orbital/firmament` and `POST /api/orbital/orbis` only when the operator
  explicitly supplies the CID/Labyrinth service and trusted origin; otherwise 503.
  Host/forwarded headers do not determine the trusted origin.

The base `@infinitum/firmament` ledger library does not import orbital: doing so
would create a Firmament → orbital → Labyrinth → CID → Firmament cycle. The
existing authenticated host composes them instead. No new UI or listener startup
is introduced; mounting these routes is repository code, not deployment.

## Request contract

All requests use JSON and `Authorization: Bearer <explicit session or delegated
repository credential>`. Browser CID cookies alone cannot call these endpoints.
Existing `/api/labyrinth` provisioning/consent/token flow remains explicit.

Every write includes `repo`, safe `id` and `expectedHead` (null only for an empty
repository); conflict returns 409. The CAS preflight and final save both run
through current authorization. A successful write returns `{commit:{id,parent,at},
path,artifact}` without exposing the repository's sibling-product tree.

| `action` | Other fields | Stored relative path |
|---|---|---|
| `tle` | `line1`, `line2` | `orbital/elements/<id>.json` |
| `omm` | `elements` (JSON object) | `orbital/elements/<id>.json` |
| `propagate` | `source:{id,commit}`, UTC `at` | `orbital/states/<id>.json` |
| `passes` | `source:{id,commit}`, `options:{station,start,end,stepSeconds?}` | `orbital/passes/<id>.json` |
| `schedule` | `requests`, optional `options:{turnaroundSeconds?,existing?}` | `orbital/schedules/<id>.json` |
| `link-budget` | `parameters` | `orbital/budgets/<id>.json` |
| `catalog` | `source:{commit,path}`, `observedAt`, `mediaType` | `orbital/catalog/<id>.json` |
| `load` | `repo`, `commit`, orbital `path` only; no write fields | Read only |

Labyrinth adds `products/<product>/` to every path. `source` orbital elements are
loaded at the requested immutable commit and reparsed from raw TLE/OMM: persisted
caller-authored epoch/SatRec metadata is never used as the numerical authority.
Catalog `source.path` is a safe relative path within the same product/repository,
including existing imagery/telemetry artifacts; `lbrnth://` is a private reference,
not an automatically resolvable public URL or an external network request.

Station: `{id,latitudeDeg,longitudeDeg,heightM,minElevationDeg}`. Contact:
`{id,stationId,satelliteId,start,end,priority?}`. Priority is 0–100 (higher wins),
then earlier start, then ASCII ID. Existing reservations are fixed; contradictory
ones are rejected rather than silently overwritten. Schedule output explicitly
sets `visibilityVerified:false` and `externalReservation:false`; the operator
must separately compare requested windows with pass estimates.

Link parameters: `distanceKm`, `frequencyHz`, `txPowerDbm`, `txGainDbi`, `rxGainDbi`,
`bandwidthHz`, `requiredSnrDb`; optional nonnegative `txLossDb`, `rxLossDb`,
`otherLossDb` default 0, `noiseTemperatureK` defaults 290. Results include inputs
and explicit units in field names. It is a calculator, not radio configuration.

```ts
import { OrbitalClient } from "@infinitum/orbital/client";
const client = new OrbitalClient({
  origin: trustedOperatorOrigin,
  token: () => obtainExplicitRepositoryBearer(),
});
const saved = await client.request("firmament", {
  action: "omm", repo: existingRepo, id: "offline-example",
  expectedHead: null, elements: independentlySuppliedOmm,
});
```

This is a library-contract example, not a credentialed script or an operation
against any real satellite. The client requires HTTPS except literal loopback
HTTP for local tests, enforces size limits and a 15-second transport timeout.
Unknown fields/actions, unsupported frames, invalid JSON/dates and unsafe paths
fail closed; API errors never echo bearer tokens, private payloads or internals.

## Bounds and numerical assumptions

- JSON request ≤64 KiB; client response ≤2 MiB. Existing Labyrinth artifact,
  storage, commit and repository limits still apply.
- UTC years 1957–2099; OMM fractional epoch precision ≤3 decimal places.
  More precision and non-UTC offsets are rejected, not silently truncated.
  TLE preserves its original epoch for SGP4; date displays round to milliseconds.
- Supported mean motion 0.001–20 rev/day, eccentricity <1, inclination 0–180°;
  model initialization/propagation errors are rejected.
- Pass window >0 and ≤24 hours; step 5–120 seconds; ≤4096 coarse samples,
  ≤8192 total evaluations, ≤64 passes. Crossing brackets refine to ≤0.5 seconds;
  this numerical tolerance is not orbital-position or acquisition accuracy.
- Station latitude ±90°, longitude ±180°, height −500…10000 m, mask 0…85°.
- Contact arrays ≤128 each (proposed/fixed), combined horizon ≤7 days,
  each interval ≤24 hours, turnaround 0–3600 seconds. No distributed reservation
  locking or fairness/optimality guarantee.
- States are **TEME**, not J2000/GCRF. Earth-fixed/look-angle conversion uses the
  library's GMST/ellipsoid approximation, not a full IERS/EOP/polar-motion model.
- SGP4 is a model driven by element quality; the ±7-day bound is conservative
  software scope, not an assertion that an element is physically accurate then.

## Sources and licenses actually applied

| Capability | Provenance | License / application |
|---|---|---|
| SGP4, JSON OMM/TLE model initialization and coordinate transforms | [satellite.js](https://github.com/shashwatak/satellite-js), exactly 7.1.0 | MIT runtime dependency, integrity pinned. Original license copied under `packages/orbital/licenses/`; no vendored implementation or build/WASM pipeline. |
| Independent numerical tests | Vallado/Crawford/Hujsak/Kelso, [AIAA 2006-6753](https://celestrak.org/publications/AIAA/2006-6753/), selected SGP4-VER.TLE/tcppver.out facts | Ten published state vectors, three cases (near-Earth, deep-space, resonant). Reference-data mirror revision is in NOTICE. No Python/GPL runtime/source imported. |
| Pass sampling, contact proposals, validation and access adapter | Independently authored TypeScript | No satellite-company implementation copied; existing internal CID/Labyrinth contracts reused. |
| Link-budget calculator | Published Friis and kTB equations; exact SI c and Boltzmann constants | Independently authored mathematical implementation, not a vendor's communications stack. |
| Catalog | [STAC 1.0.0](https://github.com/radiantearth/stac-spec/tree/v1.0.0) structural convention | Independently authored STAC-style metadata, custom `infinitum:` fields; no borrowed SDK or dataset. |

`packages/orbital/NOTICE` records attribution and the full upstream MIT license.
Existing Apache notices from PR #28 are unchanged. None of the commercial
satellite-company survey candidates is claimed as imported or integrated here.

## Verification and remaining work

The orbital tests exercise actual passkey-backed CID sessions, delegated expiry,
revoked sessions/consent, separate entitlement, read-only consent, tenant/product
isolation, CAS, bounded JSON streams, unsafe paths and real HTTP host mounting.
Numerical tests compare **ten** published TEME states for NORAD 00005, 04632 and
08195 at epoch and positive/negative elapsed times, to 1e-6 km and 1e-8 km/s
reference-output tolerance. This is implementation agreement, **not** physical
tracking accuracy or an independent certification of pass predictions.

Final local verification (2026-11-07): **514 workspace tests pass** across 28
test-bearing projects, zero failed/cancelled/skipped; **39 added tests** comprise
37 orbital-package tests and two real HTTP integration tests. All 29 workspace
package/app typechecks pass. Semgrep `p/typescript` + `p/security-audit`: zero
findings, zero scan errors, 89 applicable rules across all 16 changed/new
TypeScript files. Runtime dependency audit reports no known vulnerabilities.
No CI workflow or independent reviewer was run/added by this change; independent
review is still required before any separately authorized merge.

Remaining: independent astrodynamics/cyber review, full pass-prediction reference
validation, strict STAC-schema/API conformance if required, automatic visibility
checking for contact windows, optimal/multi-station scheduling, orbit data source
rights/authenticity and refresh policy, accurate time/EOP models, weather and
calibrated equipment models, durable multi-writer operational storage, ingress
rate/deadline/WAF controls, production observability and load testing. Existing
CID/Labyrinth deployment and persistent-storage operational gaps remain. No real
satellite/antenna integration or deployment has been performed or implied.
