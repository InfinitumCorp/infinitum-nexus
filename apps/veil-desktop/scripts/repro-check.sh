#!/usr/bin/env bash
# Build the unsigned desktop artifacts twice and fail if any hashed byte changes.
# The second build uses a cold GOCACHE.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
a="$(mktemp -d)"
b="$(mktemp -d)"
cache="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$cache"' EXIT
ARTIFACT_DIR="$a" bash "$root/scripts/build-reproducible.sh"
GOCACHE="$cache" ARTIFACT_DIR="$b" bash "$root/scripts/build-reproducible.sh"
diff -u "$a/SHA256SUMS" "$b/SHA256SUMS"
(cd "$a" && sha256sum -c SHA256SUMS)
(cd "$b" && sha256sum -c SHA256SUMS)
while IFS= read -r line; do
  path="${line#*  }"
  cmp -s "$a/$path" "$b/$path" || {
    echo "desktop artifact changed between builds: $path" >&2
    exit 1
  }
done < "$a/SHA256SUMS"
echo "desktop artifacts match"
