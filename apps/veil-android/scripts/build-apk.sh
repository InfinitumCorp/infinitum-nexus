#!/bin/sh
# Build the debug VEIL APK. Does not change host routes, firewall, or /dev/kvm.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
sdk=${ANDROID_HOME:-/tmp/android-sdk}
ndk=${ANDROID_NDK_HOME:-$sdk/ndk/27.2.12479018}
export ANDROID_HOME=$sdk
export ANDROID_NDK_HOME=$ndk
export GOTOOLCHAIN=go1.26.10
if [ -r /dev/kvm ]; then
  echo "kvm: readable by this user"
else
  echo "kvm: not readable by this user; emulator acceleration is unavailable and this script will not change /dev/kvm"
fi
mkdir -p "$root/android/app/libs"
bindir=$root/.gocache/bin
mkdir -p "$bindir"
(
  cd "$root/mobile"
  GOBIN=$bindir go install tool
)
export PATH="$bindir:$PATH"
gomobile init
(
  cd "$root/mobile"
  gomobile bind \
    -target=android/arm64,android/amd64 -androidapi 26 -javapkg=app.infinitum.veil \
    -o "$root/android/app/libs/veil.aar" .
)
if [ ! -x "$root/android/gradlew" ]; then
  gradle_bin=${GRADLE_BIN:-gradle}
  (cd "$root/android" && "$gradle_bin" wrapper --gradle-version 8.11.1)
fi
(cd "$root/android" && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon)
apk=$root/android/app/build/outputs/apk/debug/app-debug.apk
testapk=$root/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
sha256sum "$apk" "$testapk"
