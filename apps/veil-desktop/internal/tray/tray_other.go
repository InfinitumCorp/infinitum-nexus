//go:build !windows

package tray

import (
	"context"
	"os"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
)

// Run is the console menu. The macOS menu bar is macos/VeilMenu.
func Run(ctx context.Context, controller *app.Controller) error {
	return RunConsole(ctx, controller, os.Stdin, os.Stdout)
}
