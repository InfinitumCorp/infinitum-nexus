// Copyright Infinitum Corporation.
// Process entry used by the Android VpnService. Keys are not logged.
// The product domain is not an endpoint.

package mobile

import (
	"errors"
	"os"
	"sync"

	"golang.org/x/sys/unix"
	"infinitum.local/veil/tunnel"
)

// Protector is VpnService.protect. A false result fails the socket closed.
type Protector interface {
	Protect(fd int32) bool
}

var (
	mu     sync.Mutex
	client *tunnel.Runtime
	peer   *tunnel.Runtime
)

// MintKey returns "privateHex publicHex" for a disposable test key.
// Callers must not write the result to logs or storage.
func MintKey() (string, error) {
	priv, pub, err := tunnel.MintHex()
	if err != nil {
		return "", err
	}
	return priv + " " + pub, nil
}

// Start opens the WireGuard device on a VpnService TUN fd.
// endpoint must be an IPv4 host:port. The product domain is refused.
// The fd is duplicated; the caller still owns the original descriptor.
func Start(tunFd int32, privateKeyHex, peerPublicHex, endpoint, localCIDR string, keepalive int32, protector Protector) (int32, error) {
	if localCIDR == "" {
		return 0, errors.New("local address is required")
	}
	priv, err := tunnel.ParseHexKey(privateKeyHex)
	if err != nil {
		return 0, err
	}
	pub, err := tunnel.ParseHexKey(peerPublicHex)
	if err != nil {
		return 0, err
	}
	dup, err := unix.Dup(int(tunFd))
	if err != nil {
		return 0, err
	}
	file := os.NewFile(uintptr(dup), "veil0")
	listen, unspecified := tunnel.DeviceListenIP()
	dev := tunnel.NewFDTUN(file, 1280)
	rt, err := tunnel.StartRuntime(tunnel.RuntimeConfig{
		PrivateKey: priv, PeerPublic: pub, Endpoint: endpoint,
		ListenIP: listen, AllowUnspecifiedListen: unspecified,
		KeepaliveSeconds: int(keepalive), TUN: dev, Protect: adapt(protector),
	})
	if err != nil {
		file.Close()
		return 0, err
	}
	mu.Lock()
	if client != nil {
		mu.Unlock()
		rt.Stop()
		return 0, errors.New("tunnel is already connected")
	}
	client = rt
	mu.Unlock()
	return int32(rt.Port()), nil
}

// SetClientPeer moves the device tunnel's peer to an IPv4 literal.
func SetClientPeer(endpoint string) error {
	mu.Lock()
	rt := client
	mu.Unlock()
	if rt == nil {
		return errors.New("tunnel is not connected")
	}
	return rt.SetEndpoint(endpoint)
}

// ClientHandshakeUnix is 0 until a handshake completes.
func ClientHandshakeUnix() int64 {
	mu.Lock()
	rt := client
	mu.Unlock()
	if rt == nil {
		return 0
	}
	return rt.HandshakeUnix()
}

// ClientUp reports whether the device tunnel is running.
func ClientUp() bool {
	mu.Lock()
	defer mu.Unlock()
	return client != nil
}

// StopClient tears the device tunnel down.
func StopClient() {
	mu.Lock()
	rt := client
	client = nil
	mu.Unlock()
	if rt != nil {
		rt.Stop()
	}
}

// PeerStart runs an in-process peer on a channel TUN. Tests use it as the
// disposable other end. It is not a provisioned server.
func PeerStart(privateKeyHex, peerPublicHex, endpoint string, keepalive int32, protector Protector) (int32, error) {
	priv, err := tunnel.ParseHexKey(privateKeyHex)
	if err != nil {
		return 0, err
	}
	pub, err := tunnel.ParseHexKey(peerPublicHex)
	if err != nil {
		return 0, err
	}
	dev, _ := tunnel.NewChannelDevice()
	listen, unspecified := tunnel.DeviceListenIP()
	rt, err := tunnel.StartRuntime(tunnel.RuntimeConfig{
		PrivateKey: priv, PeerPublic: pub, Endpoint: endpoint,
		ListenIP: listen, AllowUnspecifiedListen: unspecified,
		KeepaliveSeconds: int(keepalive), TUN: dev, Protect: adapt(protector),
	})
	if err != nil {
		return 0, err
	}
	mu.Lock()
	if peer != nil {
		mu.Unlock()
		rt.Stop()
		return 0, errors.New("peer is already running")
	}
	peer = rt
	mu.Unlock()
	return int32(rt.Port()), nil
}

// SetInprocessPeer moves the in-process peer's remote endpoint.
func SetInprocessPeer(endpoint string) error {
	mu.Lock()
	rt := peer
	mu.Unlock()
	if rt == nil {
		return errors.New("peer is not running")
	}
	return rt.SetEndpoint(endpoint)
}

// StopPeer stops the in-process peer.
func StopPeer() {
	mu.Lock()
	rt := peer
	peer = nil
	mu.Unlock()
	if rt != nil {
		rt.Stop()
	}
}

// PeerHas reports whether the in-process peer decrypted payload.
func PeerHas(payload []byte) bool {
	mu.Lock()
	rt := peer
	mu.Unlock()
	if rt == nil {
		return false
	}
	return rt.InnerHas(payload)
}

// WireHasPlaintext reports whether the device tunnel sent payload in the clear.
func WireHasPlaintext(payload []byte) bool {
	mu.Lock()
	rt := client
	mu.Unlock()
	if rt == nil {
		return false
	}
	return rt.ContainsPlaintext(payload)
}

// Dropped is the number of non-IPv4 packets the device tunnel discarded.
func Dropped() int64 {
	mu.Lock()
	rt := client
	mu.Unlock()
	if rt == nil {
		return 0
	}
	return int64(rt.Dropped())
}

func adapt(protector Protector) func(int) error {
	return func(fd int) error {
		if protector == nil || !protector.Protect(int32(fd)) {
			return tunnel.ErrProtectRequired
		}
		return nil
	}
}
