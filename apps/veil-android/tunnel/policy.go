// Copyright Infinitum Corporation.
// Packet policy only. Cryptography stays in wireguard-go.

package tunnel

import (
	"errors"
	"net/netip"
)

var (
	ErrTunnelNet           = errors.New("tunnel prefix must be an IPv4 network from /16 to /32")
	ErrDNS                 = errors.New("DNS must be an IPv4 address inside the tunnel prefix")
	ErrPublicDNS           = errors.New("public DNS resolvers are not used")
	ErrEndpoint            = errors.New("peer endpoint must be an IPv4 host:port")
	ErrEndpointNotLoopback = errors.New("this lab build accepts only a loopback peer")
	ErrUnsupportedPacket   = errors.New("only IPv4 packets are encapsulated")
)

// CaptureV4 and CaptureV6 are the routes a later VpnService builder must
// install so the device cannot bypass the tunnel. IPv6 is captured and then
// discarded until an IPv6 peer exists. These values are not installed on the
// host running the lab tests.
func CaptureRoutes() (v4, v6 netip.Prefix) {
	return netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")
}

// LabProfile is the private-lab addressing used by the acceptance tests.
func LabProfile() Profile {
	dns := netip.MustParseAddr("10.77.0.1")
	return Profile{
		TunnelNet: netip.MustParsePrefix("10.77.0.0/24"),
		DNS:       &dns,
	}
}

// Profile is the addressing contract shared by the lab and a future service.
type Profile struct {
	TunnelNet netip.Prefix
	DNS       *netip.Addr
}

// ValidateProfile accepts a tunnel-internal DNS address and nothing else.
// A nil DNS means the service must not install a resolver.
func ValidateProfile(p Profile) error {
	netw := p.TunnelNet.Masked()
	if !netw.IsValid() || !netw.Addr().Is4() {
		return ErrTunnelNet
	}
	bits := netw.Bits()
	addr := netw.Addr()
	if bits < 16 || bits > 32 || addr.IsUnspecified() || addr.IsLoopback() || addr.IsMulticast() {
		return ErrTunnelNet
	}
	if p.DNS == nil {
		return nil
	}
	dns := *p.DNS
	if !dns.IsValid() || !dns.Is4() || dns.IsUnspecified() || dns.IsLoopback() || dns.IsMulticast() {
		return ErrDNS
	}
	if publicResolver(dns) {
		return ErrPublicDNS
	}
	if !netw.Contains(dns) {
		return ErrDNS
	}
	return nil
}

func publicResolver(addr netip.Addr) bool {
	switch addr.String() {
	case "8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "208.67.222.222", "208.67.220.220":
		return true
	default:
		return false
	}
}

// ValidateEndpoint rejects hostnames, IPv6, and any non-loopback peer.
// Non-loopback is a limit of this lab build so the tests cannot dial out.
func ValidateEndpoint(endpoint string) error {
	addr, err := netip.ParseAddrPort(endpoint)
	if err != nil || !addr.Addr().Is4() || addr.Port() == 0 {
		return ErrEndpoint
	}
	if !addr.Addr().IsLoopback() {
		return ErrEndpointNotLoopback
	}
	return nil
}

// FilterPacket reports whether an inner packet may be encapsulated.
// IPv6 and truncated packets are discarded by the caller.
func FilterPacket(pkt []byte) error {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return ErrUnsupportedPacket
	}
	return nil
}
