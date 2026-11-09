// Package routeplan builds host routes that keep the WireGuard handshake on the
// physical NIC and send everything else, including DNS, into the tunnel.
package routeplan

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

type Input struct {
	Endpoint        netip.Addr
	EndpointPort    uint16
	PhysicalGateway netip.Addr
	PhysicalDevice  string
	TunnelDevice    string
	TunnelAddress   netip.Prefix
	DNS             []netip.Addr
}

type Plan struct {
	EndpointRoute []string
	Address       []string
	DefaultRoute  []string
	DNSInTunnel   bool
}

func Build(in Input) (Plan, error) {
	if !in.Endpoint.IsValid() || in.Endpoint.IsUnspecified() {
		return Plan{}, errors.New("exit address is required before routes change")
	}
	if !in.PhysicalGateway.IsValid() || in.PhysicalDevice == "" || in.TunnelDevice == "" {
		return Plan{}, errors.New("physical gateway and device names are required")
	}
	if in.PhysicalDevice == in.TunnelDevice {
		return Plan{}, errors.New("tunnel device must be distinct from the physical device")
	}
	pool, _ := netip.ParsePrefix("10.64.0.0/16")
	if pool.Contains(in.Endpoint) {
		return Plan{}, errors.New("exit address must not be inside the tunnel pool")
	}
	for _, dns := range in.DNS {
		if !pool.Contains(dns) {
			return Plan{}, errors.New("DNS is not inside the tunnel")
		}
	}
	endpoint := in.Endpoint.String()
	plan := Plan{
		EndpointRoute: []string{"ip", "route", "replace", endpoint + "/32", "via", in.PhysicalGateway.String(), "dev", in.PhysicalDevice},
		Address:       []string{"ip", "address", "replace", in.TunnelAddress.String(), "dev", in.TunnelDevice},
		DefaultRoute:  []string{"ip", "route", "replace", "default", "dev", in.TunnelDevice, "metric", "10"},
		DNSInTunnel:   true,
	}
	if strings.Contains(strings.Join(plan.EndpointRoute, " "), in.TunnelDevice) {
		return Plan{}, errors.New("endpoint route must stay on the physical device")
	}
	return plan, nil
}

func Format(args []string) string { return fmt.Sprint(args) }
