# © Infinitum Corporation®. All rights reserved.
"""Builds the Cumulus Superset dashboards as a Superset v1 import bundle (a ZIP).

    python3 superset/dashboards/build_bundle.py cumulus-dashboards.zip
    superset import-dashboards -p cumulus-dashboards.zip -u <a Superset user>

Two dashboards, defined here as code so every environment gets the same ones with the same
UUIDs:

* **Product activity** (embeddable): events per day, by type and in total, from
  ``data_platform.events_bi``. Every dataset on an embeddable dashboard has ``product`` and
  ``tenant`` columns, because guest tokens pin the RLS clause ``product = .. AND tenant = ..``
  to every chart (privacy-gateway/cumulus_privacy/embed.py). A test checks this.
* **Data quality** (internal, Cumulus ID sign-in only): ingest quality runs from
  ``data_platform.quality_runs``, check names and numbers only.

The database connection is ``data_platform_reader`` with **no password** in the bundle (the
repo is public). Set it once in Superset (Settings > Database connections) after the first
import. Override the host with CUMULUS_BI_DATABASE_URI (still without a password).

Standard library only. The files are JSON, which is valid YAML.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

NS = uuid.UUID("6f1b8c1e-6c1d-4f43-9a52-3c0f2b7d9e10")
VERSION = "1.0.0"
DEFAULT_URI = "postgresql+psycopg2://data_platform_reader@localhost:5432/postgres?sslmode=require"


def uid(name: str) -> str:
    return str(uuid.uuid5(NS, name))


DATABASE = {
    "database_name": "Cumulus data platform (EU)",
    "uuid": uid("database:cumulus"),
}


def _col(name: str, type_: str, dttm: bool = False, groupby: bool = True) -> dict[str, Any]:
    return {"column_name": name, "verbose_name": None, "is_dttm": dttm, "is_active": True, "type": type_,
            "groupby": groupby, "filterable": True, "expression": None, "description": None,
            "python_date_format": None, "extra": {}}


def _metric(name: str, expression: str, verbose: str, d3format: str | None = None) -> dict[str, Any]:
    return {"metric_name": name, "verbose_name": verbose, "metric_type": None, "expression": expression,
            "description": None, "d3format": d3format, "extra": {}, "warning_text": None}


DATASETS: dict[str, dict[str, Any]] = {
    "events_bi": {
        "main_dttm_col": "occurred_at",
        "description": "Events without text, payload or CID (data_platform.events_bi).",
        "columns": [_col("event_id", "UUID", groupby=False), _col("product", "TEXT"), _col("tenant", "TEXT"),
                    _col("event_type", "TEXT"), _col("schema_version", "INTEGER"),
                    _col("occurred_at", "TIMESTAMP WITH TIME ZONE", dttm=True), _col("region", "TEXT"),
                    _col("object_type", "TEXT"), _col("object_id", "TEXT", groupby=False),
                    _col("ingested_at", "TIMESTAMP WITH TIME ZONE", dttm=True)],
        "metrics": [_metric("count", "COUNT(*)", "Events"),
                    _metric("objects", "COUNT(DISTINCT object_id)", "Distinct objects")],
    },
    "quality_runs": {
        "main_dttm_col": "checked_at",
        "description": "Ingest quality runs: check names and numbers only (data_platform.quality_runs).",
        "columns": [_col("id", "BIGINT", groupby=False), _col("dataset", "TEXT"), _col("product", "TEXT"),
                    _col("checked_at", "TIMESTAMP WITH TIME ZONE", dttm=True), _col("ok", "BOOLEAN"),
                    _col("rows", "INTEGER")],
        "metrics": [_metric("count", "COUNT(*)", "Runs"),
                    _metric("pass_rate", "AVG(CASE WHEN ok THEN 1.0 ELSE 0.0 END)", "Pass rate", ".1%"),
                    _metric("failed_runs", "SUM(CASE WHEN ok THEN 0 ELSE 1 END)", "Failed runs")],
    },
}


def _params(viz: str, dataset: str, **extra: Any) -> dict[str, Any]:
    return {"datasource": f"{uid('dataset:' + dataset)}__table", "viz_type": viz, "time_range": "Last month",
            "adhoc_filters": [], **extra}


# (key, title, viz_type, dataset, params, width)
CHARTS: list[tuple[str, str, str, str, dict[str, Any], int]] = [
    ("activity.total", "Events", "big_number_total", "events_bi",
     {"metric": "count", "subheader": "in the selected period"}, 3),
    ("activity.per_day", "Events per day", "echarts_timeseries_line", "events_bi",
     {"x_axis": "occurred_at", "time_grain_sqla": "P1D", "metrics": ["count"], "groupby": [], "row_limit": 1000}, 9),
    ("activity.by_type", "Events by type", "table", "events_bi",
     {"query_mode": "aggregate", "groupby": ["event_type"], "metrics": ["count", "objects"], "row_limit": 50,
      "order_desc": True, "timeseries_limit_metric": "count"}, 12),
    ("quality.pass_rate", "Quality pass rate", "big_number_total", "quality_runs",
     {"metric": "pass_rate", "subheader": "of ingest batches passed every check", "y_axis_format": ".1%"}, 3),
    ("quality.by_dataset", "Runs by dataset", "table", "quality_runs",
     {"query_mode": "aggregate", "groupby": ["product", "dataset"], "metrics": ["count", "failed_runs", "pass_rate"],
      "row_limit": 100, "order_desc": True, "timeseries_limit_metric": "failed_runs"}, 9),
    ("quality.failed", "Failed runs", "table", "quality_runs",
     {"query_mode": "raw", "all_columns": ["checked_at", "product", "dataset", "rows"], "row_limit": 200,
      "order_by_cols": ['["checked_at", false]'],
      "adhoc_filters": [{"expressionType": "SQL", "sqlExpression": "NOT ok", "clause": "WHERE"}]}, 12),
]

# (key, title, slug, embeddable, chart keys in rows)
DASHBOARDS = [
    ("activity", "Product activity", "cumulus-product-activity", True,
     [["activity.total", "activity.per_day"], ["activity.by_type"]]),
    ("quality", "Data quality", "cumulus-data-quality", False,
     [["quality.pass_rate", "quality.by_dataset"], ["quality.failed"]]),
]

# Native filters per dashboard: (name, column or None for the time range). The dataset is the
# one the dashboard's charts use. No filter offers tenant or product on the embeddable
# dashboard: the guest token already pins both, and listing values would show other tenants'.
FILTERS = {
    "activity": ("events_bi", [("Time range", None), ("Event type", "event_type"), ("Region", "region")]),
    "quality": ("quality_runs", [("Time range", None), ("Product", "product"), ("Dataset", "dataset")]),
}


def _native_filters(dashboard: str) -> list[dict[str, Any]]:
    dataset, filters = FILTERS[dashboard]
    out = []
    for name, column in filters:
        f: dict[str, Any] = {
            "id": f"NATIVE_FILTER-{uid(f'filter:{dashboard}:{name}')[:12]}",
            "name": name, "type": "NATIVE_FILTER", "description": "",
            "filterType": "filter_time" if column is None else "filter_select",
            "targets": [{}] if column is None else [{"column": {"name": column}, "datasetUuid": uid("dataset:" + dataset)}],
            "controlValues": {} if column is None else {
                "enableEmptyFilter": False, "defaultToFirstItem": False, "multiSelect": True,
                "searchAllOptions": False, "inverseSelection": False},
            "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
            "cascadeParentIds": [], "scope": {"rootPath": ["ROOT_ID"], "excluded": []},
            "chartsInScope": [], "tabsInScope": [],
        }
        out.append(f)
    return out


def _position(title: str, rows: list[list[str]], widths: dict[str, int]) -> dict[str, Any]:
    pos: dict[str, Any] = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
        "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": title}},
    }
    for r, row in enumerate(rows, 1):
        row_id = f"ROW-{r}"
        pos["GRID_ID"]["children"].append(row_id)
        pos[row_id] = {"type": "ROW", "id": row_id, "children": [], "parents": ["ROOT_ID", "GRID_ID"],
                       "meta": {"background": "BACKGROUND_TRANSPARENT"}}
        for key in row:
            chart_id = f"CHART-{key.replace('.', '-')}"
            pos[row_id]["children"].append(chart_id)
            pos[chart_id] = {"type": "CHART", "id": chart_id, "children": [], "parents": ["ROOT_ID", "GRID_ID", row_id],
                             # Superset remaps chartId from the uuid on import; the key must exist.
                             "meta": {"width": widths[key], "height": 50, "uuid": uid("chart:" + key),
                                      "chartId": [c[0] for c in CHARTS].index(key) + 1,
                                      "sliceName": next(c[1] for c in CHARTS if c[0] == key)}}
    return pos


def files(database_uri: str = DEFAULT_URI) -> dict[str, dict[str, Any]]:
    """Bundle path -> content. Raises if the URI carries a password."""
    if "@" in database_uri and ":" in database_uri.split("://", 1)[-1].split("@", 1)[0]:
        raise ValueError("CUMULUS_BI_DATABASE_URI must not contain a password; set it in Superset instead")
    out: dict[str, dict[str, Any]] = {
        "metadata.yaml": {"version": VERSION, "type": "Dashboard",
                          "timestamp": datetime(2026, 11, 28, tzinfo=timezone.utc).isoformat()},
        "databases/cumulus.yaml": {
            "database_name": DATABASE["database_name"], "sqlalchemy_uri": database_uri, "cache_timeout": None,
            "expose_in_sqllab": True, "allow_run_async": False, "allow_ctas": False, "allow_cvas": False,
            "allow_dml": False, "allow_file_upload": False, "extra": {"metadata_params": {}, "engine_params": {},
                                                                      "schemas_allowed_for_file_upload": []},
            "uuid": DATABASE["uuid"], "version": VERSION,
        },
    }
    for name, d in DATASETS.items():
        out[f"datasets/cumulus/{name}.yaml"] = {
            "table_name": name, "main_dttm_col": d["main_dttm_col"], "description": d["description"],
            "default_endpoint": None, "offset": 0, "cache_timeout": None, "schema": "data_platform", "sql": None,
            "params": None, "template_params": None, "filter_select_enabled": True, "fetch_values_predicate": None,
            "extra": None, "normalize_columns": False, "always_filter_main_dttm": False,
            "uuid": uid("dataset:" + name), "metrics": d["metrics"], "columns": d["columns"],
            "version": VERSION, "database_uuid": DATABASE["uuid"],
        }
    for key, title, viz, dataset, params, _ in CHARTS:
        out[f"charts/{key.replace('.', '_')}.yaml"] = {
            "slice_name": title, "description": None, "certified_by": None, "certification_details": None,
            "viz_type": viz, "params": _params(viz, dataset, **params), "query_context": None,
            "cache_timeout": None, "uuid": uid("chart:" + key), "version": VERSION,
            "dataset_uuid": uid("dataset:" + dataset),
        }
    widths = {c[0]: c[5] for c in CHARTS}
    for key, title, slug, embeddable, rows in DASHBOARDS:
        out[f"dashboards/{slug}.yaml"] = {
            "dashboard_title": title, "description": None, "css": "", "slug": slug,
            "certified_by": None, "certification_details": None, "published": True,
            "uuid": uid("dashboard:" + key), "position": _position(title, rows, widths),
            "metadata": {"color_scheme": "", "refresh_frequency": 0, "expanded_slices": {}, "label_colors": {},
                         "timed_refresh_immune_slices": [], "cross_filters_enabled": True,
                         "native_filter_configuration": _native_filters(key), "shared_label_colors": [],
                         "color_scheme_domain": []},
            "version": VERSION,
        }
    return out


def write(path: str, database_uri: str = DEFAULT_URI) -> None:
    root = "cumulus_dashboards"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in sorted(files(database_uri).items()):
            z.writestr(f"{root}/{name}", json.dumps(content, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    write(sys.argv[1], os.environ.get("CUMULUS_BI_DATABASE_URI", DEFAULT_URI))
    for key, title, slug, embeddable, _ in DASHBOARDS:
        print(f"{uid('dashboard:' + key)}  {title}{'  (embeddable)' if embeddable else ''}")
