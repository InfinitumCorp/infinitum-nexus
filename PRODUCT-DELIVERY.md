# Infinitum Product Delivery

Maps every product advertised on https://infinitum-corporation.vercel.app/#products to current evidence in this monorepo, missing capabilities, and concrete next build steps so each product can perform the tasks as advertised.

**Note:** #THRONE is ignored and will not be built or referenced further.

**Legend:**  
- **Foundation** — shared packages that every product depends on  
- **Core software** — buildable as TypeScript packages/apps in this monorepo  
- **Hardware / physical** — concepts that require physical systems; software interfaces only can be stubbed  
- **Status:** Not started / Scaffolded / Core logic / Partial / Complete

## Foundation (already present)

| Product | Advertised task | Status | Evidence | Next steps |
|---------|-----------------|--------|----------|------------|
| Firmament Network | Append-only hash-chained Ed25519 ledger. | Core logic | `packages/firmament` + real Merkle root anchoring + Anchor.sol + anchor client + deploy-anchor.ts | Deploy anchor. |
| Cumulus://ID (CID) | One account for every product. | Core logic | `packages/cid` | Wire into remaining apps. |
| **Data Exchange** | Opt-in data licensing, 85% rev-share to users, CDAT tokens. | Partial | `packages/data-exchange` (catalog, Firmament-backed consent, marketplace, revshare, **14 collectors covering all software products**) + `apps/data-exchange` HTTP API | Persist sales/licenses on Firmament; issue CDAT tokens; wire collectors into live product runtimes; production storage. |

## Core software products

| Product | Advertised task | Status | Evidence | Next steps |
|---------|-----------------|--------|----------|------------|
| **+SPCTR™ (Spectre)** | AI intelligent CRM. | Partial | Full app.ts + METATRON + research ... | Typecheck, tests, deploy. SpectreCollector ready. |
| **:\ARCHITECT\\** | Intent → Score → perform → verify. | Partial | Score, executor, autonomy | Deploy via Docker/Vercel. ArchitectCollector ready. |
| **SCALVS.ai** | AI workforce platform. | Scaffolded | Agent + Context Vault + tools + Team + Architect evidence + Firmament vault + NEXT.md | See packages/scalus/NEXT.md. ScalusCollector ready. |
| **METATRON** | Prediction + analytics. | Scaffolded | Default scorer + analytics + Spectre wrapper + forecast projection | MetatronCollector ready. |
| **HRVST** | Capture → privacy filter → Harvest Packet. | Scaffolded | Packet + privacy filter + licensing + Personal Silo | Production privacy model. HrvstCollector ready. |
| **ei·det·ic** | Identity-intelligence (authorized use only). | Scaffolded | Service + Spectre integration | Production sources. Restricted. EideticCollector ready. |
| **FIRM + FIRM Wallet** | Ecosystem token, wallet, DEX. | Partial | EVM client + wallet signing + DEX + router calldata + contracts + deploy scripts + compile.sh + deploy-helper.md | See DEPLOY.md and packages/firm/scripts/deploy-helper.md. Compile and deploy. FirmCollector ready. |
| **Project-specific tokens** | $HRVST, $ARCT, $SPCTR, $SCLV. | Scaffolded | tokens.ts + ProjectToken.sol + deploy.ts | Compile and deploy. TokensCollector ready. |
| **Cumulus://Cloud** | Storage, licensing, agent runtime, **Data Exchange** | Partial (exchange) | packages/cloud + packages/data-exchange + apps/data-exchange | Wire CumulusCollector; object store production; CDAT settlement. |
| **Cumulus://Mail** | Free email on every CID, alex@cumulusmail.cloud, encrypted at rest, end-to-end between Cumulus accounts, SCALVS briefs, Architect tasks, Drive files, snooze, rules, signature. | Core logic + inside-network delivery | `packages/mail` + `apps/cumulus-mail` | SMTP handoff for the outbox. SCALVS when `XAI_API_KEY` is set. |

## Supporting / infrastructure concepts

| Product | Notes | Software path |
|---------|-------|---------------|
| Cumulus://Cloud | Storage, licensing, agent runtime, data exchange | Partial for exchange (API + collectors) |
| VEIL</> | Browser cyber proxy, optional Tor | Partial — v0.8.0 default mode is the CID-entitled VEIL exit (HTTPS/SOCKS5, DNS through the proxy, fail-closed). Optional Tor mode uses a local SOCKS client (9050 / 9150) with circuit isolation, New Identity, a Tor check, and remote DNS including .onion. Not a device-wide VPN and not Tor Browser fingerprinting protection. | See apps/veil/README.md. Tor is not bundled. VeilCollector ready. |
| FABRIC | Encrypted calls/messaging | Scaffolded — AES-256-GCM AEAD + session. FabricCollector ready. |
| >_ARGUS | AI sensor fusion & ISR | Core logic — `packages/argus`: multi-sensor fusion with chi-square gating, global-nearest-neighbour association, 2D constant-velocity Kalman filter, tentative/confirmed/coasting/dropped lifecycle and per-track sensor provenance (6 tests). Next: 3D + bearing-only sensors, sign each picture on Firmament, feed ODIN°. Excluded from public Data Exchange. |
| ÆTHER™ | Distributed communications | Partial — M1 protocol core: signed packets, flooding + store-and-forward, receipts, simulator (100% delivery, 100 nodes, 20% churn). No encryption or device transports yet. AetherCollector ready. | See packages/aether/README.md |
| Firmament Network | Ledger stats | FirmamentCollector ready. |
| E(O)N | AI wearable for secure communications | Core logic — `packages/eon`: X25519 pairing with HKDF directional keys and a 6-digit SAS, AES-256-GCM voice/text frames with counter nonces and replay rejection, on-device intent parsing (call, message, mute, wipe with confirmation), aggregate-only usage meter that feeds EonCollector (9 tests). Next: bind to the ÆTHER Rust core / device firmware, audio codec framing, key rotation. |

