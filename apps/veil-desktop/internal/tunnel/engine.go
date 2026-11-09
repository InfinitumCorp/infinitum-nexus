// Package tunnel runs WireGuard in userspace (wireguard-go, MIT).
// Netstack mode stays inside the process and is what the tests exercise.
// TUN mode is the device-wide path on Linux, macOS utun, and Windows wintun.
package tunnel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

// Engine is one WireGuard device. Close releases it.
type Engine struct {
	dev  *device.Device
	name string
	net  *netstack.Net
}

func (e *Engine) Name() string { return e.name }

func (e *Engine) Net() *netstack.Net { return e.net }

func (e *Engine) Close() {
	if e != nil && e.dev != nil {
		e.dev.Close()
	}
}

// ReplacePeers swaps the peer list. The private key stays on the device.
func (e *Engine) ReplacePeers(peers []wgconfig.Peer) error {
	if e == nil || e.dev == nil {
		return errors.New("tunnel is not up")
	}
	var b strings.Builder
	b.WriteString("replace_peers=true\n")
	for _, peer := range peers {
		if len(peer.PublicKey) != 32 {
			return errors.New("peer public key is invalid")
		}
		fmt.Fprintf(&b, "public_key=%s\n", hex.EncodeToString(peer.PublicKey))
		if peer.Endpoint != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", peer.Endpoint)
		}
		for _, cidr := range peer.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", cidr)
		}
	}
	if err := e.dev.IpcSet(b.String()); err != nil {
		return errors.New("wireguard peer update rejected")
	}
	return nil
}

func (e *Engine) Down() error {
	if e == nil || e.dev == nil {
		return errors.New("tunnel is not up")
	}
	return e.dev.Down()
}

func (e *Engine) ListenPort() (int, error) {
	raw, err := e.dev.IpcGet()
	if err != nil {
		return 0, errors.New("could not read tunnel state")
	}
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "listen_port=") {
			return strconv.Atoi(strings.TrimPrefix(line, "listen_port="))
		}
	}
	return 0, errors.New("listen port is missing")
}

// StartNetstack builds a userspace TCP/IP stack over WireGuard. No host route changes.
func StartNetstack(addr netip.Addr, dns []netip.Addr, mtu int, private []byte, listen int, peers []wgconfig.Peer) (*Engine, error) {
	if mtu == 0 {
		mtu = 1280
	}
	if len(dns) == 0 {
		dns = []netip.Addr{netip.MustParseAddr("10.64.0.1")}
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, dns, mtu)
	if err != nil {
		return nil, err
	}
	eng, err := start(tunDev, "netstack", mtu, private, listen, peers)
	if err != nil {
		return nil, err
	}
	eng.net = tnet
	return eng, nil
}

// StartTUN opens a host tunnel device. The caller installs addresses, routes, and the kill switch.
func StartTUN(name string, mtu int, private []byte, listen int, peers []wgconfig.Peer) (*Engine, error) {
	if mtu == 0 {
		mtu = 1280
	}
	tunDev, err := tun.CreateTUN(name, mtu)
	if err != nil {
		return nil, err
	}
	real := name
	if got, err := tunDev.Name(); err == nil && got != "" {
		real = got
	}
	return start(tunDev, real, mtu, private, listen, peers)
}

func start(tunDev tun.Device, name string, mtu int, private []byte, listen int, peers []wgconfig.Peer) (*Engine, error) {
	_ = mtu
	logger := device.NewLogger(device.LogLevelSilent, "veil")
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	uapi, err := (&wgconfig.Config{PrivateKey: private}).UAPI(listen, peers)
	if err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, errors.New("wireguard configuration rejected")
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &Engine{dev: dev, name: name}, nil
}

