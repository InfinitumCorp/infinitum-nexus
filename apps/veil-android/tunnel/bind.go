// Copyright Infinitum Corporation.
// loopbackBind is a UDP carrier for wireguard-go. It is not a TUN device
// and it does not change host routes. protect runs before the listener exists.

package tunnel

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
)

var (
	ErrProtectRequired = errors.New("protect callback is required")
	ErrNotProtected    = errors.New("tunnel socket was not protected")
)

// loopbackBind carries WireGuard datagrams on 127.0.0.1 only.
type loopbackBind struct {
	protect func(fd int) error

	mu        sync.Mutex
	pc        *net.UDPConn
	protected bool
	protectN  int
	seen      [][]byte
}

func newLoopbackBind(protect func(fd int) error) *loopbackBind {
	return &loopbackBind{protect: protect}
}

var (
	_ conn.Bind     = (*loopbackBind)(nil)
	_ conn.Endpoint = (*loopbackEP)(nil)
)

func (b *loopbackBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	if b.protect == nil {
		return nil, 0, ErrProtectRequired
	}
	b.mu.Lock()
	if b.pc != nil {
		b.mu.Unlock()
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	b.mu.Unlock()

	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			if network != "udp4" || !stringsHasLoopback(address) {
				return ErrEndpointNotLoopback
			}
			var fd int
			if err := c.Control(func(f uintptr) { fd = int(f) }); err != nil {
				return err
			}
			if err := b.protect(fd); err != nil {
				return err
			}
			b.mu.Lock()
			b.protected = true
			b.protectN++
			b.mu.Unlock()
			return nil
		},
	}
	packet, err := lc.ListenPacket(context.Background(), "udp4", net.JoinHostPort("127.0.0.1", itoaPort(port)))
	if err != nil {
		b.mu.Lock()
		b.protected = false
		b.mu.Unlock()
		return nil, 0, err
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
		if addr == nil || addr.IP == nil || !addr.IP.IsLoopback() {
			return 0, ErrEndpointNotLoopback
		}
		sizes[0] = n
		eps[0] = &loopbackEP{ap: addr.AddrPort()}
		return 1, nil
	}
	return []conn.ReceiveFunc{fn}, actual, nil
}

func (b *loopbackBind) Close() error {
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

func (b *loopbackBind) SetMark(uint32) error { return nil }

func (b *loopbackBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	dst, ok := ep.(*loopbackEP)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	if err := ValidateEndpoint(dst.DstToString()); err != nil {
		return err
	}
	b.mu.Lock()
	if !b.protected || b.pc == nil {
		b.mu.Unlock()
		return ErrNotProtected
	}
	pc := b.pc
	for _, buf := range bufs {
		seen := make([]byte, len(buf))
		copy(seen, buf)
		b.seen = append(b.seen, seen)
	}
	b.mu.Unlock()

	for _, buf := range bufs {
		if _, err := pc.WriteToUDP(buf, net.UDPAddrFromAddrPort(dst.ap)); err != nil {
			return err
		}
	}
	return nil
}

func (b *loopbackBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if err := ValidateEndpoint(s); err != nil {
		return nil, err
	}
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return nil, err
	}
	return &loopbackEP{ap: ap}, nil
}

func (b *loopbackBind) BatchSize() int { return 1 }

func (b *loopbackBind) packets() [][]byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([][]byte, len(b.seen))
	for i, p := range b.seen {
		out[i] = append([]byte(nil), p...)
	}
	return out
}

func (b *loopbackBind) listening() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pc != nil
}

func (b *loopbackBind) localAddr() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pc == nil {
		return ""
	}
	return b.pc.LocalAddr().String()
}

func (b *loopbackBind) protectCalls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.protectN
}

type loopbackEP struct {
	ap netip.AddrPort
}

func (e *loopbackEP) ClearSrc()           {}
func (e *loopbackEP) SrcToString() string { return "" }
func (e *loopbackEP) DstToString() string { return e.ap.String() }
func (e *loopbackEP) DstIP() netip.Addr   { return e.ap.Addr() }
func (e *loopbackEP) SrcIP() netip.Addr   { return netip.Addr{} }
func (e *loopbackEP) DstToBytes() []byte {
	b, err := e.ap.MarshalBinary()
	if err != nil {
		return nil
	}
	return b
}

func itoaPort(port uint16) string {
	if port == 0 {
		return "0"
	}
	var buf [5]byte
	i := len(buf)
	for port > 0 {
		i--
		buf[i] = byte('0' + port%10)
		port /= 10
	}
	return string(buf[i:])
}

func stringsHasLoopback(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
