package geo

import (
	"path/filepath"
	"testing"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/geosetting"
)

func TestDisabledSwitchDoesNotReadGeoData(t *testing.T) {
	dir := t.TempDir()
	config := filepath.Join(dir, "geo-routing.json")
	dat := filepath.Join(dir, "missing.dat")
	if prefixes := ActivePrefixes(config, dat); prefixes != nil {
		t.Fatalf("missing settings returned %v", prefixes)
	}
	if _, err := geosetting.Resolve(config, []string{"--geo-routing"}, ""); err != nil {
		t.Fatal(err)
	}
	if prefixes := ActivePrefixes(config, dat); prefixes != nil {
		t.Fatalf("enabled switch with no countries returned %v", prefixes)
	}
}
