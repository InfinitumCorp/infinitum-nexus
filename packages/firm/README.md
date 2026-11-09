# FIRM

> The $FIRM Wallet™ app is in `apps/firm-wallet` (real BIP-39/secp256k1/ed25519 signing, swaps, perps, options). This package keeps the contracts and the server-side account ledger.

Ecosystem token, wallet, and DEX. FIRM Wallet domain: `FIRM_ROOT_DOMAIN`, default `firmwallet.app` (bare hostname, hosted at Cloudflare).

## Status
- JSON-RPC EVM client (`evm-client.ts`)
- Wallet signing (`wallet.ts`)
- DEX with Uniswap-style router eth_call (`dex.ts`)
- FirmToken.sol, ProjectToken.sol, Anchor.sol
- Deploy scripts (`deploy.ts`, `deploy-anchor.ts`)
- Compile script (`compile.sh`)

## Next
- Compile with solc
- Deploy contracts
- Wire real secp256k1 signing
