# VEIL</>

Tor-first secure browser sidebar for the Infinitum ecosystem.

## Status
Partial (v0.3.0): Manifest V3 side panel with multi-panel UI (Ask, Wallet, Rewards, Privacy).
- Ask calls Conductor
- Rewards + wallet via chrome.storage
- Content script strips trackers (manual + optional auto-clean)
- Tor proxy toggle + connectivity check (requires local Tor on 127.0.0.1:9050)
- Simple SVG icon

## Load in Chrome / Edge
1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → select `apps/veil`

## Tor
Start Tor (or Tor Browser) so SOCKS5 listens on 9050, then toggle in the Privacy panel and use “Check Tor”.

## Packaging
See PACKAGING.md.
