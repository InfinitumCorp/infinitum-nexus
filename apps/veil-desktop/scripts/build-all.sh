#!/usr/bin/env bash
# Reproducible unsigned builds for VEIL Desktop. No store submission, no signing.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
dist="$root/artifacts"
rm -rf "$dist"
mkdir -p "$dist/logs" "$dist/windows" "$dist/darwin" "$dist/linux"
export PATH="${HOME}/sdk/go/bin:${PATH}"
export CGO_ENABLED=0
cd "$root"

echo "== test =="
go test ./... | tee "$dist/logs/go-test.log"

echo "== selftest =="
go run ./cmd/veil-desktop selftest | tee "$dist/logs/selftest.log"

echo "== linux =="
go build -trimpath -ldflags "-s -w" -o "$dist/linux/veil-desktop" ./cmd/veil-desktop
go build -trimpath -ldflags "-s -w" -o "$dist/linux/veil-exit" ./cmd/veil-exit

echo "== windows =="
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "$dist/windows/veil-desktop.exe" ./cmd/veil-desktop
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "$dist/windows/veil-exit.exe" ./cmd/veil-exit
bash "$root/scripts/fetch-wintun.sh" "$dist/windows"
bash "$root/scripts/package-msi.sh" "$dist/windows" "$dist/VEILDesktop-unsigned.msi"

echo "== darwin =="
GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "$dist/darwin/veil-desktop-amd64" ./cmd/veil-desktop
GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o "$dist/darwin/veil-desktop-arm64" ./cmd/veil-desktop
bash "$root/scripts/package-macos.sh" "$dist/darwin" "$dist"

if command -v xcodebuild >/dev/null 2>&1; then
  echo "== macos network extension =="
  bash "$root/macos/build-macos.sh" | tee "$dist/logs/xcodebuild.log"
else
  echo "macOS NetworkExtension build skipped: xcodebuild is not available. Apple Developer signing is also required." | tee "$dist/logs/xcodebuild.log"
fi

{
  echo "Infinitum Corporation® VEIL Desktop unsigned artifacts"
  echo "Built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  file "$dist/linux/veil-desktop" "$dist/windows/veil-desktop.exe" "$dist/darwin/veil-desktop-amd64" "$dist/darwin/veil-desktop-arm64" || true
  (cd "$dist" && find . -type f ! -path './logs/*' ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum)
} | tee "$dist/SHA256SUMS"

mkdir -p "$root/build-logs"
cp "$dist/logs/"*.log "$root/build-logs/"
echo "artifacts in $dist"
