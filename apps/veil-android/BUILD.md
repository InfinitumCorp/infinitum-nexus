# VEIL Android debug build

Pinned, free toolchain. This produces a debug APK. It is not a Play Store
signature and it does not provision `infinitumveilvpn.app`.

| Piece | Pin |
|---|---|
| commandlinetools | `commandlinetools-linux-11076708_latest.zip` |
| Android platform | `platforms;android-35` |
| build-tools | `35.0.0` |
| NDK | `27.2.12479018` |
| Gradle / Android Gradle Plugin | `8.11.1` / `8.7.3` |
| Go for the APK | `1.26.10` via `GOTOOLCHAIN` (`mobile/go.mod` says `go 1.26.0`) |
| gomobile | `v0.0.0-20261011034528-197770444867` |
| wireguard-go | `v0.0.0-20261024220952-b3bc704ef0ee` |
| min / target SDK | 26 / 35 |

`infinitumveilvpn.app` is the product name, hosted at Cloudflare. It is not a
WireGuard endpoint. The app refuses that name as a peer. No key, certificate,
or server address is shipped.

## Limits

- IPv6 routes are installed (`::/0`) and then discarded by the Go policy. They
  are not tunneled.
- No DNS server is installed. Apps are not given `8.8.8.8` or any other resolver.
- `SUPPORTS_ALWAYS_ON` is false. A failed handshake closes the TUN. Traffic is
  not blocked after that. This is not an OS kill switch.
- Host lab tests (`go test -race` in `tunnel/`) use an in-memory TUN and
  `127.0.0.1`. They are not Android packet-flow proof.
- `TunnelE2ETest` is the device test. It needs an emulator or phone. Opening
  `/dev/kvm` is a separate permission; this script does not change it.

## Commands

```sh
export ANDROID_HOME=/tmp/android-sdk
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018" "platform-tools"
cd apps/veil-android
sh scripts/build-apk.sh
cd tunnel && go test -count=1 -race -timeout 180s ./...
```

The packaged debug APK contains only `arm64-v8a` (`lib/arm64-v8a/libgojni.so`).
Gradle’s debug keystore signs it. That is not a Play upload key.

Agent build of this tree, copied to `/opt/cursor/artifacts/veil-arm64-v8a-debug.apk`:

```
b3481476962f97821273ccf27cfce6d2916e20bc94c8d0c42eaab19b5d6ace8b
```

```
applicationId: app.infinitum.veil
versionName: 0.1.0-debug
versionCode: 1
minSdk: 26
targetSdk: 35
abi: arm64-v8a
launch activity: app.infinitum.veil.MainActivity
service: app.infinitum.veil.VeilVpnService
```

This is not `com.infinitum.veilvpn` and not targetSdk 36. An already installed
debug `com.infinitum.veilvpn` 0.1.0 has unknown provenance. Do not reuse its
keys, VPN consent, or process state. Install this APK beside it, or uninstall
that package first if the tester must avoid mixing logcat.

## Disposable peer

There is no production endpoint and no settings field. `MainActivity` only
displays the product name. The supported entry is `VeilVpnService.connect`:

1. `VpnService.prepare` returns null. On a test image: `adb shell appops set app.infinitum.veil ACTIVATE_VPN allow`.
2. Bind `app.infinitum.veil.VeilVpnService`.
3. Mint keys in process with `Mobile.mintKey()` (`privateHex publicHex`). Do not log or store them.
4. `connect` with an IPv4 `host:port` only. `infinitumveilvpn.app`, a scheme, or a hostname returns `domain-is-not-an-endpoint` or `bad-endpoint` and does not call `establish()`.
5. The service adds address `10.77.0.2/32` when the test passes that CIDR, route `0.0.0.0/0`, and route `::/0`. It does not call `addDnsServer`.
6. `wireguard-go` owns the TUN fd. `protect(fd)` must return true for the UDP socket or `connect` returns `protect-failed` and closes the TUN.
7. After `establish()`, start the in-process peer with `Mobile.peerStart` using the other keypair. Point the client at `<device-non-loopback-ipv4>:<peerPort>` and the peer at `<same-ip>:<clientListenPort>`.
8. Send UDP to `10.77.0.1:9` from an unprotected socket. Those bytes are the inner payload. They must not appear in the clear on the WireGuard UDP socket.
9. `disconnect` or `onRevoke` closes the TUN. Other traffic is then not blocked. `SUPPORTS_ALWAYS_ON` is false. This is not a kill switch.
10. IPv6 to `::/0` is captured and discarded, not encapsulated. No resolver is installed, so there is no tunnel DNS and no fallback resolver inside the VPN.

Install and open, after `adb` is available:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.infinitum.veil/.MainActivity
```

The launcher does not connect. `infinitumveilvpn.app` is the product name and is
rejected as a peer. A tunnel starts only when `VeilVpnService.connect` is given
an IPv4 `host:port`, a local CIDR, and disposable WireGuard keys. The
instrumented test mints those keys in process (`Mobile.mintKey`), starts an
in-process peer after `establish()`, then points both sides at the device’s
own non-loopback IPv4. The inner datagram is UDP to `10.77.0.1:9`. No public
server is required. `VpnService.prepare` must already be granted (`appops set
app.infinitum.veil ACTIVATE_VPN allow` on a test image, or the system consent
screen). Instrumentation, when a device is attached:

```sh
cd apps/veil-android/android
./gradlew :app:connectedDebugAndroidTest --no-daemon
```

Host `go test -race` does not replace that device test.
