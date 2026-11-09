//go:build linux

package tunnel

import (
	"context"
	"net"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

func TestSystemTUNWireGuardPing(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to create a TUN device")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	serverPriv, serverPub, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	clientPriv, clientPub, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	port, err := freeUDP()
	if err != nil {
		t.Fatal(err)
	}
	server, err := StartTUN("veilts", 1280, serverPriv, port, []wgconfig.Peer{{
		PublicKey: clientPub, AllowedIPs: []string{"10.200.90.2/32"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := StartTUN("veiltc", 1280, clientPriv, 0, []wgconfig.Peer{{
		PublicKey:  serverPub,
		Endpoint:   net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		AllowedIPs: []string{"10.200.90.1/32"},
		Keepalive:  25,
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	steps := [][]string{
		{"ip", "link", "set", server.Name(), "up"},
		{"ip", "link", "set", client.Name(), "up"},
		{"ip", "addr", "replace", "10.200.90.1/32", "dev", server.Name()},
		{"ip", "addr", "replace", "10.200.90.2/32", "dev", client.Name()},
		{"ip", "route", "replace", "10.200.90.2/32", "dev", server.Name()},
		{"ip", "route", "replace", "10.200.90.1/32", "dev", client.Name()},
	}
	for _, step := range steps {
		if out, err := exec.CommandContext(ctx, step[0], step[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %v %s", step, err, out)
		}
	}
	defer exec.Command("ip", "route", "del", "10.200.90.1/32").Run()
	defer exec.Command("ip", "route", "del", "10.200.90.2/32").Run()
	var last []byte
	var pingErr error
	for i := 0; i < 5; i++ {
		last, pingErr = exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", "-I", "10.200.90.2", "10.200.90.1").CombinedOutput()
		if pingErr == nil {
			t.Logf("system TUN ping ok via %s -> %s", client.Name(), server.Name())
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("ping across wireguard TUN failed: %v %s", pingErr, last)
}
