#!/bin/bash
# Installs the events index template in OpenSearch. Idempotent.
set -euo pipefail
OS="${1:-http://localhost:9200}"
DIR="$(cd "$(dirname "$0")" && pwd)"
for _ in $(seq 1 60); do curl -fs "$OS/_cluster/health" >/dev/null && break; sleep 2; done
curl -fsS -X PUT "$OS/_index_template/cumulus-events" -H 'Content-Type: application/json' \
  --data-binary "@$DIR/events-template.json"
echo
# One write alias for the first monthly index. Readers use per-tenant filtered aliases
# (cumulus-events-<tenant>), created when a tenant is provisioned.
if ! curl -fs "$OS/_alias/cumulus-events-write" >/dev/null; then
  curl -fsS -X PUT "$OS/cumulus-events-000001" -H 'Content-Type: application/json' \
    -d '{"aliases":{"cumulus-events-write":{"is_write_index":true}}}'
  echo
fi
echo "search bootstrap done"
