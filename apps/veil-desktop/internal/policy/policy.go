// Package policy decides which packets may leave the machine.
// VEIL mode is fail-closed: anything that is not the tunnel, loopback, or the
// WireGuard UDP socket to the exit is dropped. Public DNS is never an exception.
package policy

import (
	"fmt"
	"net/netip"
	"strings"
)

type Mode string

const (
	ModeOff       Mode = "off"
	ModeVeil      Mode = "veil"
	ModeTor       Mode = "tor"
	ModeBlackhole Mode = "blackhole"
)

type Packet struct {
	OutIface string
	Proto    string
	Dst      netip.Addr
	DstPort  uint16
}

type Decision string

const (
	Allow Decision = "allow"
	Drop  Decision = "drop"
)

type State struct {
	Mode         Mode
	TunnelUp     bool
	TunnelIface  string
	Endpoint     netip.AddrPort
	TunnelDNS    []netip.Addr
	TorSOCKSPort uint16
	TransPort    uint16
	DNSPort      uint16
	// GeoExclude is opt-in. When it is false, ExcludedPrefixes are ignored and
	// physical egress stays dropped.
	GeoExclude       bool
	ExcludedPrefixes []netip.Prefix
}

// Decide is the kill switch. Off allows the packet. Every other mode drops it
// unless a specific exception matches.
func Decide(state State, pkt Packet) Decision {
	if state.Mode == ModeOff {
		return Allow
	}
	if pkt.Dst.IsLoopback() {
		if state.Mode == ModeTor && state.TransPort > 0 && pkt.Proto == "tcp" && pkt.DstPort == state.TransPort {
			return Allow
		}
		if state.Mode == ModeTor && state.DNSPort > 0 && pkt.DstPort == state.DNSPort && (pkt.Proto == "udp" || pkt.Proto == "tcp") {
			return Allow
		}
		if state.Mode == ModeTor && state.TorSOCKSPort > 0 && pkt.Proto == "tcp" && pkt.DstPort == state.TorSOCKSPort {
			return Allow
		}
		if state.Mode != ModeTor {
			return Allow
		}
		return Drop
	}
	if state.Mode == ModeVeil && state.Endpoint.IsValid() && pkt.Proto == "udp" && pkt.Dst == state.Endpoint.Addr() && pkt.DstPort == state.Endpoint.Port() {
		return Allow
	}
	if state.Mode == ModeVeil && state.TunnelUp && pkt.OutIface == state.TunnelIface && state.TunnelIface != "" {
		if pkt.DstPort == 53 || pkt.DstPort == 853 {
			for _, dns := range state.TunnelDNS {
				if pkt.Dst == dns {
					return Allow
				}
			}
			return Drop
		}
		return Allow
	}
	if state.GeoExclude && excludedDestination(state, pkt) {
		return Allow
	}
	return Drop
}

func excludedDestination(state State, pkt Packet) bool {
	if pkt.DstPort == 53 || pkt.DstPort == 853 {
		return false
	}
	for _, prefix := range state.ExcludedPrefixes {
		if prefix.Contains(pkt.Dst) {
			return true
		}
	}
	return false
}

