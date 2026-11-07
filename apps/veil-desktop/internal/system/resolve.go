package system

import (
	"context"
	"errors"
	"net"
	"net/netip"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

func resolveEndpoint(ctx context.Context, cfg wgconfig.Config) (netip.Addr, error) {
	addr := cfg.Endpoint.Addr()
	if addr.IsValid() && !addr.IsUnspecified() {
		return addr, nil
	}
	if cfg.EndpointDNS == "" {
		return netip.Addr{}, errors.New("exit endpoint is missing")
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", cfg.EndpointDNS)
	if err != nil || len(ips) == 0 {
		return netip.Addr{}, errors.New("exit DNS lookup failed")
	}
	return ips[0], nil
}

func peersFor(cfg wgconfig.Config, endpoint string) []wgconfig.Peer {
	return []wgconfig.Peer{cfg.ClientPeer(endpoint)}
}
