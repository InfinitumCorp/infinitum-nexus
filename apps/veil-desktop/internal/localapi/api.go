// Package localapi is the loopback control socket for the tray and the menu bar.
// It is not a web VPN. The token never leaves 127.0.0.1.
package localapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
)

type Server struct {
	Controller *app.Controller
	token      string
}

func New(controller *app.Controller) (*Server, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	return &Server{Controller: controller, token: hex.EncodeToString(buf)}, nil
}

func (s *Server) Token() string { return s.token }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", s.status)
	mux.HandleFunc("/mode", s.mode)
	return mux
}

func (s *Server) Listen() (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	if host, _, err := net.SplitHostPort(ln.Addr().String()); err != nil || host != "127.0.0.1" {
		ln.Close()
		return nil, errors.New("control socket left loopback")
	}
	return ln, nil
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, s.Controller.Status())
}

func (s *Server) mode(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		http.Error(w, "json", http.StatusBadRequest)
		return
	}
	if err := s.Controller.SetMode(r.Context(), app.Mode(body.Mode)); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, s.Controller.Status())
}

func (s *Server) allow(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		http.Error(w, "loopback only", http.StatusForbidden)
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, body app.Status) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}
