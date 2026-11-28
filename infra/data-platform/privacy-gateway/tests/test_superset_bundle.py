"""The Superset dashboards bundle (superset/dashboards/build_bundle.py)."""
import importlib.util
import json
import re
import zipfile
from pathlib import Path

import pytest

SRC = Path(__file__).parents[2] / "superset" / "dashboards" / "build_bundle.py"
spec = importlib.util.spec_from_file_location("build_bundle", SRC)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


@pytest.fixture(scope="module")
def files():
    return bundle.files()


def by_prefix(files, prefix):
    return {k: v for k, v in files.items() if k.startswith(prefix)}


def test_every_reference_resolves(files):
    datasets = {v["uuid"]: v for v in by_prefix(files, "datasets/").values()}
    charts = {v["uuid"]: v for v in by_prefix(files, "charts/").values()}
    db = files["databases/cumulus.yaml"]
    assert all(d["database_uuid"] == db["uuid"] for d in datasets.values())
    for c in charts.values():
        ds = datasets[c["dataset_uuid"]]
        assert c["params"]["datasource"] == f"{ds['uuid']}__table"
        names = {m["metric_name"] for m in ds["metrics"]}
        cols = {col["column_name"] for col in ds["columns"]}
        used_metrics = c["params"].get("metrics", []) + [c["params"][k] for k in ("metric", "timeseries_limit_metric")
                                                         if k in c["params"]]
        assert set(used_metrics) <= names, c["slice_name"]
        used_cols = c["params"].get("groupby", []) + c["params"].get("all_columns", []) + \
            ([c["params"]["x_axis"]] if "x_axis" in c["params"] else [])
        assert set(used_cols) <= cols, c["slice_name"]
    for d in by_prefix(files, "dashboards/").values():
        in_layout = [v["meta"]["uuid"] for v in d["position"].values() if isinstance(v, dict) and v.get("type") == "CHART"]
        assert in_layout and set(in_layout) <= set(charts)


def test_embeddable_dashboards_only_use_tenant_scoped_datasets(files):
    """Guest tokens add `product = .. AND tenant = ..` to every query of an embedded dashboard."""
    datasets = {v["uuid"]: v for v in by_prefix(files, "datasets/").values()}
    charts = {v["uuid"]: v for v in by_prefix(files, "charts/").values()}
    embeddable = [d for key, _, slug, emb, _ in bundle.DASHBOARDS if emb for d in [files[f"dashboards/{slug}.yaml"]]]
    assert embeddable
    for d in embeddable:
        for v in d["position"].values():
            if isinstance(v, dict) and v.get("type") == "CHART":
                ds = datasets[charts[v["meta"]["uuid"]]["dataset_uuid"]]
                assert {"product", "tenant"} <= {c["column_name"] for c in ds["columns"]}, ds["table_name"]
                assert ds["table_name"] != "events"  # the view without text, payload or CID


def test_no_password_and_no_personal_columns(files):
    assert ":" not in files["databases/cumulus.yaml"]["sqlalchemy_uri"].split("://")[1].split("@")[0]
    with pytest.raises(ValueError):
        bundle.files("postgresql+psycopg2://data_platform_reader:hunter2@db.example:5432/postgres")
    cols = {c["column_name"] for d in by_prefix(files, "datasets/").values() for c in d["columns"]}
    assert not cols & {"cid", "text", "payload", "metrics", "results"}


def test_uuids_are_stable_and_the_zip_imports_as_one_root(tmp_path):
    assert bundle.uid("dashboard:activity") == bundle.files()["dashboards/cumulus-product-activity.yaml"]["uuid"]
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}", bundle.uid("dashboard:activity"))
    out = tmp_path / "b.zip"
    bundle.write(str(out))
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert {n.split("/")[0] for n in names} == {"cumulus_dashboards"}
        assert "cumulus_dashboards/metadata.yaml" in names
        assert json.loads(z.read("cumulus_dashboards/metadata.yaml"))["type"] == "Dashboard"
