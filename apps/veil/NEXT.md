# VEIL Next Steps

Scaffold complete (2026-11-04) — v0.4.2.

Done:
- All-white layout matching Infinitum site
- Branding: VEIL</>™ (product title used as logo, site style)
- Multi-panel sidebar + Conductor Ask
- $VEIL session rewards with Claim button
- Browser Web Crypto key generation (ECDSA P-256) + sign.js
- Transaction sender (tx.js) builds claim tx + signs it
- Base RPC balance query
- Tracker stripping + Tor proxy + connectivity check
- VeilClaim.sol + deploy.ts + deployed.json placeholder
- Background auto-loads deployed.json on install
- Fonts: Helvetica Neue
- Manifest references PNG icons (see ICONS.md)

Post-scaffold (bugs / production later):
- Real RLP encoding + eth_sendRawTransaction
- Compile + deploy of VeilClaim and $VEIL token on Base
- Confirm binary PNG icons (regenerate locally if needed)
- Firmament proof verification in the claim contract

See DEPLOY.md, ICONS.md, and root PRODUCT-DELIVERY.md.
VEIL is ready for unpacked testing.
