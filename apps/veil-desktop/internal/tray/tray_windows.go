//go:build windows

package tray

import (
	"context"
	"unsafe"

	"github.com/InfinitumCorp/infinitum-nexus/apps/veil-desktop/internal/app"
	"golang.org/x/sys/windows"
)

const (
	wmUser       = 0x0400
	wmCommand    = 0x0111
	wmLButtonUp  = 0x0202
	wmRButtonUp  = 0x0205
	wmDestroy    = 0x0002
	nimAdd       = 0x00000000
	nimDelete    = 0x00000002
	nifMessage   = 0x00000001
	nifIcon      = 0x00000002
	nifTip       = 0x00000004
	mfString     = 0x00000000
	mfSeparator  = 0x00000800
	idiShield    = 32518
	trayCallback = wmUser + 1
)

var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	shell32             = windows.NewLazySystemDLL("shell32.dll")
	procRegisterClass   = user32.NewProc("RegisterClassExW")
	procCreateWindow    = user32.NewProc("CreateWindowExW")
	procDefWindowProc   = user32.NewProc("DefWindowProcW")
	procGetMessage      = user32.NewProc("GetMessageW")
	procTranslate       = user32.NewProc("TranslateMessage")
	procDispatch        = user32.NewProc("DispatchMessageW")
	procPostQuit        = user32.NewProc("PostQuitMessage")
	procLoadIcon        = user32.NewProc("LoadIconW")
	procCreatePopupMenu = user32.NewProc("CreatePopupMenu")
	procAppendMenu      = user32.NewProc("AppendMenuW")
	procTrackPopupMenu  = user32.NewProc("TrackPopupMenu")
	procSetForeground   = user32.NewProc("SetForegroundWindow")
	procDestroyMenu     = user32.NewProc("DestroyMenu")
	procGetCursorPos    = user32.NewProc("GetCursorPos")
	procShellNotify     = shell32.NewProc("Shell_NotifyIconW")
)

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   windows.Handle
	icon       windows.Handle
	cursor     windows.Handle
	background windows.Handle
	menuName   *uint16
	className  *uint16
	iconSm     windows.Handle
}

type point struct{ x, y int32 }

type msg struct {
	hwnd    windows.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type notifyIcon struct {
	size            uint32
	wnd             windows.Handle
	id              uint32
	flags           uint32
	callbackMessage uint32
	icon            windows.Handle
	tip             [128]uint16
}

// Run shows the notification-area menu: VEIL VPN, Tor, Off, Quit.
func Run(ctx context.Context, controller *app.Controller) error {
	class, _ := windows.UTF16PtrFromString("InfinitumVeilDesktop")
	title, _ := windows.UTF16PtrFromString("VEIL Desktop")
	instance, _, _ := procLoadIcon.Call(0, idiShield)
	var hwnd windows.Handle
	cb := windows.NewCallback(func(h uintptr, m uint32, w, l uintptr) uintptr {
		switch m {
		case trayCallback:
			if l == wmRButtonUp || l == wmLButtonUp {
				showMenu(windows.Handle(h), controller, ctx)
			}
		case wmCommand:
			applyCommand(app.Mode(""), commandID(w), controller, ctx)
		case wmDestroy:
			procPostQuit.Call(0)
		default:
			ret, _, _ := procDefWindowProc.Call(h, uintptr(m), w, l)
			return ret
		}
		return 0
	})
	classEx := wndClassEx{wndProc: cb, instance: windows.Handle(instance), className: class}
	classEx.size = uint32(unsafe.Sizeof(classEx))
	procRegisterClass.Call(uintptr(unsafe.Pointer(&classEx)))
	hwndRaw, _, _ := procCreateWindow.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0, 0, 0, 0, 0, 0, 0, uintptr(instance), 0)
	hwnd = windows.Handle(hwndRaw)
	icon, _, _ := procLoadIcon.Call(0, idiShield)
	nid := notifyIcon{
		wnd: hwnd, id: 1, flags: nifMessage | nifIcon | nifTip, callbackMessage: trayCallback, icon: windows.Handle(icon),
	}
	nid.size = uint32(unsafe.Sizeof(nid))
	tip, _ := windows.UTF16FromString("Infinitum Corporation® VEIL Desktop")
	copy(nid.tip[:], tip)
	procShellNotify.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	defer procShellNotify.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	go func() {
		<-ctx.Done()
		_ = controller.SetMode(context.Background(), app.ModeOff)
		procPostQuit.Call(0)
	}()
	var message msg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		procTranslate.Call(uintptr(unsafe.Pointer(&message)))
		procDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
	return controller.SetMode(context.Background(), app.ModeOff)
}

func showMenu(hwnd windows.Handle, controller *app.Controller, ctx context.Context) {
	menu, _, _ := procCreatePopupMenu.Call()
	defer procDestroyMenu.Call(menu)
	appendItem(menu, 1, "VEIL VPN")
	appendItem(menu, 2, "Tor")
	appendItem(menu, 3, "Off")
	procAppendMenu.Call(menu, mfSeparator, 0, 0)
	appendItem(menu, 5, "Quit")
	var cursor point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor)))
	procSetForeground.Call(uintptr(hwnd))
	procTrackPopupMenu.Call(menu, 0, uintptr(cursor.x), uintptr(cursor.y), 0, uintptr(hwnd), 0)
	_ = controller
	_ = ctx
}

func appendItem(menu uintptr, id uintptr, label string) {
	text, _ := windows.UTF16PtrFromString(label)
	procAppendMenu.Call(menu, mfString, id, uintptr(unsafe.Pointer(text)))
}

func commandID(wparam uintptr) Command {
	switch wparam & 0xffff {
	case 1:
		return CommandVeil
	case 2:
		return CommandTor
	case 3:
		return CommandOff
	default:
		return CommandQuit
	}
}

func applyCommand(mode app.Mode, cmd Command, controller *app.Controller, ctx context.Context) {
	switch cmd {
	case CommandVeil:
		_ = controller.SetMode(ctx, app.ModeVeil)
	case CommandTor:
		_ = controller.SetMode(ctx, app.ModeTor)
	case CommandOff, CommandQuit:
		_ = controller.SetMode(ctx, app.ModeOff)
	}
	_ = mode
}
