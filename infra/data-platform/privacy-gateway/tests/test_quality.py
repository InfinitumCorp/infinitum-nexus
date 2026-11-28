from datetime import datetime, timedelta, timezone

import pytest

from cumulus_privacy.quality import completeness, run_suite, uniqueness

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)

ROWS = [
    {"id": 1, "email": "a", "amount": 10, "stage": "won", "updated_at": "2026-11-12T10:00:00Z"},
    {"id": 2, "email": "", "amount": 5, "stage": "lead", "updated_at": "2026-11-11T10:00:00Z"},
    {"id": 2, "email": None, "amount": -3, "stage": "lost", "updated_at": "2026-11-10T10:00:00Z"},
    {"id": 4, "email": "d", "amount": 7, "stage": "maybe", "updated_at": "2026-11-09T10:00:00Z"},
]


def test_metrics():
    assert completeness(ROWS, "email") == 0.5
    assert uniqueness(ROWS, ["id"]) == 0.5  # ids 1 and 4 occur once out of 4 rows
    assert completeness([], "x") == 0.0


def _result(report, kind):
    return next(r for r in report.results if r.kind == kind)


def test_suite_reports_each_failure():
    suite = {
        "dataset": "spectre.deals",
        "checks": [
            {"kind": "completeness", "column": "email", "min": 0.9},
            {"kind": "uniqueness", "columns": ["id"]},
            {"kind": "range", "column": "amount", "min": 0},
            {"kind": "allowed_values", "column": "stage", "values": ["lead", "won", "lost"]},
            {"kind": "freshness", "column": "updated_at", "max_age_hours": 6},
            {"kind": "size", "min": 1, "max": 10},
        ],
    }
    rep = run_suite(suite, ROWS, now=NOW)
    assert not rep.ok
    assert not _result(rep, "completeness").ok
    assert not _result(rep, "uniqueness").ok
    assert _result(rep, "range").metric == 1
    assert _result(rep, "allowed_values").metric == 1
    assert _result(rep, "freshness").ok and _result(rep, "freshness").metric == pytest.approx(2.0)
    assert _result(rep, "size").ok


def test_stale_data_fails_freshness():
    rep = run_suite(
        {"checks": [{"kind": "freshness", "column": "updated_at", "max_age_hours": 1}]},
        ROWS,
        now=NOW + timedelta(days=2),
    )
    assert not rep.ok


def test_anomaly_against_history():
    suite = {"checks": [{"kind": "anomaly", "metric": "size", "max_relative_change": 0.5}]}
    assert run_suite(suite, ROWS, history=[]).ok  # first run has nothing to compare with
    assert run_suite(suite, ROWS, history=[{"size": 5}]).ok
    rep = run_suite(suite, ROWS, history=[{"size": 100}])
    assert not rep.ok and rep.results[0].metric == pytest.approx(0.96)


def test_unknown_check_is_an_error():
    with pytest.raises(ValueError):
        run_suite({"checks": [{"kind": "vibes"}]}, ROWS)
