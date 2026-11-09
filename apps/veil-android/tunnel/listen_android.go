//go:build android

package tunnel

// DeviceListenIP listens on all device interfaces. gomobile builds this file
// with GOOS=android, so the parent host's tests never take this path.
func DeviceListenIP() (string, bool) { return "0.0.0.0", true }
