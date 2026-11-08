# $FIRM Wallet™

Self-custody wallet for Ethereum, Base, Arbitrum and Solana, with the Infinitum Nexus™ swap, wrapped crypto, tokenized stocks, perps, options, a rewards inbox, VEIL Nexus sign-in, and Conjure™ predictive signals. It's a web app (installable on Android and iPhone as a PWA) served by a Cloudflare Worker on the free plan.

**Everything is free and open source.** Libraries: viem, @scure/bip39, @scure/bip32, @scure/base, @noble/curves, @noble/hashes (MIT), Preact, Vite (MIT), qrcode-generator (MIT). Data: public RPCs, Hyperliquid's API (prices, candles, perps), Jupiter's free API (Solana swaps, xStocks discovery), GeckoTerminal (stock-token history), Derive's public API (options). No API keys, no paid services. Infinitum adds no fees.

## Run it

```bash
pnpm install                       # from the monorepo root
pnpm --filter @infinitum/firm-wallet dev        # http://localhost:5178
pnpm --filter @infinitum/firm-wallet test       # 59 tests (keys, vault, device unlock, Solana tx, Hyperliquid signing, Nexus origins, prediction markets, mini app, data sharing…)
pnpm --filter @infinitum/firm-wallet build      # typecheck + production build into dist/
pnpm --filter @infinitum/firm-wallet deploy:check  # Worker bundle dry run (no deploy)
```

Conjure Markets lives in `packages/conjure/src/markets.ts` (9 tests: `node --test --experimental-strip-types packages/conjure/src/markets.test.ts`).

## What's in it

| Area | How it works | Code |
|---|---|---|
| Keys | BIP-39 phrase; Ethereum/Base/Arbitrum at `m/44'/60'/0'/0/0`; Solana at `m/44'/501'/0'/0'` (SLIP-0010). Tested against published vectors. | `src/core/keys.ts` |
| Vault | Phrase encrypted on the device: PBKDF2-SHA256 (600k) → AES-256-GCM, stored in IndexedDB. Keys live in memory only while unlocked; auto-lock after idle. | `src/core/vault.ts`, `src/ui/store.ts` |
| Fingerprint / face unlock | Optional, per device. A passkey made on the phone's own authenticator (secure hardware) returns a 32-byte secret through the WebAuthn PRF extension only after a fingerprint, face or screen-lock check; HKDF-SHA256 turns it into an AES-256-GCM key for a second copy of the phrase. No server, nothing sent; the password keeps working. Shown only where the browser supports it. | `src/core/device-unlock.ts`, `vault.ts`, `ui/cards.tsx` |
| Install | Settings and the mini app's Wallet tab offer "Install" where the browser can (Android Chrome) and Share → Add to Home Screen on iPhone. The full wallet and `/mini` install as separate home-screen apps. | `src/ui/install.ts`, `public/*.webmanifest` |
| Data exchange (opt-in, in development) | Product-by-product checkboxes for pooling de-identified usage data (pools of 1,000+, the person keeps 85%). Off by default; Global Privacy Control turns every product off; military editions are never offered; messages, documents, prompts, precise location and biometrics are never sold. Choices stay on the device until the exchange opens. | `src/core/data-sharing.ts`, `ui/cards.tsx` |
| Send / receive | Native coins and ERC-20 (viem); SOL, SPL and Token-2022 transfers built and signed in-house, creating the recipient's token account when needed. QR receive. | `src/core/evm.ts`, `src/core/solana.ts` |
| Wrapped crypto | WETH, WBTC, cbBTC, wSOL. One-tap ETH ⇄ WETH through the WETH contract; wSOL handled by Jupiter swaps. | `src/core/config.ts`, `evm.ts` |
| Swap | EVM: Uniswap V2 routers, checking direct, via $FIRM™ and via USDC paths and taking the best. Solana: Jupiter. Approvals are exact-amount, never unlimited. | `evm.ts`, `solana.ts`, `ui/screens/Swap.tsx` |
| Tokenized stocks | xStocks (Solana Token-2022), discovered from Jupiter's verified token list at runtime, swapped through Jupiter. | `src/core/stocks.ts` |
| Perps | Hyperliquid: MessagePack + keccak action hash + EIP-712 signature with the wallet's own key. Market/limit, leverage (wallet cap 10×), liquidation estimate, close, cancel. Funding: USDC on Arbitrum to Hyperliquid's bridge. | `src/core/perps.ts` |
| Options | Derive option chains (v3 public API: bid/ask, IV, delta) next to Conjure's chance of finishing in the money vs the market's. Derive blocks direct browser calls, so the Worker forwards its two public read methods (`get_all_live_instruments`, `get_ticker`) and nothing else. Trades open on Derive. | `src/core/options.ts`, `worker/api.ts` |
| $FIRM Mini™ (Telegram) | `/mini`: a one-thumb DEX for Telegram or any phone browser. Trade Hyperliquid perps (Long/Short, $ amount and leverage chips) and spot (USDC pairs), swap on Uniswap / Jupiter, see positions, spot balances and open orders, close or cancel in one tap, move USDC between perps and spot, receive with QR. Same keys and review sheet as the full wallet (same origin). Inside Telegram it uses Telegram's own bottom button, back button, haptics and theme through a small bridge written from Telegram's published protocol (no outside script). Market lists refresh every 5 minutes, prices every 10 seconds. | `src/mini/`, `src/core/dex.ts` |
| Predict | Polymarket and Kalshi side by side: browse by category, search, sort by 24h volume or ending soon. Each market shows outcomes with 24h moves, a price chart (1d to all), the live order book, a ticket with shares, payout and Kalshi's taker fee, the same question on the other venue, the rules, and Conjure's chance for crypto price questions (end-of-period and "hit"/"dip" touch questions). Watchlist, price alerts (checked every minute while open, with an optional browser notification) and your Polymarket positions. Market data is public and needs no account; Kalshi blocks direct browser calls, so the Worker forwards its read-only market paths. Trades open on the venue. | `src/core/predictions.ts`, `ui/screens/Predict.tsx` |
| Conjure™ Markets | On-device METATRON logistic model + damped Holt trend, walk-forward backtest with a purge gap. Only says buy/sell when it beat the base rate on unseen days; otherwise "no edge". Option ITM probabilities and a perps leverage ceiling. Optional server-side @conjure swarm (off by default; paid model calls). | `packages/conjure/src/markets.ts` |
| Rewards inbox | Product-token transfers to your addresses, grouped by product (ERC-20 logs; Solana balance changes). | `src/core/rewards.ts` |
| VEIL Nexus | Products open `#/connect` or `#/pay`; only Infinitum origins are answered; Sign-In with Ethereum (EIP-4361); replies by `postMessage` to the exact origin. | `src/core/connect.ts` |
| Worker | Serves the app with strict security headers (CSP; no framing, except Telegram Web may frame `/mini`), read-only Derive and Kalshi data relays (allow-listed paths only, Kalshi lists cached at the edge for a minute), and an optional Conjure swarm proxy. No region or country checks. | `worker/` |

