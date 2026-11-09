package wgconfig

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func b64(fill byte) string {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func sampleGrant() string {
	return `{
		"coverage":"device",
		"deviceWide":true,
		"browserOnly":false,
		"dns":"through-tunnel",
		"killSwitch":"fail-closed",
		"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `",
		"interface":{
			"privateKey":"` + b64(1) + `",
			"publicKey":"` + b64(2) + `",
			"address":"10.64.0.2/32",
			"dns":["10.64.0.1"],
			"mtu":1280
		},
		"peer":{
			"publicKey":"` + b64(3) + `",
			"endpoint":"203.0.113.10:51820",
			"allowedIps":["0.0.0.0/0","::/0"],
			"persistentKeepalive":25
		}
	}`
}

func TestParseGrantFullTunnel(t *testing.T) {
	cfg, err := ParseGrant([]byte(sampleGrant()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Endpoint.String() != "203.0.113.10:51820" {
		t.Fatalf("endpoint %s", cfg.Endpoint)
	}
	if strings.Contains(cfg.Redacted(), b64(1)) {
		t.Fatal("redacted status contains key material")
	}
	uapi, err := cfg.UAPI(0, []Peer{cfg.ClientPeer(cfg.Endpoint.String())})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(uapi, "allowed_ip=0.0.0.0/0\n") || !strings.Contains(uapi, "allowed_ip=::/0\n") {
		t.Fatalf("uapi missing full tunnel:\n%s", uapi)
	}
	cfg.Wipe()
	for _, b := range cfg.PrivateKey {
		if b != 0 {
			t.Fatal("private key was not wiped")
		}
	}
}

func TestParseGrantRejectsLeaks(t *testing.T) {
	cases := map[string]string{
		"public dns":      strings.Replace(sampleGrant(), `["10.64.0.1"]`, `["8.8.8.8"]`, 1),
		"split tunnel":    strings.Replace(sampleGrant(), `["0.0.0.0/0","::/0"]`, `["0.0.0.0/1"]`, 1),
		"browser grant":   strings.Replace(sampleGrant(), `"deviceWide":true`, `"deviceWide":false`, 1),
		"link local":      strings.Replace(sampleGrant(), "203.0.113.10:51820", "169.254.1.1:51820", 1),
		"gateway address": strings.Replace(sampleGrant(), "10.64.0.2/32", "10.64.0.1/32", 1),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseGrant([]byte(raw)); err == nil {
				t.Fatal("expected refusal")
			}
		})
	}
}
