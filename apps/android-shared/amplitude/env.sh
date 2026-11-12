# Sourced by the Gradle-less Android build scripts to add Amplitude analytics.
#   . "<repo>/apps/android-shared/amplitude/env.sh"
# Fetches the vendored SDK if needed, then sets:
#   AMP_SRC        shared Java sources (app.infinitum.analytics.Analytics), for javac
#   AMP_RES        library resources, for aapt2 compile --dir
#   AMP_PKGS       for aapt2 link --extra-packages (R classes the libraries read)
#   AMP_CP         javac classpath entries, with the platform's separator in front of each
#   AMP_JARS       the jars, space-separated, for d8 (paths have no spaces)
# and amp_path PATH, which prints PATH in the form javac takes inside a classpath list.
AMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$AMP_DIR/fetch-deps.sh"
AMP_SRC="$AMP_DIR/src"
AMP_RES="$AMP_DIR/.deps/res"
AMP_PKGS="androidx.startup:androidx.lifecycle.runtime"
AMP_JARS="$(ls "$AMP_DIR"/.deps/jars/*.jar | tr '\n' ' ')"
_amp_sep=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) _amp_sep=";";; esac
amp_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
AMP_CP=""
for _amp_j in $AMP_JARS; do AMP_CP="$AMP_CP$_amp_sep$(amp_path "$_amp_j")"; done
unset _amp_j
