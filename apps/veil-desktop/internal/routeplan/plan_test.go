package routeplan

import (
	"net/netip"
	"strings"
	"testing"
)

func TestEndpointRouteStaysPhysical(t *testing.T) {
	plan, err := Build(Input{
		Endpoint:        netip.MustParseAddr("203.0.113.10"),
		EndpointPort:    51820,
		PhysicalGateway: netip.MustParseAddr("192.0.2.1"),
		PhysicalDevice:  "eth0",
		TunnelDevice:    "veil0",
		TunnelAddress:   netip.MustParsePrefix("10.64.0.2/32"),
		DNS:             []netip.Addr{netip.MustParseAddr("10.64.0.1")},
	})
	if err != nil {
		t.Fatal(err)
	}
	endpoint := strings.Join(plan.EndpointRoute, " ")
	if !strings.Contains(endpoint, "dev eth0") || strings.Contains(endpoint, "veil0") {
		t.Fatalf("endpoint route %s", endpoint)
	}
	if !strings.Contains(strings.Join(plan.DefaultRoute, " "), "dev veil0") {
		t.Fatal("default route is not the tunnel")
	}
	if !plan.DNSInTunnel {
		t.Fatal("DNS was given a physical route")
	}
}

func TestRejectsTunnelExitAddress(t *testing.T) {
	_, err := Build(Input{
		Endpoint:        netip.MustParseAddr("10.64.0.9"),
		PhysicalGateway: netip.MustParseAddr("192.0.2.1"),
		PhysicalDevice:  "eth0",
		TunnelDevice:    "veil0",
		TunnelAddress:   netip.MustParsePrefix("10.64.0.2/32"),
		DNS:             []netip.Addr{netip.MustParseAddr("8.8.8.8")},
	})
	if err == nil {
		t.Fatal("expected refusal")
	}
}
