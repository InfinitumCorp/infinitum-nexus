#!/usr/bin/env bash
# Mints a device grant with the VEIL control plane, then carries a payload
# through wireguard-go using those keys. Key files stay in a temp directory.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
export PATH="${HOME}/sdk/go/bin:${PATH}"
export PATH="${HOME}/.nvm/versions/node/v22.23.4/bin:${PATH}"
dir="$(mktemp -d)"
cleanup() { rm -rf "$dir"; }
trap cleanup EXIT
node --experimental-strip-types "$root/scripts/mint-fixture.ts" "$dir"
cd "$root"
VEIL_FIXTURE_DIR="$dir" go test ./internal/tunnel -count=1 -run TestControlPlaneFixture
echo "control-plane wireguard fixture carried a payload"
