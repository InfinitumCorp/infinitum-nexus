// Copyright Infinitum Corporation.

package tunnel

import (
	"errors"
	"net/netip"

	"github.com/InfinitumCorp/infinitum-nexus/packages/geo-dat"
)

// CaptureWithExclusions is the opt-in country hole punch. Disabled, empty, or
// unreadable input keeps the full 0.0.0.0/0 and ::/0 capture and returns no
// direct prefixes. A prefix that contains a tunnel DNS address is refused and
// the full capture is kept.
func CaptureWithExclusions(enabled bool, dat []byte, countries []string, dns []netip.Addr) (capture, direct []netip.Prefix, err error) {
	fullV4, fullV6 := CaptureRoutes()
	full := []netip.Prefix{fullV4, fullV6}
	if !enabled || len(countries) == 0 || len(dat) == 0 {
		return full, nil, nil
	}
	entries, err := geodat.ParseGeoIP(dat)
	if err != nil {
		return full, nil, err
	}
	prefixes, err := geodat.PrefixesFor(entries, countries)
	if err != nil {
		return full, nil, err
	}
	for _, prefix := range prefixes {
		for _, addr := range dns {
			if prefix.Contains(addr) {
				return full, nil, errors.New("geo exclusion contains tunnel DNS")
			}
		}
	}
	capture, direct = geodat.Capture(true, prefixes)
	return capture, direct, nil
}
