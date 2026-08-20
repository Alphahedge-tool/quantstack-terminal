//go:build windows

package feed

import (
	"os/exec"
	"syscall"
)

// configureProcess keeps the child off the desktop.
//
// Without HideWindow, every bridge spawn flashes a console window — and the
// engine respawns on every reconnect, so a flaky session turns into a stream of
// windows stealing focus from whatever the trader is actually doing. The
// TypeScript supervisor passes windowsHide for the same reason.
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
