package policy

import (
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func veilState(up bool) State {
	return State{
		Mode:        ModeVeil,
		TunnelUp:    up,
		TunnelIface: "veil0",
		Endpoint:    netip.MustParseAddrPort("203.0.113.10:51820"),
		TunnelDNS:   []netip.Addr{netip.MustParseAddr("10.64.0.1")},
	}
}

func TestKillSwitchDropsPublicDNSAndPhysicalTraffic(t *testing.T) {
	up := veilState(true)
	down := veilState(false)
	cases := []struct {
		name string
		st   State
		pkt  Packet
		want Decision
	}{
		{"off allows", State{Mode: ModeOff}, Packet{Proto: "udp", Dst: netip.MustParseAddr("8.8.8.8"), DstPort: 53}, Allow},
		{"endpoint udp", up, Packet{Proto: "udp", Dst: netip.MustParseAddr("203.0.113.10"), DstPort: 51820}, Allow},
		{"endpoint tcp is not the handshake", up, Packet{Proto: "tcp", Dst: netip.MustParseAddr("203.0.113.10"), DstPort: 51820}, Drop},
		{"tunnel dns", up, Packet{OutIface: "veil0", Proto: "udp", Dst: netip.MustParseAddr("10.64.0.1"), DstPort: 53}, Allow},
		{"public dns on tunnel", up, Packet{OutIface: "veil0", Proto: "udp", Dst: netip.MustParseAddr("8.8.8.8"), DstPort: 53}, Drop},
		{"public dns on physical", up, Packet{OutIface: "eth0", Proto: "udp", Dst: netip.MustParseAddr("1.1.1.1"), DstPort: 53}, Drop},
		{"web via tunnel", up, Packet{OutIface: "veil0", Proto: "tcp", Dst: netip.MustParseAddr("203.0.113.50"), DstPort: 443}, Allow},
		{"web via physical", up, Packet{OutIface: "eth0", Proto: "tcp", Dst: netip.MustParseAddr("203.0.113.50"), DstPort: 443}, Drop},
		{"down blocks web", down, Packet{OutIface: "eth0", Proto: "tcp", Dst: netip.MustParseAddr("203.0.113.50"), DstPort: 443}, Drop},
		{"down still allows handshake", down, Packet{Proto: "udp", Dst: netip.MustParseAddr("203.0.113.10"), DstPort: 51820}, Allow},
		{"blackhole drops endpoint", State{Mode: ModeBlackhole}, Packet{Proto: "udp", Dst: netip.MustParseAddr("203.0.113.10"), DstPort: 51820}, Drop},
		{"tor socks", State{Mode: ModeTor, TorSOCKSPort: 9050}, Packet{Proto: "tcp", Dst: netip.MustParseAddr("127.0.0.1"), DstPort: 9050}, Allow},
		{"tor blocks direct", State{Mode: ModeTor, TorSOCKSPort: 9050, TransPort: 9040, DNSPort: 5353}, Packet{Proto: "tcp", Dst: netip.MustParseAddr("203.0.113.50"), DstPort: 443}, Drop},
		{"tor allows transparent", State{Mode: ModeTor, TransPort: 9040}, Packet{Proto: "tcp", Dst: netip.MustParseAddr("127.0.0.1"), DstPort: 9040}, Allow},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Decide(tc.st, tc.pkt); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

func TestNftSyntaxWhenAvailable(t *testing.T) {
	nft, err := exec.LookPath("nft")
	if err != nil {
		t.Skip("nft is not installed")
	}
	rules := RenderNft(veilState(true))
	if !strings.Contains(rules, "policy drop") || !strings.Contains(rules, "203.0.113.10") {
		t.Fatalf("rules missing fail-closed clauses:\n%s", rules)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "veil.nft")
	if err := os.WriteFile(path, []byte(rules), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(nft, "-c", "-f", path).CombinedOutput()
	if err != nil {
		text := string(out)
		if strings.Contains(text, "Operation not permitted") || strings.Contains(text, "Permission denied") {
			t.Skip("nft check needs CAP_NET_ADMIN; the namespace test applies the rules as root")
		}
		t.Fatalf("nft rejected the ruleset: %v\n%s", err, out)
	}
}

func TestWindowsAndDarwinRenderersDoNotAllowPublicDNS(t *testing.T) {
	for _, cmd := range WindowsDNSBlocks() {
		line := strings.Join(cmd, " ")
		if !strings.Contains(line, "action=block") || !strings.Contains(line, "remoteport=53") && !strings.Contains(line, "remoteport=853") {
			t.Fatalf("unexpected windows rule %s", line)
		}
	}
	pf := DarwinPf(veilState(true))
	if !strings.Contains(pf, "block out all") || !strings.Contains(pf, "pass out on veil0") {
		t.Fatalf("pf rules:\n%s", pf)
	}
}
