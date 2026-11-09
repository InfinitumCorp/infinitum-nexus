#!/usr/bin/env bash
# Downloads the official Wintun prebuilt DLL and checks its digest.
# Redistribution is allowed beside an application that uses the Wintun API.
# The DLL is not modified.
set -euo pipefail
dest="${1:?destination directory}"
zip="/tmp/wintun-0.14.1.zip"
url="https://www.wintun.net/builds/wintun-0.14.1.zip"
zip_sha="07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51"
dll_sha="e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce"
if [[ ! -f "$zip" ]] || ! echo "$zip_sha  $zip" | sha256sum -c - >/dev/null 2>&1; then
  curl -fsSL -o "$zip" "$url"
fi
echo "$zip_sha  $zip" | sha256sum -c -
tmp="$(mktemp -d)"
unzip -q -o "$zip" -d "$tmp"
echo "$dll_sha  $tmp/wintun/bin/amd64/wintun.dll" | sha256sum -c -
cp "$tmp/wintun/bin/amd64/wintun.dll" "$dest/wintun.dll"
cp "$tmp/wintun/LICENSE.txt" "$dest/WINTUN-LICENSE.txt"
rm -rf "$tmp"
