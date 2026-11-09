// Package app is the VEIL Desktop mode switch: VEIL VPN, Tor, or Off.
package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

type Mode string

const (
	ModeOff  Mode = "off"
	ModeVeil Mode = "veil"
	ModeTor  Mode = "tor"
)

type Result struct {
	Backend     string
	Enforcement string
}

// Applier installs a device-wide route. Tests use a fake. The OS packages install the real one.
type Applier interface {
	ApplyVeil(ctx context.Context, cfg wgconfig.Config) (Result, error)
	ApplyTor(ctx context.Context, avail tor.Availability) (Result, error)
	Blackhole(ctx context.Context, reason string) (Result, error)
	Clear(ctx context.Context) error
}

// ControlClient talks to the existing VEIL control plane.
type ControlClient interface {
	Connect(ctx context.Context, serverID string) (wgconfig.Config, error)
	Disconnect(ctx context.Context) error
}

// TorInspector looks at the local Tor client only.
type TorInspector interface {
	Inspect(ctx context.Context) (tor.Availability, error)
}

type Status struct {
	Mode        string `json:"mode"`
	TunnelUp    bool   `json:"tunnelUp"`
	KillSwitch  bool   `json:"killSwitch"`
	FailClosed  bool   `json:"failClosed"`
	Enforcement string `json:"enforcement"`
	Backend     string `json:"backend"`
	Detail      string `json:"detail"`
	Coverage    string `json:"coverage"`
	Expires     string `json:"expires,omitempty"`
}

type Controller struct {
	mu         sync.Mutex
	applier    Applier
	control    ControlClient
	tor        TorInspector
	serverID   string
	mode       Mode
	tunnelUp   bool
	kill       bool
	failClosed bool
	backend    string
	enforce    string
	detail     string
	expires    time.Time
}

func New(applier Applier, control ControlClient, inspector TorInspector, serverID string) *Controller {
	if serverID == "" {
		serverID = "iad-1"
	}
	return &Controller{applier: applier, control: control, tor: inspector, serverID: serverID, mode: ModeOff, detail: "off"}
}

func (c *Controller) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.statusLocked()
}

func (c *Controller) statusLocked() Status {
	expires := ""
	if !c.expires.IsZero() {
		expires = c.expires.UTC().Format(time.RFC3339)
	}
	coverage := "off"
	switch c.mode {
	case ModeVeil:
		if c.tunnelUp {
			coverage = "device"
		} else {
			coverage = "device-blocked"
		}
	case ModeTor:
		coverage = "device-tor"
	}
	return Status{
		Mode: string(c.mode), TunnelUp: c.tunnelUp, KillSwitch: c.kill, FailClosed: c.failClosed,
		Enforcement: c.enforce, Backend: c.backend, Detail: c.detail, Coverage: coverage, Expires: expires,
	}
}

// SetMode switches the device. A VEIL or Tor selection that cannot install a
// kill switch is refused, and the previous mode is left in place.
func (c *Controller) SetMode(ctx context.Context, mode Mode) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch mode {
	case ModeOff:
		return c.offLocked(ctx)
	case ModeVeil:
		return c.veilLocked(ctx)
	case ModeTor:
		return c.torLocked(ctx)
	default:
		return errors.New("mode must be veil, tor, or off")
	}
}

func (c *Controller) Refresh(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.mode != ModeVeil {
		return nil
	}
	return c.veilLocked(ctx)
}

func (c *Controller) offLocked(ctx context.Context) error {
	if c.control != nil && c.mode == ModeVeil {
		_ = c.control.Disconnect(ctx)
	}
	if err := c.applier.Clear(ctx); err != nil {
		return err
	}
	c.mode = ModeOff
	c.tunnelUp = false
	c.kill = false
	c.failClosed = false
	c.backend = ""
	c.enforce = ""
	c.detail = "off"
	c.expires = time.Time{}
	return nil
}

func (c *Controller) veilLocked(ctx context.Context) error {
	if c.control == nil {
		return errors.New("VEIL control plane is not configured")
	}
	cfg, err := c.control.Connect(ctx, c.serverID)
	if err != nil {
		return c.failOrRefuse(ctx, ModeVeil, "VEIL control plane refused the session: "+err.Error())
	}
	defer cfg.Wipe()
	result, err := c.applier.ApplyVeil(ctx, cfg)
	if err != nil {
		_ = c.applier.Clear(ctx)
		return c.failOrRefuse(ctx, ModeVeil, err.Error())
	}
	c.mode = ModeVeil
	c.tunnelUp = true
	c.kill = true
	c.failClosed = true
	c.backend = result.Backend
	c.enforce = result.Enforcement
	c.detail = "VEIL VPN"
	c.expires = cfg.Expires
	return nil
}

func (c *Controller) torLocked(ctx context.Context) error {
	if c.tor == nil {
		return c.failOrRefuse(ctx, ModeTor, "Tor inspection is not configured")
	}
	avail, err := c.tor.Inspect(ctx)
	if err != nil {
		return c.failOrRefuse(ctx, ModeTor, "Tor client did not answer. Direct traffic stays blocked when the kill switch is installed.")
	}
	result, err := c.applier.ApplyTor(ctx, avail)
	if err != nil {
		_ = c.applier.Clear(ctx)
		return c.failOrRefuse(ctx, ModeTor, err.Error())
	}
	c.mode = ModeTor
	c.tunnelUp = false
	c.kill = true
	c.failClosed = true
	c.backend = result.Backend
	c.enforce = result.Enforcement
	c.detail = avail.Coverage + ". " + strings.Join(avail.HonestLimits, " ")
	c.expires = time.Time{}
	return nil
}

func (c *Controller) failOrRefuse(ctx context.Context, mode Mode, detail string) error {
	result, err := c.applier.Blackhole(ctx, detail)
	if err != nil {
		return errors.New(detail + ": kill switch was not installed")
	}
	c.mode = mode
	c.tunnelUp = false
	c.kill = true
	c.failClosed = true
	c.backend = result.Backend
	c.enforce = result.Enforcement
	c.detail = detail
	c.expires = time.Time{}
	return nil
}
