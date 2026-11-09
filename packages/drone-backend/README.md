# Drone inventory and telemetry archive backend

By **Infinitum Corporation®**. Backend only; not deployed.

Administrative inventory and selected historical observations for **DAEMON, SLUG,
ORBIS, POLLEN and Flower**. Product definitions come from
`packages/hardware/src/catalog.ts` and `PRODUCT-DELIVERY.md`, not invented aircraft
specifications. Flower is a base station. A namespace is not a hardware integration.

This is **not** a ground-control station, autopilot, combat integration or flight
operations service. It has no outbound vehicle transport, commands, mission upload,
routing, targeting, swarm coordination, EW resilience or firmware actions. Military
product editions are not integrated. No existing mission/autonomy code is changed.

## Real runtime

`+SPCTR` mounts `POST /api/drones/{daemon|slug|orbis|pollen|flower}` against its
existing operator-configured `suite.labyrinth`. Missing storage/auth/origin returns
503. No new listener, account provider or deployment is created.

For another Fetch-compatible host:

```ts
import { droneBackend } from "@infinitum/drone-backend";
const handle = droneBackend(suite.labyrinth); // trusted server-owned CidLabyrinth
const response = await handle(request);
```

The Node adapter `serveNodeDroneBackend(req, res, auth, origin)` takes a trusted
operator origin. It never trusts Host/forwarded headers to decide the origin.
HTTPS is required except loopback development.

## Authorization and state

Every call requires an **explicit opaque CID or short-lived repository bearer**
in Authorization. Cookies alone never authorize this API. The existing CID login
and `/api/labyrinth` consent/provision/token flow remain the onboarding boundary.
No new consent, role or paid-plan grant happens in this package.

`CidLabyrinth` rechecks session revocation/expiry, current org, repository role,
LBRNTH read/write consent and the separate paid-plan authority on each operation.
The product namespace comes from the URL, never a body org/CID/product claim.
Repository handles, keys and tokens are not persisted by this package. Operators
must use the authoritative CID host, not independently populated CID stores.

Inventory and log records are immutable versioned JSON artifacts in the existing
Labyrinth repository. Updating a logical file creates a new commit, not an in-place
mutation. All writes require `expectedHead` (null only at initial head); stale
updates return 409. No second in-memory fleet database is created.

## JSON actions

Each POST uses `Content-Type: application/json`. Unknown fields are rejected.
`repo` is an existing private Labyrinth repository ID; create it through the
existing authenticated repository API first.

| action | Additional fields | Result |
|---|---|---|
| `register` | `repo`, `vehicle`, `systemId`, `componentId`, `expectedHead` | Labyrinth commit of `fleet/<vehicle>.json`; domains are air/land/base |
| `fleet` | `repo` | Current main head and at most 64 inventory records |
| `telemetry` | `repo`, `vehicle`, `registrationCommit`, `log`, `frames`, `expectedHead` | Commit of `logs/<vehicle>/<log>.json`; `frames` is canonical base64 of complete MAVLink frames |
| `load` | `repo`, `vehicle`, `commit`, `kind: "fleet"` | Historical registration JSON |
| `load` | `repo`, `vehicle`, `commit`, `kind: "logs"`, `artifact` | Historical selected-observation JSON |
| `lineage` | `repo` | Product-filtered changed paths, author, time and commit/parent IDs within latest 100 main commits |

All paths have the server prefix `products/<product>/`. Identifiers contain only
ASCII letters/digits/underscore/hyphen, maximum 64 characters. Device IDs must be
1–255. Fleet registration references are historical bindings, **not proof of
hardware identity**; authorized callers can update them. Source IDs in an uploaded
packet must match the selected registration version.

## Protocol subset

Independent receive-only MAVLink v1/v2 decoding supports:

- HEARTBEAT (0; CRC_EXTRA 50): reported mode/status, not permission to act.
- SYS_STATUS (1; CRC_EXTRA 124): battery percentage, voltage and current, preserving
  unknown sentinels as JSON null.
- GLOBAL_POSITION_INT (33; CRC_EXTRA 104): degrees, MSL and relative metres,
  NED metres/second, null unknown heading. Relative altitude is **not** assumed AGL.

CRC and lengths are checked before decoding; v2 truncated trailing zeros are
restored. Unknown messages and all v2 incompatibility flags, **including signed
frames**, are rejected. There is no signature verifier: accepting signed frames
without checking their signature would misrepresent authenticity.

A telemetry submission is a bounded datagram of complete frames, **not a raw TCP
stream** or a `.ulg`/`.bin` flight log importer. A batch fails atomically on any bad
or unsupported frame. Limit: 32 KiB/64 frames per batch; HTTP JSON cap: 128 KiB,
enforced on streamed/chunked bodies too. No decompression or network connection to
a vehicle occurs. Logs contain normalized selected observations, not raw radio
packets; records explicitly state `senderVerified: false`, `controlAuthority: false`.
Sequence numbers and boot time are observations only: replay/ordering is **not**
used as live flight authority, and an authorized user may archive the same batch
again at a newer CAS head. There is no anti-replay guarantee for physical sources.

## Deployment and assurance limits

- TLS ingress, upload deadlines, connection limits and rate limiting must be
  configured by the host. Body-size limits do not replace those controls.
- Real trusted gateways/device enrollment, transport signing verification,
  field/SITL tests, durable multi-writer storage, billing, backup/KMS operations and
  organization onboarding remain operator work.
- Existing Labyrinth single-writer/capacity/storage constraints apply. A persistent
  snapshot must never be placed on ephemeral Vercel storage.
- Lineage is recorded provenance, not an externally anchored attestation or a
  claim that the uploaded physical observations are truthful. A parent outside the
  100-commit window is omitted from path-change comparisons.
- No raw telemetry is exported to the public Data Exchange.

Run `pnpm --filter @infinitum/drone-backend test` and
`pnpm --filter @infinitum/drone-backend typecheck`. Runtime route regressions are in
`apps/spectre/src/server/drone.http.test.ts`. Research/license notes:
[DRONE-BACKEND.md](../../docs/DRONE-BACKEND.md).
