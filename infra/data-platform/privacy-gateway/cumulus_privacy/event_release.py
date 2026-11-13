# © Infinitum Corporation®. All rights reserved.
"""Differentially private releases over events already stored by the data platform.

A product asks for a noisy count or sum over one of its own registered datasets (an event
type) in a time window, grouped by a field whose values it supplies up front. The gateway
reads the stored events itself, so raw rows never pass through the caller, and the release
runs through ``dp.release``: contribution bounding per Cumulus ID pseudonym, Google DP noise,
and an epsilon charge against the dataset's persisted budget before any noise is drawn.

What is counted:

* Only events that carry a Cumulus ID pseudonym. The privacy unit is the person, so events
  with no person behind them cannot be bounded and are left out.
* Only events whose consent includes ANALYTICS or EXCHANGE. ESSENTIAL-only events are never
  used for statistics.
* Only fields the catalog marks safe to group or sum on: rule KEEP and a classification of
  PUBLIC, INTERNAL or CONFIDENTIAL. PERSONAL and SPECIAL_CATEGORY fields are refused.

The response never carries exact row or person counts, only the noisy groups and the epsilon
left on the dataset.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable, Mapping, Protocol

from . import dp
from .platform import Catalog, PlatformError, _bad, _iso, _parse_time

METRICS = {"COUNT": "count", "SUM": "sum"}
RELEASE_CONSENTS = {"ANALYTICS", "EXCHANGE"}
GROUPABLE = {"PUBLIC", "INTERNAL", "CONFIDENTIAL"}
NUMERIC = {"integer", "double"}
MAX_EPSILON_PER_RELEASE = 1.0
MAX_GROUPS = 200
MAX_PARTITIONS = 10
MAX_WINDOW = timedelta(days=366)
MAX_ROWS = 200_000


class ReleaseSource(Protocol):
    def release_rows(
        self, product: str, event_type: str, start: datetime, end: datetime, limit: int
    ) -> list[dict[str, Any]]:
        """Up to ``limit`` stored events as {"cid", "consent", "payload"}, cid not null."""
        ...


class StoredReleases:
    def __init__(
        self,
        catalog: Catalog,
        source: Any,
        budget: Any,
        backend: Callable[[], dp.NoiseBackend] | None = None,
        max_rows: int = MAX_ROWS,
    ) -> None:
        self.catalog, self.source, self.budget = catalog, source, budget
        self.backend = backend
        self.max_rows = max_rows

    def _field(self, spec: Mapping[str, Any], name: Any, what: str) -> Mapping[str, Any]:
        fields = {f["name"]: f for f in spec["fields"]}
        if not isinstance(name, str) or name not in fields:
            raise _bad(f"{what} must be a field of {spec['name']}")
        f = fields[name]
        if f["rule"] != "KEEP" or f["classification"] not in GROUPABLE:
            raise _bad(f"{what} {name} is {f['classification']} with rule {f['rule']}; it cannot be released")
        return f

    def release(self, caller: str, name: str, req: Mapping[str, Any]) -> dict[str, Any]:
        spec = self.catalog.read(caller, name)  # 404 / 403 for other products' datasets
        if not callable(getattr(self.source, "release_rows", None)):
            raise PlatformError(500, "NotConfigured", "the event store does not support releases")

        start = _parse_time(req.get("from"), "from")
        end = _parse_time(req.get("to"), "to")
        if end <= start:
            raise _bad("to must be after from")
        if end - start > MAX_WINDOW:
            raise _bad("the time window is limited to 366 days")

        metric = METRICS.get(str(req.get("metric", "")).upper())
        if metric is None:
            raise _bad("metric must be COUNT or SUM")
        group_by = self._field(spec, req.get("groupBy"), "groupBy")["name"]
        value_field = None
        if metric == "sum":
            vf = self._field(spec, req.get("valueField"), "valueField")
            if vf["type"] not in NUMERIC:
                raise _bad(f"valueField {vf['name']} is not numeric")
            value_field = vf["name"]

        groups = req.get("publicGroups")
        if not isinstance(groups, list) or not groups or not all(isinstance(g, str) and g for g in groups):
            raise _bad("publicGroups must be a non-empty list of group values chosen without looking at the data")
        if len(groups) > MAX_GROUPS or len(set(groups)) != len(groups):
            raise _bad(f"publicGroups must be at most {MAX_GROUPS} distinct values")

        epsilon = req.get("epsilon")
        if isinstance(epsilon, bool) or not isinstance(epsilon, (int, float)) or not 0 < epsilon <= MAX_EPSILON_PER_RELEASE:
            raise _bad(f"epsilon must be above 0 and at most {MAX_EPSILON_PER_RELEASE}")
        max_partitions = req.get("maxPartitions", 1)
        if isinstance(max_partitions, bool) or not isinstance(max_partitions, int) or not 1 <= max_partitions <= MAX_PARTITIONS:
            raise _bad(f"maxPartitions must be an integer from 1 to {MAX_PARTITIONS}")
        lower, upper, suppress = (req.get(k, d) for k, d in (("lower", 0.0), ("upper", 1.0), ("suppressBelow", 0.0)))
        for k, v in (("lower", lower), ("upper", upper), ("suppressBelow", suppress)):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise _bad(f"{k} must be a number")
        if metric == "sum" and not lower < upper:
            raise _bad("lower must be below upper")

        if float(epsilon) > self.budget.remaining(name) + 1e-12:
            raise PlatformError(409, "PrivacyBudgetExceeded",
                                f"{name}: {self.budget.remaining(name):.4f} epsilon left", {"name": name})

        stored = self.source.release_rows(caller, name, start, end, self.max_rows + 1)
        if len(stored) > self.max_rows:
            raise _bad("too many events in the window for one release; use a shorter window")
        rows = []
        for r in stored:
            if not r.get("cid") or not RELEASE_CONSENTS & set(r.get("consent") or ()):
                continue
            payload = r.get("payload") or {}
            g = payload.get(group_by)
            row = {"unit": r["cid"], "group": g if isinstance(g, str) else str(g)}
            if value_field:
                v = payload.get(value_field)
                row["value"] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0
            rows.append(row)

        try:
            out = dp.release(
                rows,
                dataset=name,
                metric=metric,
                unit_key="unit",
                group_key="group",
                public_groups=groups,
                epsilon=float(epsilon),
                budget=self.budget,
                max_partitions=max_partitions,
                value_key="value" if value_field else None,
                lower=float(lower),
                upper=float(upper),
                suppress_below=float(suppress),
                backend=self.backend() if self.backend else None,
            )
        except dp.BudgetExceeded as e:  # lost a race with another release
            raise PlatformError(409, "PrivacyBudgetExceeded", str(e), {"name": name}) from e
        except ImportError as e:
            raise PlatformError(503, "DpLibraryUnavailable", "Google DP library is not installed") from e
        return {
            "dataset": name,
            "metric": metric.upper(),
            "from": _iso(start),
            "to": _iso(end),
            "epsilon": out.epsilon,
            "groups": out.groups,
            "suppressed": out.suppressed,
            "remainingEpsilon": round(self.budget.remaining(name), 6),
        }
