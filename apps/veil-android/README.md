# VEIL Android lab tunnel

Loopback acceptance tests for a future Android `VpnService`. The engine is
[wireguard-go](https://git.zx2c4.com/wireguard-go) (MIT). This tree does not
add a cipher.

`apps/veil` (the Chrome extension), FABRIC, and Cumulus are unchanged.

## Product domain

Canonical name for the VEIL VPN product: `infinitumveilvpn.app`, hosted at
Cloudflare. The constant is `VPNProduct()` in `tunnel/product.go`.

That name is product metadata. It is not a WireGuard peer, not a DNS server,
and not a running tunnel. This lab still binds `127.0.0.1` only and rejects
the product domain as an endpoint. No production key is stored here, and no
live endpoint has been provisioned.

`infinitumveil.app` is the separate browser product. Do not use it for the VPN.

Status of this tree: debug Android app plus the loopback lab. `infinitumveilvpn.app` is still only the product name. No server is provisioned. See BUILD.md. The host `go test` suite is not Android packet-flow proof.

## What the tests prove

Two wireguard-go devices exchange an ICMP packet over UDP bound to
`127.0.0.1` only. The TUN is an in-memory channel, so the test does not create
a host interface, route, firewall rule, or device-wide VPN.

- The UDP payload is a WireGuard handshake and transport message. The inner
  packet is not visible in the clear.
- `protect(fd)` runs inside the socket control callback, before the listener
  exists. If it returns an error, connect fails and no peer receives the packet.
- Disconnect stops delivery. A second connect while up is refused.
- IPv6 and other non-IPv4 packets are discarded, not encapsulated.
- DNS must sit inside the tunnel prefix (`10.77.0.0/24` in the lab). Public
  resolvers and hostnames are rejected. Peers must be IPv4 loopback.
- Logs pass through a redactor. The private key hex is not written.

The host tests above do not call `VpnService.Builder.establish()`. The debug
app in `android/` does, and it hands that file descriptor to wireguard-go.
`establish()` returning non-nil is not, by itself, a passing result. Build
steps are in BUILD.md.

## Run

Requires Go 1.26.0 or newer (golang.org/x/crypto v0.58.0 declares Go 1.26).

```sh
cd apps/veil-android/tunnel
go test -count=1 -race ./...
```

The module sums pin `golang.zx2c4.com/wireguard` at
`v0.0.0-20261024220952-b3bc704ef0ee`.

## Android contract, after the SDK is available

1. The service starts disconnected. Connect and disconnect are explicit.
2. `VpnService.prepare` is the user consent step.
3. `protect(fd)` is applied to the tunnel UDP socket before it can send.
4. Routes to declare on the builder: `0.0.0.0/0` and `::/0`. IPv6 is captured
   and then discarded until a real IPv6 peer exists. The UI must say that.
5. DNS, when set, is `Profile.DNS` only after `ValidateProfile`. No second resolver.
6. Hand the builder's file descriptor to wireguard-go only after steps 3–5.
   `establish()` returning non-nil is not a passing test.
7. The emulator peer, when that test is authorized, stays inside the AVD.
   This lab build rejects non-loopback peers so it cannot dial a public endpoint.

Tor is not part of this slice. Arti is MIT or Apache-2.0, with LGPL-3.0 in
`equix` and `hashx` when those crates are enabled. That choice stays closed
until a later review.

## iOS blockers

No iOS target is built or signed here.

Confirm these before any Network Extension source:

- A paid Apple Developer Program (or Enterprise) team is already owned. Do not
  buy one for this work. Re-read the checkmarks on
  [Supported capabilities (iOS)](https://developer.apple.com/help/account/reference/supported-capabilities-ios/):
  Network Extensions (`packet-tunnel-provider`) and Personal VPN are
  membership capabilities. The free Apple Developer agreement cannot distribute apps.
- An App ID with that entitlement, plus provisioning profiles for the app and
  the packet-tunnel extension.
- A physical iPhone. The Simulator does not run a packet tunnel.
- A Mac with Xcode. This Linux tree cannot compile or sign the extension.
- The same WireGuard engine (`wireguard-apple`, MIT, which embeds wireguard-go).
  No second protocol.
- Export-compliance paperwork for ordinary WireGuard is a later filing.

Until those are true, iOS stays a written blocker.
