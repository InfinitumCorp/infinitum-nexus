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

## Done in v0.8.0

- VEIL VPN is the default route again: CID session plus a VEIL plan, exit list, authenticated HTTPS/SOCKS, DNS through the proxy, fail-closed
- Tor stays optional: local SOCKS5 (`9050` or Tor Browser `9150`), per-site isolation, New Identity, Tor check, `.onion` with remote DNS
- Popup switch: VEIL VPN / Tor / Off. Both active modes limit WebRTC the same way

## Done in v0.7.0

- Tor routing for this browser through a local SOCKS5 client (`127.0.0.1:9050`, or Tor Browser `9150`)
- Per-site and per-tab circuit isolation via SOCKS username/password (`IsolateSOCKSAuth` on the user's Tor)
- New circuit and New Identity, Tor check, remote DNS including `.onion`, WebRTC non-proxied UDP disabled, fail-closed when Tor is down
- Cumulus ID and a VEIL plan gate optional bridge lines only. Tor itself does not call Infinitum servers
- Honest limit: not Tor Browser fingerprinting protection, and not a device-wide VPN

## Done in v0.6.0

- First browser-proxy pass. v0.7.0 replaces the operator exit fleet with local Tor.

## Remaining
- FIRM Wallet key management (passkey / hardware-backed) in the extension
- Deploy the $VEIL claim contract, then wire `buildClaim` to FIRM Wallet signing
- Server-side rewards validation (duplicate accounts, emulator farms) before settlement
- New Tor circuit control (needs the Tor control port; extension cannot reach it)
- Chain decision: the product page says $VEIL is on Solana; packages/firm targets Base
- Per-app permissions dashboard (needs grant/revoke HTTP routes on the CID server; `packages/cid` has `grant`/`revoke`)
- Clients for Cumulus://Cloud, SCALVS.ai and METATRON¹⁰⁰, then add their origins to `lib/nexus.js`
- A shared CID session across products (today Mail and +SPCTR each keep their own cookie)
- Device-wide VPN, OS DNS, and non-browser traffic are out of scope
- Tor Browser fingerprinting resistance (fonts, screen, APIs) is out of scope for a regular-browser extension
- The Tor executable is not bundled. The user runs Tor, with `IsolateSOCKSAuth` if they want separate circuits
- Chrome may cache one SOCKS login for the local port; Firefox attaches a new username and password on every request

See root PRODUCT-DELIVERY.md.
