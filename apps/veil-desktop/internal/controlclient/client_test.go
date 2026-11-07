package controlclient

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConnectParsesDeviceGrantAndRefusesBrowserShapedErrors(t *testing.T) {
	priv := base64.StdEncoding.EncodeToString(bytes32(9))
	grant := `{
		"coverage":"device","deviceWide":true,"browserOnly":false,
		"dns":"through-tunnel","killSwitch":"fail-closed",
		"expiresAt":"` + time.Now().Add(time.Minute).UTC().Format(time.RFC3339) + `",
		"interface":{"privateKey":"` + priv + `","publicKey":"` + base64.StdEncoding.EncodeToString(bytes32(2)) + `","address":"10.64.0.2/32","dns":["10.64.0.1"],"mtu":1280},
		"peer":{"publicKey":"` + base64.StdEncoding.EncodeToString(bytes32(3)) + `","endpoint":"203.0.113.10:51820","allowedIps":["0.0.0.0/0","::/0"],"persistentKeepalive":25}
	}`
	var seenAuth, seenHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("authorization")
		seenHeader = r.Header.Get("x-veil")
		if r.URL.Path == "/api/veil/device/connect" {
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(grant))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	client := Client{BaseURL: srv.URL, Token: "cid-session"}
	cfg, err := client.Connect(context.Background(), "iad-1")
	if err != nil {
		t.Fatal(err)
	}
	if seenHeader != "1" || !strings.HasPrefix(seenAuth, "Bearer ") {
		t.Fatalf("headers auth=%q veil=%q", seenAuth, seenHeader)
	}
	if cfg.Endpoint.String() != "203.0.113.10:51820" {
		t.Fatalf("endpoint %s", cfg.Endpoint)
	}
	cfg.Wipe()
}

func TestPublicHTTPControlURLIsRefused(t *testing.T) {
	client := Client{BaseURL: "http://veil.example", Token: "cid-session"}
	if _, err := client.Connect(context.Background(), "iad-1"); err == nil {
		t.Fatal("expected refusal")
	}
}

func TestErrorBodyDoesNotNeedThePrivateKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"veil_plan_required","deviceWide":false}`))
	}))
	defer srv.Close()
	_, err := (Client{BaseURL: srv.URL, Token: "cid-session"}).Connect(context.Background(), "iad-1")
	if err == nil || !strings.Contains(err.Error(), "veil_plan_required") {
		t.Fatalf("err %v", err)
	}
}

func bytes32(fill byte) []byte {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	return raw
}
