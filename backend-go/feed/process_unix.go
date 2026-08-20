//go:build !windows

package feed

import (
	"os/exec"
	"syscall"
)

// configureProcess puts the child in its own process group.
//
// The Python SDK spawns helpers of its own, and killing only the interpreter
// leaves them holding the broker subscription — which then counts against the
// account's session limit while publishing to nobody. A process group makes the
// teardown cover the whole tree.
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
