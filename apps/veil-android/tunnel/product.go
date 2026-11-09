// Copyright Infinitum Corporation.
// Product identity only. This file must not grow a peer, a key, or a dialer.

package tunnel

// ProductStatusLabOnly is the only status this tree may report.
// No tunnel service is running and no production peer is configured.
const ProductStatusLabOnly = "lab-only"

// VPNProduct is the canonical VEIL VPN product record.
// Domain is the name William assigned on 2026-11-07 (17:51 MSK).
// Host records where that name is hosted. It is not a WireGuard endpoint,
// not a resolver, and not a promise that Android VpnService exists yet.
//
// infinitumveil.app is the separate browser product and is not this domain.
func VPNProduct() Product {
	return Product{
		Name:         "VEIL VPN",
		Domain:       "infinitumveilvpn.app",
		Host:         "Cloudflare",
		Status:       ProductStatusLabOnly,
		DistinctFrom: "infinitumveil.app",
	}
}

// Product is documented configuration. It has no endpoint, key, or socket.
type Product struct {
	Name         string
	Domain       string
	Host         string
	Status       string
	DistinctFrom string
}
