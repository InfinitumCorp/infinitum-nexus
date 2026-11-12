# © Infinitum Corporation®. All rights reserved.
"""Differentially private aggregate releases on Google's differential-privacy library.

Noise comes from Google's C++ library through its Python binding (PyPI ``python-dp``, module
``pydp``). It ships Linux and macOS wheels only, so on Windows run this in the container or CI.

What this module adds on top of the library, because each is needed for a correct release:

* **Public partitions.** Group keys must be supplied up front (e.g. the product list or the
  calendar). Releasing whichever groups happen to appear in the data would leak membership.
* **Contribution bounding.** Each privacy unit (normally the CID) counts in at most
  ``max_partitions`` groups, once per group, and its per-group sum is clamped to bounds.
* **A privacy budget per dataset.** Every release spends epsilon from a persisted ledger,
  and a release that would overspend is refused before any noise is drawn.
* **Small-group suppression** after noise, for readability, not for privacy.

Use it for releases that leave the tenant: Exchange samples, public statistics and
benchmark reports. Internal dashboards use exact numbers under access policy instead.
"""
from __future__ import annotations

import json
import os
import random
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence


class BudgetExceeded(RuntimeError):
    pass


class PrivacyBudget:
    """Total epsilon per dataset, persisted as JSON so restarts do not reset it."""

    def __init__(self, path: str | os.PathLike[str], total_epsilon: float) -> None:
        if not total_epsilon > 0:
            raise ValueError("total_epsilon must be positive")
        self.path = Path(path)
        self.total = float(total_epsilon)
        self._lock = threading.Lock()

    def _load(self) -> dict[str, float]:
        if not self.path.exists():
            return {}
        return {k: float(v) for k, v in json.loads(self.path.read_text("utf-8")).items()}

    def spent(self, dataset: str) -> float:
        return self._load().get(dataset, 0.0)

    def remaining(self, dataset: str) -> float:
        return max(0.0, self.total - self.spent(dataset))

    def charge(self, dataset: str, epsilon: float) -> None:
        if not epsilon > 0:
            raise ValueError("epsilon must be positive")
        with self._lock:
            ledger = self._load()
            used = ledger.get(dataset, 0.0)
            if used + epsilon > self.total + 1e-12:
                raise BudgetExceeded(
                    f"{dataset}: release needs epsilon {epsilon}, only {self.total - used:.4f} left"
                )
            ledger[dataset] = used + epsilon
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(ledger, sort_keys=True), "utf-8")
            tmp.replace(self.path)


class NoiseBackend(Protocol):
    def count(self, units: list[int], epsilon: float, max_partitions: int) -> float: ...

    def bounded_sum(
        self, values: list[float], epsilon: float, lower: float, upper: float, max_partitions: int
    ) -> float: ...


class GoogleDpBackend:
    """Laplace mechanisms from Google's differential-privacy library (via pydp)."""

    def __init__(self) -> None:
        from pydp.algorithms.laplacian import BoundedSum, Count  # noqa: PLC0415

        self._Count = Count
        self._BoundedSum = BoundedSum

    def count(self, units: list[int], epsilon: float, max_partitions: int) -> float:
        algo = self._Count(epsilon=epsilon, l0_sensitivity=max_partitions, linf_sensitivity=1, dtype="int")
        return float(algo.quick_result(units))

    def bounded_sum(
        self, values: list[float], epsilon: float, lower: float, upper: float, max_partitions: int
    ) -> float:
        algo = self._BoundedSum(
            epsilon=epsilon,
            lower_bound=lower,
            upper_bound=upper,
            l0_sensitivity=max_partitions,
            linf_sensitivity=1,
            dtype="float",
        )
        return float(algo.quick_result(values))


@dataclass
class DpRelease:
    dataset: str
    metric: str
    epsilon: float
    groups: dict[str, float]
    suppressed: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset": self.dataset,
            "metric": self.metric,
            "epsilon": self.epsilon,
            "groups": self.groups,
            "suppressed": self.suppressed,
        }


