#!/usr/bin/env bash
# Package the extension twice and fail if the SHA-256 manifests or bytes differ.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
pins="$root/scripts/toolchain.js"
node_version="$(sed -n 's/^export const NODE_VERSION = "\([^"]*\)".*/\1/p' "$pins")"
pnpm_version="$(sed -n 's/^export const PNPM_VERSION = "\([^"]*\)".*/\1/p' "$pins")"
if [[ "$(node --version)" != "v${node_version}" ]]; then
  echo "VEIL reproducible builds require Node v${node_version} (running $(node --version))" >&2
  exit 1
fi
if [[ "$(pnpm --version)" != "$pnpm_version" ]]; then
  echo "VEIL reproducible builds require pnpm ${pnpm_version} (running $(pnpm --version))" >&2
  exit 1
fi
a="$(mktemp -d)"
b="$(mktemp -d)"
trap 'rm -rf "$a" "$b"' EXIT
node "$root/scripts/package.js" "$a"
node "$root/scripts/package.js" "$b"
diff -u "$a/SHA256SUMS" "$b/SHA256SUMS"
(cd "$a" && sha256sum -c SHA256SUMS)
(cd "$b" && sha256sum -c SHA256SUMS)
while IFS= read -r line; do
  path="${line#*  }"
  cmp -s "$a/$path" "$b/$path" || {
    echo "extension artifact changed between builds: $path" >&2
    exit 1
  }
done < "$a/SHA256SUMS"
git -C "$repo" rev-parse HEAD >/dev/null
echo "extension artifacts match"
