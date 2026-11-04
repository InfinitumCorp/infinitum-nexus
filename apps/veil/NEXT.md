# VEIL Next Steps

Scaffold complete (2026-11-04) — v0.5.2.

Done:
- All-white layout matching Infinitum site
- Branding: VEIL</>™ (product title used as logo, site style)
- Multi-panel sidebar + Conductor Ask
- Page info line in Ask panel (title + detected trackers)
- $VEIL session rewards with Claim button + Export log
- Browser Web Crypto key generation (ECDSA P-256) + sign.js
- ABI-style calldata helpers (abi.js) used by tx.js
- Transaction sender builds claim tx + signs it
- Base RPC balance query + Copy address
- Expanded tracker list + Tor proxy + connectivity check
- Context menu: "VEIL: Clean trackers on this page"
- Keyboard shortcuts: Ctrl+Shift+V (open), Ctrl+Shift+C (clean)
- Badge shows current $VEIL balance
- Options page (RPC URL + VeilClaim address)
- VeilClaim.sol with signer + claimWithSig scaffold
- deploy.ts + deployed.json placeholder
- Background auto-loads deployed.json on install
- Fonts: Helvetica Neue
- Manifest references PNG icons (see ICONS.md)

Post-scaffold (bugs / production later):
- Real RLP encoding + eth_sendRawTransaction
- Compile + deploy of VeilClaim and $VEIL token on Base
- Confirm binary PNG icons (regenerate locally if needed)
- Full ecrecover / Firmament proof verification in the claim contract

See DEPLOY.md, ICONS.md, and root PRODUCT-DELIVERY.md.
VEIL is ready for unpacked testing.
