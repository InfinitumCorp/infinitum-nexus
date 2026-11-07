//go:build linux

package policy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNetNSKillSwitchDrops(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to create a network namespace")
	}
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("nft is not installed")
	}
	ns := fmt.Sprintf("vk%x", time.Now().UnixNano()&0xfffffff)
	if out, err := exec.Command("ip", "netns", "add", ns).CombinedOutput(); err != nil {
		t.Fatalf("netns add: %v %s", err, out)
	}
	defer exec.Command("ip", "netns", "del", ns).Run()
	if out, err := exec.Command("ip", "link", "add", "vvk0", "type", "veth", "peer", "name", "vvk1").CombinedOutput(); err != nil {
		t.Fatalf("veth: %v %s", err, out)
	}
	defer exec.Command("ip", "link", "del", "vvk0").Run()
	steps := [][]string{
		{"ip", "link", "set", "vvk1", "netns", ns},
		{"ip", "addr", "add", "10.250.0.1/24", "dev", "vvk0"},
		{"ip", "link", "set", "vvk0", "up"},
		{"ip", "netns", "exec", ns, "ip", "link", "set", "lo", "up"},
		{"ip", "netns", "exec", ns, "ip", "addr", "add", "10.250.0.2/24", "dev", "vvk1"},
		{"ip", "netns", "exec", ns, "ip", "link", "set", "vvk1", "up"},
	}
	for _, step := range steps {
		if out, err := exec.Command(step[0], step[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %v %s", step, err, out)
		}
	}
	if out, err := exec.Command("ip", "netns", "exec", ns, "ping", "-c", "1", "-W", "2", "10.250.0.1").CombinedOutput(); err != nil {
		t.Fatalf("baseline ping should work before the kill switch: %v %s", err, out)
	}
	rules := RenderNft(State{Mode: ModeBlackhole})
	path := filepath.Join(t.TempDir(), "veil.nft")
	if err := os.WriteFile(path, []byte(rules), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("ip", "netns", "exec", ns, "nft", "-f", path).CombinedOutput(); err != nil {
		t.Fatalf("nft apply: %v %s\n%s", err, out, rules)
	}
	if err := exec.Command("ip", "netns", "exec", ns, "ping", "-c", "1", "-W", "2", "10.250.0.1").Run(); err == nil {
		t.Fatal("kill switch allowed a ping out of the namespace")
	}
}
