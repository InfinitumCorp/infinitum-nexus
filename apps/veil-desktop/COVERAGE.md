# Browser extension and device client

Infinitum Corporation® ships two VEIL clients. They do not cover the same traffic.

| | Browser extension `apps/veil` | Desktop `apps/veil-desktop` |
| --- | --- | --- |
| Default mode | VEIL VPN | VEIL VPN |
| Optional mode | Tor, local SOCKS | Tor, local client |
| Off | Clears the browser proxy | Clears routes, DNS, and the kill switch |
| Cumulus ID session | Required for VEIL VPN | Required for VEIL VPN |
| VEIL entitlement | Required for VEIL VPN | Required for VEIL VPN |
| Tor calls Infinitum | No | No |
| What is covered | Requests in the browser profile that loaded the extension | Traffic the operating system routes into the tunnel, where the kill switch is installed |
| What is not covered | Other browsers, other apps, the operating system, a profile that did not load the extension | See the gaps below |
| DNS | Proxied with the browser request (`proxyDNS` on Firefox). The system resolver is unchanged | System DNS is pointed at `10.64.0.1` when the platform tool succeeds. Other DNS is dropped by the Linux kill switch |
| WebRTC | Non-proxied UDP disabled in the extension | Not a browser control. UDP follows the tunnel or is dropped |
| Fingerprinting | Not Tor Browser | Not Tor Browser |
| Device-wide | No | Only while the tunnel and the kill switch are up |

## Desktop gaps that are still true

- A program that binds a physical interface by name can bypass a route-only tunnel. The Linux nftables output hook drops that path. The Windows build does not install an equivalent crash-safe filter.
- IPv6 destinations are inside the WireGuard allowed IPs (`::/0`) so they enter the tunnel. If the exit has no IPv6, they fail instead of leaking.
- Tor does not carry arbitrary UDP. QUIC, WebRTC, and NTP are dropped in Tor mode, not anonymized.
- Transparent Tor needs the user's `TransPort` (`127.0.0.1:9040`) and `DNSPort` (`127.0.0.1:5353`). SOCKS alone (`127.0.0.1:9050`) is fail-closed for programs that ignore the system proxy. It is one circuit for the machine, not per-site isolation.
- DHCP on the physical link is not a web request. The in-memory policy allows loopback. It does not special-case DHCP. A host that loses DHCP while the kill switch is up stays blocked until Off.
- The browser extension does not start this client, and this client does not install the extension.
- macOS distribution through a Network Extension was not built or signed. The utun binary needs root and is a different mechanism from `NEPacketTunnelProvider`.
