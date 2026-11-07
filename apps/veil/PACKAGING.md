# VEIL Packaging

Current version: 0.6.0

VEIL here is a browser cyber proxy for Infinitum Corporation®. The packaged extension protects traffic in that browser only. It is not a device-wide VPN.

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

Firefox uses `browser.proxy`, `webRequestBlocking`, and the extension id `veil@infinitum.corporation` (strict minimum 128). Chrome uses `chrome.proxy` and `webRequestAuthProvider`. The zips contain the extension sources, popup, sidebar, and icons. They do not contain the control server, tests, or dependencies.

Load `dist/firefox` as a temporary add-on in Firefox. The zip is the store/distribution artifact.

## Icons

`icons/icon-{16,32,48,128}.png` are generated from `icon.svg`:

```sh
node scripts/make-icons.js
```

## Store packages

Sign the zips with the browser vendor's developer dashboard. No package script embeds a signing key.
