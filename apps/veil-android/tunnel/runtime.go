// Copyright Infinitum Corporation.
// Runtime is the wireguard-go device the Android process starts on a
// VpnService TUN. Host tests of this type use an in-memory TUN and are not
// Android packet-flow proof.

package tunnel

import (
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"sync"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/tuntest"
)

var ErrHandshakeTimeout = errors.New("handshake did not complete")

// RuntimeConfig is one WireGuard peer. Endpoint is an IPv4 literal, never the
// product domain. ListenIP is 127.0.0.1 in host tests.
type RuntimeConfig struct {
	PrivateKey [32]byte
	PeerPublic [32]byte
	Endpoint   string
	ListenIP   string
	// AllowUnspecifiedListen is true only for the device process, which
	// listens on 0.0.0.0 inside the phone or emulator.
	AllowUnspecifiedListen bool
	KeepaliveSeconds       int
	TUN                    tun.Device
	Protect                func(fd int) error
}

// Runtime is one running wireguard-go device.
type Runtime struct {
	mu     sync.Mutex
	dev    *device.Device
	bind   *ifaceBind
	policy *policyTUN
	log    *memLog
	peer   [32]byte
	port   int
	inner  [][]byte
	done   chan struct{}
}

// StartRuntime brings the device up. It does not install host routes.
func StartRuntime(cfg RuntimeConfig) (*Runtime, error) {
	if err := validateDevicePeer(cfg.Endpoint); err != nil {
		return nil, err
	}
	if cfg.PrivateKey == ([32]byte{}) || cfg.PeerPublic == ([32]byte{}) {
		return nil, ErrPrivateKey
	}
	if cfg.TUN == nil {
		return nil, errors.New("TUN is required")
	}
	if cfg.KeepaliveSeconds < 0 || cfg.KeepaliveSeconds > 65535 {
		return nil, errors.New("keepalive is invalid")
	}
	bind, err := NewIfaceBind(cfg.Protect, cfg.ListenIP, cfg.AllowUnspecifiedListen)
	if err != nil {
		return nil, err
	}
	logs := &memLog{}
	logs.addSecret(keyHex(cfg.PrivateKey))
	policy := newPolicyTUN(cfg.TUN)
	dev := device.NewDevice(policy, bind, logs.logger())
	uapi := strings.Join([]string{
		"private_key=" + keyHex(cfg.PrivateKey),
		"listen_port=0",
		"replace_peers=true",
		"public_key=" + keyHex(cfg.PeerPublic),
		"endpoint=" + cfg.Endpoint,
		"protocol_version=1",
		"replace_allowed_ips=true",
		"allowed_ip=0.0.0.0/0",
		"persistent_keepalive_interval=" + strconv.Itoa(cfg.KeepaliveSeconds),
		"",
	}, "\n")
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	port, err := portFromAddr(bind.localAddr())
	if err != nil {
		dev.Close()
		return nil, err
	}
	rt := &Runtime{
		dev: dev, bind: bind, policy: policy, log: logs, peer: cfg.PeerPublic, port: port,
		done: make(chan struct{}),
	}
	if ch, ok := cfg.TUN.(interface{ InboundChan() <-chan []byte }); ok {
		go rt.collect(ch.InboundChan())
	}
	return rt, nil
}

// ChannelDevice is a tun.Device that also exposes decrypted packets.
type channelDevice struct {
	tun.Device
	in <-chan []byte
}

func (c channelDevice) InboundChan() <-chan []byte { return c.in }

// NewChannelDevice returns an in-memory TUN for a test peer.
func NewChannelDevice() (tun.Device, *tuntest.ChannelTUN) {
	ch := tuntest.NewChannelTUN()
	return channelDevice{Device: ch.TUN(), in: ch.Inbound}, ch
}

func (r *Runtime) collect(in <-chan []byte) {
	r.mu.Lock()
	done := r.done
	r.mu.Unlock()
	for {
		select {
		case <-done:
			return
		case pkt, ok := <-in:
			if !ok {
				return
			}
			cp := append([]byte(nil), pkt...)
			r.mu.Lock()
			if len(r.inner) < 32 {
				r.inner = append(r.inner, cp)
			}
			r.mu.Unlock()
		}
	}
}

