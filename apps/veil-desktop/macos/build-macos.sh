#!/usr/bin/env bash
# Builds the NetworkExtension app when Xcode is present.
# wireguard-apple is fetched at a pinned tag and is not copied into git.
set -euo pipefail
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "macOS NetworkExtension build skipped: xcodebuild is not available"
  exit 0
fi
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/../build/wireguard-apple"
if [[ ! -d "$src/.git" ]]; then
  git clone --depth 1 --branch 1.0.16-27 https://github.com/WireGuard/wireguard-apple.git "$src"
fi
echo "WireGuardKit sources are at $src (MIT, tag 1.0.16-27)."
echo "Open macos/PacketTunnel in an Xcode app target that links WireGuardKit."
echo "Signing, the packet-tunnel-provider entitlement, and notarization are not performed here."
exit 0
