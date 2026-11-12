#!/usr/bin/env bash
# Vendors the official Amplitude Android SDK (com.amplitude:analytics-android 1.37.1) and its
# runtime dependencies into apps/android-shared/amplitude/.deps/, for the Gradle-less Android apps
# (Cumulus Mail, +SPCTR, METATRON¹⁰⁰). Every artifact comes from Maven Central or Google Maven and
# is pinned by SHA-256; nothing is unpacked unless its hash matches.
#
# Output:
#   .deps/jars/*.jar      classes for javac (-classpath) and d8 (program input)
#   .deps/res/values/     the two library resources the runtime reads (androidx.startup's
#                         "androidx_startup" string, lifecycle-runtime's view-tree id); link them with
#                         aapt2 --extra-packages androidx.startup:androidx.lifecycle.runtime
#
# Left out on purpose: androidx.core / core-ktx (location and view-hierarchy code, both disabled),
# androidx.fragment and Compose (looked up at runtime and skipped when absent), OkHttp (optional),
# profileinstaller (an optimisation only). Those code paths never run with Analytics.java's settings.
set -euo pipefail
cd "$(dirname "$0")"

MAVEN=https://repo1.maven.org/maven2
GOOGLE=https://dl.google.com/dl/android/maven2
# repo  path-without-extension  extension  sha256
ARTIFACTS="
MAVEN  com/amplitude/analytics-android/1.37.1/analytics-android-1.37.1                          aar 6479c5f75f48a6ea2818c9877e823b0246f819ebbdb0ec6e4ef5a32a3f0afc1c
MAVEN  com/amplitude/analytics-core/1.37.1/analytics-core-1.37.1                                jar d6fe5ac484be00f1ef48e01a536ff4c946711a736a8112e559e6d8ce0380c529
MAVEN  com/amplitude/analytics-connector/1.0.0/analytics-connector-1.0.0                        aar 1c7debd45524344399b6339f5139edca61bef5df5e74357fc66bc1abdd1caab8
MAVEN  org/jetbrains/kotlin/kotlin-stdlib/1.9.25/kotlin-stdlib-1.9.25                           jar f9cdcdbff1f5de85380ae526977e683726c2aa42db1ed6e6e50ae89e496e95fd
MAVEN  org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.8.1/kotlinx-coroutines-core-jvm-1.8.1 jar f3d4f5de1c391bbcc20f3b3435ccbac013521e76b6902d7d59635ec15c1f797e
MAVEN  org/jetbrains/kotlinx/kotlinx-coroutines-android/1.8.1/kotlinx-coroutines-android-1.8.1  jar a134dacf4e6578b29b32e97aa50548d09cb45e3cb3551ce77ac27e55e265d8f5
MAVEN  com/squareup/curtains/curtains/1.2.5/curtains-1.2.5                                      aar 1afd155dc4c7997b8fcf9c96be0bd4358eace2b54897c1c9036ffdb7b0663d27
GOOGLE androidx/lifecycle/lifecycle-process/2.8.7/lifecycle-process-2.8.7                       aar 62e076a2de2d650a23bf79495419f8a4357ad8e9b28d801318d0fcdd6e35fa87
GOOGLE androidx/lifecycle/lifecycle-runtime-android/2.8.7/lifecycle-runtime-android-2.8.7       aar b8eb997dd434d70eb97cbd6d1395b6337c6771717c7acd59f11c0853f3860284
GOOGLE androidx/lifecycle/lifecycle-common-jvm/2.8.7/lifecycle-common-jvm-2.8.7                 jar 61c873a7327c946ec033c310bb98f3f92eeabcede0e1a5200ab8a1896483c7bf
GOOGLE androidx/arch/core/core-common/2.2.0/core-common-2.2.0                                   jar 65308a06b1c00ee186cb9e19321383f043b993813f1522c47f4a3e3303bdba41
GOOGLE androidx/arch/core/core-runtime/2.2.0/core-runtime-2.2.0                                 aar a1be5e0caa2b07623862af6ae21b3ab0718123245184d0e30dea81b53f990a47
GOOGLE androidx/startup/startup-runtime/1.1.1/startup-runtime-1.1.1                             aar e0a6329a371262fe4c450372b70fdaf33b769ef6917094723787cfce896b1dd3
GOOGLE androidx/tracing/tracing/1.0.0/tracing-1.0.0                                             aar 07b8b6139665b884a162eccf97891ca50f7f56831233bf25168ae04f7b568612
"

D=.deps
STAMP="$D/stamp-1-amplitude-1.37.1"
[ -f "$STAMP" ] && exit 0
# Keep verified downloads in .deps/dl (each is re-checked); rebuild everything else.
mkdir -p "$D/dl" && find "$D" -mindepth 1 -maxdepth 1 ! -name dl -exec rm -rf {} + && mkdir -p "$D/jars" "$D/res/values"

fetch() { # url file sha256
  if [ -f "$2" ] && [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ]; then return 0; fi
  curl -sSfL --retry 3 -o "$2" "$1"
  local got; got="$(sha256sum "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "SHA-256 mismatch for $1: got $got" >&2; rm -f "$2"; exit 1; fi
}

echo "$ARTIFACTS" | while read -r repo path ext sha; do
  [ -z "$repo" ] && continue
  if [ "$repo" = GOOGLE ]; then base="$GOOGLE"; else base="$MAVEN"; fi
  name="$(basename "$path")"
  f="$D/dl/$name.$ext"
  fetch "$base/$path.$ext" "$f" "$sha"
  if [ "$ext" = aar ]; then
    unzip -p "$f" classes.jar > "$D/jars/$name.jar"
  else
    cp "$f" "$D/jars/$name.jar"
  fi
done

unzip -p "$D/dl/startup-runtime-1.1.1.aar" res/values/values.xml > "$D/res/values/androidx-startup.xml"
unzip -p "$D/dl/lifecycle-runtime-android-2.8.7.aar" res/values/values.xml > "$D/res/values/androidx-lifecycle-runtime.xml"
touch "$STAMP"
echo "Fetched Amplitude analytics-android 1.37.1 and its runtime dependencies into $(pwd)/$D/"
