# VEIL</>

Infinitum Corporation® Tor extension for this browser, plus the signed-in sidebar used beside the rest of the ecosystem.

## Limits

VEIL routes **traffic in this browser** through a Tor client you already run on this machine. It is not a device-wide VPN.

A Tor extension in Chrome or Firefox does **not** give Tor Browser fingerprinting protection. Sites can still see this browser's fonts, screen size, APIs, and other traits that Tor Browser equalizes. VEIL does not modify those surfaces.

- Other applications, the operating system, and browsers without this extension are unchanged.
- DNS for proxied requests, including `.onion` names, is resolved by Tor (SOCKS5, and `proxyDNS` on Firefox). The operating system's resolver is not reconfigured.
- Only loopback is contacted directly, so the browser can reach the local Tor client. Everything else stays on that SOCKS port.
- If Tor is unreachable, requests fail. They are not sent on the ordinary network.
- WebRTC's non-proxied UDP is disabled. That is the leak control the extension API allows. It is not Tor Browser's removal of WebRTC.
- Incognito and other profiles are covered only when that browser runs the extension there.
- The Tor binary is not bundled. Install Tor, or use Tor Browser's client, yourself.
- Circuit isolation uses a different SOCKS username and password per site and tab. That only builds separate circuits when the local client has `IsolateSOCKSAuth`. Tor Browser's port 9150 already does. A system Tor on 9050 needs a line such as `SocksPort 9050 IsolateSOCKSAuth`.
- New circuit rotates that SOCKS identity. New Identity also clears site data and closes tabs. Neither signal reaches Tor's control port.

## Tor routing

The toolbar popup and the sidebar Privacy tab share one switch.

| Client | SOCKS address |
| --- | --- |
| System Tor | `127.0.0.1:9050` |
| Tor Browser | `127.0.0.1:9150` |

Check uses `https://check.torproject.org/api/ip`. The status line says whether the exit is Tor, whether Tor did not answer, or whether Tor is off.

Turning Tor on does not call Infinitum servers.

## Optional bridges

A Cumulus ID session is the same cookie the sidebar already uses for `/api/me`. A VEIL plan, checked on the CID host, may download bridge lines from `GET /api/veil/bridges`. Those lines are for your local Tor configuration. They are not exits, and Tor works with the list empty.

```sh
VEIL_ENTITLED_CIDS=cid_...
VEIL_BRIDGES='["bridge obfs4 192.0.2.10:443 FINGERPRINT cert=... iat-mode=0"]'
```

Unset means nobody is entitled and no lines are published.

## Sidebar

Anonymous and signed-in workspaces, tracker stripping, $VEIL rewards, the Cumulus account summary, and the Nexus launcher are unchanged. Rewards and apps still require the signed-in workspace. Tor does not.

## Load

Chrome: `chrome://extensions` → Developer mode → Load unpacked → `apps/veil`.

Firefox: `node scripts/package.js`, then load `apps/veil/dist/firefox` from `about:debugging`.

## Develop

```sh
cd apps/veil
pnpm test
pnpm typecheck
pnpm lint
node scripts/package.js
node scripts/make-icons.js
```

## Configuration (chrome.storage.local)

`origins` overrides where each product runs. Plain HTTP is limited to localhost. `torPort` is `9050` or `9150` (or another local port).

| Key in `origins` | Default | Product |
| --- | --- | --- |
| `cid` | `http://localhost:3000` | Cumulus://ID sign-in and `/api/me` |
| `veil` | `http://localhost:3000` | Optional bridge list on that CID host |
| `mail` | `http://localhost:3010` | Cumulus://Mail |
| `architect` | `http://localhost:3001` | :\ARCHITECT\ endpoint for Ask |
