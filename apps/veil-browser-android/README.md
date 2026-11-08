# VEIL for Android (browser)

Package `app.infinitum.veil.browser`, v0.7.0, minSdk 26 / targetSdk 35. A private WebView browser that shares its URL rules with the VEIL extension.

- **Address bar:** strips tracking parameters (same 27-entry list as `apps/veil/lib/privacy.js`), upgrades to HTTPS (except `.onion` and localhost), and sends anything that isn't a URL to a DuckDuckGo search.
- **Privacy defaults:** third-party cookies off, no file/content access, no geolocation, no form data, mixed content blocked, SSL errors refused, non-web schemes blocked, FLAG_SECURE (no screenshots), `allowBackup=false`.
- **Identity:** wipes cookies, web storage, cache, history and form data. The same wipe runs on exit.
- **Tor, built in:** VEIL ships the Tor Project's own Android build of tor (`libTor.so` from the Tor Browser expert bundle) and starts it with the app. Both web views (the page and the app side panel) go through Tor's SOCKS5 port via androidx.webkit `ProxyController`, so host names resolve inside Tor. It fails closed: no network request leaves until the proxy is set and Tor reports 100%, and if Tor stops, pages stop loading. WebRTC is removed from every frame, since it can bypass the proxy. The Tor box shows progress (`Tor 45%`), then `● Tor`; tapping it opens check.torproject.org. New Identity also sends `SIGNAL NEWNYM`. No Orbot needed.
- **Bridges, automatically:** where Tor is blocked, a direct start stalls (typically at 10%, "Connected to a relay"). After 20 s without progress VEIL restarts Tor with Tor Browser's built-in bridges (Snowflake, obfs4, meek from the bundle's `pt_config.json`) through `lyrebird` (`libLyrebird.so`), and remembers that bridges worked for the next launch. If neither way connects after a few rounds, the Tor box turns `Tor ✕` and pages stay blocked.
- **Not Tor Browser:** this is Android System WebView (Chromium) over Tor, without Tor Browser's anti-fingerprinting, so sites can still fingerprint the browser. Use Tor Browser when that matters.
- **Hub:** the VEIL web app (`apps/veil-web`), bundled offline at `file:///android_asset/hub/`.

## Build

No Gradle. You need JDK 17+, Python 3 and an Android SDK with `platforms/android-36` and `build-tools/36.0.0`. The first build runs `scripts/fetch-deps.sh`, which downloads Tor 16.0 (arm64-v8a, armeabi-v7a, x86_64) and androidx.webkit 1.18.0 into `.deps/` and checks each against a pinned SHA-256. The script explains how to update Tor.

    bash scripts/build.sh test   # JVM tests for the URL rules, incl. parity with the extension
    bash scripts/build.sh        # build/veil-browser.apk (debug-signed)

To release-sign, set `VEIL_KEYSTORE`, `VEIL_KS_PASS` and `VEIL_KS_ALIAS`. Then copy the APK to `apps/veil-web/public/downloads/` so the website serves it.

## Tested

On a TECNO KM4 (Android 15), 2026-11-07:
- Address bar: `http://example.com/?utm_source=test&id=7&fbclid=abc` loaded as `https://example.com/?id=7`.
- Identity wiped the session and returned to the Hub in "Anonymous session" mode.

On the same phone, 2026-11-09 (v0.7.0, Tor 0.4.9.15 built in), on a Wi-Fi network that blocks Tor:
- Direct start stalled at 10%. VEIL switched to bridges after 21 s, and Tor reached 100% over Snowflake about 75 s later. The obfs4 bridges were blocked there.
- check.torproject.org: "Congratulations. This browser is configured to use Tor.", exit 185.220.101.5 (and, as expected, "it does not appear to be Tor Browser").
