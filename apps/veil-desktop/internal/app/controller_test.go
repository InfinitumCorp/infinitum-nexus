package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

type fakeApplier struct {
	veilErr      error
	torErr       error
	blackholeErr error
	cleared      int
	last         string
}

func (f *fakeApplier) ApplyVeil(context.Context, wgconfig.Config) (Result, error) {
	f.last = "veil"
	if f.veilErr != nil {
		return Result{}, f.veilErr
	}
	return Result{Backend: "test", Enforcement: "fail-closed"}, nil
}
func (f *fakeApplier) ApplyTor(context.Context, tor.Availability) (Result, error) {
	f.last = "tor"
	if f.torErr != nil {
		return Result{}, f.torErr
	}
	return Result{Backend: "tor", Enforcement: "fail-closed"}, nil
}
func (f *fakeApplier) Blackhole(context.Context, string) (Result, error) {
	f.last = "blackhole"
	if f.blackholeErr != nil {
		return Result{}, f.blackholeErr
	}
	return Result{Backend: "none", Enforcement: "blackhole"}, nil
}
func (f *fakeApplier) Clear(context.Context) error {
	f.cleared++
	return nil
}

type fakeControl struct {
	err error
	cfg wgconfig.Config
}

func (f fakeControl) Connect(context.Context, string) (wgconfig.Config, error) {
	if f.err != nil {
		return wgconfig.Config{}, f.err
	}
	return f.cfg, nil
}
func (f fakeControl) Disconnect(context.Context) error { return nil }

type fakeTor struct{ err error }

func (f fakeTor) Inspect(context.Context) (tor.Availability, error) {
	if f.err != nil {
		return tor.Availability{}, f.err
	}
	return tor.Availability{SOCKS: true, Coverage: "socks-fail-closed", HonestLimits: []string{"UDP other than DNS is dropped."}}, nil
}

func grant() wgconfig.Config {
	return wgconfig.Config{
		PrivateKey: []byte("this-is-not-a-real-key-32b!!!!"),
		Expires:    time.Now().Add(time.Minute),
	}
}

func TestVeilModeDoesNotClaimProtectionWithoutAKillSwitch(t *testing.T) {
	applier := &fakeApplier{veilErr: errors.New("no tun"), blackholeErr: errors.New("no admin")}
	ctl := New(applier, fakeControl{cfg: grant()}, fakeTor{}, "iad-1")
	if err := ctl.SetMode(context.Background(), ModeVeil); err == nil {
		t.Fatal("expected refusal")
	}
	status := ctl.Status()
	if status.Mode != "off" || status.TunnelUp || status.FailClosed {
		t.Fatalf("status %+v", status)
	}
	if strings.Contains(status.Detail, "this-is-not") {
		t.Fatal("status leaked key bytes")
	}
}

func TestVeilFailClosedWhenTheTunnelCannotStart(t *testing.T) {
	applier := &fakeApplier{veilErr: errors.New("handshake failed")}
	ctl := New(applier, fakeControl{cfg: grant()}, fakeTor{}, "iad-1")
	if err := ctl.SetMode(context.Background(), ModeVeil); err != nil {
		t.Fatal(err)
	}
	status := ctl.Status()
	if status.Mode != "veil" || status.TunnelUp || !status.FailClosed || status.Coverage != "device-blocked" {
		t.Fatalf("status %+v", status)
	}
	if applier.last != "blackhole" {
		t.Fatalf("last apply %s", applier.last)
	}
}

func TestVeilSuccessAndOff(t *testing.T) {
	applier := &fakeApplier{}
	ctl := New(applier, fakeControl{cfg: grant()}, fakeTor{}, "iad-1")
	if err := ctl.SetMode(context.Background(), ModeVeil); err != nil {
		t.Fatal(err)
	}
	status := ctl.Status()
	if !status.TunnelUp || status.Coverage != "device" || status.Enforcement != "fail-closed" || status.Backend != "test" {
		t.Fatalf("status %+v", status)
	}
	raw := status.Detail + status.Expires
	if strings.Contains(raw, "this-is-not") {
		t.Fatal("private key reached status")
	}
	if err := ctl.SetMode(context.Background(), ModeOff); err != nil {
		t.Fatal(err)
	}
	if ctl.Status().Mode != "off" || ctl.Status().KillSwitch {
		t.Fatalf("off status %+v", ctl.Status())
	}
}

func TestTorUnreachableIsFailClosed(t *testing.T) {
	applier := &fakeApplier{}
	ctl := New(applier, fakeControl{}, fakeTor{err: errors.New("down")}, "iad-1")
	if err := ctl.SetMode(context.Background(), ModeTor); err != nil {
		t.Fatal(err)
	}
	status := ctl.Status()
	if status.Mode != "tor" || status.TunnelUp || !status.FailClosed {
		t.Fatalf("status %+v", status)
	}
	if !strings.Contains(status.Detail, "did not answer") {
		t.Fatalf("detail %s", status.Detail)
	}
}

func TestControlPlaneRefusalDoesNotOpenTheNetwork(t *testing.T) {
	applier := &fakeApplier{}
	ctl := New(applier, fakeControl{err: errors.New("no entitlement")}, fakeTor{}, "iad-1")
	if err := ctl.SetMode(context.Background(), ModeVeil); err != nil {
		t.Fatal(err)
	}
	if ctl.Status().TunnelUp || applier.last != "blackhole" {
		t.Fatalf("status %+v last %s", ctl.Status(), applier.last)
	}
}
