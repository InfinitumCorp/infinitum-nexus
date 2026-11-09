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

- `dist/chrome/` and `dist/veil-chrome.zip`, plus `dist/veil-chrome.tar`
- `dist/firefox/` and `dist/veil-firefox.zip`, plus `dist/veil-firefox.tar`
- `dist/BUILDINFO` and `dist/SHA256SUMS`

The packager pins Node.js in `scripts/toolchain.js`. Archive timestamps come from `SOURCE_DATE_EPOCH`, or from the git commit time when that variable is unset. Zip and tar entries are sorted by name. The archives do not store a host user, a host path, or the current clock. `dist/SHA256SUMS` is a `sha256sum` manifest.

```sh
bash scripts/repro-check.sh
```

That packages twice and fails if the manifests or the bytes differ.

Firefox uses `browser.proxy` (per-request SOCKS authentication and remote DNS), `webRequestBlocking`, and the extension id `veil@infinitum.corporation` (strict minimum 128). Chrome uses `chrome.proxy` with SOCKS5 and `webRequestAuthProvider` for the isolation credentials. The zips contain the extension sources, popup, sidebar, and icons. They do not contain the control server, tests, or a Tor executable.

Load `dist/firefox` as a temporary add-on in Firefox.

## Icons

`icons/icon-{16,32,48,128}.png` are generated from `icon.svg`:

```sh
node scripts/make-icons.js
```

## Store packages

Sign the zips with the browser vendor's developer dashboard. No package script embeds a signing key.
