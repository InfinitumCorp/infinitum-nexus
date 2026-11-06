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
| **Project-specific tokens** | $HRVST, $CNDT, $SPCTR, $SCLV. | Scaffolded | tokens.ts + ProjectToken.sol + deploy.ts | Compile and deploy. TokensCollector ready. |
| **Cumulus://Cloud** | Storage, licensing, agent runtime, **Data Exchange** | Partial (exchange) | packages/cloud + packages/data-exchange + apps/data-exchange | Wire CumulusCollector; object store production; CDAT settlement. |
| **Cumulus://Mail** | Free email on every CID, alex@cumulusmail.cloud, encrypted at rest, end-to-end between Cumulus accounts, SCALVS briefs, Architect tasks, Drive files, snooze, rules, signature. | Core logic + inside-network delivery | `packages/mail` + `apps/cumulus-mail` | SMTP handoff for the outbox. SCALVS when `XAI_API_KEY` is set. |

## Supporting / infrastructure concepts

| Product | Notes | Software path |
|---------|-------|---------------|
| Cumulus://Cloud | Storage, licensing, agent runtime, data exchange | Partial for exchange (API + collectors) |
| VEIL</> | Tor-first browser + sidebar | Partial — v0.3.1 multi-panel, Architect Ask, Tor proxy + check, claimable rewards, Base RPC wallet balance | See apps/veil/NEXT.md + PACKAGING.md. VeilCollector ready. |
| FABRIC | Encrypted calls/messaging | Scaffolded — AES-256-GCM AEAD + session. FabricCollector ready. |
| ÆTHER | Distributed communications | Scaffolded — mesh + BFS routing. AetherCollector ready. |
| Firmament Network | Ledger stats | FirmamentCollector ready. |
| E(O)N | Wearable usage aggregates | EonCollector ready (limited). |

## Hardware / physical concepts (software stubs only)

ORBIS, POLLEN, Flower, NEMESIS, ARGUS (sensor fusion), ODIN° (military suite).  
**Interfaces stubbed** in `packages/hardware`.  
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
