package tray

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

type allow struct{}

func (allow) ApplyVeil(context.Context, wgconfig.Config) (app.Result, error) {
	return app.Result{Backend: "test", Enforcement: "fail-closed"}, nil
}
func (allow) ApplyTor(context.Context, tor.Availability) (app.Result, error) {
	return app.Result{}, nil
}
func (allow) Blackhole(context.Context, string) (app.Result, error) {
	return app.Result{Enforcement: "blackhole"}, nil
}
func (allow) Clear(context.Context) error { return nil }

type control struct{}

func (control) Connect(context.Context, string) (wgconfig.Config, error) {
	return wgconfig.Config{}, nil
}
func (control) Disconnect(context.Context) error { return nil }

func TestMenuSwitchesVeilThenOff(t *testing.T) {
	ctl := app.New(allow{}, control{}, nil, "iad-1")
	var out bytes.Buffer
	err := RunConsole(context.Background(), ctl, strings.NewReader("veil\nstatus\noff\nquit\n"), &out)
	if err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.Contains(text, "mode=veil") || !strings.Contains(text, "coverage=device") || !strings.Contains(text, "mode=off") {
		t.Fatalf("menu output:\n%s", text)
	}
	if strings.Contains(text, "privateKey") {
		t.Fatal("menu printed a private key")
	}
}

func TestParse(t *testing.T) {
	cmd, err := Parse("  VPN ")
	if err != nil || cmd != CommandVeil {
		t.Fatalf("%s %v", cmd, err)
	}
}
