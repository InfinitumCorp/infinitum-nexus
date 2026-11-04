# VEIL</>™

Tor-first secure browser sidebar for the Infinitum ecosystem.

## Status
Scaffold complete (v0.4.0). Ready for unpacked testing.

- All-white layout matching Infinitum site (Helvetica Neue)
- Multi-panel: Ask / Wallet / Rewards / Privacy
- Ask → Conductor
- Web Crypto ECDSA P-256 key generation + signing
- Transaction sender builds and signs claim payloads
- Base RPC balance query
- Tracker stripping (manual + auto-clean)
- Tor proxy toggle + connectivity check
- VeilClaim.sol + deploy scaffolding

## Load
`chrome://extensions` → Developer mode → Load unpacked → `apps/veil`

## Next (post-scaffold)
See NEXT.md and DEPLOY.md.
Real chain deploy and RLP encoding remain.
