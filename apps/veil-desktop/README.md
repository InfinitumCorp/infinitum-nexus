# VEIL Desktop

Infinitum Corporation® device-wide cyber VPN. The default mode is the VEIL tunnel. Tor is optional. Off removes the route and the kill switch.

This is not the browser extension. `apps/veil` covers one browser. This client covers the device, on the platforms where the tunnel and the kill switch are actually installed.

## Modes

The Windows notification area, the macOS menu-bar source, and the console menu use the same three choices:

| Mode | What it does |
| --- | --- |
| VEIL VPN | Asks the existing VEIL control plane for a short-lived WireGuard peer. A live Cumulus ID session is required and is not enough. The VEIL entitlement is checked. The client private key is minted on the server, returned once, and not stored in this repository. |
| Tor | Does not call Infinitum. Routes through a Tor client you already installed. |
| Off | Removes routes, DNS changes, and the kill switch. |

If VEIL VPN or Tor is selected and the path is not up, traffic is blocked where the kill switch installed. If the kill switch itself cannot be installed, the mode is refused and the previous mode stays.

## Control plane

The desktop client uses the CID host that already serves the browser proxy:

- `GET /api/veil/device/session`
- `POST /api/veil/device/connect` with `{"serverId":"iad-1"}`
- `POST /api/veil/device/disconnect`
- `GET /api/veil/device/peers` for the exit process, with `x-veil-exit`

Browser routes are unchanged and still report `deviceWide: false`.

Operator environment, none of which is committed:

```sh
VEIL_WG_SERVER_PUBLIC_KEY=base64-wireguard-public-key
VEIL_WG_ENDPOINT=203.0.113.10:51820
VEIL_EXIT_TOKEN=at-least-16-url-safe-characters
```

The exit private key stays in `VEIL_WG_SERVER_PRIVATE_KEY_FILE` on the exit host. `cmd/veil-exit` reads that file. Tunnel addresses come from `10.64.0.0/16`. The exit address inside the tunnel is `10.64.0.1`, which is also the only DNS server the client will accept. Public resolvers such as `8.8.8.8` are refused.

## Run

```sh
veil-desktop selftest
veil-desktop run --control https://cid.example --token-file /path/to/cid-session
veil-desktop status
veil-desktop mode veil
veil-desktop mode tor
veil-desktop mode off
```

`VEIL_CID_TOKEN` is accepted and is not written into the repository. The local menu socket is `127.0.0.1` only. Its token is written mode `0600` under the user config directory and deleted when the process exits.

## Build

```sh
bash apps/veil-desktop/scripts/build-all.sh
bash apps/veil-desktop/scripts/integration-test.sh
```

Go 1.24.6 or newer is required because wireguard-go 0.0.20250522 declares Go 1.23.1. `CGO_ENABLED=0`.

Unsigned outputs land in `apps/veil-desktop/artifacts/`:

- Linux `veil-desktop` and `veil-exit`
- Windows `veil-desktop.exe`, `wintun.dll`, and `VEILDesktop-unsigned.msi` when `wixl` is installed
- macOS `VEILDesktop-amd64-utun.app` and `VEILDesktop-arm64-utun.app`, zipped

A `.dmg` is produced only when `hdiutil` exists. This Linux build does not invent one.

## What is real, and what was not executed here

- Userspace WireGuard (wireguard-go) carries a payload in `go test` and in `veil-desktop selftest`.
- A second test mints the peer with the TypeScript control plane and uses those keys.
- On Linux, a root test creates two TUN devices and pings through WireGuard.
- On Linux, a root test applies the nftables kill switch inside a network namespace and shows a ping that worked before the rules fail after them.
- The Windows `.exe` is a real PE binary. Its tray code is Win32. It was not clicked on a Windows desktop in this workspace.
- Wintun is the official DLL, hash-pinned. The Windows path does not install a global block-outbound firewall policy, because that policy survives a crash. DNS blocks and the tunnel route are installed. A full Windows Filtering Platform kill switch is a gap.
- The macOS `.app` in the artifacts is the utun engine (`wireguard-go`), unsigned. It is not a Network Extension and it was not launched on macOS here.
- `macos/PacketTunnel` is the NetworkExtension provider. It imports WireGuardKit (wireguard-apple, MIT). It was not compiled. `xcodebuild` is not on this machine, and the entitlement needs an Apple Developer account.
- `macos/VeilMenu` is the menu bar. It was not compiled.

See [COVERAGE.md](COVERAGE.md) and [SECURITY-AND-RELEASE.md](SECURITY-AND-RELEASE.md).
