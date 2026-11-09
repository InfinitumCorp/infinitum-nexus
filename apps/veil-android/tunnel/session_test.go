// Copyright Infinitum Corporation.

package tunnel

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun/tuntest"
)

func TestRoundTripIsWireGuardNotCleartext(t *testing.T) {
	a, b, aKey := testPair(t)
	pkt := tuntest.Ping(netip.MustParseAddr("10.77.0.1"), netip.MustParseAddr("10.77.0.2"))
	if err := a.SendFromOS(pkt); err != nil {
		t.Fatal(err)
	}
	got := recv(t, b, 3*time.Second)
	if !bytes.Equal(got, pkt) {
		t.Fatalf("inner packet changed\n got %x\nwant %x", got, pkt)
	}

	wire := a.WirePackets()
	if len(wire) == 0 {
		t.Fatal("no UDP payload was sent")
	}
	var sawHandshake, sawTransport bool
	for _, frame := range wire {
		if bytes.Contains(frame, pkt) {
			t.Fatal("inner packet was visible on the UDP socket")
		}
		switch MessageType(frame) {
		case 1:
			sawHandshake = true
		case 4:
			sawTransport = true
		}
	}
	if !sawHandshake || !sawTransport {
		t.Fatalf("wire types handshake=%v transport=%v", sawHandshake, sawTransport)
	}
	if strings.Contains(strings.ToLower(a.LogText()+b.LogText()), keyHex(aKey)) {
		t.Fatal("private key appeared in the log")
	}
	if !a.Listening() || !strings.HasPrefix(a.LocalAddr(), "127.0.0.1:") {
		t.Fatalf("listener = %s", a.LocalAddr())
	}
}

func TestWrongPeerFailsClosed(t *testing.T) {
	_, peerPub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	a := newLabSession(t)
	b := newLabSession(t)
	if err := a.SetPeer(peerPub, fmt.Sprintf("127.0.0.1:%d", b.Port())); err != nil {
		t.Fatal(err)
	}
	pkt := tuntest.Ping(netip.MustParseAddr("10.77.0.1"), netip.MustParseAddr("10.77.0.2"))
	if err := a.SendFromOS(pkt); err != nil {
		t.Fatal(err)
	}
	expectNone(t, b, 500*time.Millisecond)
	for _, frame := range a.WirePackets() {
		if bytes.Contains(frame, pkt) {
			t.Fatal("failed handshake sent the inner packet in the clear")
		}
	}
}

func TestProtectFailureFailsClosed(t *testing.T) {
	key, _, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := NewSession()
	t.Cleanup(func() { s.Disconnect() })
	_, err = s.Connect(Config{
		PrivateKey: key,
		Profile:    LabProfile(),
		Protect:    func(int) error { return errors.New("protect rejected") },
	})
	if err == nil {
		t.Fatal("connect succeeded without protect")
	}
	if s.Connected() || s.Listening() || s.Port() != 0 {
		t.Fatalf("connected=%v listening=%v port=%d", s.Connected(), s.Listening(), s.Port())
	}
	logText := strings.ToLower(s.LogText())
	if strings.Contains(logText, keyHex(key)) {
		t.Fatal("private key appeared in the protect-failure log")
	}
	if !strings.Contains(logText, "protect rejected") && !strings.Contains(logText, "unable to update bind") {
		t.Fatalf("protect failure was not logged: %q", s.LogText())
	}
}

func TestMissingProtectDoesNotListen(t *testing.T) {
	key, _, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := NewSession()
	_, err = s.Connect(Config{PrivateKey: key, Profile: LabProfile(), Protect: nil})
	if !errors.Is(err, ErrProtectRequired) {
		t.Fatalf("error = %v", err)
	}
	if s.Listening() {
		t.Fatal("listener opened without protect")
	}
}

