// Copyright Infinitum Corporation.
// These tests exercise the same wireguard-go runtime the APK starts.
// They use an in-memory TUN and 127.0.0.1. They are not Android VpnService
// packet-flow proof.

package tunnel

import (
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

func TestRuntimeRoundTripIsEncrypted(t *testing.T) {
	aPriv, aPub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	bPriv, bPub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	aDev, aCh := NewChannelDevice()
	bDev, _ := NewChannelDevice()
	a := startLabRuntime(t, aPriv, bPub, "127.0.0.1:1", aDev)
	b := startLabRuntime(t, bPriv, aPub, "127.0.0.1:1", bDev)
	if err := a.SetEndpoint(ep(b.Port())); err != nil {
		t.Fatal(err)
	}
	if err := b.SetEndpoint(ep(a.Port())); err != nil {
		t.Fatal(err)
	}
	payload := []byte("VEIL-RUNTIME-ROUNDTRIP")
	pkt := udp4(payload)
	deadline := time.Now().Add(3 * time.Second)
	for !b.InnerHas(payload) {
		if time.Now().After(deadline) {
			t.Fatal("decrypted payload was not delivered")
		}
		select {
		case aCh.Outbound <- pkt:
		case <-time.After(200 * time.Millisecond):
		}
		time.Sleep(20 * time.Millisecond)
	}
	if a.ContainsPlaintext(payload) {
		t.Fatal("payload was visible on the UDP socket")
	}
	if !a.HasWireType(4) && !a.HasWireType(1) {
		t.Fatal("no WireGuard datagram was sent")
	}
	if strings.Contains(strings.ToLower(a.LogText()+b.LogText()), keyHex(aPriv)) {
		t.Fatal("private key appeared in the log")
	}
	a.Stop()
	if a.Port() != 0 {
		t.Fatal("stop left the runtime up")
	}
}

func TestRuntimeRejectsProductDomainAndUnspecifiedListen(t *testing.T) {
	priv, pub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	tunDevice, _ := NewChannelDevice()
	_, err = StartRuntime(RuntimeConfig{
		PrivateKey: priv, PeerPublic: pub, Endpoint: VPNProduct().Domain + ":51820",
		ListenIP: "127.0.0.1", TUN: tunDevice, Protect: allowProtect,
	})
	if err != ErrEndpoint {
		t.Fatalf("domain endpoint error = %v", err)
	}
	_, err = NewIfaceBind(allowProtect, "0.0.0.0", false)
	if err == nil {
		t.Fatal("host bind accepted 0.0.0.0")
	}
}

func TestRuntimeProtectFailureDoesNotSend(t *testing.T) {
	priv, pub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	tunDevice, _ := NewChannelDevice()
	_, err = StartRuntime(RuntimeConfig{
		PrivateKey: priv, PeerPublic: pub, Endpoint: "127.0.0.1:9",
		ListenIP: "127.0.0.1", TUN: tunDevice,
		Protect: func(int) error { return ErrProtectRequired },
	})
	if err == nil {
		t.Fatal("connect succeeded without protect")
	}
}

func startLabRuntime(t *testing.T, priv, peer [32]byte, endpoint string, dev tun.Device) *Runtime {
	t.Helper()
	rt, err := StartRuntime(RuntimeConfig{
		PrivateKey: priv, PeerPublic: peer, Endpoint: endpoint,
		ListenIP: "127.0.0.1", KeepaliveSeconds: 0,
		TUN: dev, Protect: allowProtect,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Stop)
	return rt
}

func ep(port int) string {
	return "127.0.0.1:" + itoaPort(uint16(port))
}

func udp4(payload []byte) []byte {
	pkt := make([]byte, 28+len(payload))
	pkt[0] = 0x45
	pkt[2] = byte(len(pkt) >> 8)
	pkt[3] = byte(len(pkt))
	pkt[8] = 64
	pkt[9] = 17
	pkt[12], pkt[13], pkt[14], pkt[15] = 10, 77, 0, 2
	pkt[16], pkt[17], pkt[18], pkt[19] = 10, 77, 0, 1
	pkt[23] = 9
	copy(pkt[28:], payload)
	return pkt
}
