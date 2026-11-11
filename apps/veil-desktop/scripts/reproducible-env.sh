#!/usr/bin/env bash
# Shared toolchain and SOURCE_DATE_EPOCH for unsigned reproducible builds.
# Source this file. Versions live in apps/veil/scripts/toolchain.js.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "source scripts/reproducible-env.sh; do not execute it" >&2
  exit 1
fi

veil_pin() {
  local repo="$1"
  local name="$2"
  sed -n "s/^export const ${name} = \"\\([^\"]*\\)\".*/\\1/p" "$repo/apps/veil/scripts/toolchain.js"
}

veil_prepare() {
  local repo="$1"
  GO_VERSION="$(veil_pin "$repo" GO_VERSION)"
  NODE_VERSION="$(veil_pin "$repo" NODE_VERSION)"
  PNPM_VERSION="$(veil_pin "$repo" PNPM_VERSION)"
  if [[ -z "$GO_VERSION" || -z "$NODE_VERSION" || -z "$PNPM_VERSION" ]]; then
    echo "apps/veil/scripts/toolchain.js is missing a pinned version" >&2
    return 1
  fi
  export GO_VERSION NODE_VERSION PNPM_VERSION
  export GOTOOLCHAIN="go${GO_VERSION}"
  export CGO_ENABLED=0
  export GO111MODULE=on
  export GOAMD64=v1
  export GOFLAGS="-trimpath"
  export TZ=UTC
  export LC_ALL=C
  export LANG=C
  umask 022

  if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
    SOURCE_DATE_EPOCH="$(git -C "$repo" log -1 --format=%ct)"
  fi
  if [[ ! "${SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
    echo "SOURCE_DATE_EPOCH must be a non-negative integer" >&2
    return 1
  fi
  export SOURCE_DATE_EPOCH

  local node_got go_got
  node_got="$(node --version)"
  if [[ "$node_got" != "v${NODE_VERSION}" ]]; then
    echo "VEIL reproducible builds require Node v${NODE_VERSION} (running ${node_got})" >&2
    return 1
  fi
  go_got="$(go env GOVERSION 2>/dev/null || true)"
  if [[ "$go_got" != "go${GO_VERSION}" ]]; then
    echo "VEIL reproducible builds require go${GO_VERSION} (go env GOVERSION returned ${go_got:-nothing})" >&2
    return 1
  fi
}

veil_go_build() {
  local out="$1"
  shift
  go build -trimpath -buildvcs=false -mod=readonly -ldflags='-s -w -buildid=' -o "$out" "$@"
}
