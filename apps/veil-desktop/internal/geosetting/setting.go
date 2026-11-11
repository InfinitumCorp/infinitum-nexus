// Package geosetting stores the opt-in geo-routing switch. The default is off.
// A missing file is off and is not created until a person sets the switch.
package geosetting

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type File struct {
	Enabled   bool     `json:"enabled"`
	Countries []string `json:"countries"`
}

func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "veil-desktop", "geo-routing.json"), nil
}

func Load(path string) (File, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{}, false, nil
	}
	if err != nil {
		return File{}, false, err
	}
	var file File
	if err := json.Unmarshal(raw, &file); err != nil {
		return File{}, true, err
	}
	return file, true, nil
}

func Save(path string, file File) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(file)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

// Flag reports whether argv sets the switch. The boolean is the requested value.
func Flag(argv []string) (present, enabled bool) {
	for _, arg := range argv {
		switch arg {
		case "--geo-routing", "--geo-routing=true", "--geo-routing=on", "--geo-routing=1":
			return true, true
		case "--no-geo-routing", "--geo-routing=false", "--geo-routing=off", "--geo-routing=0":
			return true, false
		}
	}
	return false, false
}

func FromEnv(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "on", "yes":
		return true
	default:
		return false
	}
}

// Resolve applies CLI, then the saved file, then the environment. The CLI
// choice is written back. Anything else leaves a missing file missing.
func Resolve(path string, argv []string, envValue string) (File, error) {
	current, exists, err := Load(path)
	if err != nil {
		return File{}, err
	}
	present, enabled := Flag(argv)
	if present {
		current.Enabled = enabled
		return current, Save(path, current)
	}
	if exists {
		return current, nil
	}
	return File{Enabled: FromEnv(envValue)}, nil
}

func Toggle(path string) (bool, error) {
	current, _, err := Load(path)
	if err != nil {
		return false, err
	}
	current.Enabled = !current.Enabled
	if err := Save(path, current); err != nil {
		return false, err
	}
	return current.Enabled, nil
}
