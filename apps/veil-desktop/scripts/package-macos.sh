#!/usr/bin/env bash
# Wraps the unsigned darwin binaries in .app bundles.
# A mountable DMG needs hdiutil, which is macOS-only. This script records that
# and writes a zip of the .app instead of a fake disk image.
set -euo pipefail
src="${1:?darwin directory}"
dest="${2:?artifact directory}"

make_app() {
  local arch="$1"
  local bin="$2"
  local app="$dest/VEILDesktop-${arch}-utun.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$bin" "$app/Contents/MacOS/veil-desktop"
  chmod 755 "$app/Contents/MacOS/veil-desktop"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>corporation.infinitum.veil.utun.${arch}</string>
  <key>CFBundleName</key><string>VEIL Desktop</string>
  <key>CFBundleDisplayName</key><string>VEIL</string>
  <key>CFBundleExecutable</key><string>veil-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.9.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHumanReadableCopyright</key><string>Infinitum Corporation®</string>
</dict>
</plist>
EOF
  if command -v hdiutil >/dev/null 2>&1; then
    hdiutil create -volname "VEIL Desktop" -srcfolder "$app" -ov -format UDZO "$dest/VEILDesktop-${arch}-unsigned.dmg"
  fi
  (cd "$dest" && zip -qr "VEILDesktop-${arch}-unsigned-app.zip" "VEILDesktop-${arch}-utun.app")
}

make_app amd64 "$src/veil-desktop-amd64"
make_app arm64 "$src/veil-desktop-arm64"
if ! command -v hdiutil >/dev/null 2>&1; then
  echo "unsigned DMG was not produced: hdiutil is not available on this machine" | tee "$dest/logs/dmg.log"
fi
