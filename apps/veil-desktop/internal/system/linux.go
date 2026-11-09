//go:build linux

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
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/routeplan"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tunnel"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

// Linux installs a wireguard-go TUN, routes, and an nftables kill switch.
type Linux struct {
	engine   *tunnel.Engine
	endpoint netip.Addr
}

func New() *Linux { return &Linux{} }

func (l *Linux) ApplyVeil(ctx context.Context, cfg wgconfig.Config) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("VEIL VPN needs administrator rights to create the tunnel and the kill switch")
	}
	if err := l.Clear(ctx); err != nil {
		return app.Result{}, err
	}
	endpoint, err := resolveEndpoint(ctx, cfg)
	if err != nil {
		return app.Result{}, err
	}
	gateway, device, err := defaultRoute()
	if err != nil {
		return app.Result{}, err
	}
	port := cfg.Endpoint.Port()
	if port == 0 {
		return app.Result{}, errors.New("exit port is missing")
	}
	eng, err := tunnel.StartTUN("veil0", cfg.MTU, cfg.PrivateKey, 0, peersFor(cfg, net.JoinHostPort(endpoint.String(), uintToString(port))))
	if err != nil {
		return app.Result{}, err
	}
	l.engine = eng
	l.endpoint = endpoint
	plan, err := routeplan.Build(routeplan.Input{
		Endpoint: endpoint, EndpointPort: port, PhysicalGateway: gateway, PhysicalDevice: device,
		TunnelDevice: eng.Name(), TunnelAddress: cfg.Address, DNS: cfg.DNS,
	})
	if err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, "ip", "link", "set", eng.Name(), "up"); err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, plan.Address[0], plan.Address[1:]...); err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, plan.EndpointRoute[0], plan.EndpointRoute[1:]...); err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	state := policy.State{
		Mode: policy.ModeVeil, TunnelUp: true, TunnelIface: eng.Name(),
		Endpoint: netip.AddrPortFrom(endpoint, port), TunnelDNS: cfg.DNS,
	}
	if err := applyNft(ctx, policy.RenderNft(state)); err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	if err := run(ctx, plan.DefaultRoute[0], plan.DefaultRoute[1:]...); err != nil {
		_ = l.Clear(ctx)
		return app.Result{}, err
	}
	enforcement := "nft-fail-closed"
	if err := setDNS(ctx, eng.Name(), cfg.DNS); err != nil {
		enforcement = "nft-fail-closed-system-dns-unchanged"
	}
	return app.Result{Backend: "wireguard-go-tun", Enforcement: enforcement}, nil
}

func (l *Linux) ApplyTor(ctx context.Context, avail tor.Availability) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("Tor mode needs administrator rights for the kill switch")
	}
	if err := l.Clear(ctx); err != nil {
		return app.Result{}, err
	}
	state := policy.State{Mode: policy.ModeTor, TorSOCKSPort: portOf(avail.SOCKSAddr)}
	if avail.Transparent {
		state.TransPort = portOf(avail.TransAddr)
		state.DNSPort = portOf(avail.DNSAddr)
	}
	if err := applyNft(ctx, policy.RenderNft(state)); err != nil {
		return app.Result{}, err
	}
	kind := "nft-tor-socks-fail-closed"
	if avail.Transparent {
		kind = "nft-tor-transparent-tcp-dns"
	}
	return app.Result{Backend: "local-tor", Enforcement: kind}, nil
}

func (l *Linux) Blackhole(ctx context.Context, _ string) (app.Result, error) {
	if os.Geteuid() != 0 {
		return app.Result{}, errors.New("kill switch needs administrator rights")
	}
	if l.engine != nil {
		l.engine.Close()
		l.engine = nil
	}
	if err := applyNft(ctx, policy.RenderNft(policy.State{Mode: policy.ModeBlackhole})); err != nil {
		return app.Result{}, err
	}
	return app.Result{Backend: "none", Enforcement: "nft-blackhole"}, nil
}

func (l *Linux) Clear(ctx context.Context) error {
	_ = exec.CommandContext(ctx, "nft", "delete", "table", "inet", "veil-desktop").Run()
	if l.endpoint.IsValid() {
		_ = exec.CommandContext(ctx, "ip", "route", "del", l.endpoint.String()+"/32").Run()
		l.endpoint = netip.Addr{}
	}
	if l.engine != nil {
		l.engine.Close()
		l.engine = nil
	}
	return nil
}

func defaultRoute() (netip.Addr, string, error) {
	out, err := exec.Command("ip", "-4", "route", "show", "default").Output()
	if err != nil {
		return netip.Addr{}, "", errors.New("no IPv4 default route")
	}
	fields := strings.Fields(string(out))
	var gateway, device string
	for i := 0; i < len(fields)-1; i++ {
		if fields[i] == "via" {
			gateway = fields[i+1]
		}
		if fields[i] == "dev" && device == "" {
			device = fields[i+1]
		}
	}
	addr, err := netip.ParseAddr(gateway)
	if err != nil || device == "" {
		return netip.Addr{}, "", errors.New("could not parse the IPv4 default route")
	}
	return addr, device, nil
}

func applyNft(ctx context.Context, rules string) error {
	file, err := os.CreateTemp("", "veil-desktop-*.nft")
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
	return run(ctx, "nft", "-f", name)
}

func setDNS(ctx context.Context, iface string, dns []netip.Addr) error {
	if len(dns) == 0 {
		return errors.New("no tunnel DNS")
	}
	if _, err := exec.LookPath("resolvectl"); err != nil {
		return errors.New("resolvectl is not installed; non-tunnel DNS is still dropped")
	}
	args := []string{"dns", iface}
	for _, addr := range dns {
		args = append(args, addr.String())
	}
	if err := run(ctx, "resolvectl", args...); err != nil {
		return err
	}
	return run(ctx, "resolvectl", "domain", iface, "~.")
}

func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		text := strings.TrimSpace(string(out))
		if text == "" {
			return err
		}
		return errors.New(name + ": " + text)
	}
	return nil
}

func portOf(addr string) uint16 {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	n, err := net.LookupPort("tcp", port)
	if err != nil || n < 0 || n > 65535 {
		return 0
	}
	return uint16(n)
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
