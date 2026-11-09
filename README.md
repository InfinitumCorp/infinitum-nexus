# Infinitum Nexus

Shared foundation for every Infinitum product, by Infinitum Corporation®.

**Repos:** [product delivery](PRODUCT-DELIVERY.md) · [deploy](DEPLOY.md) · [GitHub standards](docs/github/ORG-STANDARDS.md) · [cleanup audit](docs/github/CLEANUP-AUDIT.md) · [security](SECURITY.md)

| Package | What it is |
|---|---|
| `packages/firmament` | Firmament Network core: append-only, hash-chained, Ed25519-signed ledger for identity, provenance, licensing, payments and audit. Merkle roots for anchoring to Base. |
| `packages/cid` | Cumulus://ID (CID): one account for every product. Passkeys and security keys (WebAuthn), authenticator-app MFA, session revocation, app-by-app permissions recorded on Firmament, organization SSO (OIDC), and social sign-in with Google, Apple, Microsoft, GitHub and ChatGPT (PKCE, state bound to the browser, nonce, issuer checks; accounts are never joined by email). Canonical host `id.cumuluscloud.app`. |
| `packages/aether` | ÆTHER™ mesh protocol core: Ed25519 node addresses, signed packets, flooding with TTL and ttl upgrades, store-and-forward, delivery receipts, rate limits, and a radio simulator. 100 nodes with 20% churn deliver 100% of messages across 6–13 hops (19 passing tests). Not encrypted yet. |

| `apps/spectre` | +SPCTR™ (Spectre) intelligent CRM. Core so far: companies, contacts, deals, activities and relationships with a Firmament audit trail and source provenance; opt-out handling; predictive pipeline with explained win probability, risk alerts, next best action and monthly forecast; warmest-path relationship map and buying-committee gaps; duplicate detection, merging and stale-data flags (17 passing tests). |

| `packages/cumulus` | The Cumulus account suite. Every CID gets Cumulus://Mail, Cumulus://Cloud and a FIRM Wallet on the free tier (15 GB shared by Mail and Cloud), like Gmail with a Google account. Sends login security notices, Cloud share notices and wallet receipts by mail. Products build their CID from `createCumulus()`. |
| `packages/mail` | Cumulus://Mail post office: one mailbox per CID (`name@cumuluscloud.app`), delivery between Cumulus addresses, bounces, an outbound queue, reserved product senders, pay-by-mail, folders, threads, aliases and Architect tasks. |
| `apps/cumulus-mail` | Cumulus://Mail web client (unlisted, noindex). Sign in with a Cumulus://ID. |
| `packages/eon` | E(O)N™ AI wearable core: X25519 pairing with a 6-digit safety code, AES-256-GCM voice and text frames with replay protection, on-device intents, and an aggregate-only usage meter (9 tests). |
| `packages/argus` | >_ARGUS™ sensor fusion: gated multi-sensor association, constant-velocity Kalman tracks, track lifecycle and per-track sensor provenance (6 tests). Military edition stays out of the public Data Exchange. |
| `packages/hardware` | Tasking, telemetry and evidence interface for physical products, with a profile per platform including DAEMON™ (autonomous aircraft) and SLUG™ (autonomous land drone). |
| `packages/autonomy` | Mission safety for DAEMON™, SLUG™, ORBIS™ and POLLEN™ with Flower™ docking: fence and no-go checks, altitude limits, energy reserve, a runtime interlock (hold, return, land), swarm coverage planning and pad scheduling (7 tests). Every mission still needs a person's approval. |

Run Cumulus://Mail: `node --experimental-strip-types apps/cumulus-mail/src/server.ts`, then open http://localhost:3010. Set `XAI_API_KEY` to turn on SCALVS briefs. Mail is intentionally not listed on the public site.

Run +SPCTR locally: `node apps/spectre/src/server/main.ts`, then open http://localhost:3000 and create a CID with a passkey. Set `ANTHROPIC_API_KEY` to turn on Ask Spectre.

### Cumulus domain

`cumuluscloud.app` is the canonical domain for Cumulus://ID, Cumulus://Cloud and Cumulus://Mail. It is configured with environment variables (see `.env.example`):

| Variable | Default | Use |
|---|---|---|
| `CUMULUS_ROOT_DOMAIN` | `cumuluscloud.app` | Mail addresses: `name@cumuluscloud.app` |
| `CUMULUS_ID_HOST` | `id.cumuluscloud.app` | Host for the Cumulus://ID Keycloak issuer |
| `CUMULUS_KEYCLOAK_REALM` | `cumulus` | Issuer `https://id.cumuluscloud.app/realms/cumulus`. JWKS `https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs` |
| `CUMULUS_CLOUD_HOST` | `cloud.cumuluscloud.app` | Cumulus://Cloud |
| `CUMULUS_MAIL_HOST` | `mail.cumuluscloud.app` | Cumulus://Mail |

The issuer is derived from the ID host and realm: `https://<CUMULUS_ID_HOST>/realms/<CUMULUS_KEYCLOAK_REALM>`. CORS allows only the exact HTTPS origins of the three hosts. A wildcard origin is rejected, and `Access-Control-Allow-Origin` is never `*`. When `CUMULUS_ROOT_DOMAIN` is overridden on its own, the three hosts follow it (`id.`, `cloud.`, `mail.`). An explicit host must be that root domain or one of its subdomains.

### Social sign-in

CID supports Continue with Google, Apple, Microsoft, GitHub and ChatGPT. Any product that uses Cumulus://ID can enable the same providers by calling socialFromEnv() and passing the result to CidService. Each button appears only when its credentials are set:

