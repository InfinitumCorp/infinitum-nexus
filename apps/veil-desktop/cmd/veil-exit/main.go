package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tunnel"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/wgconfig"
)

// veil-exit is the operator-side WireGuard peer. The private key is read from a
// file the operator provides. It is not part of the client grant and is not stored here.
func main() {
	keyFile := flag.String("private-key-file", os.Getenv("VEIL_WG_SERVER_PRIVATE_KEY_FILE"), "exit private key file")
	listen := flag.Int("listen", 51820, "UDP listen port")
	control := flag.String("control", os.Getenv("VEIL_CONTROL_URL"), "VEIL control plane base URL")
	token := flag.String("token", os.Getenv("VEIL_EXIT_TOKEN"), "exit peer-list token")
	flag.Parse()
	raw, err := os.ReadFile(*keyFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "exit private key file is required")
		os.Exit(1)
	}
	private, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(private) != 32 {
		fmt.Fprintln(os.Stderr, "exit private key is invalid")
		os.Exit(1)
	}
	if *control == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "VEIL_CONTROL_URL and VEIL_EXIT_TOKEN are required")
		os.Exit(1)
	}
	ctx := context.Background()
	peers, err := fetchPeers(ctx, *control, *token)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	eng, err := tunnel.StartTUN("veilexit", 1280, private, *listen, peers)
	if err != nil {
		fmt.Fprintln(os.Stderr, "exit tunnel did not start:", err.Error())
		os.Exit(1)
	}
	defer eng.Close()
	fmt.Fprintf(os.Stderr, "VEIL exit listening on %s port %d with %d peers\n", eng.Name(), *listen, len(peers))
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		next, err := fetchPeers(ctx, *control, *token)
		if err != nil {
			fmt.Fprintln(os.Stderr, "peer refresh failed")
			continue
		}
		if err := eng.ReplacePeers(next); err != nil {
			fmt.Fprintln(os.Stderr, "peer update rejected")
			continue
		}
		peers = next
	}
}

type peerList struct {
	Peers []struct {
		PublicKey string `json:"publicKey"`
		Address   string `json:"address"`
	} `json:"peers"`
}

func fetchPeers(ctx context.Context, base, token string) ([]wgconfig.Peer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/api/veil/device/peers", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-veil", "1")
	req.Header.Set("x-veil-exit", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("peer list status %d", resp.StatusCode)
	}
	var listed peerList
	if err := json.Unmarshal(body, &listed); err != nil {
		return nil, err
	}
	out := make([]wgconfig.Peer, 0, len(listed.Peers))
	for _, peer := range listed.Peers {
		raw, err := base64.StdEncoding.DecodeString(peer.PublicKey)
		if err != nil || len(raw) != 32 {
			continue
		}
		out = append(out, wgconfig.Peer{PublicKey: raw, AllowedIPs: []string{peer.Address}})
	}
	return out, nil
}
