#!/usr/bin/env bash
# Operate the $0 data platform on the self-hosted box.
#
#   bash infra/data-platform/deploy/box/box.sh check     # .env complete, Docker ready, compose valid
#   bash infra/data-platform/deploy/box/box.sh up        # build and start (idempotent)
#   bash infra/data-platform/deploy/box/box.sh status    # containers, gateway health, tunnel
#   bash infra/data-platform/deploy/box/box.sh logs [service]
#   bash infra/data-platform/deploy/box/box.sh update    # pull the current branch, rebuild, restart
#   bash infra/data-platform/deploy/box/box.sh backup    # dump the data_platform schema (keeps 7)
#   bash infra/data-platform/deploy/box/box.sh down
#
# Never prints secret values.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${BOX_ENV_FILE:-$here/.env}"
compose=(docker compose -f "$here/compose.box.yml" --env-file "$env_file")

required=(PRIVACY_GATEWAY_TOKEN PRIVACY_PSEUDONYM_KEY DATABASE_URL SUPERSET_SECRET_KEY
          SUPERSET_DB_PASSWORD CLOUDFLARE_TUNNEL_TOKEN)

die() { echo "box: $*" >&2; exit 1; }

value_of() { # last assignment of $1 in the env file, without surrounding quotes
  sed -n "s/^$1=//p" "$env_file" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

check() {
  command -v docker >/dev/null || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
  [ -f "$env_file" ] || die "missing $env_file (copy .env.example next to compose.box.yml and fill it in)"
  if [ -n "$(find "$env_file" -perm -o=r 2>/dev/null)" ]; then
    echo "box: warning: $env_file is world-readable; run: chmod 600 $env_file" >&2
  fi
  local missing=() k v
  for k in "${required[@]}"; do
    v="$(value_of "$k")"
    [ -n "$v" ] || missing+=("$k")
  done
  [ ${#missing[@]} -eq 0 ] || die "empty in .env: ${missing[*]}"
  for k in PRIVACY_GATEWAY_TOKEN PRIVACY_PSEUDONYM_KEY; do
    [ "$(value_of "$k" | wc -c)" -gt 32 ] || die "$k must be 32+ characters"
  done
  case "$(value_of DATABASE_URL)" in
    *sslmode=require*|*sslmode=verify-full*) ;;
    *) die "DATABASE_URL must use TLS: add ?sslmode=require" ;;
  esac
  case "$(value_of DATABASE_URL)" in
    *data_platform_gateway*) ;;
    *) die "DATABASE_URL must connect as the data_platform_gateway role, not postgres" ;;
  esac
  [ -n "$(value_of PLATFORM_PRODUCT_TOKENS)" ] || echo "box: note: PLATFORM_PRODUCT_TOKENS is empty, so collection, catalog and search are off" >&2
  "${compose[@]}" config -q
  echo "box: configuration ok"
}

status() {
  "${compose[@]}" ps
  echo
  if "${compose[@]}" exec -T privacy-gateway python -c \
      "import urllib.request,sys;sys.stdout.write(urllib.request.urlopen('http://127.0.0.1:8090/api/v1/health',timeout=5).read().decode())"; then
    echo
  else
    echo "box: gateway health check failed" >&2
  fi
  "${compose[@]}" logs --tail 20 cloudflared 2>/dev/null | grep -Ei "registered tunnel connection|error" | tail -n 4 || true
}

backup() {
  # The Supabase free plan has no downloadable backups, so the box keeps its own: a daily
  # data-only dump of the data_platform schema (already-redacted events, specs, DP ledger),
  # owner-only files, newest 7 kept. Run it from cron on the box, e.g.
  #   23 2 * * * bash /path/to/box.sh backup >> /var/log/cumulus-data-backup.log 2>&1
  local dir="${BOX_BACKUP_DIR:-$HOME/cumulus-data-backups}" url file
  url="$(value_of DATABASE_URL)"
  [ -n "$url" ] || die "DATABASE_URL is empty"
  mkdir -p "$dir" && chmod 700 "$dir"
  file="$dir/data_platform-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # --enable-row-security: RLS is forced on these tables, so pg_dump must apply the policies.
  # The URL goes in through the environment, never on the command line.
  docker run --rm --network host -e PGURL="$url" postgres:17.11-alpine \
    sh -c 'pg_dump "$PGURL" --schema=data_platform --data-only --enable-row-security --format=custom' > "$file.part"
  [ -s "$file.part" ] || { rm -f "$file.part"; die "backup is empty"; }
  chmod 600 "$file.part" && mv "$file.part" "$file"
  ls -1t "$dir"/data_platform-*.dump | tail -n +8 | xargs -r rm -f
  echo "box: backup written ($(du -h "$file" | cut -f1))"
}

cmd="${1:-status}"
case "$cmd" in
  check) check ;;
  up) check; "${compose[@]}" up -d --build --wait --wait-timeout 900; status ;;
  status) status ;;
  logs) shift; "${compose[@]}" logs --tail 200 -f "$@" ;;
  update)
    git -C "$here" pull --ff-only
    check
    "${compose[@]}" up -d --build --wait --wait-timeout 900
    status ;;
  down) "${compose[@]}" down ;;
  backup) backup ;;
  *) die "usage: box.sh check|up|status|logs [service]|update|backup|down" ;;
esac