## Hardware / physical concepts (software stubs only)

DAEMON, SLUG, ORBIS, POLLEN, Flower, NEMESIS, ODIN° (military suite).  
**Interfaces stubbed** in `packages/hardware`. `catalog.ts` gives every platform a profile (commands, approval-gated commands, declared telemetry, MIL edition); DAEMON (autonomous aircraft) and SLUG (autonomous land drone) were added there. `checkedTask()` rejects commands a product does not accept and flags ones that need a person's approval.

`packages/autonomy` adds mission safety for the mobile platforms (planning envelopes, to be replaced with flight-test data):
- **Pre-launch check:** every leg must stay inside the operating fence (concave fences included), no leg may enter a no-go zone, altitudes must suit the platform (DAEMON 120 m, ORBIS 30 m, POLLEN 60 m; SLUG ground only), and the battery must cover route, holds and return with the platform's reserve. Every mission still needs a person's approval.
- **Runtime interlock:** on each telemetry tick it escalates continue → hold → return to base → land now for low battery, fence or ceiling breach, and operator-link loss; the most severe rule wins.
- **POLLEN coverage:** lanes one swath wide, shared in contiguous blocks, each unit's route put through the pre-launch check.
- **Flower docking:** lowest battery charges first on the soonest-free pad.

7 tests. Next: real envelopes per airframe, wind in the energy model, Flower firmware tasking through `checkedTask()`.  
These cannot be fully built as software. Data from these is excluded from public Data Exchange.

**Ignored:** #THRONE — not part of this delivery plan.

## Immediate next build

See **DEPLOY.md**, **apps/spectre/src/server/RESTORE-APP.md**, **packages/firm/scripts/deploy-helper.md**, **apps/architect/DEPLOY.md**, **apps/veil/NEXT.md**, and **packages/scalus/NEXT.md**.  
- Spectre: full restore of `app.ts`, then deploy.  
- Architect: deploy.  
- FIRM: compile then deploy.  
- METATRON enabled by default in Spectre.  
- VEIL: real key management + deploy $VEIL claim.
- **Data Exchange:** run `apps/data-exchange`; wire the 14 collectors into product runtimes; record sales as Firmament license/payment entries; issue CDAT tokens on Base.

## Acceptance criteria (for "performs as advertised")

- Spectre: full CRM + AI + audit.  
- Architect: Score execution with evidence.  
- SCALVS: agent with tools and memory.  
- Data Exchange: opt-in packaging, listing, sale with 85% rev-share, Firmament consent audit, collectors for all software products.  
- All new code type-checks and has tests.  
- No product is claimed production-complete until deployed.

## Labyrinth *LBRNTH

Infinitum Corporation® client repository capability: `packages/lbrnth`. Backend SDK with org isolation, roles, versioned code/artifacts, branches/tags, file-level diff, CID consent plus plan gating, hash-chained audit and encrypted single-writer persistence. Not deployed; UI/Git hosting and distributed storage are follow-ons. [Integration contract](packages/lbrnth/README.md).

### Labyrinth product connections

Cumulus ID-authenticated repository API and explicit save/load adapters are wired
through the existing product libraries and host applications. No website edits or
deployments. Five brands remain registry-only; library adapters are not claimed as
new deployed apps. [Full inventory, identity mapping and rollout gaps](docs/LBRNTH-INTEGRATIONS.md).

### Drone inventory and historical telemetry backend

`packages/drone-backend` and the existing +SPCTR CID host now provide backend-only
private inventory, bounded selected MAVLink observation archival, historical reads
and product-filtered lineage for DAEMON, SLUG, ORBIS, POLLEN and Flower.
This is administrative/retrospective software, not flight control or mission
planning, and does not integrate military editions or change existing autonomy.
No hardware compatibility, deployment or operational readiness is claimed.
[API, provenance and remaining gaps](packages/drone-backend/README.md).

### Reliable archive ingestion (public-source backend applications)

`packages/event-ingest` adds mandatory mTLS source binding, CID/plan-gated archive
receipts, bounded idempotent outbox retry, explicit HTTP/MQTT dispatcher seams and
fixed-cardinality metrics. Real namespace-pinned clients are exported for the five
drone inventory products plus Cloud, HRVST, METATRON, FABRIC and AETHER. No vehicle
control, operational mission features, biometric/person tracking or automatic
upload is added. [API and limits](packages/event-ingest/README.md);
[source/license/application matrix](docs/OSS-BACKEND-APPLICATIONS.md).
