# VEIL</>

Infinitum Corporation® browser cyber proxy, plus the Tor-first sidebar used to exercise VEIL beside the rest of the ecosystem.

## Limits

VEIL in this extension protects **traffic in this browser**. It is not a device-wide VPN.

- Other applications, the operating system, and browsers without this extension are unchanged.
- DNS for proxied browser requests is resolved by the exit (HTTPS CONNECT or SOCKS5 with remote DNS). The operating system's resolver is not reconfigured.
- Cumulus ID and the VEIL control host are reached directly, so a dead proxy cannot lock you out of sign-in.
- If the proxy drops while VEIL is on, browser traffic is blocked (fail closed) until you reconnect or explicitly disconnect.
- Incognito and other browser profiles are covered only when that browser runs the extension there.
- This repository does not ship a public exit node or a proxy password. Operators configure exits and the VEIL plan on the Cumulus ID host.
- Tor remains a separate local SOCKS proxy. It cannot be on at the same time as the VEIL proxy.

## Browser proxy (v0.6.0)

- **Cumulus ID sign-in** uses the existing CID host session (`/api/me` and the `spctr_session` cookie). The popup opens that host; Refresh reads the session.
- **Entitlement is server-side.** A live session is required and is not enough. Free CID entitlements and grants for other products do not connect. The host checks `VEIL_ENTITLED_CIDS` (or the `veil.entitled` callback) on every session, connect, and proxy-credential use.
- **Server list and selection.** Exits come from `VEIL_SERVERS`. The extension sends only a server id. It does not accept a host supplied by the page.
- **Connect / disconnect** uses `chrome.proxy.settings` on Chrome and `browser.proxy.onRequest` on Firefox. Credentials are HTTPS or SOCKS5, held in memory, and supplied only to that proxy's authentication challenge.
- **Leak controls.** WebRTC non-proxied UDP is disabled while protected or fail-closed. SOCKS4 and plain HTTP proxies are refused. Disconnect clears the proxy and the WebRTC override.

### Operator configuration

On the Cumulus ID host (`apps/spectre` local process, not the marketing site):

```sh
VEIL_ENTITLED_CIDS=cid_...           # comma-separated; unset means nobody
VEIL_SERVERS='[{"id":"iad-1","name":"Washington","region":"us-east","host":"veil-iad.example","port":443,"scheme":"https"}]'
```

`scheme` is `https` or `socks5`. There is no password in this list. The control plane mints a short-lived username and password after the plan check. Restarting the host drops those credentials (fail closed).

## Sidebar status

v0.5.0 remains: anonymous and signed-in workspaces, Tor to 127.0.0.1:9050, New Identity, tracker stripping, $VEIL rewards, Cumulus account summary, and the Nexus launcher.

## Load

Chrome: `chrome://extensions` → Developer mode → Load unpacked → `apps/veil`.

Firefox: `node scripts/package.js`, then load `apps/veil/dist/firefox` from `about:debugging`.

The toolbar button opens the proxy popup. The sidebar is still available from that popup on Chrome.

## Develop

```sh
cd apps/veil
node --test test/            # extension unit tests
pnpm test                    # extension tests and the control-plane tests
pnpm typecheck
pnpm lint
node scripts/package.js      # dist/veil-chrome.zip and dist/veil-firefox.zip
node scripts/make-icons.js   # regenerate icons/ from icon.svg
```

## Configuration (chrome.storage.local)

`origins` overrides where each product runs; only http(s) origins are accepted. Plain HTTP is limited to localhost.

| Key in `origins` | Default | Product |
| --- | --- | --- |
| `cid` | `http://localhost:3000` | Cumulus://ID sign-in and `/api/me` |
| `veil` | `http://localhost:3000` | VEIL control on that same CID host (`/api/veil`) |
| `mail` | `http://localhost:3010` | Cumulus://Mail |
| `architect` | `http://localhost:3001` | :\ARCHITECT\ endpoint for Ask |
