#!/usr/bin/env bash
# Read-only report of InfinitumCorp GitHub hygiene, plus optional destructive
# cleanup when HYGIENE_APPLY=1 is set by an org admin.
set -euo pipefail

ORG="${GITHUB_ORG:-InfinitumCorp}"
REPO="${GITHUB_REPO:-infinitum-nexus}"
FULL="$ORG/$REPO"

need_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh is required" >&2
    exit 1
  fi
}

list_merged_heads() {
  gh pr list -R "$FULL" --state merged --limit 200 --json headRefName --jq '.[].headRefName' | sort -u
}

list_remote_branches() {
  gh api "repos/$FULL/branches" --paginate --jq '.[].name' | sort -u
}

list_open_heads() {
  gh pr list -R "$FULL" --state open --limit 200 --json headRefName --jq '.[].headRefName' | sort -u
}

report() {
  need_gh
  echo "== $FULL hygiene report =="
  echo
  echo "Open PRs: $(gh pr list -R "$FULL" --state open --limit 200 --json number --jq 'length')"
  echo "Remote branches: $(list_remote_branches | wc -l | tr -d ' ')"
  echo
  echo "-- Open PRs --"
  gh pr list -R "$FULL" --state open --limit 200
  echo
  echo "-- Branches whose tips were already merged (safe delete candidates) --"
  local merged open remote
  merged="$(mktemp)"
  open="$(mktemp)"
  remote="$(mktemp)"
  list_merged_heads >"$merged"
  list_open_heads >"$open"
  list_remote_branches >"$remote"
  # present on remote, appeared as a merged PR head, not currently an open PR head, not main
  comm -12 "$remote" "$merged" | grep -vx main | while read -r b; do
    if ! grep -qxF "$b" "$open"; then
      echo "$b"
    fi
  done
  echo
  echo "-- backup/* branches (delete or retag) --"
  grep -E '^backup/' "$remote" || true
  echo
  echo "-- Conflicting open PRs --"
  gh pr list -R "$FULL" --state open --limit 200 --json number,title,mergeable,url \
    --jq '.[] | select(.mergeable=="CONFLICTING") | "#\(.number) \(.title) — \(.url)"'
  rm -f "$merged" "$open" "$remote"
}

apply_deletes() {
  need_gh
  if [[ "${HYGIENE_APPLY:-}" != "1" ]]; then
    echo "Refusing to delete: set HYGIENE_APPLY=1 to apply." >&2
    exit 2
  fi
  echo "Deleting merged head branches that are not open PR heads…"
  local merged open remote
  merged="$(mktemp)"
  open="$(mktemp)"
  remote="$(mktemp)"
  list_merged_heads >"$merged"
  list_open_heads >"$open"
  list_remote_branches >"$remote"
  comm -12 "$remote" "$merged" | grep -vx main | while read -r b; do
    if ! grep -qxF "$b" "$open"; then
      echo "git push origin --delete $b"
      git push origin --delete "$b"
    fi
  done
  if [[ "${HYGIENE_DELETE_BACKUPS:-}" == "1" ]]; then
    echo "Deleting backup/* branches…"
    grep -E '^backup/' "$remote" | while read -r b; do
      echo "git push origin --delete $b"
      git push origin --delete "$b"
    done
  fi
  rm -f "$merged" "$open" "$remote"
}

case "${1:-report}" in
  report) report ;;
  apply) apply_deletes ;;
  *)
    echo "Usage: $0 [report|apply]" >&2
    exit 1
    ;;
esac
