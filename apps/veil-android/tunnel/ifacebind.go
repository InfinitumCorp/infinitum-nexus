// Copyright Infinitum Corporation.
// ifaceBind is the UDP carrier the device process uses. protect runs before
// the socket can send. Host tests pass 127.0.0.1. The Android process is the
// only caller that listens on 0.0.0.0, and that process is the emulator or
// phone, not the parent host.

package tunnel

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
)

// NewIfaceBind listens on listenIP. Only 127.0.0.1 and, for the device
// process, 0.0.0.0 are accepted. 0.0.0.0 is refused unless allowUnspecified
// is true.
func NewIfaceBind(protect func(int) error, listenIP string, allowUnspecified bool) (*ifaceBind, error) {
	if protect == nil {
		return nil, ErrProtectRequired
	}
	if listenIP == "" {
		listenIP = "127.0.0.1"
	}
	ip := net.ParseIP(listenIP)
	if ip == nil || ip.To4() == nil {
		return nil, ErrEndpoint
	}
	if ip.IsUnspecified() {
		if !allowUnspecified {
			return nil, ErrEndpoint
		}
		listenIP = "0.0.0.0"
	} else if !ip.IsLoopback() {
		return nil, ErrEndpointNotLoopback
	} else {
		listenIP = "127.0.0.1"
	}
	return &ifaceBind{protect: protect, listenIP: listenIP}, nil
}

type ifaceBind struct {
	protect  func(int) error
	listenIP string

	mu        sync.Mutex
	pc        *net.UDPConn
	protected bool
	seen      [][]byte
}

func (b *ifaceBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	if b.pc != nil {
		b.mu.Unlock()
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	b.mu.Unlock()

	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			host, _, splitErr := net.SplitHostPort(address)
			got := net.ParseIP(host)
			want := net.ParseIP(b.listenIP)
			if splitErr != nil || got == nil || want == nil || !got.Equal(want) {
				return ErrStageListen
			}
			var fd int
			if err := c.Control(func(f uintptr) { fd = int(f) }); err != nil {
				return ErrStageListen
			}
			if err := b.protect(fd); err != nil {
				return err
			}
			b.mu.Lock()
			b.protected = true
			b.mu.Unlock()
			return nil
		},
	}
	packet, err := lc.ListenPacket(context.Background(), "udp4", net.JoinHostPort(b.listenIP, itoaPort(port)))
	if err != nil {
		b.mu.Lock()
		b.protected = false
		b.mu.Unlock()
		if errors.Is(err, ErrProtectRequired) || errors.Is(err, ErrNotProtected) || errors.Is(err, ErrStageProtect) {
			return nil, 0, ErrProtectRequired
		}
		return nil, 0, ErrStageListen
	}
	pc := packet.(*net.UDPConn)
	actual := uint16(pc.LocalAddr().(*net.UDPAddr).Port)
	b.mu.Lock()
	b.pc = pc
	b.mu.Unlock()

	fn := func(bufs [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		n, addr, err := pc.ReadFromUDP(bufs[0])
		if err != nil {
			return 0, err
		}
		if addr == nil || addr.IP == nil || addr.IP.To4() == nil {
			return 0, ErrEndpoint
		}
		sizes[0] = n
		eps[0] = &ifaceEP{ap: addr.AddrPort()}
		return 1, nil
	}
	return []conn.ReceiveFunc{fn}, actual, nil
}

func (b *ifaceBind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.protected = false
	if b.pc == nil {
		return nil
	}
	err := b.pc.Close()
	b.pc = nil
	return err
}

func (b *ifaceBind) SetMark(uint32) error { return nil }

func (b *ifaceBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	dst, ok := ep.(*ifaceEP)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	if err := validateDevicePeer(dst.DstToString()); err != nil {
		return err
	}
	b.mu.Lock()
	if !b.protected || b.pc == nil {
		b.mu.Unlock()
		return ErrNotProtected
	}
	pc := b.pc
	for _, buf := range bufs {
		if len(b.seen) < 64 {
			seen := make([]byte, len(buf))
			copy(seen, buf)
			b.seen = append(b.seen, seen)
		}
	}
	b.mu.Unlock()
	for _, buf := range bufs {
		if _, err := pc.WriteToUDP(buf, net.UDPAddrFromAddrPort(dst.ap)); err != nil {
			return err
		}
	}
	return nil
}

func (b *ifaceBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if err := validateDevicePeer(s); err != nil {
		return nil, err
	}
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return nil, err
	}
	return &ifaceEP{ap: ap}, nil
}

func (b *ifaceBind) BatchSize() int { return 1 }

func (b *ifaceBind) packets() [][]byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([][]byte, len(b.seen))
	for i, p := range b.seen {
		out[i] = append([]byte(nil), p...)
	}
	return out
}

func (b *ifaceBind) localAddr() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pc == nil {
		return ""
	}
	return b.pc.LocalAddr().String()
}

type ifaceEP struct{ ap netip.AddrPort }

func (e *ifaceEP) ClearSrc()           {}
func (e *ifaceEP) SrcToString() string { return "" }
func (e *ifaceEP) DstToString() string { return e.ap.String() }
func (e *ifaceEP) DstIP() netip.Addr   { return e.ap.Addr() }
func (e *ifaceEP) SrcIP() netip.Addr   { return netip.Addr{} }
func (e *ifaceEP) DstToBytes() []byte {
	raw, err := e.ap.MarshalBinary()
	if err != nil {
		return nil
	}
	return raw
}

// validateDevicePeer accepts an IPv4 host:port. Hostnames, the product
// domain, and an unspecified address are refused. Loopback is allowed so
// host tests stay on 127.0.0.1. This does not relax the lab's ValidateEndpoint.
func validateDevicePeer(endpoint string) error {
	if strings.Contains(strings.ToLower(endpoint), VPNProduct().Domain) {
		return ErrEndpoint
	}
	addr, err := netip.ParseAddrPort(endpoint)
	if err != nil || !addr.Addr().Is4() || addr.Port() == 0 || addr.Addr().IsUnspecified() {
		return ErrEndpoint
	}
	return nil
}

var (
	_ conn.Bind     = (*ifaceBind)(nil)
	_ conn.Endpoint = (*ifaceEP)(nil)
)