def _bound_contributions(
    rows: Sequence[Mapping[str, Any]],
    unit_key: str,
    group_key: str,
    public_groups: Sequence[str],
    max_partitions: int,
    rng: random.Random,
) -> dict[str, dict[Any, list[Mapping[str, Any]]]]:
    """group -> unit -> rows, keeping at most `max_partitions` groups per unit (chosen at
    random so no group is systematically favoured) and only public groups."""
    allowed = set(public_groups)
    per_unit: dict[Any, dict[str, list[Mapping[str, Any]]]] = {}
    for r in rows:
        g = r.get(group_key)
        u = r.get(unit_key)
        if u is None or g not in allowed:
            continue
        per_unit.setdefault(u, {}).setdefault(g, []).append(r)
    out: dict[str, dict[Any, list[Mapping[str, Any]]]] = {g: {} for g in public_groups}
    for u, groups in per_unit.items():
        keys = list(groups)
        if len(keys) > max_partitions:
            keys = rng.sample(keys, max_partitions)
        for g in keys:
            out[g][u] = groups[g]
    return out


def release(
    rows: Sequence[Mapping[str, Any]],
    *,
    dataset: str,
    metric: str,
    unit_key: str,
    group_key: str,
    public_groups: Sequence[str],
    epsilon: float,
    budget: PrivacyBudget,
    max_partitions: int = 1,
    value_key: str | None = None,
    lower: float = 0.0,
    upper: float = 1.0,
    suppress_below: float = 0.0,
    backend: NoiseBackend | None = None,
    rng: random.Random | None = None,
) -> DpRelease:
    """Release a DP ``count`` (distinct privacy units per group) or ``sum`` of ``value_key``
    per group. The whole epsilon is charged to the budget before any noise is drawn. Every
    group's mechanism gets the full epsilon with l0 sensitivity ``max_partitions``, which is
    what makes the release as a whole epsilon-DP for each privacy unit."""
    if metric not in ("count", "sum"):
        raise ValueError("metric must be 'count' or 'sum'")
    if metric == "sum" and not value_key:
        raise ValueError("sum needs value_key")
    if not public_groups:
        raise ValueError("public_groups is required: group keys must not come from the data")
    if max_partitions < 1:
        raise ValueError("max_partitions must be at least 1")
    if lower > upper:
        raise ValueError("lower must not exceed upper")

    if epsilon > budget.remaining(dataset) + 1e-12:
        raise BudgetExceeded(f"{dataset}: release needs epsilon {epsilon}, only {budget.remaining(dataset):.4f} left")
    backend = backend or GoogleDpBackend()
    rng = rng or random.SystemRandom()
    budget.charge(dataset, epsilon)  # re-checked under the lock

    bounded = _bound_contributions(rows, unit_key, group_key, public_groups, max_partitions, rng)
    groups: dict[str, float] = {}
    suppressed: list[str] = []
    for g in public_groups:
        units = bounded[g]
        if metric == "count":
            noisy = backend.count([1] * len(units), epsilon, max_partitions)
        else:
            per_unit = []
            for unit_rows in units.values():
                total = sum(float(r.get(value_key) or 0.0) for r in unit_rows)
                per_unit.append(min(max(total, lower), upper))
            noisy = backend.bounded_sum(per_unit, epsilon, lower, upper, max_partitions)
        if noisy < suppress_below:
            suppressed.append(g)
        else:
            groups[g] = round(noisy, 6)
    return DpRelease(dataset=dataset, metric=metric, epsilon=epsilon, groups=groups, suppressed=suppressed)


def exact_backend() -> NoiseBackend:
    """No-noise backend for tests of the bounding and budget logic only. Never use it for
    a real release."""

    class _Exact:
        def count(self, units: list[int], epsilon: float, max_partitions: int) -> float:
            return float(len(units))

        def bounded_sum(self, values, epsilon, lower, upper, max_partitions) -> float:
            return float(sum(values))

    return _Exact()
