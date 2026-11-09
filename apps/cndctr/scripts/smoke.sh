#!/usr/bin/env bash
# Public /health, branded UI, and a rejected anonymous perform.
set -euo pipefail
port="${1:-3011}"
image="${IMAGE:-cndctr:ci}"
name="cndctr-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" -p "${port}:3011" "$image" >/dev/null
ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" -ne 1 ]]; then
  docker logs "$name" >&2 || true
  echo "cndctr did not become healthy" >&2
  exit 1
fi
health="$(curl -fsS "http://127.0.0.1:${port}/health")"
printf '%s\n' "$health"
printf '%s\n' "$health" | grep -q '"ok":true'
printf '%s\n' "$health" | grep -q '"service":"cndctr"'
curl -fsS "http://127.0.0.1:${port}/" | grep -q 'Infinitum Corporation®'
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${port}/api/perform" -H 'content-type: application/json' -d '{"intent":"hello","autonomy":"rehearsal"}')"
test "$code" = "401"
curl -fsS "http://127.0.0.1:${port}/health" >/dev/null
echo "cndctr smoke ok"
