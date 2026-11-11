// Package geo turns the saved geo-routing switch into country prefixes.
// The switch defaults off. A disabled switch does not read geoip.dat.
package geo

import (
	"net/netip"
	"os"
	"path/filepath"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/geosetting"
	"github.com/InfinitumCorp/infinitum-nexus/packages/geo-dat"
)

func DefaultDatPath() string {
	if path := os.Getenv("VEIL_GEOIP_PATH"); path != "" {
		return path
	}
	return filepath.Join("data", "geo", "geoip.dat")
}

// ActivePrefixes returns country prefixes only when the switch is on, a
// country list is saved, and geoip.dat parses. Any problem returns nil so
// the tunnel stays a full capture.
func ActivePrefixes(configPath, datPath string) []netip.Prefix {
	if configPath == "" {
		return nil
	}
	file, exists, err := geosetting.Load(configPath)
	if err != nil || !exists || !file.Enabled || len(file.Countries) == 0 {
		return nil
	}
	raw, err := os.ReadFile(datPath)
	if err != nil {
		return nil
	}
	entries, err := geodat.ParseGeoIP(raw)
	if err != nil {
		return nil
	}
	prefixes, err := geodat.PrefixesFor(entries, file.Countries)
	if err != nil {
		return nil
	}
	return prefixes
}
