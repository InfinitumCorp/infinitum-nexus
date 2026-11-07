# VEIL Packaging

Current version: 0.8.0

VEIL is Infinitum Corporation®'s browser cyber proxy. The default mode is the entitled VEIL exit. Tor is optional and uses a local Tor client. It is not a device-wide VPN, and Tor mode does not provide Tor Browser fingerprinting protection. The Tor binary is not included.

## Unpacked Chrome

Load `apps/veil` from `chrome://extensions` (Developer mode). `manifest.json` is the Chrome MV3 manifest.

## Chrome and Firefox zips

From `apps/veil`:

```sh
node scripts/package.js
```

This writes:

- `dist/chrome/` and `dist/veil-chrome.zip`
- `dist/firefox/` and `dist/veil-firefox.zip`

Firefox uses `browser.proxy` (per-request SOCKS authentication and remote DNS), `webRequestBlocking`, and the extension id `veil@infinitum.corporation` (strict minimum 128). Chrome uses `chrome.proxy` with SOCKS5 and `webRequestAuthProvider` for the isolation credentials. The zips contain the extension sources, popup, sidebar, and icons. They do not contain the control server, tests, or a Tor executable.

Load `dist/firefox` as a temporary add-on in Firefox.

## Icons

`icons/icon-{16,32,48,128}.png` are generated from `icon.svg`:

```sh
node scripts/make-icons.js
```

## Store packages

Sign the zips with the browser vendor's developer dashboard. No package script embeds a signing key.