func TestDisconnectAndSecondConnect(t *testing.T) {
	a, b, _ := testPair(t)
	pkt := tuntest.Ping(netip.MustParseAddr("10.77.0.1"), netip.MustParseAddr("10.77.0.2"))
	if err := a.SendFromOS(pkt); err != nil {
		t.Fatal(err)
	}
	_ = recv(t, b, 3*time.Second)

	port := a.Port()
	_, err := a.Connect(Config{PrivateKey: mustKey(t), Profile: LabProfile(), Protect: allowProtect})
	if !errors.Is(err, ErrAlreadyConnected) {
		t.Fatalf("second connect = %v", err)
	}
	if a.Port() != port {
		t.Fatalf("port changed from %d to %d", port, a.Port())
	}

	if err := a.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if err := a.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if a.Connected() || a.Listening() {
		t.Fatal("disconnect left the socket up")
	}
	if err := a.SendFromOS(pkt); !errors.Is(err, ErrDown) {
		t.Fatalf("send after disconnect = %v", err)
	}
	expectNone(t, b, 200*time.Millisecond)
}

func TestIPv6IsDiscardedAndIPv4StillFlows(t *testing.T) {
	a, b, _ := testPair(t)
	v6 := make([]byte, 40)
	v6[0] = 0x60
	if err := a.SendFromOS(v6); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for a.Dropped() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("IPv6 packet was not discarded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	expectNone(t, b, 200*time.Millisecond)
	for _, frame := range a.WirePackets() {
		if bytes.Contains(frame, v6) {
			t.Fatal("IPv6 header was encapsulated")
		}
	}

	pkt := tuntest.Ping(netip.MustParseAddr("10.77.0.1"), netip.MustParseAddr("10.77.0.2"))
	if err := a.SendFromOS(pkt); err != nil {
		t.Fatal(err)
	}
	if got := recv(t, b, 3*time.Second); !bytes.Equal(got, pkt) {
		t.Fatal("IPv4 stopped flowing after an IPv6 discard")
	}
}

func TestCleartextDatagramIsNotDelivered(t *testing.T) {
	_, b, _ := testPair(t)
	pkt := tuntest.Ping(netip.MustParseAddr("10.77.0.2"), netip.MustParseAddr("10.77.0.1"))
	conn, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: b.Port()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write(pkt); err != nil {
		t.Fatal(err)
	}
	expectNone(t, b, 300*time.Millisecond)
}

func TestNonLoopbackPeerIsRefused(t *testing.T) {
	s := newLabSession(t)
	_, pub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	err = s.SetPeer(pub, "203.0.113.10:51820")
	if !errors.Is(err, ErrEndpointNotLoopback) {
		t.Fatalf("error = %v", err)
	}
	if len(s.WirePackets()) != 0 {
		t.Fatal("refused peer still sent datagrams")
	}
}

func testPair(t *testing.T) (a, b *Session, aKey [32]byte) {
	t.Helper()
	aKey, aPub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	bKey, bPub, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	a = connectLab(t, aKey)
	b = connectLab(t, bKey)
	if err := a.SetPeer(bPub, fmt.Sprintf("127.0.0.1:%d", b.Port())); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPeer(aPub, fmt.Sprintf("127.0.0.1:%d", a.Port())); err != nil {
		t.Fatal(err)
	}
	return a, b, aKey
}

func newLabSession(t *testing.T) *Session {
	t.Helper()
	key, _, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	return connectLab(t, key)
}

func connectLab(t *testing.T, key [32]byte) *Session {
	t.Helper()
	s := NewSession()
	t.Cleanup(func() { s.Disconnect() })
	if _, err := s.Connect(Config{PrivateKey: key, Profile: LabProfile(), Protect: allowProtect}); err != nil {
		t.Fatal(err)
	}
	return s
}

func mustKey(t *testing.T) [32]byte {
	t.Helper()
	key, _, err := generateKey()
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func allowProtect(fd int) error {
	if fd < 0 {
		return errors.New("invalid fd")
	}
	return nil
}

func recv(t *testing.T, s *Session, wait time.Duration) []byte {
	t.Helper()
	ch := s.ToOS()
	if ch == nil {
		t.Fatal("no delivery channel")
	}
	select {
	case pkt := <-ch:
		return pkt
	case <-time.After(wait):
		t.Fatal("timed out waiting for the inner packet")
	}
	return nil
}

func expectNone(t *testing.T, s *Session, wait time.Duration) {
	t.Helper()
	ch := s.ToOS()
	if ch == nil {
		t.Fatal("no delivery channel")
	}
	select {
	case pkt := <-ch:
		t.Fatalf("unexpected inner packet %x", pkt)
	case <-time.After(wait):
	}
}
