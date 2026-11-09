// Package controlclient calls the existing VEIL control plane.
// A Cumulus ID session and a VEIL entitlement are required. Tor mode does not use this package.
package controlclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

// ProductOrigin is the public VEIL browser host. It is hosted on Cloudflare.
// VEIL_CONTROL_URL overrides it. http is accepted only for localhost and 127.0.0.1.
const ProductOrigin = "https://infinitumveil.app"

func DefaultControlURL() string {
	if v := strings.TrimSpace(os.Getenv("VEIL_CONTROL_URL")); v != "" {
		return v
	}
	return ProductOrigin
}

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

type Session struct {
	Entitled   bool `json:"entitled"`
	Configured bool `json:"configured"`
	DeviceWide bool `json:"deviceWide"`
}

func (c Client) Session(ctx context.Context) (Session, error) {
	var body Session
	err := c.do(ctx, http.MethodGet, "/api/veil/device/session", nil, &body)
	return body, err
}

func (c Client) Connect(ctx context.Context, serverID string) (wgconfig.Config, error) {
	if strings.TrimSpace(c.Token) == "" {
		return wgconfig.Config{}, errors.New("Cumulus ID session token is missing")
	}
	payload, err := json.Marshal(map[string]string{"serverId": serverID})
	if err != nil {
		return wgconfig.Config{}, err
	}
	req, err := c.request(ctx, http.MethodPost, "/api/veil/device/connect", bytes.NewReader(payload))
	if err != nil {
		return wgconfig.Config{}, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return wgconfig.Config{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return wgconfig.Config{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return wgconfig.Config{}, errors.New(publicError(raw, resp.StatusCode))
	}
	return wgconfig.ParseGrant(raw)
}

func (c Client) Disconnect(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/veil/device/disconnect", strings.NewReader("{}"), nil)
}

func (c Client) do(ctx context.Context, method, path string, body io.Reader, dest any) error {
	req, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return errors.New(publicError(raw, resp.StatusCode))
	}
	if dest == nil {
		return nil
	}
	return json.Unmarshal(raw, dest)
}

func (c Client) request(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, errors.New("VEIL control URL is invalid")
	}
	if base.Scheme != "https" && base.Hostname() != "127.0.0.1" && base.Hostname() != "localhost" {
		return nil, errors.New("VEIL control URL must be https, or http on localhost")
	}
	req, err := http.NewRequestWithContext(ctx, method, base.JoinPath(path).String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-veil", "1")
	req.Header.Set("authorization", "Bearer "+c.Token)
	return req, nil
}

func publicError(raw []byte, status int) string {
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil && body.Error != "" && !strings.Contains(strings.ToLower(body.Error), "private") {
		return body.Error
	}
	return fmt.Sprintf("control plane status %d", status)
}
