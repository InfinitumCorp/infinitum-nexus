// Copyright Infinitum Corporation.

package tunnel

import (
	"fmt"
	"strings"
	"sync"

	"golang.zx2c4.com/wireguard/device"
)

// memLog records WireGuard error lines and strips configured secrets.
// Verbose device logs are discarded so UAPI traces are not retained.
type memLog struct {
	mu      sync.Mutex
	lines   []string
	secrets []string
}

func (m *memLog) logger() *device.Logger {
	return &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   m.record,
	}
}

func (m *memLog) addSecret(secret string) {
	if secret == "" {
		return
	}
	m.mu.Lock()
	m.secrets = append(m.secrets, secret, strings.ToUpper(secret))
	m.mu.Unlock()
}

func (m *memLog) record(format string, args ...any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	line := redact(fmt.Sprintf(format, args...), m.secrets)
	m.lines = append(m.lines, line)
}

func (m *memLog) text() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(m.lines, "\n")
}

func redact(line string, secrets []string) string {
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		line = strings.ReplaceAll(line, secret, "[redacted]")
	}
	return line
}
