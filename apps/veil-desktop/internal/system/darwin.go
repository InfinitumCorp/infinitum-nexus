//go:build darwin

package system

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strings"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/policy"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tunnel"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

// Darwin uses wireguard-go on utun. This is the device-wide path that can be
// cross-compiled. The signed NetworkExtension app is macos/PacketTunnel and is
// the build that App Store and notarized distribution require.
type Darwin struct {
	engine *tunnel.Engine
	iface  string
}

func New() *Darwin { return &Darwin{} }

func (d *Darwin) ApplyVeil(ctx context.Context, cfg wgconfig.Config) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("VEIL VPN needs root for utun, routes, and pf")
	}
	_ = d.Clear(ctx)
	endpoint, err := resolveEndpoint(ctx, cfg)
	if err != nil {
		return app.Result{}, err
	}
	eng, err := tunnel.StartTUN("veil", cfg.MTU, cfg.PrivateKey, 0, peersFor(cfg, net.JoinHostPort(endpoint.String(), uintToString(cfg.Endpoint.Port()))))
	if err != nil {
		return app.Result{}, err
	}
	d.engine = eng
	d.iface = eng.Name()
	addr := cfg.Address.Addr().String()
	if err := run(ctx, "ifconfig", d.iface, "inet", addr, addr, "up"); err != nil {
		_ = d.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, "route", "-n", "add", "-host", endpoint.String(), "gateway", defaultGateway(ctx)); err != nil {
		_ = d.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, "route", "-n", "add", "-net", "0.0.0.0/1", "-interface", d.iface); err != nil {
		_ = d.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, "route", "-n", "add", "-net", "128.0.0.0/1", "-interface", d.iface); err != nil {
		_ = d.Clear(ctx)
		return app.Result{}, err
	}
	state := policy.State{
		Mode: policy.ModeVeil, TunnelUp: true, TunnelIface: d.iface,
		Endpoint: netip.AddrPortFrom(endpoint, cfg.Endpoint.Port()), TunnelDNS: cfg.DNS,
	}
	if err := applyPf(ctx, policy.DarwinPf(state)); err != nil {
		_ = d.Clear(ctx)
		return app.Result{}, err
	}
	for _, service := range []string{"Wi-Fi", "Ethernet"} {
		_ = exec.CommandContext(ctx, "networksetup", "-setdnsservers", service, cfg.DNS[0].String()).Run()
	}
	return app.Result{Backend: "wireguard-go-utun", Enforcement: "pf-fail-closed"}, nil
}

func (d *Darwin) ApplyTor(ctx context.Context, avail tor.Availability) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("Tor mode needs root for pf")
	}
	host, port, err := net.SplitHostPort(avail.SOCKSAddr)
	if err != nil {
		return app.Result{}, err
	}
	for _, service := range []string{"Wi-Fi", "Ethernet"} {
		_ = exec.CommandContext(ctx, "networksetup", "-setsocksfirewallproxy", service, host, port).Run()
		_ = exec.CommandContext(ctx, "networksetup", "-setsocksfirewallproxystate", service, "on").Run()
	}
	if err := applyPf(ctx, policy.DarwinPf(policy.State{Mode: policy.ModeBlackhole})); err != nil {
		return app.Result{}, err
	}
	return app.Result{Backend: "local-tor", Enforcement: "pf-and-system-socks"}, nil
}

func (d *Darwin) Blackhole(ctx context.Context, _ string) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("kill switch needs root")
	}
	if d.engine != nil {
		d.engine.Close()
		d.engine = nil
	}
	if err := applyPf(ctx, policy.DarwinPf(policy.State{Mode: policy.ModeBlackhole})); err != nil {
		return app.Result{}, err
	}
	return app.Result{Backend: "none", Enforcement: "pf-blackhole"}, nil
}

func (d *Darwin) Clear(ctx context.Context) error {
	_ = exec.CommandContext(ctx, "pfctl", "-a", "veil-desktop", "-F", "all").Run()
	if d.engine != nil {
		d.engine.Close()
		d.engine = nil
	}
	for _, service := range []string{"Wi-Fi", "Ethernet"} {
		_ = exec.CommandContext(ctx, "networksetup", "-setsocksfirewallproxystate", service, "off").Run()
	}
	return nil
}

func applyPf(ctx context.Context, rules string) error {
	file, err := os.CreateTemp("", "veil-desktop-*.pf")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err := file.WriteString(rules); err != nil {
		file.Close()
		return err
	}
	file.Close()
	return run(ctx, "pfctl", "-a", "veil-desktop", "-f", name)
}

func defaultGateway(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, "route", "-n", "get", "default").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "gateway:" {
			return fields[1]
		}
	}
	return ""
}

func run(ctx context.Context, name string, args ...string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if text == "" {
			return err
		}
		return errors.New(name + ": " + text)
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
