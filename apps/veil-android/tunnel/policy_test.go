// Copyright Infinitum Corporation.

package tunnel

import (
	"net/netip"
	"os"
	"strings"
	"testing"
)

func TestProfileRejectsPublicDNSAndAcceptsTunnelDNS(t *testing.T) {
	ok := LabProfile()
	if err := ValidateProfile(ok); err != nil {
		t.Fatal(err)
	}
	if ok.DNS == nil || ok.DNS.String() != "10.77.0.1" {
		t.Fatalf("lab DNS = %v", ok.DNS)
	}

	public := ok
	resolver := netip.MustParseAddr("8.8.8.8")
	public.DNS = &resolver
	if err := ValidateProfile(public); err != ErrPublicDNS {
		t.Fatalf("public DNS error = %v", err)
	}

	outside := ok
	other := netip.MustParseAddr("192.0.2.10")
	outside.DNS = &other
	if err := ValidateProfile(outside); err != ErrDNS {
		t.Fatalf("outside DNS error = %v", err)
	}

	wide := ok
	wide.TunnelNet = netip.MustParsePrefix("0.0.0.0/0")
	if err := ValidateProfile(wide); err != ErrTunnelNet {
		t.Fatalf("default route as tunnel net error = %v", err)
	}

	none := ok
	none.DNS = nil
	if err := ValidateProfile(none); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointRejectsHostnamesIPv6AndPublicAddresses(t *testing.T) {
	if err := ValidateEndpoint("127.0.0.1:51820"); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{
		"dns.example:51820",
		"[::1]:51820",
		"203.0.113.10:51820",
		"127.0.0.1:0",
		VPNProduct().Domain,
		VPNProduct().Domain + ":51820",
	} {
		if err := ValidateEndpoint(endpoint); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
}

func TestFilterDropsIPv6(t *testing.T) {
	v4 := tunPacket()
	if err := FilterPacket(v4); err != nil {
		t.Fatal(err)
	}
	v6 := make([]byte, 40)
	v6[0] = 0x60
	if err := FilterPacket(v6); err != ErrUnsupportedPacket {
		t.Fatalf("ipv6 error = %v", err)
	}
}

func TestCaptureRoutesAreFullTunnel(t *testing.T) {
	v4, v6 := CaptureRoutes()
	if v4.String() != "0.0.0.0/0" || v6.String() != "::/0" {
		t.Fatalf("capture routes = %s %s", v4, v6)
	}
}

func TestProductDomainIsMetadataNotAnEndpoint(t *testing.T) {
	product := VPNProduct()
	if product.Domain != "infinitumveilvpn.app" || product.Host != "Cloudflare" {
		t.Fatalf("product = %+v", product)
	}
	if product.Status != ProductStatusLabOnly {
		t.Fatalf("status = %s", product.Status)
	}
	if product.DistinctFrom != "infinitumveil.app" || product.Domain == product.DistinctFrom {
		t.Fatalf("browser domain collided with VPN domain: %+v", product)
	}
	if err := ValidateEndpoint("https://infinitumveil.app"); err == nil {
		t.Fatal("browser host accepted as a VPN peer")
	}
	if err := ValidateEndpoint(product.Domain + ":51820"); err != ErrEndpoint {
		t.Fatalf("product domain as peer error = %v", err)
	}
	session := NewSession()
	if err := session.SetPeer([32]byte{}, product.Domain+":51820"); err != ErrEndpoint {
		t.Fatalf("SetPeer error = %v", err)
	}
	if session.Listening() || session.Connected() {
		t.Fatal("metadata lookup opened a session")
	}
	bindSrc, err := os.ReadFile("bind.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bindSrc), product.Domain) || !strings.Contains(string(bindSrc), "127.0.0.1") {
		t.Fatal("loopback bind no longer stays on 127.0.0.1")
	}
	if LabProfile().DNS == nil || LabProfile().DNS.String() != "10.77.0.1" {
		t.Fatal("lab DNS changed away from the tunnel prefix")
	}
}

func TestRedactRemovesPrivateKey(t *testing.T) {
	secret := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	line := redact("unable to update bind key="+secret, []string{secret, strings.ToUpper(secret)})
	if strings.Contains(line, secret) || !strings.Contains(line, "[redacted]") {
		t.Fatalf("redacted line = %q", line)
	}
}

func tunPacket() []byte {
	return []byte{
		0x45, 0, 0, 20,
		0, 0, 0, 0,
		64, 1, 0, 0,
		10, 77, 0, 2,
		10, 77, 0, 1,
	}
}
