package geosetting

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMissingFileStaysOffAndFlagPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "geo-routing.json")
	file, err := Resolve(path, nil, "")
	if err != nil || file.Enabled {
		t.Fatalf("missing file = %+v %v", file, err)
	}
	if _, err := osStat(path); err == nil {
		t.Fatal("resolving the default created a settings file")
	}
	file, err = Resolve(path, []string{"--geo-routing"}, "")
	if err != nil || !file.Enabled {
		t.Fatalf("flag = %+v %v", file, err)
	}
	file, err = Resolve(path, nil, "0")
	if err != nil || !file.Enabled {
		t.Fatalf("saved on was overwritten by the environment: %+v %v", file, err)
	}
	on, err := Toggle(path)
	if err != nil || on {
		t.Fatalf("toggle = %v %v", on, err)
	}
	if present, enabled := Flag([]string{"--no-geo-routing"}); !present || enabled {
		t.Fatal("off flag was not recognized")
	}
	if FromEnv("yes") != true || FromEnv("") != false {
		t.Fatal("environment parser changed")
	}
}

func osStat(path string) (bool, error) {
	_, err := os.Stat(path)
	return err == nil, err
}
