# Infinitum Nexus

Shared foundation for every Infinitum product.

| Package | What it is |
|---|---|
| `packages/firmament` | Firmament Network core: append-only, hash-chained, Ed25519-signed ledger for identity, provenance, licensing, payments and audit. Merkle roots for anchoring to Base. |
| `packages/cid` | Cumulus://ID (CID): one account for every product. Passkeys and security keys (WebAuthn), authenticator-app MFA, session revocation, app-by-app permissions recorded on Firmament, organization SSO (OIDC), and social sign-in with Google, Apple, Microsoft, GitHub and ChatGPT (PKCE, state bound to the browser, nonce, issuer checks; accounts are never joined by email). |

| `apps/spectre` | +SPCTR™ (Spectre) intelligent CRM. Core so far: companies, contacts, deals, activities and relationships with a Firmament audit trail and source provenance; opt-out handling; predictive pipeline with explained win probability, risk alerts, next best action and monthly forecast; warmest-path relationship map and buying-committee gaps; duplicate detection, merging and stale-data flags (17 passing tests). |

| `packages/cumulus` | The Cumulus account suite. Every CID gets Cumulus://Mail, Cumulus://Cloud and a FIRM Wallet on the free tier (15 GB shared by Mail and Cloud), like Gmail with a Google account. Sends login security notices, Cloud share notices and wallet receipts by mail. Products build their CID from `createCumulus()`. |
| `packages/mail` | Cumulus://Mail post office: one mailbox per CID, delivery between Cumulus addresses, bounces, an outbound queue, reserved product senders, pay-by-mail, folders, threads, aliases and Architect tasks. |
| `apps/cumulus-mail` | Cumulus://Mail web client (unlisted, noindex). Sign in with a Cumulus://ID. |

Run Cumulus://Mail: `node --experimental-strip-types apps/cumulus-mail/src/server.ts`, then open http://localhost:3010. Set `XAI_API_KEY` to turn on SCALVS briefs. Mail is intentionally not listed on the public site.

Run +SPCTR locally: `node apps/spectre/src/server/main.ts`, then open http://localhost:3000 and create a CID with a passkey. Set `ANTHROPIC_API_KEY` to turn on Ask Spectre.

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
