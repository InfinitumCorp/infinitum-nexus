// Package wgconfig parses a VEIL device grant into a WireGuard peer.
// Private keys stay in memory for the life of the tunnel and are wiped on close.
package wgconfig

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"
)

const (
	poolPrefix = "10.64.0.0/16"
	mtuMin     = 1280
	mtuMax     = 1420
)

// Config is the client tunnel. String fields are not a log format; use Redacted.
type Config struct {
	PrivateKey  []byte
	PublicKey   []byte
	Address     netip.Prefix
	DNS         []netip.Addr
	MTU         int
	PeerPublic  []byte
	Endpoint    netip.AddrPort
	EndpointDNS string
	AllowedIPs  []netip.Prefix
	Keepalive   int
	Expires     time.Time
}

// Wipe zeros the private key bytes this process holds.
func (c *Config) Wipe() {
	for i := range c.PrivateKey {
		c.PrivateKey[i] = 0
	}
}

// Redacted is safe to print. It has no private key material.
func (c Config) Redacted() string {
	return fmt.Sprintf("address=%s endpoint=%s dns=%s expires=%s", c.Address, c.Endpoint, c.DNS, c.Expires.Format(time.RFC3339))
}

type grant struct {
	Coverage   string `json:"coverage"`
	DeviceWide bool   `json:"deviceWide"`
	Browser    bool   `json:"browserOnly"`
	DNSMode    string `json:"dns"`
	KillSwitch string `json:"killSwitch"`
	ExpiresAt  string `json:"expiresAt"`
	Interface  struct {
		PrivateKey string   `json:"privateKey"`
		PublicKey  string   `json:"publicKey"`
		Address    string   `json:"address"`
		DNS        []string `json:"dns"`
		MTU        int      `json:"mtu"`
	} `json:"interface"`
	Peer struct {
		PublicKey string   `json:"publicKey"`
		Endpoint  string   `json:"endpoint"`
		Allowed   []string `json:"allowedIps"`
		Keepalive int      `json:"persistentKeepalive"`
	} `json:"peer"`
}

// ParseGrant checks a control-plane device grant. Split tunnels and public DNS are refused.
func ParseGrant(raw []byte) (Config, error) {
	var body grant
	if err := json.Unmarshal(raw, &body); err != nil {
		return Config{}, errors.New("device grant is not JSON")
	}
	if body.Coverage != "device" || !body.DeviceWide || body.Browser || body.DNSMode != "through-tunnel" || body.KillSwitch != "fail-closed" {
		return Config{}, errors.New("device grant is not a fail-closed VEIL tunnel")
	}
	priv, err := key(body.Interface.PrivateKey)
	if err != nil {
		return Config{}, fmt.Errorf("client private key: %w", err)
	}
	pub, err := key(body.Interface.PublicKey)
	if err != nil {
		return Config{}, fmt.Errorf("client public key: %w", err)
	}
	peer, err := key(body.Peer.PublicKey)
	if err != nil {
		return Config{}, fmt.Errorf("exit public key: %w", err)
	}
	prefix, err := netip.ParsePrefix(body.Interface.Address)
	if err != nil || !prefix.IsValid() || prefix.Bits() != 32 {
		return Config{}, errors.New("client address must be a /32 inside the VEIL pool")
	}
	pool, _ := netip.ParsePrefix(poolPrefix)
	if !pool.Contains(prefix.Addr()) || prefix.Addr().String() == "10.64.0.1" {
		return Config{}, errors.New("client address is outside the VEIL pool")
	}
	if body.Interface.MTU < mtuMin || body.Interface.MTU > mtuMax {
		return Config{}, errors.New("mtu is outside 1280-1420")
	}
	if len(body.Interface.DNS) == 0 {
		return Config{}, errors.New("tunnel DNS is required")
	}
	dns := make([]netip.Addr, 0, len(body.Interface.DNS))
	for _, item := range body.Interface.DNS {
		addr, err := netip.ParseAddr(item)
		if err != nil || !pool.Contains(addr) {
			return Config{}, errors.New("DNS must be an address inside the tunnel")
		}
		dns = append(dns, addr)
	}
	if len(body.Peer.Allowed) != 2 || body.Peer.Allowed[0] != "0.0.0.0/0" || body.Peer.Allowed[1] != "::/0" {
		return Config{}, errors.New("device mode requires a full tunnel")
	}
	allowed := make([]netip.Prefix, 0, 2)
	for _, item := range body.Peer.Allowed {
		p, err := netip.ParsePrefix(item)
		if err != nil {
			return Config{}, errors.New("allowed IP is invalid")
		}
		allowed = append(allowed, p)
	}
	host, port, err := splitEndpoint(body.Peer.Endpoint)
	if err != nil {
		return Config{}, err
	}
	if body.Peer.Keepalive < 15 || body.Peer.Keepalive > 120 {
		return Config{}, errors.New("keepalive is invalid")
	}
	expires, err := time.Parse(time.RFC3339, body.ExpiresAt)
	if err != nil {
		return Config{}, errors.New("expiry is invalid")
	}
	cfg := Config{
		PrivateKey: priv, PublicKey: pub, Address: prefix, DNS: dns, MTU: body.Interface.MTU,
		PeerPublic: peer, EndpointDNS: host, AllowedIPs: allowed, Keepalive: body.Peer.Keepalive, Expires: expires,
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if !publicEnough(addr) {
			return Config{}, errors.New("exit address is refused")
		}
		cfg.Endpoint = netip.AddrPortFrom(addr, port)
	} else {
		cfg.Endpoint = netip.AddrPortFrom(netip.IPv4Unspecified(), port)
	}
	return cfg, nil
}

