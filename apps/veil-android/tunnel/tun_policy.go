// Copyright Infinitum Corporation.

package tunnel

import (
	"os"
	"sync"
	"sync/atomic"

	"golang.zx2c4.com/wireguard/tun"
)

// policyTUN drops anything that is not IPv4 before wireguard-go sees it,
// and drops non-IPv4 packets before they are delivered to the OS side.
type policyTUN struct {
	inner   tun.Device
	events  chan tun.Event
	once    sync.Once
	dropped atomic.Uint64
	kept    atomic.Uint64
}

func newPolicyTUN(inner tun.Device) *policyTUN {
	return &policyTUN{
		inner:  inner,
		events: make(chan tun.Event, 1),
	}
}

func (p *policyTUN) File() *os.File { return p.inner.File() }

func (p *policyTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	for {
		n, err := p.inner.Read(bufs, sizes, offset)
		if n == 0 || err != nil {
			return n, err
		}
		kept := 0
		for i := 0; i < n; i++ {
			pkt := bufs[i][offset : offset+sizes[i]]
			if FilterPacket(pkt) != nil {
				p.dropped.Add(1)
				continue
			}
			if kept != i {
				copy(bufs[kept][offset:], pkt)
				sizes[kept] = sizes[i]
			}
			p.kept.Add(1)
			kept++
		}
		if kept > 0 {
			return kept, nil
		}
	}
}

func (p *policyTUN) Write(bufs [][]byte, offset int) (int, error) {
	if offset < 0 {
		return p.inner.Write(bufs, offset)
	}
	kept := make([][]byte, 0, len(bufs))
	for _, buf := range bufs {
		if offset > len(buf) || FilterPacket(buf[offset:]) != nil {
			p.dropped.Add(1)
			continue
		}
		kept = append(kept, buf)
	}
	if len(kept) == 0 {
		return len(bufs), nil
	}
	if _, err := p.inner.Write(kept, offset); err != nil {
		return 0, err
	}
	return len(bufs), nil
}

func (p *policyTUN) MTU() (int, error)        { return p.inner.MTU() }
func (p *policyTUN) Name() (string, error)    { return p.inner.Name() }
func (p *policyTUN) Events() <-chan tun.Event { return p.events }
func (p *policyTUN) BatchSize() int           { return p.inner.BatchSize() }

var _ tun.Device = (*policyTUN)(nil)

func (p *policyTUN) Close() error {
	p.once.Do(func() { close(p.events) })
	return p.inner.Close()
}