// SetEndpoint moves the peer to another IPv4 literal.
func (r *Runtime) SetEndpoint(endpoint string) error {
	if err := validateDevicePeer(endpoint); err != nil {
		return err
	}
	r.mu.Lock()
	dev := r.dev
	peer := r.peer
	r.mu.Unlock()
	if dev == nil {
		return ErrDown
	}
	uapi := "public_key=" + keyHex(peer) + "\nendpoint=" + endpoint + "\n"
	return dev.IpcSet(uapi)
}

// Stop closes the device and its UDP socket.
func (r *Runtime) Stop() {
	r.mu.Lock()
	dev := r.dev
	r.dev = nil
	done := r.done
	r.done = nil
	r.mu.Unlock()
	if done != nil {
		close(done)
	}
	if dev != nil {
		dev.Close()
	}
}

// Port is the UDP port, or 0 after Stop.
func (r *Runtime) Port() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dev == nil {
		return 0
	}
	return r.port
}

// HandshakeUnix is the peer's last handshake time in unix seconds, or 0.
// The UAPI blob that carries it also contains the private key and is not logged.
func (r *Runtime) HandshakeUnix() int64 {
	r.mu.Lock()
	dev := r.dev
	r.mu.Unlock()
	if dev == nil {
		return 0
	}
	text, err := dev.IpcGet()
	if err != nil {
		return 0
	}
	var sec int64
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "last_handshake_time_sec=") {
			continue
		}
		sec, _ = strconv.ParseInt(strings.TrimPrefix(line, "last_handshake_time_sec="), 10, 64)
	}
	return sec
}

// ContainsPlaintext reports whether an inner payload was sent in the clear.
func (r *Runtime) ContainsPlaintext(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	r.mu.Lock()
	bind := r.bind
	r.mu.Unlock()
	if bind == nil {
		return false
	}
	for _, frame := range bind.packets() {
		if bytesContains(frame, payload) {
			return true
		}
	}
	return false
}

// HasWireType reports whether a sent datagram has the WireGuard message type.
func (r *Runtime) HasWireType(kind uint32) bool {
	r.mu.Lock()
	bind := r.bind
	r.mu.Unlock()
	if bind == nil {
		return false
	}
	for _, frame := range bind.packets() {
		if MessageType(frame) == kind {
			return true
		}
	}
	return false
}

// TakeInner returns one decrypted packet, if the runtime owns a channel TUN.
func (r *Runtime) TakeInner() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.inner) == 0 {
		return nil
	}
	pkt := r.inner[0]
	r.inner = r.inner[1:]
	return pkt
}

// InnerHas reports whether any decrypted packet contains payload.
func (r *Runtime) InnerHas(payload []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, pkt := range r.inner {
		if bytesContains(pkt, payload) {
			return true
		}
	}
	return false
}

// Dropped counts packets that were not encapsulated.
func (r *Runtime) Dropped() uint64 {
	r.mu.Lock()
	policy := r.policy
	r.mu.Unlock()
	if policy == nil {
		return 0
	}
	return policy.dropped.Load()
}

// LogText is the redacted error log.
func (r *Runtime) LogText() string {
	r.mu.Lock()
	logs := r.log
	r.mu.Unlock()
	if logs == nil {
		return ""
	}
	return logs.text()
}

func bytesContains(hay, needle []byte) bool {
	return len(needle) > 0 && len(hay) >= len(needle) && indexBytes(hay, needle) >= 0
}

func indexBytes(hay, needle []byte) int {
	for i := 0; i+len(needle) <= len(hay); i++ {
		match := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// ParseHexKey decodes a 32-byte hex key. The error does not echo the input.
func ParseHexKey(text string) ([32]byte, error) {
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != 32 {
		return [32]byte{}, ErrPrivateKey
	}
	var key [32]byte
	copy(key[:], raw)
	return key, nil
}
