# VEIL for Android (browser)

Package `app.infinitum.veil.browser`, v0.6.0, minSdk 26 / targetSdk 35. A private WebView browser that shares its URL rules with the VEIL extension.

- **Address bar:** strips tracking parameters (same 27-entry list as `apps/veil/lib/privacy.js`), upgrades to HTTPS (except `.onion` and localhost), and sends anything that isn't a URL to a DuckDuckGo search.
- **Privacy defaults:** third-party cookies off, no file/content access, no geolocation, no form data, mixed content blocked, SSL errors refused, non-web schemes blocked, FLAG_SECURE (no screenshots), `allowBackup=false`.
- **Identity:** wipes cookies, web storage, cache, history and form data. The same wipe runs on exit.
- **Tor:** routing goes through [Orbot](https://orbot.app/download/) in VPN mode. The Tor button offers Orbot when it isn't installed and opens check.torproject.org.
- **Hub:** the VEIL web app (`apps/veil-web`), bundled offline at `file:///android_asset/hub/`.

## Build

No Gradle. You need JDK 17+ and an Android SDK with `platforms/android-36` and `build-tools/36.0.0`:

    bash scripts/build.sh test   # JVM tests for the URL rules, incl. parity with the extension
    bash scripts/build.sh        # build/veil-browser.apk (debug-signed)

To release-sign, set `VEIL_KEYSTORE`, `VEIL_KS_PASS` and `VEIL_KS_ALIAS`. Then copy the APK to `apps/veil-web/public/downloads/` so the website serves it.

## Tested

On a TECNO KM4 (Android 15), 2026-11-07:
- Address bar: `http://example.com/?utm_source=test&id=7&fbclid=abc` loaded as `https://example.com/?id=7`.
- The Tor dialog detected that Orbot was missing.
- Identity wiped the session and returned to the Hub in "Anonymous session" mode.
