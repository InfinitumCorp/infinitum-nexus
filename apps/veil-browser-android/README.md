# VEIL for Android (browser)

Package `app.infinitum.veil.browser`, v0.8.0, minSdk 26 / targetSdk 35. A private WebView browser that shares its URL rules with the VEIL extension.

- **Address bar:** strips tracking parameters (same 27-entry list as `apps/veil/lib/privacy.js`), upgrades to HTTPS (except `.onion` and localhost), and sends anything that isn't a URL to a DuckDuckGo search.
- **Privacy defaults:** third-party cookies off, no file/content access, no geolocation, no form data, mixed content blocked, SSL errors refused, non-web schemes blocked, FLAG_SECURE (no screenshots), `allowBackup=false`.
- **Identity:** wipes cookies, web storage, cache, history and form data. The same wipe runs on exit.
- **Fast by default:** VEIL connects directly, with trackers, ads and tracking parameters blocked. No proxy and no Tor unless the person turns it on.
- **Tor, opt-in:** VEIL ships the Tor Project's own Android build of tor (`libTor.so` from the Tor Browser expert bundle). Tap the Tor box (`Tor off`) or ⋮ > Turn on Tor. Turning it on or off clears cookies, site storage and cache, so the direct and Tor sessions can't be linked; the choice is remembered. With Tor on, both web views go through Tor's SOCKS5 port via androidx.webkit `ProxyController` (host names resolve inside Tor), and it fails closed: no request leaves until the proxy is set and Tor reports 100%. WebRTC is removed from every frame either way. The Tor box shows `Tor 45%`, then `● Tor`. New Identity also sends `SIGNAL NEWNYM`.
- **Bridges, automatically:** where Tor is blocked, a direct start stalls at 10% ("Connected to a relay"). After 20 s VEIL switches to Tor Browser's built-in bridges (from the bundle's `pt_config.json`, through `lyrebird` / `libLyrebird.so`), one type at a time like Tor Browser: Snowflake, then meek, then obfs4. A type that can't reach a bridge at all (still below 10% after 20 s, as with blocked obfs4) is skipped. Otherwise a type gets 90 s without a handshake, and that window restarts while lyrebird reports Snowflake still working (broker offer and answer, a new volunteer proxy), up to 4 minutes. Snowflake's broker answers within seconds or not at all, so a request unanswered after 20 s is retried with a fresh start (twice per type). Once a type has completed a handshake, VEIL stays with it, and bytes still arriving (`GETINFO traffic/read`) count as progress, so a slow consensus download over meek isn't cut off. VEIL remembers the type that worked and starts with it next time, and doesn't retry direct once it has stalled. After two rounds of every way the Tor box shows `Tor ✕`. Each restart is numbered, so a stale relaunch, stall check or log line from a replaced tor is ignored.
- **Share data & earn (opt-in, off by default):** ⋮ > Share data & earn. While off, VEIL counts nothing. When on, it keeps only the VEIL dataset of the Cumulus Data Exchange (`packages/data-exchange`, `VeilCollector`: feature counts, session count, average session length). Never sites, searches, page content, typed text or IP. The person sees exactly what is kept and can turn it off, which deletes it. Sales pay 85% to the person's Cumulus://ID. The exchange API isn't live yet, so nothing is uploaded (`Earn.java`).
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

On the same phone, 2026-11-10 (v0.8.0), on a network where direct Tor stalls at 10% and the obfs4 bridges are blocked: with Tor turned on, VEIL started with Snowflake bridges and reached 100% in 29 s; check.torproject.org said "Congratulations. This browser is configured to use Tor." Before this change it alternated direct/all-bridges and stayed at 10–25% for over 7 minutes.

Later that day, on the same network while it was very slow (a plain TLS handshake took 7–27 s): the first Snowflake try timed out at 60 s, meek too, and the full cycle took nearly 4 minutes. With the longer Snowflake window and the broker retry, two cold starts reached 100% in 45 s and 15 s. Tapping ● Tor > Check showed "Connected through Tor" with the exit address (178.20.55.16) in a VEIL dialog; no page opened.
