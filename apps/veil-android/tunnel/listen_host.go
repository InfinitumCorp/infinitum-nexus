//go:build !android

package tunnel

// DeviceListenIP is the UDP bind address for this process.
// Host builds stay on loopback. The Android build listens inside the device.
func DeviceListenIP() (string, bool) { return "127.0.0.1", false }
