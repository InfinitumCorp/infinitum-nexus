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

func TestDisabledGeoExclusionKeepsTheDefaultRoute(t *testing.T) {
	in := Input{
		Endpoint:        netip.MustParseAddr("203.0.113.10"),
		PhysicalGateway: netip.MustParseAddr("192.0.2.1"),
		PhysicalDevice:  "eth0",
		TunnelDevice:    "veil0",
		TunnelAddress:   netip.MustParsePrefix("10.64.0.2/32"),
		DNS:             []netip.Addr{netip.MustParseAddr("10.64.0.1")},
		Excluded:        []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")},
	}
	plan, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.DirectRoutes) != 0 || !plan.DNSInTunnel {
		t.Fatalf("disabled plan grew direct routes: %+v", plan.DirectRoutes)
	}
	in.GeoExclude = true
	plan, err = Build(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.DirectRoutes) != 1 || !strings.Contains(strings.Join(plan.DirectRoutes[0], " "), "dev eth0") {
		t.Fatalf("direct routes = %v", plan.DirectRoutes)
	}
	if !strings.Contains(strings.Join(plan.DefaultRoute, " "), "dev veil0") || !plan.DNSInTunnel {
		t.Fatal("the tunnel stopped being the default or DNS left it")
	}
	in.Excluded = []netip.Prefix{netip.MustParsePrefix("10.64.0.0/16")}
	if _, err := Build(in); err == nil {
		t.Fatal("an exclusion containing tunnel DNS was installed")
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
