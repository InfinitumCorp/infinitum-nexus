package tunnel

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

func TestControlPlaneFixture(t *testing.T) {
	dir := os.Getenv("VEIL_FIXTURE_DIR")
	if dir == "" {
		t.Skip("set by scripts/integration-test.sh")
	}
	clientRaw, err := os.ReadFile(filepath.Join(dir, "client.json"))
	if err != nil {
		t.Fatal(err)
	}
	serverRaw, err := os.ReadFile(filepath.Join(dir, "server.json"))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := wgconfig.ParseGrant(clientRaw)
	if err != nil {
		t.Fatal(err)
	}
	defer cfg.Wipe()
	var server struct {
		PrivateKey    string `json:"privateKey"`
		ListenPort    int    `json:"listenPort"`
		PeerPublicKey string `json:"peerPublicKey"`
		PeerAddress   string `json:"peerAddress"`
	}
	if err := json.Unmarshal(serverRaw, &server); err != nil {
		t.Fatal(err)
	}
	serverPriv, err := base64.StdEncoding.DecodeString(server.PrivateKey)
	if err != nil || len(serverPriv) != 32 {
		t.Fatal("exit private key from the fixture is invalid")
	}
	peerPub, err := base64.StdEncoding.DecodeString(server.PeerPublicKey)
	if err != nil || len(peerPub) != 32 {
		t.Fatal("client public key from the fixture is invalid")
	}
	exit, err := StartNetstack(netip.MustParseAddr("10.64.0.1"), cfg.DNS, cfg.MTU, serverPriv, server.ListenPort, []wgconfig.Peer{{
		PublicKey: peerPub, AllowedIPs: []string{server.PeerAddress},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer exit.Close()
	client, err := StartNetstack(cfg.Address.Addr(), cfg.DNS, cfg.MTU, cfg.PrivateKey, 0, []wgconfig.Peer{
		cfg.ClientPeer(net.JoinHostPort(cfg.Endpoint.Addr().String(), strconv.Itoa(int(cfg.Endpoint.Port())))),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ln, err := exit.Net().ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.64.0.1"), Port: 4242})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 32)
		n, _ := conn.Read(buf)
		_, _ = conn.Write(buf[:n])
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var last error
	for ctx.Err() == nil {
		dialCtx, cancelDial := context.WithTimeout(ctx, 2*time.Second)
		conn, err := client.Net().DialContextTCPAddrPort(dialCtx, netip.MustParseAddrPort("10.64.0.1:4242"))
		cancelDial()
		if err != nil {
			last = err
			time.Sleep(200 * time.Millisecond)
			continue
		}
		_, _ = conn.Write([]byte("veil-control-plane"))
		buf := make([]byte, 32)
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		n, err := conn.Read(buf)
		conn.Close()
		if err == nil && string(buf[:n]) == "veil-control-plane" {
			return
		}
		last = err
	}
	if last == nil {
		t.Fatal("control-plane tunnel did not carry a payload")
	}
	t.Fatal(last)
}
