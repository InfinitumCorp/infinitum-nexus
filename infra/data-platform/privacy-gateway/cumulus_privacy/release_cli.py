# © Infinitum Corporation®. All rights reserved.
"""Operator tool for differentially private releases (ReleaseService), with a release record.

    DATA_API_URL=https://data-api.example.com DATA_API_TOKEN=<product token> \
      python -m cumulus_privacy.release_cli release.json --out report.json [--dry-run]

``release.json`` holds ``{"dataset": "spectre.deal.stage_changed", "request": {StoredReleaseRequest}}``.

1. Reads the dataset's budget (``getBudget``, which spends nothing) and refuses before any spend
   if the request's epsilon is above what is left or above the per-release cap.
2. ``--dry-run`` stops there and prints the plan.
3. Otherwise runs ``releaseDataset`` once (never retried, since every call spends epsilon) and
   writes a report: the request, the budget before, the noisy figures, the suppressed groups
   and a sha256 over the published figures, so a figure quoted later can be traced to this run.

The product token is read from the environment and never printed or written to the report.
Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

Transport = Callable[[str, str, Any], tuple[int, dict[str, Any]]]


class ReleaseRefused(Exception):
    pass


def http_transport(base: str, token: str, timeout: float = 120.0) -> Transport:
    base = base.rstrip("/")
    if not base.startswith("https://") and not base.startswith(("http://127.0.0.1", "http://localhost")):
        raise ValueError("DATA_API_URL must use https")

    def call(method: str, path: str, body: Any = None) -> tuple[int, dict[str, Any]]:
        req = urllib.request.Request(
            base + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}
    return call


def _seg(s: str) -> str:
    from urllib.parse import quote
    if not isinstance(s, str) or not s:
        raise ReleaseRefused("dataset is required")
    return quote(s, safe="")


def figures_sha256(release: Mapping[str, Any]) -> str:
    """Over what is published: dataset, metric, window, epsilon, groups and suppressed."""
    keys = ("dataset", "metric", "from", "to", "epsilon", "groups", "suppressed")
    canon = json.dumps({k: release.get(k) for k in keys}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def _err(status: int, out: Mapping[str, Any]) -> str:
    name = out.get("errorName", f"HTTP {status}")
    msg = (out.get("parameters") or {}).get("message", "")
    return f"{name}: {msg}".rstrip(": ")


def plan(call: Transport, spec: Mapping[str, Any]) -> dict[str, Any]:
    dataset, req = spec.get("dataset"), spec.get("request")
    if not isinstance(req, Mapping):
        raise ReleaseRefused("request is required")
    eps = req.get("epsilon")
    if isinstance(eps, bool) or not isinstance(eps, (int, float)) or eps <= 0:
        raise ReleaseRefused("request.epsilon must be a positive number")
    status, budget = call("GET", f"/api/v1/releases/datasets/{_seg(dataset)}/budget", None)
    if status != 200:
        raise ReleaseRefused(f"budget check failed: {_err(status, budget)}")
    if eps > budget["maxEpsilonPerRelease"]:
        raise ReleaseRefused(f"epsilon {eps} is above the per-release cap {budget['maxEpsilonPerRelease']}")
    if eps > budget["remainingEpsilon"]:
        raise ReleaseRefused(f"epsilon {eps} is above the remaining budget {budget['remainingEpsilon']}")
    return {"dataset": dataset, "request": dict(req), "budgetBefore": budget,
            "remainingAfter": round(budget["remainingEpsilon"] - eps, 12)}


def run(call: Transport, spec: Mapping[str, Any], now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> dict[str, Any]:
    p = plan(call, spec)
    status, out = call("POST", f"/api/v1/releases/datasets/{_seg(p['dataset'])}", p["request"])
    if status != 200:
        raise ReleaseRefused(f"release failed: {_err(status, out)}")
    return {
        "releasedAt": now().isoformat().replace("+00:00", "Z"),
        "dataset": p["dataset"],
        "request": p["request"],
        "budgetBefore": p["budgetBefore"],
        "release": out,
        "figuresSha256": figures_sha256(out),
        "note": "Differentially private figures (Google DP). Suppressed groups are withheld, not zero.",
    }


def main(argv: list[str] | None = None, transport: Transport | None = None) -> int:
    ap = argparse.ArgumentParser(prog="release_cli", description="Plan and run a DP release with a record.")
    ap.add_argument("spec", help="release.json: {dataset, request}")
    ap.add_argument("--out", help="where to write the report (required unless --dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="check the budget and print the plan; spend nothing")
    a = ap.parse_args(argv)
    if not a.dry_run and not a.out:
        ap.error("--out is required unless --dry-run")
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    if transport is None:
        url, token = os.environ.get("DATA_API_URL"), os.environ.get("DATA_API_TOKEN")
        if not url or not token:
            print("set DATA_API_URL and DATA_API_TOKEN (the product's gateway token)", file=sys.stderr)
            return 2
        transport = http_transport(url, token)
    try:
        if a.dry_run:
            print(json.dumps(plan(transport, spec), indent=2, sort_keys=True))
            return 0
        report = run(transport, spec)
    except ReleaseRefused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 3
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"released {report['dataset']}: epsilon {report['request']['epsilon']}, "
          f"{len(report['release'].get('groups', {}))} groups, {len(report['release'].get('suppressed', []))} suppressed, "
          f"{report['release'].get('remainingEpsilon')} epsilon left; sha256 {report['figuresSha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
