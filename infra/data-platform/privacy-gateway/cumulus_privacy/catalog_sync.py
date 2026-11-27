# © Infinitum Corporation®. All rights reserved.
"""Replay the dataset catalog into DataHub, with ownership and lineage.

DataHub runs on demand (datahub/quickstart.sh), so it starts empty while the catalog of
record lives in Supabase (data_platform.datasets). This sync pushes every stored spec to
DataHub, with owners (``team-*`` as groups, others as people), classification tags, schema,
glossary terms and spec-level lineage. It then ties the logical datasets to the physical tables
that the Postgres recipe (datahub/recipes/supabase-postgres.yml) ingests:

    logical dataset (cumulus platform)  -->  data_platform.events  -->  data_platform.events_bi

With a quality log, the ingest quality runs (ingest_quality.py) go along as DataHub assertions:
one assertion per dataset, check kind and target, and one run event per stored run, so the
dataset page shows which checks pass. Runs hold check names and numbers only.

Metadata only: no event rows are read.

    DATABASE_URL=... DATAHUB_GMS_URL=http://localhost:8080 python -m cumulus_privacy.catalog_sync
"""
from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime
import urllib.error
from typing import Any, Callable, Iterable, Mapping

from .platform import DataHubSink, dataset_urn, proposal

STAMP = {"time": 0, "actor": "urn:li:corpuser:datahub"}
FIELD_KINDS = {"completeness", "uniqueness", "range", "allowed_values", "freshness"}
RUNS_PER_DATASET = 30

QualityRuns = Callable[[str, int], list[Mapping[str, Any]]]


def assertion_urn(dataset: str, kind: str, target: str) -> str:
    """Stable per (dataset, kind, target), so repeated syncs update the same assertion."""
    key = hashlib.sha256(f"{dataset}|{kind}|{target}".encode()).hexdigest()[:32]
    return f"urn:li:assertion:{key}"


def _millis(ts: Any) -> int:
    if isinstance(ts, datetime):
        return int(ts.timestamp() * 1000)
    return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)


def quality_proposals(dataset: str, runs: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """assertionInfo for every check seen in the runs, and an assertionRunEvent per run and check."""
    ds = dataset_urn(dataset)
    infos: dict[str, dict[str, Any]] = {}
    events = []
    for run in runs:
        at = _millis(run["checkedAt"])
        for r in run["results"]:
            urn = assertion_urn(dataset, r["kind"], r["target"])
            if urn not in infos:
                field_level = r["kind"] in FIELD_KINDS
                info: dict[str, Any] = {
                    "dataset": ds,
                    "scope": "DATASET_COLUMN" if field_level else "DATASET_ROWS",
                    "operator": "_NATIVE_",
                    "nativeType": r["kind"],
                }
                if field_level:
                    info["fields"] = [f"urn:li:schemaField:({ds},{f})" for f in r["target"].split(",") if f]
                infos[urn] = proposal(urn, "assertionInfo", {
                    "type": "DATASET",
                    "datasetAssertion": info,
                    "customProperties": {"kind": r["kind"], "target": r["target"], "source": "cumulus ingest quality"},
                }, "assertion")
            events.append(proposal(urn, "assertionRunEvent", {
                "timestampMillis": at,
                "runId": f"{dataset}@{at}",
                "asserteeUrn": ds,
                "assertionUrn": urn,
                "status": "COMPLETE",
                "result": {
                    "type": "SUCCESS" if r["ok"] else "FAILURE",
                    "actualAggregateValue": float(r["metric"]),
                    "nativeResults": {"message": str(r["message"])[:500]},
                },
            }, "assertion"))
    return [*infos.values(), *events]


def physical_urn(table: str, instance: str = "cumulus-eu", database: str = "postgres", env: str = "PROD") -> str:
    """URN DataHub's Postgres source gives a table: <instance>.<database>.<schema>.<table>."""
    return f"urn:li:dataset:(urn:li:dataPlatform:postgres,{instance}.{database}.{table},{env})"


class CatalogSync:
    def __init__(self, specs: Callable[[], Iterable[Mapping[str, Any]]], sink: DataHubSink,
                 instance: str = "cumulus-eu", database: str = "postgres",
                 quality_runs: QualityRuns | None = None) -> None:
        self.specs, self.sink, self.quality_runs = specs, sink, quality_runs
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
        assertions = 0
        for name in names if self.quality_runs else []:
            try:
                props = quality_proposals(name, self.quality_runs(name, RUNS_PER_DATASET))
                self.sink.send(props)
                assertions += sum(1 for p in props if p["aspectName"] == "assertionInfo")
            except (urllib.error.URLError, OSError) as e:
                failed.append({"name": f"{name} quality", "error": type(e).__name__})
        out = {"pushed": pushed, "failed": failed, "lineageEdges": len(names) + (1 if names else 0)}
        if self.quality_runs:
            out["assertions"] = assertions
        return out


def main() -> int:
    dsn, gms = os.environ.get("DATABASE_URL"), os.environ.get("DATAHUB_GMS_URL")
    if not gms:
        print("set DATAHUB_GMS_URL (and DATABASE_URL for the Supabase catalog)", file=sys.stderr)
        return 2
    quality: QualityRuns | None = None
    if dsn:
        from .pgstore import PostgresCatalog, PostgresQualityLog

        specs: Callable[[], Iterable[Mapping[str, Any]]] = PostgresCatalog(dsn).all
        quality = PostgresQualityLog(dsn).runs
    else:
        from .platform import Catalog

        specs = Catalog(os.environ.get("PLATFORM_CATALOG_FILE", "/var/lib/privacy-gateway/catalog.json")).all
    sync = CatalogSync(specs, DataHubSink(gms, os.environ.get("DATAHUB_GMS_TOKEN")),
                       os.environ.get("DATAHUB_PLATFORM_INSTANCE", "cumulus-eu"),
                       os.environ.get("CUMULUS_PG_DATABASE", "postgres"), quality)
    out = sync.run()
    quality_note = f"{out['assertions']} quality assertions, " if "assertions" in out else ""
    print(f"pushed {out['pushed']} datasets, {out['lineageEdges']} lineage edges, {quality_note}"
          f"{len(out['failed'])} failed")
    for f in out["failed"]:
        print(f"  failed: {f['name']} ({f['error']})", file=sys.stderr)
    return 1 if out["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
