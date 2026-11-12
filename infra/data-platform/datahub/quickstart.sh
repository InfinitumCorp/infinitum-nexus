#!/usr/bin/env bash
# Start DataHub locally from its official, pinned quickstart. DataHub brings its own
# Kafka, MySQL and search containers (about 8 GB RAM), so it is kept out of the core
# compose file and started only when you work on the catalog.
set -euo pipefail
DATAHUB_CLI_VERSION="1.7.0.20"   # PyPI acryl-datahub (Apache-2.0)
DATAHUB_SERVER_VERSION="v1.7.0.1" # acryldata/datahub-* images
VENV="${DATAHUB_VENV:-$HOME/.cache/cumulus-datahub-venv}"

python3 -m venv "$VENV"
"$VENV/bin/pip" install -q "acryl-datahub[datahub-rest,postgres,elasticsearch]==$DATAHUB_CLI_VERSION"
"$VENV/bin/datahub" docker quickstart --version "$DATAHUB_SERVER_VERSION"
echo "DataHub UI: http://localhost:9002   GMS: http://localhost:8080"
echo "Ingest: $VENV/bin/datahub ingest -c infra/data-platform/datahub/recipes/<recipe>.yml"