| Provider | Environment variables | Register at |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials |
| Apple | `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple Developer → Certificates, Identifiers & Profiles |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra admin center → App registrations |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps |
| ChatGPT | `CHATGPT_CLIENT_ID`, `CHATGPT_CLIENT_SECRET`, `CHATGPT_ISSUER` | OpenAI's Sign in with ChatGPT partner program (beta) |

Callback URL for each: `{SPECTRE_ORIGIN}/api/auth/oauth/{provider}/callback`. Data is stored in `apps/spectre/data/`.

Coming next: AI account research the Spectre agent team, then `$FIRM` and product token contracts.

### Spectre AI endpoints (current)
- `POST /api/research` — public research for a company (persists facts when `companyId` given)
- `POST /api/research/all` — bulk research up to 10 accounts
- `POST /api/query` — plain-language CRM query via agent team
- `POST /api/agents/:id/run` — run a specific agent (researcher, prospector, deal-coach, query)
- `POST /api/prospect` — ICP matching suggestions
- `GET /api/execution/pending` / `POST /api/execution/run` — self-executing deal actions via Architect (logs activities)
- `GET /api/metrics` — workspace counts
- `GET /api/export` — dump companies, contacts, deals, activities
- `GET /api/search?q=` — search companies, contacts, deals
- `GET /api/activities` — recent activities (optional kind filter)
- `GET /api/pipeline/stats` — counts and amounts by stage
- `POST /api/research/contact` — research a person
- `POST /api/companies/:id/research` — research shortcut for an account
- `GET /api/deals?stage=&minAmount=` — filtered deals
- `GET /api/companies?industry=&sort=` — filtered/sorted accounts
- `POST /api/rehearse` — deal coach rehearsal
- `GET /api/activities?kind=` — filtered activities
- Research logs activities and dedupes facts; company list shows AI fact counts and last research time
- Metrics include avg open-deal probability and industry/kind breakdowns
- Pipeline supports closingBefore date filter
- Accounts support researched=1/0, minConfidence and UI confidence filters and show lastResearch time
- Research facts include confidence and limited snippets; web_search has timeout; /api/research/status (with avg, low, high confidence and totalFacts), /api/research/history, /api/research/recommendations and /api/research/queue (GET + POST + process + remove + stats) available

## Requirements

Node.js 22.18 or newer (runs TypeScript directly; no build step).

## Run the tests

```sh
pnpm test        # every package
pnpm typecheck
```

### Conjure™ (swarm forecasting, built into every product)

`packages/conjure` (`@infinitum/conjure`): one engine that every Infinitum product imports; its agents run on the SCALVS.ai agent engine. Give it a question and background material; it maps who's involved, creates AI agents with personas, goals, stances and memory, and lets them react to each other on a shared feed over several rounds. Inject "what if" events between rounds, fork a simulation to compare futures, have the report agent investigate and write a forecast, and interview any agent. Runs one round per request (fits serverless limits), estimates AI calls up front and enforces a budget. In +SPCTR: the Conjure page, and "Simulate with Conjure" on any deal (seeded from that deal's records). Original implementation inspired by swarm-simulation research such as MiroFish/OASIS; no third-party code included.

#### @conjure: live prediction in every product

People reach Conjure™ by typing **@conjure** and a question anywhere in a product: `@conjure will Northwind sign by March?`. The product's server passes the text to `handleConjureMention` (`@infinitum/conjure`); the hosted Conjure service runs a live swarm prediction and returns a forecast to post back. Forecasts are metered per product and visible to Infinitum staff on the private Conjure dashboard.

```ts
import { conjureLiveFromEnv, handleConjureMention } from "@infinitum/conjure";
const conjure = conjureLiveFromEnv(); // null when not configured
const out = conjure && await handleConjureMention(conjure, text, { context, user: cid, source: "thread", wait: false });
```

| Variable | Use |
|---|---|
| `CONJURE_URL` | The hosted Conjure service, e.g. `https://app.<host>` |
| `CONJURE_PRODUCT_KEY` | This product's key (`cjp_<product>_…`), issued on the Conjure staff dashboard. Server secret: never send it to a browser. |

In +SPCTR, `@conjure` in Ask starts a live forecast (seeded from the deal when asked on one) and the answer updates round by round.

### Labyrinth *LBRNTH — private client repositories

`packages/lbrnth` (`@infinitum/lbrnth`) gives client organizations private code and artifact repositories inside Infinitum products: org roles, SHA-256 versions, branches/tags, history, file diffs, audit and per-org encrypted persistence. Access requires a client LBRNTH plan entitlement **and** existing CID `can()` scopes. There is no Git protocol. Nothing in this tree is deployed. See [integration/API guide](packages/lbrnth/README.md), [design](docs/LBRNTH.md) and [run/deploy plan](docs/LBRNTH-RUN-DEPLOY.md).

Labyrinth now has real Cumulus ID session authentication and a browser/Worker-safe
`@infinitum/lbrnth-client` transport. All website product brands are registered;
implemented products have explicit artifact adapters, while five unimplemented
brands remain registry-only. See [product/auth integration matrix](docs/LBRNTH-INTEGRATIONS.md).

The Labyrinth repository workspace now runs at `/labyrinth` in +SPCTR and Cumulus
Mail: private repositories, text/binary artifacts, commits, branches/tags, member
roles and paged history/audit. Offline maintenance supports verify, backup and key
rotation. See [build/run guide](docs/LBRNTH-BUILD.md). Production activation remains
operator-controlled.

For a persistent, non-root Labyrinth deployment with health checks and verified
restart durability, see [service deployment](deploy/labyrinth/README.md).
