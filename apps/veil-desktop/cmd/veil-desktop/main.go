package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/controlclient"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/localapi"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/system"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tor"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tray"
	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/tunnel"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "selftest":
		text := tunnel.Describe(context.Background())
		fmt.Println(text)
		if strings.Contains(text, "failed") {
			os.Exit(1)
		}
	case "run", "daemon":
		os.Exit(run(os.Args[1], os.Args[2:]))
	case "mode", "status":
		os.Exit(client(os.Args[1], os.Args[2:]))
	case "-h", "--help", "help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `Infinitum Corporation® VEIL Desktop

  veil-desktop selftest
  veil-desktop run --control https://cid.example --token-file session
  veil-desktop daemon --control https://cid.example --token-file session
  veil-desktop status
  veil-desktop mode veil|tor|off

Default mode is VEIL VPN. Tor uses a local Tor client and does not call Infinitum.
The browser extension remains browser-only. This process is the device-wide client.
`)
}

type options struct {
	control   string
	token     string
	tokenFile string
	server    string
	socks     string
}

func parseOptions(args []string) options {
	fs := flag.NewFlagSet("veil-desktop", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	opt := options{}
	fs.StringVar(&opt.control, "control", os.Getenv("VEIL_CONTROL_URL"), "VEIL control plane base URL")
	fs.StringVar(&opt.token, "token", "", "Cumulus ID session token")
	fs.StringVar(&opt.tokenFile, "token-file", os.Getenv("VEIL_CID_TOKEN_FILE"), "file containing the Cumulus ID session token")
	fs.StringVar(&opt.server, "server", "iad-1", "VEIL exit id")
	fs.StringVar(&opt.socks, "tor-socks", tor.DefaultSOCKS, "local Tor SOCKS address")
	_ = fs.Parse(args)
	if opt.token == "" {
		opt.token = os.Getenv("VEIL_CID_TOKEN")
	}
	if opt.token == "" && opt.tokenFile != "" {
		raw, err := os.ReadFile(opt.tokenFile)
		if err == nil {
			opt.token = strings.TrimSpace(string(raw))
		}
	}
	return opt
}

func run(command string, args []string) int {
	opt := parseOptions(args)
	controller := app.New(system.New(), controlclient.Client{BaseURL: opt.control, Token: opt.token}, torInspector{socks: opt.socks}, opt.server)
	api, err := localapi.New(controller)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ln, err := api.Listen()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer ln.Close()
	if err := writeRuntime(ln.Addr().String(), api.Token()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.Remove(runtimePath())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go http.Serve(ln, api.Handler())
	fmt.Fprintf(os.Stderr, "VEIL Desktop listening on %s\n", ln.Addr())
	var runErr error
	if command == "daemon" {
		<-ctx.Done()
	} else {
		runErr = tray.Run(ctx, controller)
	}
	_ = controller.SetMode(context.Background(), app.ModeOff)
	if runErr != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, runErr)
		return 1
	}
	return 0
}

func client(command string, args []string) int {
	raw, err := os.ReadFile(runtimePath())
	if err != nil {
		fmt.Fprintln(os.Stderr, "VEIL Desktop daemon is not running")
		return 1
	}
	var runtime struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &runtime); err != nil {
		fmt.Fprintln(os.Stderr, "runtime file is invalid")
		return 1
	}
	var req *http.Request
	if command == "status" {
		req, err = http.NewRequest(http.MethodGet, runtime.URL+"/status", nil)
	} else {
		if len(args) != 1 || (args[0] != "veil" && args[0] != "tor" && args[0] != "off") {
			fmt.Fprintln(os.Stderr, "usage: veil-desktop mode veil|tor|off")
			return 2
		}
		body := strings.NewReader(`{"mode":"` + args[0] + `"}`)
		req, err = http.NewRequest(http.MethodPost, runtime.URL+"/mode", body)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	req.Header.Set("authorization", "Bearer "+runtime.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "VEIL Desktop daemon is not running")
		return 1
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(res.Body)
	fmt.Print(string(payload))
	if res.StatusCode >= 300 {
		return 1
	}
	return 0
}

func runtimePath() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "infinitum", "veil-desktop", "local.json")
}

func writeRuntime(addr, token string) error {
	path := runtimePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]string{"url": "http://" + addr, "token": token})
	if err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0o600)
}

type torInspector struct{ socks string }

func (t torInspector) Inspect(ctx context.Context) (tor.Availability, error) {
	return tor.Inspect(ctx, t.socks, tor.DefaultTransPort, tor.DefaultDNSPort)
}