// RenderNft renders the same policy as nftables syntax for the inet family.
// Callers apply it with nft. The table name is veil-desktop.
func RenderNft(state State) string {
	var b strings.Builder
	b.WriteString("table inet veil-desktop {\n")
	b.WriteString("  chain output {\n")
	b.WriteString("    type filter hook output priority 0; policy drop;\n")
	if state.Mode == ModeOff {
		b.WriteString("    accept\n")
	} else {
		b.WriteString("    oif \"lo\" accept\n")
		if state.Mode == ModeVeil && state.Endpoint.IsValid() {
			fmt.Fprintf(&b, "    ip daddr %s udp dport %d accept\n", state.Endpoint.Addr(), state.Endpoint.Port())
			if state.Endpoint.Addr().Is6() {
				fmt.Fprintf(&b, "    ip6 daddr %s udp dport %d accept\n", state.Endpoint.Addr(), state.Endpoint.Port())
			}
		}
		if state.Mode == ModeVeil && state.TunnelUp && state.TunnelIface != "" {
			fmt.Fprintf(&b, "    oifname %q accept\n", state.TunnelIface)
		}
		if state.Mode == ModeVeil && state.GeoExclude {
			writeExcluded(&b, state.ExcludedPrefixes)
		}
		if state.Mode == ModeTor {
			if state.TorSOCKSPort > 0 {
				fmt.Fprintf(&b, "    ip daddr 127.0.0.1 tcp dport %d accept\n", state.TorSOCKSPort)
			}
			if state.TransPort > 0 {
				fmt.Fprintf(&b, "    ip daddr 127.0.0.1 tcp dport %d accept\n", state.TransPort)
			}
			if state.DNSPort > 0 {
				fmt.Fprintf(&b, "    ip daddr 127.0.0.1 udp dport %d accept\n", state.DNSPort)
				fmt.Fprintf(&b, "    ip daddr 127.0.0.1 tcp dport %d accept\n", state.DNSPort)
			}
		}
	}
	b.WriteString("  }\n")
	if state.Mode == ModeTor && state.TransPort > 0 {
		b.WriteString("  chain preroute {\n")
		b.WriteString("    type nat hook output priority -100; policy accept;\n")
		b.WriteString("    ip daddr 127.0.0.0/8 return\n")
		fmt.Fprintf(&b, "    meta l4proto tcp redirect to :%d\n", state.TransPort)
		if state.DNSPort > 0 {
			fmt.Fprintf(&b, "    udp dport 53 redirect to :%d\n", state.DNSPort)
			fmt.Fprintf(&b, "    tcp dport 53 redirect to :%d\n", state.DNSPort)
		}
		b.WriteString("  }\n")
	}
	b.WriteString("}\n")
	return b.String()
}

// WindowsDNSBlocks are outbound blocks for public resolvers.
// Windows Firewall block rules outrank allow rules, so this file does not
// install a global block-outbound policy. That policy is easy to leave in
// place after a crash. The gap is documented in SECURITY-AND-RELEASE.md.
func WindowsDNSBlocks() [][]string {
	targets := []string{"8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9"}
	var cmds [][]string
	for _, ip := range targets {
		for _, proto := range []string{"UDP", "TCP"} {
			for _, port := range []string{"53", "853"} {
				cmds = append(cmds, []string{
					"netsh", "advfirewall", "firewall", "add", "rule",
					"name=VEIL block " + proto + "/" + port + " " + ip,
					"dir=out", "action=block", "protocol=" + proto,
					"remoteip=" + ip, "remoteport=" + port,
				})
			}
		}
	}
	return cmds
}

// DarwinPf is a pf anchor that drops egress except the exit UDP and the utun.
func DarwinPf(state State) string {
	var b strings.Builder
	b.WriteString("set block-policy drop\n")
	if state.Mode == ModeOff {
		b.WriteString("pass out all\n")
		return b.String()
	}
	b.WriteString("block out all\n")
	b.WriteString("pass out on lo0 all\n")
	if state.Mode == ModeVeil && state.Endpoint.IsValid() {
		fmt.Fprintf(&b, "pass out proto udp to %s port %d\n", state.Endpoint.Addr(), state.Endpoint.Port())
	}
	if state.Mode == ModeVeil && state.TunnelUp && state.TunnelIface != "" {
		fmt.Fprintf(&b, "pass out on %s all\n", state.TunnelIface)
	}
	if state.Mode == ModeVeil && state.GeoExclude {
		for _, prefix := range state.ExcludedPrefixes {
			fmt.Fprintf(&b, "pass out inet proto { tcp, udp } to %s port != 53\n", prefix)
		}
	}
	return b.String()
}

func writeExcluded(b *strings.Builder, prefixes []netip.Prefix) {
	for _, prefix := range prefixes {
		family := "ip"
		if prefix.Addr().Is6() {
			family = "ip6"
		}
		fmt.Fprintf(b, "    %s daddr %s tcp dport != { 53, 853 } accept\n", family, prefix)
		fmt.Fprintf(b, "    %s daddr %s udp dport != { 53, 853 } accept\n", family, prefix)
	}
}
