# VEIL</>

Tor-first secure browser sidebar for the Infinitum ecosystem (Chrome MV3 extension).
This is the extension edition used to build and test VEIL features ahead of the
Tor Browser-derived desktop engine described on the product page.

## Status
v0.5.0: roadmap Phase I (browser foundation), the start of Phase II (identity and
communications), and the rewards ledger from Phase IV.

- **Two workspaces.** Anonymous (default): Tor, tracker stripping and New Identity only.
  Signed-in: Cumulus://ID, Mail, the Infinitum apps, Ask (:\ARCHITECT\), FIRM Wallet and $VEIL rewards.
  Every switch is confirmed in the panel and clears cookies and site data first.
- **Tor.** SOCKS5 proxy to a local Tor service on 127.0.0.1:9050 (DNS goes over Tor),
  WebRTC limited to the proxy, connectivity check against check.torproject.org.
- **New Identity.** Clears cookies, caches and site storage and closes every tab.
  History, passwords and downloads are untouched.
- **Tracker stripping.** Removes utm_*, fbclid, gclid and similar parameters, on by default.
- **$VEIL rewards** at the published launch rate: 0.1 $VEIL per eligible active minute,
  max 240 minutes (24 $VEIL) per UTC day. A minute counts only with a trusted keyboard,
  mouse or touch event on the active tab of the focused window, in the signed-in workspace.
  Pages report three booleans and nothing about the site. Claims produce receipts that
  stay `pending-settlement` until the $VEIL claim contract is deployed.
- **Cumulus account (Phase II).** After sign-in, the Account tab shows plan, unread mail and shared
  Mail + Cloud storage; the Wallet tab shows the FIRM Wallet account that comes with the CID. Unread
  mail also shows on the toolbar badge, refreshed every 5 minutes. All of it is dropped when you
  leave the signed-in workspace or use New Identity.
- **Apps (VEIL Nexus).** The seven free-tier products from the product page. Mail, :\ARCHITECT\ and
  Cumulus://ID open in their own tab; FIRM Wallet opens its panel; the rest are marked Coming soon.
- **Ask** shares the current tab's title and address only when you tick the box.

## Load
`chrome://extensions` → Developer mode → Load unpacked → `apps/veil`

## Develop
```sh
cd apps/veil
node --test test/            # unit + background tests (fake chrome.*)
node scripts/make-icons.js   # regenerate icons/ from the icon.svg design
```

## Configuration (chrome.storage.local)
`origins` overrides where each product runs; only http(s) origins are accepted.

| Key in `origins` | Default | Product |
| --- | --- | --- |
| `cid` | `http://localhost:3000` | Cumulus://ID sign-in and `/api/me` (served by +SPCTR today) |
| `mail` | `http://localhost:3010` | Cumulus://Mail (the account summary can override it) |
| `architect` | `http://localhost:3001` | :\ARCHITECT\ endpoint for Ask |