func publicEnough(addr netip.Addr) bool {
	if addr.IsUnspecified() || addr.IsMulticast() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() {
		return false
	}
	if addr.Is4() {
		ip := addr.As4()
		if ip[0] == 169 && ip[1] == 254 {
			return false
		}
		if ip[0] == 0 || ip == [4]byte{255, 255, 255, 255} {
			return false
		}
	}
	return true
}

func splitEndpoint(value string) (string, uint16, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, errors.New("exit endpoint is invalid")
	}
	port, err := net.LookupPort("udp", portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, errors.New("exit port is invalid")
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" || strings.ContainsAny(host, " /@%") {
		return "", 0, errors.New("exit host is invalid")
	}
	return host, uint16(port), nil
}

func key(text string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(raw) != 32 {
		return nil, errors.New("expected 32 bytes")
	}
	zero := true
	for _, b := range raw {
		if b != 0 {
			zero = false
			break
		}
	}
	if zero {
		return nil, errors.New("blank key")
	}
	return raw, nil
}

// UAPI is the userspace WireGuard configuration. Do not log it.
func (c Config) UAPI(listenPort int, peers []Peer) (string, error) {
	if len(c.PrivateKey) != 32 && listenPort == 0 {
		return "", errors.New("private key is required")
	}
	var b strings.Builder
	if len(c.PrivateKey) == 32 {
		fmt.Fprintf(&b, "private_key=%s\n", hex.EncodeToString(c.PrivateKey))
	}
	if listenPort > 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", listenPort)
	}
	for _, peer := range peers {
		if len(peer.PublicKey) != 32 {
			return "", errors.New("peer public key is invalid")
		}
		fmt.Fprintf(&b, "public_key=%s\n", hex.EncodeToString(peer.PublicKey))
		if peer.Endpoint != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", peer.Endpoint)
		}
		if peer.Keepalive > 0 {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", peer.Keepalive)
		}
		if len(peer.AllowedIPs) == 0 {
			return "", errors.New("peer is missing allowed IPs")
		}
		for _, cidr := range peer.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", cidr)
		}
	}
	return b.String(), nil
}

// Peer is one remote WireGuard peer in UAPI form.
type Peer struct {
	PublicKey  []byte
	Endpoint   string
	AllowedIPs []string
	Keepalive  int
}

// ClientPeer is this grant's exit, for a full tunnel.
func (c Config) ClientPeer(endpoint string) Peer {
	allowed := make([]string, len(c.AllowedIPs))
	for i, prefix := range c.AllowedIPs {
		allowed[i] = prefix.String()
	}
	return Peer{PublicKey: c.PeerPublic, Endpoint: endpoint, AllowedIPs: allowed, Keepalive: c.Keepalive}
}