Every transaction, swap, approval and order goes through one review screen that shows what you're approving before anything is signed.

## $FIRM Mini in Telegram

No bot server is needed: the mini app talks to Telegram in the browser, and keys never leave the device.

1. In Telegram, open @BotFather, send `/newbot` and follow the steps.
2. Send `/newapp` (or `/setmenubutton`) to that bot and give it `https://<wallet domain>/mini`.
3. Open the bot and tap the button. On first open, create or import a wallet; it's stored encrypted on that device.

Telegram's in-app browser keeps its own storage, separate from Chrome or Safari, so a wallet made in Telegram lives in Telegram on that phone (the mini app says so before onboarding). To use the same wallet in both, import the recovery phrase in each.

Phones and Telegram Desktop open it in a webview; Telegram Web frames it, which the Worker allows for `/mini` from `https://web.telegram.org` only.

## Configuration (all optional, `VITE_*` at build time)

| Variable | Default | Use |
|---|---|---|
| `VITE_DEFAULT_MODE` | `testnet` | `mainnet` once the wallet has had an external security review |
| `VITE_INFINITUM_TOKENS` | none | Deployed $FIRM™ / product token addresses: `{"mainnet":{"base":{"FIRM":"0x…"},"solana":{"FIRM":"<mint>"}}}`. Until set, they show as not live. |
| `VITE_RPC_*` | public endpoints | Override any chain's RPC |
| `VITE_EXTRA_NEXUS_HOSTS` | none | More product hosts allowed to connect |
| `VITE_CONJURE_SWARM` | off | `1` shows "Ask the @conjure swarm"; needs Worker `CONJURE_URL` + secret `CONJURE_KEY` |

## Before mainnet

- External security audit of key handling, signing and the Solana transaction builder.
- Deploy $FIRM™ and the product tokens, seed FIRM/USDC/ETH pools, then set `VITE_INFINITUM_TOKENS`.
- Legal review of token rewards and of linking to stocks, perps and options venues (see `infinitum-revenue/MONETIZATION.md` §3). The wallet asks people to confirm venue terms on the device; it does no location checks.
- Add the custom domain (e.g. `app.firmwallet.app`) to `wrangler.jsonc` routes and deploy with sign-off.
