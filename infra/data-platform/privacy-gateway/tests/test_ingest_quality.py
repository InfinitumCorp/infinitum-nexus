"""Deequ-style quality checks on the collection path."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import yaml

from cumulus_privacy.ingest_quality import MemoryQualityLog, validate_checks
from cumulus_privacy.platform import Catalog, Collector, PlatformError, validate_spec

from .test_platform import DEALS, FakeIndex, event

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
PLATFORM = yaml.safe_load((Path(__file__).parents[2] / "conjure" / "platform.yml").read_text("utf-8"))
OBJECTS = PLATFORM["types"]["definitions"]["objects"]

CHECKS = [
    {"kind": "completeness", "column": "dealId"},                    # required, per event
    {"kind": "range", "column": "amount", "min": 0, "max": 1_000_000},
    {"kind": "allowed_values", "column": "stage", "values": ["lead", "won", "lost"]},
    {"kind": "freshness", "maxAgeHours": 72},                        # occurredAt
    {"kind": "completeness", "column": "note", "min": 0.5},          # measured
    {"kind": "uniqueness", "columns": ["dealId"], "min": 0.9},        # measured
    {"kind": "anomaly", "metric": "size", "maxRelativeChange": 1.0},  # measured
]


def with_quality(checks=CHECKS):
    return {**DEALS, "quality": checks}


@pytest.fixture()
def setup(redactor, tmp_path):
    catalog = Catalog(tmp_path / "c.json")
    catalog.register("spectre", DEALS["name"], with_quality())
    log = MemoryQualityLog()
    index = FakeIndex()
    return Collector(catalog, redactor, index, "EU", quality_log=log, clock=lambda: NOW), index, log


def ev(**payload_over):
    occurred = payload_over.pop("occurredAt", "2026-11-12T10:00:00Z")
    e = event(occurredAt=occurred)
    e["payload"] = {**e["payload"], **payload_over}
    return e


def test_per_event_checks_reject_with_reasons(setup):
    collector, index, _ = setup
    out = collector.ingest("spectre", [
        ev(),
        ev(dealId=""),
        ev(amount=-5.0),
        ev(stage="maybe"),
        ev(occurredAt="2026-11-01T00:00:00Z"),
    ])
    assert out["accepted"] == 1 and len(index.docs) == 1
    reasons = [r["reason"] for r in out["rejected"]]
    assert reasons == [
        "quality: dealId is required",
        "quality: amount is outside [0, 1000000]",
        "quality: stage is not an allowed value",
        "quality: occurredAt is older than 72 hours",
    ]


def test_batch_checks_are_measured_not_enforced(setup):
    collector, index, log = setup
    rows = [ev(dealId="d-1"), ev(dealId="d-1", note=None), ev(dealId="d-2", note="")]
    assert collector.ingest("spectre", rows)["accepted"] == 3  # uniqueness 1/3 does not block
    (run,) = log.runs(DEALS["name"], 10)
    assert set(run) == set(OBJECTS["QualityRun"]["fields"])
    assert set(run["results"][0]) == set(OBJECTS["DatasetCheckResult"]["fields"])
    assert run["rows"] == 3 and run["ok"] is False
    by_kind = {r["kind"]: r for r in run["results"]}
    assert by_kind["completeness"]["metric"] == pytest.approx(1 / 3) and not by_kind["completeness"]["ok"]
    assert by_kind["uniqueness"]["metric"] == pytest.approx(1 / 3)
    assert by_kind["anomaly"]["message"] == "no history yet"
    # No event values in the log: only metric names, numbers and messages.
    assert "Jane" not in json.dumps(run) and "d-1" not in json.dumps(run)


def test_anomaly_uses_previous_runs(setup):
    collector, _, log = setup
    collector.ingest("spectre", [ev(dealId=f"a{i}") for i in range(2)])
    collector.ingest("spectre", [ev(dealId=f"b{i}") for i in range(10)])
    latest = log.runs(DEALS["name"], 1)[0]
    anomaly = next(r for r in latest["results"] if r["kind"] == "anomaly")
    assert anomaly["metric"] == pytest.approx(4.0) and anomaly["ok"] is False  # 2 -> 10 rows


def test_no_run_when_only_per_event_checks(redactor, tmp_path):
    catalog = Catalog(tmp_path / "c.json")
    catalog.register("spectre", DEALS["name"], with_quality(CHECKS[:4]))
    log = MemoryQualityLog()
    Collector(catalog, redactor, FakeIndex(), "EU", quality_log=log, clock=lambda: NOW).ingest("spectre", [ev()])
    assert log.runs(DEALS["name"], 10) == []


def test_a_broken_log_never_loses_events(setup):
    collector, index, _ = setup

    class Broken(MemoryQualityLog):
        def record(self, product, run):
            raise OSError("db down")

    collector.quality_log = Broken()
    assert collector.ingest("spectre", [ev()])["accepted"] == 1 and len(index.docs) == 1


def test_quality_runs_are_product_scoped(setup):
    collector, _, _ = setup
    collector.ingest("spectre", [ev()])
    assert len(collector.quality_runs("spectre", DEALS["name"])["runs"]) == 1
    with pytest.raises(PlatformError) as e:
        collector.quality_runs("cumulus-mail", DEALS["name"])
    assert e.value.name == "DatasetNotFound"


@pytest.mark.parametrize("bad", [
    [{"kind": "median"}],
    [{"kind": "range", "column": "nope", "min": 0}],
    [{"kind": "freshness"}],
    [{"kind": "uniqueness", "columns": []}],
    [{"kind": "allowed_values", "column": "stage"}],
    [{"kind": "completeness", "column": "dealId", "min": 2}],
    [{"kind": "range", "column": "amount", "min": "zero"}],
    "not a list",
])
def test_spec_validation_rejects_bad_checks(bad):
    with pytest.raises(PlatformError):
        validate_spec(DEALS["name"], with_quality(bad))


def test_validation_normalizes_and_defaults():
    names = {f["name"] for f in DEALS["fields"]}
    assert validate_checks(None, names) == []
    (c,) = validate_checks([{"kind": "FRESHNESS", "maxAgeHours": 1, "min": None}], names)
    assert c == {"kind": "freshness", "maxAgeHours": 1, "column": "occurredAt"}
    assert validate_spec(DEALS["name"], DEALS)["quality"] == []


def test_freshness_on_a_payload_datetime_field(redactor, tmp_path):
    spec = {**DEALS, "fields": DEALS["fields"] + [
        {"name": "closedAt", "type": "string", "classification": "INTERNAL", "rule": "KEEP"}],
        "quality": [{"kind": "freshness", "column": "closedAt", "maxAgeHours": 1}]}
    catalog = Catalog(tmp_path / "c.json")
    catalog.register("spectre", DEALS["name"], spec)
    c = Collector(catalog, redactor, FakeIndex(), "EU", clock=lambda: NOW)
    fresh = (NOW - timedelta(minutes=10)).isoformat()
    out = c.ingest("spectre", [ev(closedAt=fresh), ev(closedAt="2026-11-01T00:00:00Z"), ev(closedAt="soon")])
    assert out["accepted"] == 1
    assert [r["reason"] for r in out["rejected"]] == [
        "quality: closedAt is older than 1 hours", "quality: closedAt is not a datetime"]
