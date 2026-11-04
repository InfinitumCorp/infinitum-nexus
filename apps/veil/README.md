# VEIL</>

Tor-first secure browser sidebar for the Infinitum ecosystem.

## Status
Partial (v0.3.1): Manifest V3 side panel.
- Ask → Conductor
- Rewards with claimable receipts
- Wallet panel queries Base RPC for native balance
- Tracker stripping + Tor proxy + connectivity check

## Load
`chrome://extensions` → Developer mode → Load unpacked → `apps/veil`

## Wallet
Connect generates a scaffold address and queries `https://mainnet.base.org` for ETH balance.
Set `firmRpc` / `firmToken` in chrome.storage when FIRM token is live.
