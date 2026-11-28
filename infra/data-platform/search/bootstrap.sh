#!/bin/bash
# Installs the events index template in OpenSearch. Idempotent.
set -euo pipefail
OS="${1:-http://localhost:9200}"
DIR="$(cd "$(dirname "$0")" && pwd)"
for _ in $(seq 1 60); do curl -fs "$OS/_cluster/health" >/dev/null && break; sleep 2; done
curl -fsS -X PUT "$OS/_index_template/cumulus-events" -H 'Content-Type: application/json' \
  --data-binary "@$DIR/events-template.json"
echo
# One write alias for the first index. The gateway reads cumulus-events-* and always adds
# product and tenant term filters to the query (platform.py), so there are no per-tenant aliases.
if ! curl -fs "$OS/_alias/cumulus-events-write" >/dev/null; then
  curl -fsS -X PUT "$OS/cumulus-events-000001" -H 'Content-Type: application/json' \
    -d '{"aliases":{"cumulus-events-write":{"is_write_index":true}}}'
  echo
fi
# Product documents (documents.py): one index, strict mapping. People are pseudonyms only.
if ! curl -fs "$OS/cumulus-documents" >/dev/null; then
  curl -fsS -X PUT "$OS/cumulus-documents" -H 'Content-Type: application/json' \
    --data-binary "@$DIR/documents-index.json"
  echo
else
  # Fields added after the index was first created. Adding a field to a mapping is safe to repeat.
  curl -fsS -X PUT "$OS/cumulus-documents/_mapping" -H 'Content-Type: application/json'     -d '{"properties":{"expiresAt":{"type":"date"}}}'
  echo
fi
echo "search bootstrap done"
