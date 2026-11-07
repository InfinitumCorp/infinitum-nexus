// Package tor routes a machine through a Tor client the user already installed.
// VEIL does not vendor Tor. TCP and DNS can be redirected. Other UDP is dropped.
package tor

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

const (
	DefaultSOCKS     = "127.0.0.1:9050"
	DefaultTransPort = "127.0.0.1:9040"
	DefaultDNSPort   = "127.0.0.1:5353"
)

type Availability struct {
	SOCKS        bool
	Transparent  bool
	SOCKSAddr    string
	TransAddr    string
	DNSAddr      string
	Coverage     string
	HonestLimits []string
}

// Inspect probes the local client. It does not contact Infinitum or the Tor network.
func Inspect(ctx context.Context, socks, trans, dns string) (Availability, error) {
	if socks == "" {
		socks = DefaultSOCKS
	}
	avail := Availability{
		SOCKSAddr: socks,
		TransAddr: trans,
		DNSAddr:   dns,
		HonestLimits: []string{
			"UDP other than DNS is dropped. Tor does not carry it.",
			"This is not Tor Browser. Fonts, screen size, and APIs are unchanged.",
			"Transparent mode uses one machine-wide circuit, not per-site isolation.",
			"The Tor executable is not bundled.",
		},
	}
	if err := ProbeSOCKS(ctx, socks); err != nil {
		return avail, err
	}
	avail.SOCKS = true
	transOpen := trans != "" && dial(ctx, trans) == nil
	dnsOpen := dns != "" && dial(ctx, dns) == nil
	if transOpen && dnsOpen {
		avail.Transparent = true
		avail.Coverage = "tcp-and-dns-redirected"
		return avail, nil
	}
	avail.Coverage = "socks-fail-closed"
	avail.HonestLimits = append(avail.HonestLimits,
		"TransPort or DNSPort is not open. Direct TCP and UDP are blocked. Only programs that use SOCKS reach Tor.")
	return avail, nil
}

// ProbeSOCKS completes the SOCKS5 greeting with no authentication.
func ProbeSOCKS(ctx context.Context, addr string) error {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("tor socks is not reachable: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return errors.New("tor socks did not accept a greeting")
	}
	buf := make([]byte, 2)
	if _, err := conn.Read(buf); err != nil || buf[0] != 0x05 || buf[1] != 0x00 {
		return errors.New("tor socks refused no-auth")
	}
	return nil
}

func dial(ctx context.Context, addr string) error {
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	return conn.Close()
}
