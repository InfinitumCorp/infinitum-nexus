// Copyright Infinitum Corporation.
// fdTUN is the packet device used for an Android VpnService file descriptor.
// It does not create a host TUN and it does not change host routes.

package tunnel

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"syscall"

	"golang.zx2c4.com/wireguard/tun"
)

type fdTUN struct {
	file   *os.File
	mtu    int
	events chan tun.Event
	once   sync.Once
	reads  atomic.Uint64
	pi     atomic.Uint32
}

// NewFDTUN wraps a duplicated TUN descriptor. Closing the device closes this copy.
func NewFDTUN(file *os.File, mtu int) tun.Device {
	return newFDTUN(file, mtu)
}

func newFDTUN(file *os.File, mtu int) *fdTUN {
	if mtu <= 0 {
		mtu = 1280
	}
	return &fdTUN{file: file, mtu: mtu, events: make(chan tun.Event, 1)}
}

func (t *fdTUN) File() *os.File { return t.file }

func (t *fdTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	if len(bufs) == 0 || offset < 0 || offset > len(bufs[0]) {
		return 0, io.ErrShortBuffer
	}
	for {
		n, err := t.file.Read(bufs[0][offset:])
		if n > 0 {
			body, sawPI := consumePI(bufs[0][offset : offset+n])
			if sawPI {
				copy(bufs[0][offset:], body)
				n = len(body)
				t.pi.Store(1)
			}
			sizes[0] = n
			t.reads.Add(1)
			return 1, nil
		}
		if err == nil {
			continue
		}
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			continue
		}
		return 0, err
	}
}

func (t *fdTUN) Write(bufs [][]byte, offset int) (int, error) {
	if offset < 0 {
		return 0, t.Close()
	}
	for i, buf := range bufs {
		if offset > len(buf) {
			return i, io.ErrShortBuffer
		}
		pkt := buf[offset:]
		if t.pi.Load() == 1 {
			frame := make([]byte, 4+len(pkt))
			if len(pkt) > 0 && pkt[0]>>4 == 6 {
				frame[2], frame[3] = 0x86, 0xdd
			} else {
				frame[2], frame[3] = 0x08, 0x00
			}
			copy(frame[4:], pkt)
			pkt = frame
		}
		if _, err := t.file.Write(pkt); err != nil {
			return i, err
		}
	}
	return len(bufs), nil
}

func (t *fdTUN) MTU() (int, error)        { return t.mtu, nil }
func (t *fdTUN) Name() (string, error)    { return "veil0", nil }
func (t *fdTUN) Events() <-chan tun.Event { return t.events }
func (t *fdTUN) BatchSize() int           { return 1 }

func (t *fdTUN) Close() error {
	var err error
	t.once.Do(func() {
		close(t.events)
		if t.file != nil {
			err = t.file.Close()
		}
	})
	return err
}

var _ tun.Device = (*fdTUN)(nil)

// consumePI removes a 4-byte tun_pi prefix when the following bytes are IP.
// A packet that already starts with IPv4 or IPv6 is returned unchanged.
func consumePI(pkt []byte) ([]byte, bool) {
	if len(pkt) >= 20 && (pkt[0]>>4 == 4 || pkt[0]>>4 == 6) {
		return pkt, false
	}
	if len(pkt) <= 4 || pkt[0] != 0 || pkt[1] != 0 {
		return pkt, false
	}
	rest := pkt[4:]
	proto := binary.BigEndian.Uint16(pkt[2:4])
	if len(rest) >= 20 && rest[0]>>4 == 4 && proto == 0x0800 {
		return rest, true
	}
	if len(rest) >= 40 && rest[0]>>4 == 6 && proto == 0x86dd {
		return rest, true
	}
	return pkt, false
}
