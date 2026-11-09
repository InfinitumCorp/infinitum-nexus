#!/usr/bin/env bash
# Build installable tarballs for the Labyrinth packages. Does not publish.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
out="${1:-$root/artifacts/labyrinth}"
mkdir -p "$out"
rm -f "$out"/*.tgz "$out"/SHA256SUMS
pnpm --filter @infinitum/lbrnth pack --pack-destination "$out"
pnpm --filter @infinitum/lbrnth-client pack --pack-destination "$out"
(
  cd "$out"
  sha256sum ./*.tgz | tee SHA256SUMS
)
echo "Packed Labyrinth artifacts in $out"
