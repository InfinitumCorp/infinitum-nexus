package system

import "testing"

func TestParseWindowsDefaultGateway(t *testing.T) {
	text := `
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.23     25
        192.168.1.0    255.255.255.0         On-link     192.168.1.23    281
`
	got, err := parseWindowsDefaultGateway(text)
	if err != nil || got != "192.168.1.1" {
		t.Fatalf("got %q err %v", got, err)
	}
	if _, err := parseWindowsDefaultGateway("no routes"); err == nil {
		t.Fatal("expected an error")
	}
}
