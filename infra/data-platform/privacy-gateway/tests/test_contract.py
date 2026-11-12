"""The gateway must serve exactly what conjure/privacy.yml declares."""
from pathlib import Path

import pytest
import yaml

from cumulus_privacy.dp import PrivacyBudget, exact_backend
from cumulus_privacy.server import CONJURE_CODES, Gateway

SPEC = yaml.safe_load((Path(__file__).parents[2] / "conjure" / "privacy.yml").read_text("utf-8"))
OBJECTS = SPEC["types"]["definitions"]["objects"]
SERVICE = SPEC["services"]["PrivacyGatewayService"]
ERRORS = SPEC["types"]["definitions"]["errors"]


def fields(name):
    return set(OBJECTS[name]["fields"])


@pytest.fixture()
def gw(redactor, tmp_path, monkeypatch):
    # Contract shape only: no-noise backend so this runs on every OS.
    import cumulus_privacy.dp as dp

    monkeypatch.setattr(dp, "GoogleDpBackend", exact_backend)
    return Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 5), "t" * 40)


def test_every_endpoint_is_routed(gw):
    declared = {SERVICE["base-path"] + e["http"].split(" ", 1)[1] for e in SERVICE["endpoints"].values()}
    assert declared == set(gw.routes)
    assert all(e["http"].startswith("POST ") for e in SERVICE["endpoints"].values())


def test_responses_match_declared_objects(gw):
    rec = [{"cid": "cid_abcdef12", "note": "hi a@b.com", "n": 1}]
    rules = {"cid": "PSEUDONYMIZE"}  # Conjure enum casing
    assert set(gw.redact({"destination": "ANALYTICS", "records": rec, "fieldRules": rules})) == fields("RedactResponse")
    suite = {"dataset": "x", "checks": [{"kind": "FRESHNESS", "column": "t", "maxAgeHours": 1}, {"kind": "SIZE", "min": 1}]}
    prep = gw.prepare({"destination": "EXCHANGE", "records": rec, "suite": suite})
    assert set(prep) == fields("PrepareExportResponse")
    report = gw.verify({"suite": suite, "rows": rec})
    assert set(report) == fields("QualityReport")
    assert set(report["results"][0]) == fields("CheckResult")
    out = gw.dp_release(
        {"dataset": "d", "metric": "COUNT", "unitKey": "cid", "groupKey": "g", "publicGroups": ["a"], "epsilon": 1, "rows": []}
    )
    assert set(out) == fields("DpReleaseResponse")


def test_request_fields_are_the_declared_ones():
    import inspect

    import cumulus_privacy.server as server

    src = inspect.getsource(server.Gateway)
    for obj in ("RedactRequest", "PrepareExportRequest", "VerifyRequest", "DpReleaseRequest"):
        for f in fields(obj):
            assert f'"{f}"' in src, f"{obj}.{f} is declared but never read"


def test_error_codes_are_conjure_codes():
    declared = {e["code"] for e in ERRORS.values()}
    assert declared <= set(CONJURE_CODES.values())
