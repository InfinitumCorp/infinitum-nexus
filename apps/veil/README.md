# VEIL</>

Tor-first secure browser sidebar for the Infinitum ecosystem.

## Status
Partial (v0.3.2): Manifest V3 side panel.
- Ask → Conductor
- Rewards with receiptId + claim helper for VeilClaim.sol
- Wallet generates ECDSA P-256 key via Web Crypto and queries Base RPC
- Tracker stripping + Tor proxy + connectivity check
- Fonts match Infinitum site (Helvetica Neue)

## Load
`chrome://extensions` → Developer mode → Load unpacked → `apps/veil`

## On-chain claims
See `packages/firm/contracts/VeilClaim.sol`. Deploy, fund, then set the address in chrome.storage as `veilClaim`.
