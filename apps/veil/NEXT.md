# VEIL Next Steps

Progress (2026-11-04) — v0.3.1:
- Multi-panel sidebar + Architect Ask
- $VEIL session rewards with claimable receipt structure
- FIRM wallet panel with Base RPC balance query (packages/firm pattern)
- Tracker stripping (manual + auto-clean)
- Tor proxy toggle + connectivity check
- SVG icon + packaging notes

Remaining:
- Real passkey / FirmWallet key management in the extension
- Deploy $VEIL token + claim contract, then wire buildClaim
- PNG icons
- Full on-chain settlement via Firmament

See root PRODUCT-DELIVERY.md.
VEIL is ready for unpacked testing.

## Sign-in
Social sign-in (Google, GitHub, ChatGPT, etc.) is available via Cumulus://ID. Call `socialFromEnv()` from `@infinitum/cid` and pass the providers to `CidService`. The same environment variables used by Spectre enable the buttons for any product.
