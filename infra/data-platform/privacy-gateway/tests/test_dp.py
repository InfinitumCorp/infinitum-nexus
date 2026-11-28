import random
import statistics

import pytest

from cumulus_privacy.dp import BudgetExceeded, PrivacyBudget, exact_backend, release

ROWS = (
    [{"cid": f"u{i}", "product": "spectre", "minutes": 30} for i in range(40)]
    + [{"cid": f"u{i}", "product": "mail", "minutes": 500} for i in range(25)]
    + [{"cid": "u0", "product": "spectre", "minutes": 30}] * 50  # one heavy user
    + [{"cid": "x", "product": "secret-product", "minutes": 1}]  # not a public group
)
GROUPS = ["spectre", "mail", "fabric"]


def _release(budget, **kw):
    args = dict(
        dataset="usage.daily",
        metric="count",
        unit_key="cid",
        group_key="product",
        public_groups=GROUPS,
        epsilon=1.0,
        budget=budget,
        backend=exact_backend(),
        rng=random.Random(7),
    )
    args.update(kw)
    return release(ROWS, **args)


def test_counts_distinct_units_in_public_groups_only(tmp_path):
    out = _release(PrivacyBudget(tmp_path / "b.json", 10), max_partitions=2)
    assert out.groups == {"spectre": 40.0, "mail": 25.0, "fabric": 0.0}
    assert "secret-product" not in out.groups


def test_max_partitions_bounds_each_unit(tmp_path):
    out = _release(PrivacyBudget(tmp_path / "b.json", 10), max_partitions=1)
    # u0..u24 are in both groups; each keeps only one.
    assert out.groups["spectre"] + out.groups["mail"] == 40.0


def test_sum_clamps_per_unit_contribution(tmp_path):
    out = _release(
        PrivacyBudget(tmp_path / "b.json", 10),
        metric="sum",
        value_key="minutes",
        lower=0,
        upper=120,
        max_partitions=2,
    )
    assert out.groups["spectre"] == 40 * 30 - 30 + 120  # u0's 51 sessions clamp to 120
    assert out.groups["mail"] == 25 * 120


def test_suppression(tmp_path):
    out = _release(PrivacyBudget(tmp_path / "b.json", 10), max_partitions=2, suppress_below=1)
    assert out.suppressed == ["fabric"]


def test_budget_is_persisted_and_enforced(tmp_path):
    path = tmp_path / "b.json"
    _release(PrivacyBudget(path, 1.5), epsilon=1.0)
    again = PrivacyBudget(path, 1.5)  # a restart must not reset spending
    assert again.remaining("usage.daily") == pytest.approx(0.5)
    with pytest.raises(BudgetExceeded):
        _release(again, epsilon=1.0)
    assert again.spent("usage.daily") == pytest.approx(1.0)  # refused release spends nothing


def test_rejects_data_derived_groups(tmp_path):
    with pytest.raises(ValueError):
        _release(PrivacyBudget(tmp_path / "b.json", 10), public_groups=[])


def test_google_dp_library_adds_calibrated_noise(tmp_path):
    pytest.importorskip("pydp", reason="Google DP wheels are Linux/macOS only; runs in CI")
    budget = PrivacyBudget(tmp_path / "b.json", 1000)
    rows = [{"cid": f"u{i}", "product": "spectre"} for i in range(1000)]
    values = [
        release(
            rows,
            dataset="d",
            metric="count",
            unit_key="cid",
            group_key="product",
            public_groups=["spectre"],
            epsilon=1.0,
            budget=budget,
        ).groups["spectre"]
        for _ in range(200)
    ]
    assert len(set(values)) > 1  # noisy, not exact
    assert statistics.mean(values) == pytest.approx(1000, abs=1.0)  # Laplace(1): mean error ~0.1
    assert statistics.pstdev(values) < 5
