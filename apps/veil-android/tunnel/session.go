// Copyright Infinitum Corporation.
// Session runs wireguard-go over a loopback UDP bind and an in-memory TUN.
// Bringing the TUN up is not the test. A packet has to cross as WireGuard.

package tunnel

import (
	"encoding/binary"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/tuntest"
)

var (
	ErrAlreadyConnected = errors.New("tunnel is already connected")
	ErrDown             = errors.New("tunnel is not connected")
	ErrSendTimeout      = errors.New("tunnel did not accept the packet")
)

// Config is one side of a lab tunnel. PrivateKey is WireGuard's X25519 key.
type Config struct {
	PrivateKey [32]byte
	Profile    Profile
	Protect    func(fd int) error
}

// NewSession returns a disconnected peer.
func NewSession() *Session { return &Session{} }

// Session is one WireGuard peer.
type Session struct {
	mu      sync.Mutex
	dev     *device.Device
	channel *tuntest.ChannelTUN
	policy  *policyTUN
	bind    *loopbackBind
	log     *memLog
	port    int
}

// Connect starts the device. It does not install host routes.
func (s *Session) Connect(cfg Config) (int, error) {
	if err := ValidateProfile(cfg.Profile); err != nil {
		return 0, err
	}
	if cfg.Protect == nil {
		return 0, ErrProtectRequired
	}
	if cfg.PrivateKey == ([32]byte{}) {
		return 0, ErrPrivateKey
	}

	s.mu.Lock()
	if s.dev != nil {
		s.mu.Unlock()
		return 0, ErrAlreadyConnected
	}
	s.mu.Unlock()

	logs := &memLog{}
	logs.addSecret(keyHex(cfg.PrivateKey))
	s.mu.Lock()
	s.log = logs
	s.mu.Unlock()

	bind := newLoopbackBind(cfg.Protect)
	channel := tuntest.NewChannelTUN()
	policy := newPolicyTUN(channel.TUN())
	dev := device.NewDevice(policy, bind, logs.logger())

	uapi := "private_key=" + keyHex(cfg.PrivateKey) + "\nlisten_port=0\n"
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return 0, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return 0, err
	}
	port, err := portFromAddr(bind.localAddr())
	if err != nil {
		dev.Close()
		return 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dev != nil {
		dev.Close()
		return 0, ErrAlreadyConnected
	}
	s.dev = dev
	s.channel = channel
	s.policy = policy
	s.bind = bind
	s.log = logs
	s.port = port
	return port, nil
}

// SetPeer installs the single lab peer. The endpoint has to be loopback.
func (s *Session) SetPeer(publicKey [32]byte, endpoint string) error {
	if err := ValidateEndpoint(endpoint); err != nil {
		return err
	}
	s.mu.Lock()
	dev := s.dev
	s.mu.Unlock()
	if dev == nil {
		return ErrDown
	}
	uapi := strings.Join([]string{
		"replace_peers=true",
		"public_key=" + keyHex(publicKey),
		"endpoint=" + endpoint,
		"protocol_version=1",
		"replace_allowed_ips=true",
		"allowed_ip=0.0.0.0/0",
		"",
	}, "\n")
	return dev.IpcSet(uapi)
}

// Disconnect closes the device and its loopback socket.
func (s *Session) Disconnect() error {
	s.mu.Lock()
	dev := s.dev
	s.dev = nil
	s.port = 0
	s.mu.Unlock()
	if dev == nil {
		return nil
	}
	dev.Close()
	return nil
}

// Connected reports whether Connect has succeeded and Disconnect has not.
func (s *Session) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dev != nil
}

// Port is the loopback UDP port, or 0 when disconnected.
func (s *Session) Port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.port
}

// SendFromOS submits an inner packet, as a TUN read would on Android.
func (s *Session) SendFromOS(pkt []byte) error {
	s.mu.Lock()
	ch := s.fromOS()
	s.mu.Unlock()
	if ch == nil {
		return ErrDown
	}
	select {
	case ch <- pkt:
		return nil
	case <-time.After(2 * time.Second):
		return ErrSendTimeout
	}
}

// ToOS receives inner packets that wireguard-go decrypted.
func (s *Session) ToOS() <-chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.channel == nil {
		return nil
	}
	return s.channel.Inbound
}

// WirePackets returns UDP payloads this side has sent.
func (s *Session) WirePackets() [][]byte {
	s.mu.Lock()
	bind := s.bind
	s.mu.Unlock()
	if bind == nil {
		return nil
	}
	return bind.packets()
}

// Dropped counts inner packets that were not encapsulated.
func (s *Session) Dropped() uint64 {
	s.mu.Lock()
	policy := s.policy
	s.mu.Unlock()
	if policy == nil {
		return 0
	}
	return policy.dropped.Load()
}

// LogText is the redacted error log.
func (s *Session) LogText() string {
	s.mu.Lock()
	logs := s.log
	s.mu.Unlock()
	if logs == nil {
		return ""
	}
	return logs.text()
}

// Listening reports whether the loopback socket is open.
func (s *Session) Listening() bool {
	s.mu.Lock()
	bind := s.bind
	s.mu.Unlock()
	return bind != nil && bind.listening()
}

// LocalAddr is the bound UDP address, for example 127.0.0.1:12345.
func (s *Session) LocalAddr() string {
	s.mu.Lock()
	bind := s.bind
	s.mu.Unlock()
	if bind == nil {
		return ""
	}
	return bind.localAddr()
}

func (s *Session) fromOS() chan []byte {
	if s.channel == nil || s.dev == nil {
		return nil
	}
	return s.channel.Outbound
}

func portFromAddr(addr string) (int, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, ErrStagePort
	}
	ip := net.ParseIP(host)
	// 127.0.0.1 is the host lab socket. 0.0.0.0 is the address a device
	// process gets back after it listens on every interface. A public
	// address is not a local listen result.
	if ip == nil || ip.To4() == nil || (!ip.IsLoopback() && !ip.IsUnspecified()) {
		return 0, ErrStagePort
	}
	port, conv := strconv.Atoi(portText)
	if conv != nil || port <= 0 || port > 65535 {
		return 0, ErrStagePort
	}
	return port, nil
}

// MessageType returns the WireGuard message type, or 0 if the datagram is too short.
func MessageType(pkt []byte) uint32 {
	if len(pkt) < 4 {
		return 0
	}
	return binary.LittleEndian.Uint32(pkt[:4])
}
