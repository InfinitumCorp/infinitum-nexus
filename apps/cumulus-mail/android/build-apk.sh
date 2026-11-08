#!/usr/bin/env bash
# Builds the Cumulus Mail Android app with the plain SDK tools (no Gradle).
#
#   MAIL_URL=https://mail.cumuluscloud.app bash apps/cumulus-mail/android/build-apk.sh
#
# Needs ANDROID_HOME (build-tools 35+ and platform 35+) and a JDK 17+.
# Signs with KEYSTORE / KEY_ALIAS / KEY_PASS when set, otherwise with the local debug key.
# The release key lives outside the repo (for example ~/.cumulus-mail/release.keystore); keep it backed up:
# Android only accepts updates signed with the same key.
# Output: apps/cumulus-mail/android/build/cumulus-mail.apk
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
SDK="${SDK//\\//}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
JAR="$PLATFORM/android.jar"
MAIL_URL="${MAIL_URL:-https://mail.cumuluscloud.app}"
OUT="$HERE/build"
EXE=""; [ -f "$BT/aapt2.exe" ] && EXE=".exe"
BAT=""; [ -f "$BT/d8.bat" ] && BAT=".bat"

rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"
cp -r "$HERE/res/." "$OUT/res/"
sed -i "s#<string name=\"mail_url\" translatable=\"false\">[^<]*</string>#<string name=\"mail_url\" translatable=\"false\">${MAIL_URL}</string>#" "$OUT/res/values/strings.xml"

"$BT/aapt2$EXE" compile --dir "$OUT/res" -o "$OUT/res.zip"
"$BT/aapt2$EXE" link -o "$OUT/unsigned.apk" -I "$JAR" --manifest "$HERE/AndroidManifest.xml" --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 35 "$OUT/res.zip"
javac -source 11 -target 11 -nowarn -Xlint:-options -classpath "$JAR" -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name "*.java")
"$BT/d8$BAT" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name "*.class")
(cd "$OUT/dex" && jar uf "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign$EXE" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="${KEYSTORE:-$HOME/.android/debug.keystore}"
"$BT/apksigner$BAT" sign --ks "$KS" --ks-key-alias "${KEY_ALIAS:-androiddebugkey}" \
  --ks-pass "pass:${KEY_PASS:-android}" --key-pass "pass:${KEY_PASS:-android}" --out "$OUT/cumulus-mail.apk" "$OUT/aligned.apk"
"$BT/apksigner$BAT" verify "$OUT/cumulus-mail.apk"
echo "Built $OUT/cumulus-mail.apk for $MAIL_URL"
