# © Infinitum Corporation®. All rights reserved.
"""Replay the dataset catalog into DataHub, with ownership and lineage.

DataHub runs on demand (datahub/quickstart.sh), so it starts empty while the catalog of
record lives in Supabase (data_platform.datasets). This sync pushes every stored spec to
DataHub, with owners (``team-*`` as groups, others as people), classification tags, schema,
glossary terms and spec-level lineage. It then ties the logical datasets to the physical tables
that the Postgres recipe (datahub/recipes/supabase-postgres.yml) ingests:

    logical dataset (cumulus platform)  -->  data_platform.events  -->  data_platform.events_bi

Metadata only: no event rows are read.

    DATABASE_URL=... DATAHUB_GMS_URL=http://localhost:8080 python -m cumulus_privacy.catalog_sync
"""
from __future__ import annotations

import os
import sys
import urllib.error
from typing import Any, Callable, Iterable, Mapping

from .platform import DataHubSink, dataset_urn, proposal

STAMP = {"time": 0, "actor": "urn:li:corpuser:datahub"}


def physical_urn(table: str, instance: str = "cumulus-eu", database: str = "postgres", env: str = "PROD") -> str:
    """URN DataHub's Postgres source gives a table: <instance>.<database>.<schema>.<table>."""
    return f"urn:li:dataset:(urn:li:dataPlatform:postgres,{instance}.{database}.{table},{env})"


class CatalogSync:
    def __init__(self, specs: Callable[[], Iterable[Mapping[str, Any]]], sink: DataHubSink,
                 instance: str = "cumulus-eu", database: str = "postgres") -> None:
        self.specs, self.sink = specs, sink
        self.events = physical_urn("data_platform.events", instance, database)
        self.events_bi = physical_urn("data_platform.events_bi", instance, database)

    def run(self) -> dict[str, Any]:
        """Push everything. A spec DataHub refuses is reported and the rest still go through."""
        pushed, failed, names = 0, [], []
        for spec in self.specs():
            names.append(spec["name"])
            try:
                self.sink.push(spec, {"storedIn": "data_platform.events", "eventTypeFilter": spec["name"]})
                pushed += 1
            except (urllib.error.URLError, OSError) as e:
                failed.append({"name": spec["name"], "error": type(e).__name__})
        lineage = []
        if names:
            lineage.append(proposal(self.events, "upstreamLineage", {
                "upstreams": [{"dataset": dataset_urn(n), "type": "TRANSFORMED", "auditStamp": STAMP} for n in sorted(names)]
            }))
            lineage.append(proposal(self.events_bi, "upstreamLineage", {
                "upstreams": [{"dataset": self.events, "type": "VIEW", "auditStamp": STAMP}]
            }))
        try:
            self.sink.send(lineage)
        except (urllib.error.URLError, OSError) as e:
            failed.append({"name": "lineage", "error": type(e).__name__})
        return {"pushed": pushed, "failed": failed, "lineageEdges": len(names) + (1 if names else 0)}


def main() -> int:
    dsn, gms = os.environ.get("DATABASE_URL"), os.environ.get("DATAHUB_GMS_URL")
    if not gms:
        print("set DATAHUB_GMS_URL (and DATABASE_URL for the Supabase catalog)", file=sys.stderr)
        return 2
    if dsn:
        from .pgstore import PostgresCatalog

        specs: Callable[[], Iterable[Mapping[str, Any]]] = PostgresCatalog(dsn).all
    else:
        from .platform import Catalog

        specs = Catalog(os.environ.get("PLATFORM_CATALOG_FILE", "/var/lib/privacy-gateway/catalog.json")).all
    sync = CatalogSync(specs, DataHubSink(gms, os.environ.get("DATAHUB_GMS_TOKEN")),
                       os.environ.get("DATAHUB_PLATFORM_INSTANCE", "cumulus-eu"),
                       os.environ.get("CUMULUS_PG_DATABASE", "postgres"))
    out = sync.run()
    print(f"pushed {out['pushed']} datasets, {out['lineageEdges']} lineage edges, {len(out['failed'])} failed")
    for f in out["failed"]:
        print(f"  failed: {f['name']} ({f['error']})", file=sys.stderr)
    return 1 if out["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
