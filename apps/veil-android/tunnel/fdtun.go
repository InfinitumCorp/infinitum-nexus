// Copyright Infinitum Corporation.
// fdTUN is the packet device used for an Android VpnService file descriptor.
// It does not create a host TUN and it does not change host routes.

package tunnel

import (
	"errors"
	"io"
	"os"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/tun"
)

type fdTUN struct {
	file   *os.File
	mtu    int
	events chan tun.Event
	once   sync.Once
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
			sizes[0] = n
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
		if _, err := t.file.Write(buf[offset:]); err != nil {
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
