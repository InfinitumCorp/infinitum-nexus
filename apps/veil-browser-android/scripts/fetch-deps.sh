#!/usr/bin/env bash
# Fetch VEIL's two third-party pieces into .deps/, pinned by SHA-256:
#   Tor        the Tor Project's own Android build (tor-expert-bundle, from Tor Browser)
#   androidx   androidx.webkit (ProxyController, document-start scripts) plus the two
#              androidx.core classes it uses
# Nothing is unpacked unless its hash matches. To update Tor: bump TOR_VERSION, check
# the signature on sha256sums-signed-build.txt (Tor Browser Developers signing key,
# EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290), and copy the new hashes in here.
set -euo pipefail
cd "$(dirname "$0")/.."

TOR_VERSION=16.0
TOR_URL="https://dist.torproject.org/torbrowser/$TOR_VERSION"
# Tor Browser ABI name, Android ABI, SHA-256 of tor-expert-bundle-android-<abi>-<version>.tar.gz
TOR_BUNDLES="
aarch64 arm64-v8a   bf8f4c63652fd7daa62288713c7fa512f244a5b972808f6251450e5fdfca9120
armv7   armeabi-v7a 13befa352b64c32ba460b63066179bb1c9eaf6c3ea7057ae860dcdd22b8acf7b
x86_64  x86_64      ab3152ba164bcd49e50175086c62e40ffa2bf9002a4f6473f77111bd88b0462b
"
MAVEN=https://dl.google.com/dl/android/maven2
WEBKIT=1.18.0
WEBKIT_SHA=f15a0bd7d51f4bb8dffdd3a2cf5829f9a7de9ad4ba2682fa85d619032050581f
CORE=1.1.0
CORE_SHA=76c7cfbe596fe3c09a6983bf1c89e889299c08ac9a3b52ce5182a088d056647e

D=.deps
STAMP="$D/stamp-2-tor$TOR_VERSION-webkit$WEBKIT-core$CORE"
[ -f "$STAMP" ] && exit 0
# Keep verified downloads in .deps/dl (each is re-checked); rebuild everything else.
mkdir -p "$D/dl" && find "$D" -mindepth 1 -maxdepth 1 ! -name dl -exec rm -rf {} + && mkdir -p "$D/lib" "$D/assets"

fetch() { # url file sha256
  if [ -f "$2" ] && [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ]; then return 0; fi
  curl -sSfL --retry 3 -o "$2" "$1"
  local got; got="$(sha256sum "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "SHA-256 mismatch for $1: got $got" >&2; rm -f "$2"; exit 1; fi
}
TAR_LOCAL=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) TAR_LOCAL="--force-local";; esac

echo "$TOR_BUNDLES" | while read -r tb abi sha; do
  [ -z "$tb" ] && continue
  f="$D/dl/tor-$tb.tar.gz"
  fetch "$TOR_URL/tor-expert-bundle-android-$tb-$TOR_VERSION.tar.gz" "$f" "$sha"
  mkdir -p "$D/x-$tb" "$D/lib/$abi"
  tar xzf "$f" $TAR_LOCAL -C "$D/x-$tb" tor/libTor.so tor/pluggable_transports/lyrebird \
    tor/pluggable_transports/pt_config.json docs/tor.txt docs/lyrebird.txt
  # Named lib*.so so Android unpacks them where apps may run programs.
  mv "$D/x-$tb/tor/libTor.so" "$D/lib/$abi/libTor.so"
  mv "$D/x-$tb/tor/pluggable_transports/lyrebird" "$D/lib/$abi/libLyrebird.so"
  # Tor Browser's built-in bridges (Snowflake, obfs4, meek), same in every bundle.
  cp "$D/x-$tb/tor/pluggable_transports/pt_config.json" "$D/assets/pt_config.json"
  cp "$D/x-$tb/docs/tor.txt" "$D/TOR-LICENSE.txt"
  cp "$D/x-$tb/docs/lyrebird.txt" "$D/LYREBIRD-LICENSE.txt"
  rm -rf "$D/x-$tb"
done

fetch "$MAVEN/androidx/webkit/webkit/$WEBKIT/webkit-$WEBKIT.aar" "$D/dl/webkit.aar" "$WEBKIT_SHA"
fetch "$MAVEN/androidx/core/core/$CORE/core-$CORE.aar" "$D/dl/core.aar" "$CORE_SHA"
python scripts/extract-aar.py "$D"
touch "$STAMP"
echo "Fetched Tor $TOR_VERSION (with lyrebird bridges) and androidx.webkit $WEBKIT into $D/"
