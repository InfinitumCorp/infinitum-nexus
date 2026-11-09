package tray

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
)

// Command is one menu choice shared by the console and the Windows tray.
type Command string

const (
	CommandVeil   Command = "veil"
	CommandTor    Command = "tor"
	CommandOff    Command = "off"
	CommandStatus Command = "status"
	CommandQuit   Command = "quit"
)

func Parse(line string) (Command, error) {
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "veil", "vpn", "1":
		return CommandVeil, nil
	case "tor", "2":
		return CommandTor, nil
	case "off", "3":
		return CommandOff, nil
	case "status", "4":
		return CommandStatus, nil
	case "quit", "q", "5":
		return CommandQuit, nil
	default:
		return "", fmt.Errorf("choose VEIL VPN, Tor, or Off")
	}
}

// RunConsole is the text menu used when a platform tray is not attached.
func RunConsole(ctx context.Context, controller *app.Controller, in io.Reader, out io.Writer) error {
	fmt.Fprintln(out, "Infinitum Corporation® VEIL Desktop")
	fmt.Fprintln(out, "VEIL VPN / Tor / Off. Type veil, tor, off, status, or quit.")
	printStatus(out, controller.Status())
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		cmd, err := Parse(scanner.Text())
		if err != nil {
			fmt.Fprintln(out, err.Error())
			continue
		}
		if cmd == CommandQuit {
			return controller.SetMode(ctx, app.ModeOff)
		}
		if cmd == CommandStatus {
			printStatus(out, controller.Status())
			continue
		}
		if err := controller.SetMode(ctx, app.Mode(cmd)); err != nil {
			fmt.Fprintln(out, err.Error())
			continue
		}
		printStatus(out, controller.Status())
	}
	return scanner.Err()
}

func printStatus(out io.Writer, status app.Status) {
	fmt.Fprintf(out, "mode=%s tunnel=%t killSwitch=%t enforcement=%s coverage=%s detail=%s\n",
		status.Mode, status.TunnelUp, status.KillSwitch, status.Enforcement, status.Coverage, status.Detail)
}
