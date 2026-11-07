#!/usr/bin/env bash
# Unsigned reproducible VEIL Desktop artifacts. No store upload and no signing.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
# shellcheck disable=SC1091
source "$root/scripts/reproducible-env.sh"
veil_prepare "$repo"

dist="${ARTIFACT_DIR:-$root/artifacts}"
rm -rf "$dist"
mkdir -p "$dist/linux" "$dist/windows" "$dist/darwin"
archive="$repo/apps/veil/scripts/archive.js"
cd "$root"

veil_go_build "$dist/linux/veil-desktop" ./cmd/veil-desktop
veil_go_build "$dist/linux/veil-exit" ./cmd/veil-exit

GOOS=windows GOARCH=amd64 veil_go_build "$dist/windows/veil-desktop.exe" ./cmd/veil-desktop
GOOS=windows GOARCH=amd64 veil_go_build "$dist/windows/veil-exit.exe" ./cmd/veil-exit
bash "$root/scripts/fetch-wintun.sh" "$dist/windows"
bash "$root/scripts/package-msi.sh" "$dist/windows" "$dist/VEILDesktop-unsigned.msi"

GOOS=darwin GOARCH=amd64 veil_go_build "$dist/darwin/veil-desktop-amd64" ./cmd/veil-desktop
GOOS=darwin GOARCH=arm64 veil_go_build "$dist/darwin/veil-desktop-arm64" ./cmd/veil-desktop
bash "$root/scripts/package-macos.sh" "$dist/darwin" "$dist"

node "$archive" pack --base "$dist/linux" --out "$dist/veil-linux-amd64.zip" --format zip --epoch "$SOURCE_DATE_EPOCH"
node "$archive" pack --base "$dist/linux" --out "$dist/veil-linux-amd64.tar" --format tar --epoch "$SOURCE_DATE_EPOCH"
node "$archive" pack --base "$dist/windows" --out "$dist/veil-windows-amd64.zip" --format zip --epoch "$SOURCE_DATE_EPOCH"
node "$archive" pack --base "$dist/windows" --out "$dist/veil-windows-amd64.tar" --format tar --epoch "$SOURCE_DATE_EPOCH"

wixl_version="absent"
if command -v wixl >/dev/null 2>&1; then
  wixl_version="$(wixl --version | tr -d '[:space:]')"
fi
cat > "$dist/BUILDINFO" <<EOF
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
GO_VERSION=${GO_VERSION}
NODE_VERSION=${NODE_VERSION}
GIT_COMMIT=$(git -C "$repo" rev-parse HEAD)
GOAMD64=v1
CGO_ENABLED=0
BUILDVCS=false
UNSIGNED=1
WIXL=${wixl_version}
EOF

node "$archive" manifest --dir "$dist" --out "$dist/SHA256SUMS" --exclude '*.dmg' --exclude 'logs/'
(cd "$dist" && sha256sum -c SHA256SUMS)
echo "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
echo "$dist/SHA256SUMS"
