# VEIL Next Steps

## Done in v0.4.0 (2026-11-06)
- Anonymous and signed-in workspaces with confirmed, data-clearing switches
- $VEIL ledger at the published launch policy (0.1/min, 240 min/day), human-activity only
- Claim receipts tied to a Cumulus://ID
- Cumulus://ID sign-in via the CID origin's `/api/me`
- Tor hardening: WebRTC limited to the proxy; New Identity
- Removed the placeholder wallet address and fake balance
- PNG icons, package.json and a test suite (`node --test test/`)

## Done in v0.5.0 (2026-11-06)
- Cumulus account summary (plan, unread mail, storage) from the CID origin
- FIRM Wallet panel shows the real CID wallet account and balances
- Unread-mail toolbar badge, refreshed every 5 minutes while signed in
- VEIL Nexus app launcher for the seven free-tier products
- Account, badge and refresh are dropped on leaving the workspace, New Identity or an expired session

## Done in v0.6.0

- Chrome MV3 and Firefox browser proxy (popup, server list, connect/disconnect)
- Cumulus ID session reused from the CID host cookie; VEIL plan checked on the server
- Authenticated HTTPS and SOCKS5 settings, WebRTC non-proxied UDP disabled, DNS through the proxy, fail-closed if the proxy drops
- `node scripts/package.js` writes Chrome and Firefox zips
- Honest limit: this browser's traffic only, not a device-wide VPN

## Remaining
- FIRM Wallet key management (passkey / hardware-backed) in the extension
- Deploy the $VEIL claim contract, then wire `buildClaim` to FIRM Wallet signing
- Server-side rewards validation (duplicate accounts, emulator farms) before settlement
- New Tor circuit control (needs the Tor control port; extension cannot reach it)
- Chain decision: the product page says $VEIL is on Solana; packages/firm targets Base
- Per-app permissions dashboard (needs grant/revoke HTTP routes on the CID server; `packages/cid` has `grant`/`revoke`)
- Clients for Cumulus://Cloud, SCALVS.ai and METATRON¹⁰⁰, then add their origins to `lib/nexus.js`
- A shared CID session across products (today Mail and +SPCTR each keep their own cookie)
- Device-wide VPN, OS DNS, and non-browser traffic are out of scope for this extension
- An operated exit fleet is not in this repository; `VEIL_SERVERS` must name exits the operator runs
- Proxy credentials are process-local on the CID host and are not written to Firmament

See root PRODUCT-DELIVERY.md.
