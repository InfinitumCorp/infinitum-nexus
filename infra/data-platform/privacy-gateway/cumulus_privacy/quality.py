# © Infinitum Corporation®. All rights reserved.
"""Data-quality checks on batches, using AWS Deequ's vocabulary (completeness, uniqueness,
compliance, freshness, size and anomaly detection on metric history).

Deequ itself needs Spark on the JVM, so it is deferred until there is a Spark lakehouse
(see docs/data-platform/ARCHITECTURE.md). These checks run on the batches the privacy gateway
already handles, in plain Python, and use the same names, so a suite can be moved to
Deequ `VerificationSuite` checks one to one later.

A suite is plain data (JSON or YAML):

    {"dataset": "spectre.deals", "checks": [
        {"kind": "completeness", "column": "deal_id", "min": 1.0},
        {"kind": "uniqueness", "columns": ["deal_id"]},
        {"kind": "freshness", "column": "updated_at", "max_age_hours": 24},
        {"kind": "range", "column": "amount", "min": 0},
        {"kind": "allowed_values", "column": "stage", "values": ["lead", "won", "lost"]},
        {"kind": "size", "min": 1},
        {"kind": "anomaly", "metric": "size", "max_relative_change": 0.5}
    ]}
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

Row = Mapping[str, Any]


@dataclass
class CheckResult:
    kind: str
    target: str
    ok: bool
    metric: float
    message: str


@dataclass
class QualityReport:
    dataset: str
    rows: int
    ok: bool
    checked_at: str
    results: list[CheckResult] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_time(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, tz=timezone.utc)
    if isinstance(v, str):
        try:
            t = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    return None


def _present(v: Any) -> bool:
    return v is not None and not (isinstance(v, str) and v.strip() == "") and not (
        isinstance(v, float) and math.isnan(v)
    )


def completeness(rows: Sequence[Row], column: str) -> float:
    if not rows:
        return 0.0
    return sum(1 for r in rows if _present(r.get(column))) / len(rows)


def uniqueness(rows: Sequence[Row], columns: Sequence[str]) -> float:
    """Deequ's definition: share of key values that occur exactly once."""
    if not rows:
        return 1.0
    counts: dict[tuple, int] = {}
    for r in rows:
        key = tuple(r.get(c) for c in columns)
        counts[key] = counts.get(key, 0) + 1
    return sum(1 for n in counts.values() if n == 1) / len(rows)


def run_suite(
    suite: Mapping[str, Any],
    rows: Sequence[Row],
    history: Sequence[Mapping[str, float]] = (),
    now: datetime | None = None,
) -> QualityReport:
    """Run every check in `suite` over `rows`. `history` holds the metrics of earlier runs of
    the same suite (oldest first), for anomaly checks."""
    now = now or datetime.now(timezone.utc)
    results: list[CheckResult] = []
    metrics: dict[str, float] = {"size": float(len(rows))}

    for check in suite.get("checks", []):
        kind = check["kind"]
        if kind == "completeness":
            col = check["column"]
            m = completeness(rows, col)
            metrics[f"completeness:{col}"] = m
            need = float(check.get("min", 1.0))
            results.append(CheckResult(kind, col, m >= need, m, f"{m:.3f} complete, need {need:.3f}"))
        elif kind == "uniqueness":
            cols = list(check["columns"])
            m = uniqueness(rows, cols)
            metrics[f"uniqueness:{','.join(cols)}"] = m
            need = float(check.get("min", 1.0))
            results.append(CheckResult(kind, ",".join(cols), m >= need, m, f"{m:.3f} unique, need {need:.3f}"))
        elif kind == "range":
            col = check["column"]
            lo, hi = check.get("min"), check.get("max")
            bad = 0
            for r in rows:
                v = r.get(col)
                if not _present(v):
                    continue
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    bad += 1
                elif (lo is not None and v < lo) or (hi is not None and v > hi):
                    bad += 1
            results.append(CheckResult(kind, col, bad == 0, float(bad), f"{bad} values outside [{lo}, {hi}]"))
        elif kind == "allowed_values":
            col = check["column"]
            allowed = set(check["values"])
            bad = sum(1 for r in rows if _present(r.get(col)) and r.get(col) not in allowed)
            results.append(CheckResult(kind, col, bad == 0, float(bad), f"{bad} values not allowed"))
        elif kind == "freshness":
            col = check["column"]
            times = [t for t in (_parse_time(r.get(col)) for r in rows) if t]
            if not times:
                results.append(CheckResult(kind, col, False, math.inf, "no parseable timestamps"))
                continue
            age_h = (now - max(times)).total_seconds() / 3600
            metrics[f"freshness_hours:{col}"] = age_h
            limit = float(check["max_age_hours"])
            results.append(CheckResult(kind, col, age_h <= limit, age_h, f"newest row {age_h:.1f} h old, limit {limit} h"))
        elif kind == "size":
            n = len(rows)
            lo, hi = check.get("min"), check.get("max")
            ok = (lo is None or n >= lo) and (hi is None or n <= hi)
            results.append(CheckResult(kind, "rows", ok, float(n), f"{n} rows, need [{lo}, {hi}]"))
        elif kind == "anomaly":
            # Deequ's RelativeRateOfChangeStrategy against the previous run.
            name = check.get("metric", "size")
            cur = metrics.get(name)
            prev = next((h[name] for h in reversed(history) if name in h), None)
            if cur is None or prev is None:
                results.append(CheckResult(kind, name, True, 0.0, "no history yet"))
                continue
            change = abs(cur - prev) / prev if prev else (0.0 if cur == 0 else math.inf)
            limit = float(check.get("max_relative_change", 0.5))
            results.append(CheckResult(kind, name, change <= limit, change, f"changed {change:.1%} vs last run, limit {limit:.0%}"))
        else:
            raise ValueError(f"unknown check kind: {kind}")

    return QualityReport(
        dataset=str(suite.get("dataset", "")),
        rows=len(rows),
        ok=all(r.ok for r in results),
        checked_at=now.isoformat(),
        results=results,
        metrics=metrics,
    )
