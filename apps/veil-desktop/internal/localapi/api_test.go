package localapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
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
	return app.Result{Backend: "tor", Enforcement: "fail-closed"}, nil
}
func (allow) Blackhole(context.Context, string) (app.Result, error) {
	return app.Result{Backend: "none", Enforcement: "blackhole"}, nil
}
func (allow) Clear(context.Context) error { return nil }

type control struct{}

func (control) Connect(context.Context, string) (wgconfig.Config, error) {
	return wgconfig.Config{}, nil
}
func (control) Disconnect(context.Context) error { return nil }

func TestLoopbackModeSwitch(t *testing.T) {
	srv, err := New(app.New(allow{}, control{}, nil, "iad-1"))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := srv.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go http.Serve(ln, srv.Handler())
	url := "http://" + ln.Addr().String() + "/mode"
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(`{"mode":"veil"}`)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(`{"mode":"veil"}`)))
	req.Header.Set("authorization", "Bearer "+srv.Token())
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var status app.Status
	if err := json.NewDecoder(res.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Mode != "veil" || !status.TunnelUp || status.Coverage != "device" {
		t.Fatalf("status %+v", status)
	}
	if _, ok := ln.Addr().(*net.TCPAddr); !ok || ln.Addr().(*net.TCPAddr).IP.String() != "127.0.0.1" {
		t.Fatalf("bound %s", ln.Addr())
	}
}
