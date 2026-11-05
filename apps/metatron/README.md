# METATRON server

The money side of METATRON¹⁰⁰™: linked bank, card, loan and brokerage accounts, broker trading for people and their agents, behind guardrails and an approval queue, with every action signed onto the Firmament Network ledger.

## What it does

| Area | How |
|---|---|
| Link banks, cards, loans, brokerages (read) | Plaid Link on a hosted page (`/link`), opened with a one-time code. Access tokens are encrypted at rest (AES-256-GCM, bound to the owner's CID). Balances live, transactions via `/transactions/sync`, signature-verified webhooks, revoke at Plaid on disconnect. |
| Trade | Alpaca (stocks, ETFs, crypto; paper or live keys, encrypted at rest) and a built-in paper portfolio. Market orders by dollar amount, sent with an idempotency key so a retry never double-orders. |
| Guardrails | Max order size, orders per day, daily loss limit, allowed symbols, kill switch. Checked when an order is proposed and again right before it's sent. |
| Approvals | Every order from the person, an agent or the assistant waits for approval (expires after 15 minutes). Approving needs the `money:trade` grant and a sign-in from the last hour. Paper agents may trade paper on their own only if allowed. |
| Agents | Rebalancer (target mix), Sector momentum (strongest sectors over a month, from Alpaca market data), DCA (fixed buy). Oversized orders are capped to the limits, never sent over them. |
| Audit | Grants, revocations, proposals, approvals, declines, orders, failures and policy changes are signed onto Firmament, written with the owner's CID. `GET /api/ledger/verify` re-checks the whole chain. |

Sign-in is Cumulus://ID: the same bearer session every Infinitum product accepts, with METATRON scopes `money:read` and `money:trade` granted in the person's CID permissions.

## Run locally

```bash
cd apps/metatron
METATRON_DEV_TOKENS="devtoken-0123456789abcdef:cid-dev" \
PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
node src/server.ts
curl -H "Authorization: Bearer devtoken-0123456789abcdef" localhost:3005/api/policy
```

Without Plaid keys the server runs and reports bank linking as not configured. The paper portfolio needs prices: set `ALPACA_DATA_KEY_ID` / `ALPACA_DATA_SECRET` (free Alpaca paper keys work), or connect a broker.

Tests: `node --test --experimental-strip-types src/*.test.ts` (21 tests, no network).

## Production

Mount the app inside the host that runs Cumulus://ID, so it shares sign-in and the ledger:

```ts
import { createApp, cidAuth, buildFromEnv } from "@infinitum/metatron-app";
const opts = await buildFromEnv(process.env, cidAuth(cid));
const metatron = createApp(opts); // route /metatron/* and /link, /webhooks/plaid to it
```

Required: `METATRON_VAULT_KEY` (32 random bytes, base64), `FIRMAMENT_SIGNER_KEY`, `PUBLIC_ORIGIN` (https, used for the Plaid webhook), `METATRON_ALLOWED_ORIGINS`, Plaid production keys and `PLAID_COUNTRY_CODES`. `METATRON_DEV_TOKENS` is refused when `NODE_ENV=production`.

Before real money:
- Plaid production access, and OAuth redirect setup (`PLAID_REDIRECT_URI`) for UK/EU banks. Plaid does not cover every country.
- Alpaca live trading requires an Alpaca brokerage account per person, or Alpaca's Broker API if Infinitum offers brokerage itself (that path has licensing and compliance requirements).
- Move `FileUserStore` to Cumulus Database (Postgres) and the ledger to the shared nexus store, as Spectre does.
- Have the approval step use a fresh passkey assertion from CID rather than session age alone.
