# © Infinitum Corporation®. All rights reserved.
"""Deequ-style data quality on the collection path.

A dataset spec may carry ``quality``: a list of checks in the same vocabulary as
``quality.run_suite``. They split by what they can judge:

* **Per event, enforced.** An event that fails is rejected with a reason and never stored:
  - ``completeness`` with ``min`` 1.0 (or no min): the field must be present;
  - ``range``: numeric field within ``min`` / ``max``;
  - ``allowed_values``: field value in ``values``;
  - ``freshness``: ``occurredAt`` (or a datetime field) no older than ``maxAgeHours``.
* **Per batch, measured.** Recorded as a quality run and never blocking, because one batch is
  a sample:
  - ``completeness`` with ``min`` below 1.0;
  - ``uniqueness`` over ``columns``;
  - ``anomaly``: a metric's relative change against the previous run.

Runs keep only numbers and check names, never event values, so the log holds no personal data.
"""
from __future__ import annotations

import math
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Mapping, Protocol, Sequence

from .quality import _parse_time, _present, run_suite

ROW_KINDS = {"completeness", "range", "allowed_values", "freshness"}
BATCH_KINDS = {"completeness", "uniqueness", "anomaly"}
KINDS = ROW_KINDS | BATCH_KINDS
TIME_COLUMN = "occurredAt"
MAX_CHECKS = 50


class QualityError(ValueError):
    pass


def _num(check: Mapping[str, Any], key: str) -> float | None:
    v = check.get(key)
    if v is None:
        return None
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        raise QualityError(f"quality check {check.get('kind')}: {key} must be a number")
    return float(v)


def _is_row(check: Mapping[str, Any]) -> bool:
    kind = check["kind"]
    if kind == "completeness":
        return (check.get("min") is None) or float(check["min"]) >= 1.0
    return kind in ("range", "allowed_values", "freshness")


def validate_checks(checks: Any, field_names: set[str]) -> list[dict[str, Any]]:
    """Normalize a spec's ``quality`` list (kinds lower case) or raise QualityError."""
    if checks is None:
        return []
    if not isinstance(checks, list) or len(checks) > MAX_CHECKS:
        raise QualityError(f"quality must be a list of at most {MAX_CHECKS} checks")
    out = []
    for c in checks:
        if not isinstance(c, Mapping) or not isinstance(c.get("kind"), str):
            raise QualityError("each quality check needs a kind")
        kind = c["kind"].lower()
        if kind not in KINDS:
            raise QualityError(f"unknown quality check kind {c['kind']}; use one of {sorted(KINDS)}")
        check = {k: v for k, v in c.items() if v is not None}
        check["kind"] = kind
        for key in ("min", "max", "maxAgeHours", "maxRelativeChange"):
            _num(check, key)
        if kind == "uniqueness":
            cols = check.get("columns")
            if not isinstance(cols, list) or not cols or not all(isinstance(x, str) for x in cols):
                raise QualityError("uniqueness needs columns")
            unknown = [x for x in cols if x not in field_names]
        elif kind == "anomaly":
            if not isinstance(check.get("metric", "size"), str):
                raise QualityError("anomaly needs a metric name")
            unknown = []
        else:
            col = check.get("column", TIME_COLUMN if kind == "freshness" else None)
            if not isinstance(col, str):
                raise QualityError(f"{kind} needs a column")
            check["column"] = col
            unknown = [] if (kind == "freshness" and col == TIME_COLUMN) else [col] if col not in field_names else []
            if kind == "freshness" and _num(check, "maxAgeHours") is None:
                raise QualityError("freshness needs maxAgeHours")
            if kind == "allowed_values" and not isinstance(check.get("values"), list):
                raise QualityError("allowed_values needs values")
            if kind == "completeness" and not 0 <= float(check.get("min", 1.0)) <= 1:
                raise QualityError("completeness min must be between 0 and 1")
        if unknown:
            raise QualityError(f"quality check {kind} names fields not in the schema: {', '.join(unknown)}")
        out.append(check)
    return out


def row_failure(checks: Sequence[Mapping[str, Any]], event: Mapping[str, Any], now: datetime) -> str | None:
    """The first enforced check this event fails, as a rejection reason, or None."""
    payload = event.get("payload") or {}
    for c in checks:
        if not _is_row(c):
            continue
        kind, col = c["kind"], c["column"]
        v = event.get(TIME_COLUMN) if col == TIME_COLUMN else payload.get(col)
        if kind == "completeness" and not _present(v):
            return f"quality: {col} is required"
        if kind == "range" and _present(v):
            lo, hi = c.get("min"), c.get("max")
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                return f"quality: {col} must be a number"
            if (lo is not None and v < lo) or (hi is not None and v > hi):
                return f"quality: {col} is outside [{lo}, {hi}]"
        if kind == "allowed_values" and _present(v) and v not in c["values"]:
            return f"quality: {col} is not an allowed value"
        if kind == "freshness":
            t = _parse_time(v)
            if t is None:
                return f"quality: {col} is not a datetime"
            if (now - t).total_seconds() > float(c["maxAgeHours"]) * 3600:
                return f"quality: {col} is older than {c['maxAgeHours']} hours"
    return None


def _finite(x: float) -> float:
    return x if math.isfinite(x) else 1e9


def batch_report(dataset: str, checks: Sequence[Mapping[str, Any]], rows: Sequence[Mapping[str, Any]],
                 history: Sequence[Mapping[str, float]], now: datetime) -> dict[str, Any] | None:
    """Measured checks over one batch's accepted payloads, as a QualityRun (wire form)."""
    measured = [c for c in checks if not _is_row(c)]
    suite = []
    for c in measured:
        s = {k: v for k, v in c.items()}
        if c["kind"] == "anomaly":
            s["max_relative_change"] = c.get("maxRelativeChange", 0.5)
        suite.append(s)
    report = run_suite({"dataset": dataset, "checks": suite}, rows, history, now)
    return {
        "dataset": dataset,
        "checkedAt": report.checked_at,
        "rows": report.rows,
        "ok": report.ok,
        "metrics": {k: _finite(v) for k, v in report.metrics.items()},
        "results": [
            {"kind": r.kind, "target": r.target, "ok": r.ok, "metric": _finite(r.metric), "message": r.message}
            for r in report.results
        ],
    }


class QualityLog(Protocol):
    def record(self, product: str, run: Mapping[str, Any]) -> None: ...

    def runs(self, dataset: str, limit: int) -> list[dict[str, Any]]:
        """Newest first."""


class MemoryQualityLog:
    """For the local dev stack and tests; the Postgres log is used with DATABASE_URL."""

    def __init__(self, keep: int = 200) -> None:
        self._runs: dict[str, deque[dict[str, Any]]] = {}
        self._keep = keep
        self._lock = threading.Lock()

    def record(self, product: str, run: Mapping[str, Any]) -> None:
        with self._lock:
            self._runs.setdefault(run["dataset"], deque(maxlen=self._keep)).append(dict(run))

    def runs(self, dataset: str, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(self._runs.get(dataset, ())))[:limit]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
