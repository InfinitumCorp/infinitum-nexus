//go:build windows

package system

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"strings"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/policy"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tunnel"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
	"golang.org/x/sys/windows"
)

// Windows uses wireguard-go on a Wintun adapter. Wintun is loaded from wintun.dll
// beside the executable. The full Windows Filtering Platform kill switch is not
// applied: a global block-outbound policy survives a crash. DNS to public
// resolvers is blocked and the default route is the tunnel.
type Windows struct {
	engine   *tunnel.Engine
	endpoint string
}

func New() *Windows { return &Windows{} }

func (w *Windows) ApplyVeil(ctx context.Context, cfg wgconfig.Config) (app.Result, error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return app.Result{}, errors.New("VEIL VPN needs an elevated process for Wintun and routes")
	}
	_ = w.Clear(ctx)
	endpoint, err := resolveEndpoint(ctx, cfg)
	if err != nil {
		return app.Result{}, err
	}
	eng, err := tunnel.StartTUN("VEIL", cfg.MTU, cfg.PrivateKey, 0, peersFor(cfg, net.JoinHostPort(endpoint.String(), uintToString(cfg.Endpoint.Port()))))
	if err != nil {
		return app.Result{}, err
	}
	w.engine = eng
	gw, err := physicalGateway(ctx)
	if err != nil {
		_ = w.Clear(ctx)
		return app.Result{}, err
	}
	addr := cfg.Address.Addr().String()
	dns := cfg.DNS[0].String()
	w.endpoint = endpoint.String()
	commands := [][]string{
		{"netsh", "interface", "ipv4", "set", "address", "name=VEIL", "source=static", "addr=" + addr, "mask=255.255.255.255"},
		{"netsh", "interface", "ipv4", "set", "dnsservers", "name=VEIL", "source=static", "addr=" + dns, "validate=no"},
		{"route", "add", endpoint.String(), "mask", "255.255.255.255", gw},
		{"route", "add", "0.0.0.0", "mask", "128.0.0.0", dns, "metric", "1"},
		{"route", "add", "128.0.0.0", "mask", "128.0.0.0", dns, "metric", "1"},
	}
	commands = append(commands, policy.WindowsDNSBlocks()...)
	for _, cmd := range commands {
		if err := run(ctx, cmd[0], cmd[1:]...); err != nil {
			_ = w.Clear(ctx)
			return app.Result{}, err
		}
	}
	return app.Result{Backend: "wireguard-go-wintun", Enforcement: "route-and-dns-block"}, nil
}

func (w *Windows) ApplyTor(ctx context.Context, avail tor.Availability) (app.Result, error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return app.Result{}, errors.New("Tor mode needs an elevated process")
	}
	host, port, err := net.SplitHostPort(avail.SOCKSAddr)
	if err != nil {
		return app.Result{}, errors.New("tor socks address is invalid")
	}
	commands := [][]string{
		{"reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"},
		{"reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyServer", "/d", "socks=" + host + ":" + port, "/f"},
	}
	commands = append(commands, policy.WindowsDNSBlocks()...)
	for _, cmd := range commands {
		if err := run(ctx, cmd[0], cmd[1:]...); err != nil {
			return app.Result{}, err
		}
	}
	kind := "system-proxy-socks-and-dns-block"
	if !avail.Transparent {
		kind += "-not-transparent"
	}
	return app.Result{Backend: "local-tor", Enforcement: kind}, nil
}

func (w *Windows) Blackhole(ctx context.Context, _ string) (app.Result, error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return app.Result{}, errors.New("kill switch needs an elevated process")
	}
	if w.engine != nil {
		w.engine.Close()
		w.engine = nil
	}
	for _, cmd := range policy.WindowsDNSBlocks() {
		if err := run(ctx, cmd[0], cmd[1:]...); err != nil {
			return app.Result{}, err
		}
	}
	return app.Result{Backend: "none", Enforcement: "dns-block-only"}, nil
}

func (w *Windows) Clear(context.Context) error {
	if w.engine != nil {
		w.engine.Close()
		w.engine = nil
	}
	if w.endpoint != "" {
		_ = exec.Command("route", "delete", w.endpoint).Run()
		w.endpoint = ""
	}
	_ = exec.Command("route", "delete", "0.0.0.0", "mask", "128.0.0.0").Run()
	_ = exec.Command("route", "delete", "128.0.0.0", "mask", "128.0.0.0").Run()
	_ = exec.Command("reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f").Run()
	return nil
}

func physicalGateway(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "route", "print", "-4").Output()
	if err != nil {
		return "", errors.New("could not read the IPv4 route table")
	}
	return parseWindowsDefaultGateway(string(out))
}

func run(ctx context.Context, name string, args ...string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if text == "" {
			return err
		}
		return errors.New(text)
	}
	return nil
}

func uintToString(n uint16) string {
	if n == 0 {
		return "0"
	}
	var buf [5]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
