//go:build linux

package system

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

func TestApplyVeilNeedsAdministrator(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root")
	}
	_, err := New().ApplyVeil(context.Background(), wgconfig.Config{})
	if err == nil || !strings.Contains(err.Error(), "administrator") {
		t.Fatalf("err %v", err)
	}
}
