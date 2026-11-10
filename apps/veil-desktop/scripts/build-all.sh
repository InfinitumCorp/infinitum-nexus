#!/usr/bin/env bash
# Tests and the unsigned reproducible artifact build. No signing and no upload.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
# shellcheck disable=SC1091
source "$root/scripts/reproducible-env.sh"
veil_prepare "$repo"
cd "$root"
mkdir -p "$root/build-logs"

echo "== test =="
go test ./... | tee "$root/build-logs/go-test.log"

echo "== selftest =="
go run ./cmd/veil-desktop selftest | tee "$root/build-logs/selftest.log"

ARTIFACT_DIR="$root/artifacts" bash "$root/scripts/build-reproducible.sh"

if command -v xcodebuild >/dev/null 2>&1; then
  bash "$root/macos/build-macos.sh" | tee "$root/build-logs/xcodebuild.log"
else
  echo "macOS Network Extension build skipped: xcodebuild is not on this machine. Signing it also needs an Apple Developer account." | tee "$root/build-logs/xcodebuild.log"
fi
echo "unsigned artifacts in $root/artifacts"
