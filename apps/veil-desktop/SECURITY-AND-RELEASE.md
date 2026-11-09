# Install, signing, and gaps

Infinitum Corporation® VEIL Desktop. This file is the release record. It does not claim a notarized or store build. Nothing here was submitted to Apple, Microsoft, or a public download site.

## Install

Windows, unsigned:

1. The MSI is `artifacts/VEILDesktop-unsigned.msi` when `wixl` produced it. It copies `veil-desktop.exe` and `wintun.dll` to Program Files.
2. SmartScreen will warn. The binary is not Authenticode signed.
3. Run an elevated `veil-desktop.exe run --control https://infinitumveil.app --token-file <session>`. The host is on Cloudflare. `VEIL_CONTROL_URL` overrides it. `http` is accepted only for localhost and 127.0.0.1.
4. The notification-area menu is VEIL VPN, Tor, or Off. That menu was compiled into the Windows binary and was not clicked on a Windows machine in the build that produced this document.

macOS, unsigned utun build:

1. Unzip `VEILDesktop-amd64-unsigned-app.zip` or the arm64 zip.
2. Gatekeeper will refuse a double-clicked unsigned app. `xattr` quarantine and `spctl` are operator steps, not performed here.
3. The executable is `Contents/MacOS/veil-desktop`. It uses utun and needs root. It is not the Network Extension.

macOS, Network Extension (not built here):

1. Create an App ID `corporation.infinitum.veil` and an extension App ID `corporation.infinitum.veil.tunnel`.
2. Enable the Network Extension capability, packet tunnel.
3. Use the entitlements in `macos/PacketTunnel/VeilTunnel.entitlements` and `macos/VeilMenu/VeilMenu.entitlements`.
4. Link WireGuardKit from wireguard-apple tag `1.0.16-27` (MIT). `macos/build-macos.sh` clones that tag when Xcode exists. It does not sign.
5. Set `includeAllNetworks` on `NETunnelProviderProtocol` before starting the tunnel. That is Apple's fail-closed switch for a packet tunnel. The provider source builds the tunnel from the device grant and refuses a split tunnel and public DNS.
6. The menu bar is `macos/VeilMenu`. It talks to the local daemon. It was not compiled here.

Linux, for the tests and for an operator exit:

```sh
sudo ./veil-desktop run --control https://infinitumveil.app --token-file <session>
sudo ./veil-exit --private-key-file /path/to/exit.key --listen 51820
```

Assign `10.64.0.1/32` on the exit interface. The client addresses are `10.64.0.2` upward.

## Code signing

Not done.

- Windows: Authenticode with a trusted certificate. Without it, SmartScreen and some enterprise policies block the EXE and the MSI. No certificate was purchased or used.
- Wintun: the DLL is already signed by WireGuard LLC. VEIL does not sign a new kernel driver and does not ship wireguard-nt. A driver-signing certificate is not required for this Wintun build. Replacing Wintun, or shipping a modified driver, would require Microsoft attestation signing. That was not done.
- macOS utun binary: Developer ID Application signature, hardened runtime, and notarization (`notarytool`) were not done. Gatekeeper will block the app.
- Network Extension: the packet-tunnel-provider entitlement is granted per team by Apple. An Apple Developer account is required. This workspace does not have one. An unsigned Network Extension will not load.
- The system extension variant, if you later move off the app extension, also needs the system-extension entitlement and a notarized host. Not built.

## Notarization

Not done. `notarytool submit`, stapling, and a Developer ID were not run. There is no Apple team id in the repository.

## Auto-update

Not implemented. There is no update URL, no Sparkle feed, and no phone-home. A future updater would need a signed feed and a pinned key. Shipping one without that would be a gap of its own, so it is absent.

## Secrets

- No private keys, CID tokens, or exit tokens are in git.
- The control plane returns a client private key once and does not retain it. `deviceAudit()` and the exit peer list contain public keys and addresses.
- The local menu token is generated at runtime, stored mode `0600`, and removed on exit.
- `VEIL_WG_SERVER_PRIVATE_KEY` is not an environment variable the control plane reads. The exit process reads a file path.

## Kill switch and DNS

Linux, when run as root: nftables table `inet veil-desktop`, policy drop, except loopback, WireGuard UDP to the exit, and the tunnel interface. A root test applies that table in a network namespace and shows the ping fail. `resolvectl` is used when it exists. If it does not, the enforcement string is `nft-fail-closed-system-dns-unchanged` and non-tunnel DNS is still dropped.

Windows: the physical default gateway is read from `route print`, the exit gets a /32 via that gateway, and `0.0.0.0/1` plus `128.0.0.0/1` point at the tunnel. Public resolvers on ports 53 and 853 are blocked. Enforcement string `route-and-dns-block`. A global `blockoutbound` policy is intentionally not set. These commands were not executed on Windows.

macOS utun: pf anchor `veil-desktop` is in the source. It was not executed. The Network Extension path relies on `includeAllNetworks`, which was not loaded.

Off is the recovery path. A crash between installing the filter and starting the tunnel can leave the filter up. On Linux, `nft delete table inet veil-desktop` clears it. The Windows and macOS crash windows were not exercised.

## Tor

Honest limits, also in the status line:

- The Tor binary is not bundled.
- UDP other than DNS is dropped.
- This is not Tor Browser. Fonts, screen size, and APIs are unchanged.
- Transparent mode is one machine-wide circuit.
- If TransPort or DNSPort is closed, direct traffic is blocked and only SOCKS clients reach Tor.
- If nothing is listening, the kill switch stays up and the detail says Tor did not answer.

## Security gaps

- Unsigned binaries.
- Network Extension not built, not entitled, not notarized.
- Windows kill switch is not a full WFP callout.
- pf and the Win32 tray were not executed on their operating systems.
- IPv6 is fail-closed into the tunnel, not a verified v6 exit.
- The exit peer refresh depends on `cmd/veil-exit` staying running. A client key the exit has not polled cannot handshake.
- Grants expire. The desktop process refreshes only while it is running and the mode is VEIL. After expiry the exit drops the peer. A failed refresh goes fail-closed when the kill switch can be installed.
- Loopback is allowed so the local menu and the local Tor client keep working. That is a local attack surface if another local user can reach the menu token file.
- No auto-update, no revocation channel beyond entitlement checks on the next grant and on the exit peer list.