// SelfTest carries a payload through two in-process WireGuard peers, then proves
// the client dial fails after the device is taken down.
func SelfTest(ctx context.Context) error {
	serverPriv, serverPub, err := NewKey()
	if err != nil {
		return err
	}
	clientPriv, clientPub, err := NewKey()
	if err != nil {
		return err
	}
	port, err := freeUDP()
	if err != nil {
		return err
	}
	server, err := StartNetstack(netip.MustParseAddr("10.64.0.1"), nil, 1280, serverPriv, port, []wgconfig.Peer{{
		PublicKey: clientPub, AllowedIPs: []string{"10.64.0.2/32"},
	}})
	if err != nil {
		return err
	}
	defer server.Close()
	client, err := StartNetstack(netip.MustParseAddr("10.64.0.2"), nil, 1280, clientPriv, 0, []wgconfig.Peer{{
		PublicKey: serverPub, Endpoint: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		AllowedIPs: []string{"0.0.0.0/0", "::/0"}, Keepalive: 25,
	}})
	if err != nil {
		return err
	}
	defer client.Close()
	ln, err := server.Net().ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.64.0.1"), Port: 4242})
	if err != nil {
		return err
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	const payload = "veil-tunnel-ok"
	var last error
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		dialCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		conn, err := client.Net().DialContextTCPAddrPort(dialCtx, netip.MustParseAddrPort("10.64.0.1:4242"))
		cancel()
		if err != nil {
			last = err
			time.Sleep(200 * time.Millisecond)
			continue
		}
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.WriteString(conn, payload); err != nil {
			conn.Close()
			last = err
			continue
		}
		buf := make([]byte, len(payload))
		if _, err := io.ReadFull(conn, buf); err != nil {
			conn.Close()
			last = err
			continue
		}
		conn.Close()
		if string(buf) != payload {
			return errors.New("tunnel payload mismatch")
		}
		if err := client.Down(); err != nil {
			return err
		}
		downCtx, cancelDown := context.WithTimeout(ctx, time.Second)
		_, err = client.Net().DialContextTCPAddrPort(downCtx, netip.MustParseAddrPort("10.64.0.1:4242"))
		cancelDown()
		if err == nil {
			return errors.New("dial succeeded after the tunnel was taken down")
		}
		return nil
	}
	if last == nil {
		last = errors.New("tunnel did not carry a payload")
	}
	return last
}

// NewKey returns a clamped Curve25519 WireGuard key pair.
func NewKey() (private, public []byte, err error) {
	private = make([]byte, 32)
	if _, err = rand.Read(private); err != nil {
		return nil, nil, err
	}
	private[0] &= 248
	private[31] = (private[31] & 127) | 64
	public, err = curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return nil, nil, err
	}
	return private, public, nil
}

// HexKey is for diagnostics that must not be logged by default.
func HexKey(key []byte) string { return hex.EncodeToString(key) }

func freeUDP() (int, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return 0, errors.New("udp address")
	}
	return addr.Port, nil
}

// WrongKeyFails proves a bad exit key does not fall back to a cleartext dial.
func WrongKeyFails(ctx context.Context) error {
	_, serverPub, err := NewKey()
	if err != nil {
		return err
	}
	clientPriv, _, err := NewKey()
	if err != nil {
		return err
	}
	bad := append([]byte(nil), serverPub...)
	bad[0] ^= 0xff
	port, err := freeUDP()
	if err != nil {
		return err
	}
	client, err := StartNetstack(netip.MustParseAddr("10.64.0.2"), nil, 1280, clientPriv, 0, []wgconfig.Peer{{
		PublicKey: bad, Endpoint: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		AllowedIPs: []string{"0.0.0.0/0", "::/0"},
	}})
	if err != nil {
		return err
	}
	defer client.Close()
	dialCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	conn, err := client.Net().DialContextTCPAddrPort(dialCtx, netip.MustParseAddrPort("10.64.0.1:9"))
	if err == nil {
		conn.Close()
		return errors.New("wrong key still connected")
	}
	return nil
}

// Describe returns a one-line result for build logs. It contains no keys.
func Describe(ctx context.Context) string {
	if err := SelfTest(ctx); err != nil {
		return "userspace tunnel failed: " + err.Error()
	}
	if err := WrongKeyFails(ctx); err != nil {
		return "userspace tunnel fail-closed check failed: " + err.Error()
	}
	return "userspace wireguard-go carried veil-tunnel-ok and blocked a dial after Down"
}
