package system

import (
	"errors"
	"net"
	"strings"
)

// parseWindowsDefaultGateway reads `route print -4` and returns the IPv4 default gateway.
func parseWindowsDefaultGateway(text string) (string, error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[0] != "0.0.0.0" || fields[1] != "0.0.0.0" {
			continue
		}
		if fields[2] == "0.0.0.0" || net.ParseIP(fields[2]) == nil {
			continue
		}
		return fields[2], nil
	}
	return "", errors.New("no IPv4 default gateway")
}
