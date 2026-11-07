#!/usr/bin/env bash
# Build VEIL for Android straight from the Android SDK: no Gradle, no downloads.
#   scripts/build.sh test     JVM tests for the URL rules
#   scripts/build.sh          debug-signed APK at build/veil-browser.apk
# Needs: JDK 17+, ANDROID_HOME with platforms/android-36 and build-tools/36.0.0.
set -euo pipefail
cd "$(dirname "$0")/.."

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/AppData/Local/Android/Sdk}}"
BT="$SDK/build-tools/${BUILD_TOOLS:-36.0.0}"
JAR="$SDK/platforms/${PLATFORM:-android-36}/android.jar"
EXT=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXT=".exe";; esac
BAT=""; [ -n "$EXT" ] && BAT=".bat"
OUT=build

if [ "${1:-}" = "test" ]; then
  rm -rf "$OUT/test" && mkdir -p "$OUT/test"
  javac -d "$OUT/test" src/main/java/app/infinitum/veil/browser/Privacy.java src/test/java/app/infinitum/veil/browser/PrivacyTest.java
  java -cp "$OUT/test" app.infinitum.veil.browser.PrivacyTest ../veil/lib/privacy.js
  exit 0
fi

rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex"

# 1. Bundle the VEIL hub (the web app) into assets.
node scripts/sync-hub.js

# 2. Resources.
"$BT/aapt2$EXT" compile --dir src/main/res -o "$OUT/res.zip"
"$BT/aapt2$EXT" link -o "$OUT/unsigned.apk" -I "$JAR" \
  --manifest src/main/AndroidManifest.xml \
  --java "$OUT/gen" "$OUT/res.zip" --auto-add-overlay

# 3. Code.
javac --release 17 -nowarn -cp "$JAR" -d "$OUT/classes" \
  $(find src/main/java "$OUT/gen" -name '*.java')
"$BT/d8$BAT" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
# Dex and assets go in with zipfile, not aapt2 -A: aapt2 on Windows writes
# backslashes into asset paths, which Android cannot open.
python scripts/add-to-apk.py "$OUT/unsigned.apk" "$OUT/dex/classes.dex"
python scripts/add-to-apk.py "$OUT/unsigned.apk" assets src/main/assets

# 4. Align and sign (debug key; release signing is a separate step).
"$BT/zipalign$EXT" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KS="${VEIL_KEYSTORE:-$HOME/.android/debug.keystore}"
"$BT/apksigner$BAT" sign --ks "$KS" --ks-pass "pass:${VEIL_KS_PASS:-android}" \
  --ks-key-alias "${VEIL_KS_ALIAS:-androiddebugkey}" --out "$OUT/veil-browser.apk" "$OUT/aligned.apk"
"$BT/apksigner$BAT" verify "$OUT/veil-browser.apk"
ls -la "$OUT/veil-browser.apk"
