"""Differentially private releases over stored events (event_release.StoredReleases)."""
import json
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

from cumulus_privacy.dp import PrivacyBudget, exact_backend
from cumulus_privacy.event_release import StoredReleases
from cumulus_privacy.platform import Catalog, Collector, PlatformError
from cumulus_privacy.server import Gateway, make_handler, parse_product_tokens

from .test_platform import DEALS, OBJECTS, FakeIndex, event

WINDOW = {"from": "2026-11-01T00:00:00Z", "to": "2026-12-01T00:00:00Z"}


class ReleaseIndex(FakeIndex):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def release_rows(self, product, event_type, start, end, limit):
        self.calls += 1
        out = []
        for d in self.docs.values():
            t = datetime.fromisoformat(d["occurredAt"].replace("Z", "+00:00"))
            if d["product"] == product and d["eventType"] == event_type and d.get("cid") and start <= t < end:
                out.append({"cid": d["cid"], "consent": d["consent"], "payload": d["payload"]})
        return out[:limit]


def deal(cid, stage, amount, consent=("ESSENTIAL", "ANALYTICS"), **over):
    e = event(cid=cid, consent=list(consent), **over)
    e["payload"] = {**e["payload"], "stage": stage, "amount": amount}
    return e


@pytest.fixture()
def setup(redactor, tmp_path):
    catalog = Catalog(tmp_path / "catalog.json")
    catalog.register("spectre", DEALS["name"], DEALS)
    index = ReleaseIndex()
    collector = Collector(catalog, redactor, index, "EU")
    collector.ingest("spectre", [
        deal("cid_a0000001", "won", 100.0),
        deal("cid_a0000001", "won", 900.0),  # same person twice: counted once
        deal("cid_b0000002", "won", 5000.0),  # clamped to upper
        deal("cid_c0000003", "lost", 50.0),
        deal("cid_d0000004", "open", 10.0),  # not a public group
        deal("cid_e0000005", "won", 70.0, consent=("ESSENTIAL",)),  # no analytics consent
        deal(None, "won", 70.0),  # no person
        deal("cid_f0000006", "won", 70.0, occurredAt="2026-10-01T00:00:00Z"),  # outside the window
    ])
    budget = PrivacyBudget(tmp_path / "budget.json", 2.0)
    return StoredReleases(catalog, index, budget, backend=exact_backend), budget, index


def req(**over):
    r = {**WINDOW, "metric": "COUNT", "groupBy": "stage", "publicGroups": ["won", "lost"], "epsilon": 0.5}
    r.update(over)
    return r


def test_count_bounds_people_consent_and_window(setup):
    releases, budget, _ = setup
    out = releases.release("spectre", DEALS["name"], req())
    assert out["groups"] == {"won": 2.0, "lost": 1.0}
    assert out["metric"] == "COUNT" and out["epsilon"] == 0.5
    assert out["remainingEpsilon"] == pytest.approx(1.5) and budget.spent(DEALS["name"]) == pytest.approx(0.5)
    assert set(out) == set(OBJECTS["StoredReleaseResponse"]["fields"])


def test_sum_clamps_each_person(setup):
    releases, *_ = setup
    out = releases.release("spectre", DEALS["name"], req(metric="sum", valueField="amount", lower=0, upper=1000))
    assert out["groups"] == {"won": 2000.0, "lost": 50.0}  # a: 100+900, b: 5000 -> 1000


def test_suppression_and_missing_groups(setup):
    releases, *_ = setup
    out = releases.release("spectre", DEALS["name"], req(publicGroups=["won", "lost", "stalled"], suppressBelow=2))
    assert out["groups"] == {"won": 2.0} and sorted(out["suppressed"]) == ["lost", "stalled"]


def test_budget_is_enforced_before_reading_events(setup):
    releases, budget, index = setup
    for _ in range(2):
        releases.release("spectre", DEALS["name"], req(epsilon=1.0))
    calls = index.calls
    with pytest.raises(PlatformError) as e:
        releases.release("spectre", DEALS["name"], req(epsilon=0.1))
    assert e.value.name == "PrivacyBudgetExceeded" and e.value.status == 409
    assert index.calls == calls and budget.spent(DEALS["name"]) == pytest.approx(2.0)


def test_other_products_cannot_release(setup):
    releases, budget, _ = setup
    with pytest.raises(PlatformError) as e:
        releases.release("cumulus-mail", DEALS["name"], req())
    assert e.value.name == "DatasetNotFound"
    assert budget.spent(DEALS["name"]) == 0.0


@pytest.mark.parametrize(
    "over, message",
    [
        ({"groupBy": "note"}, "cannot be released"),  # PERSONAL
        ({"groupBy": "contactEmail"}, "cannot be released"),
        ({"groupBy": "nope"}, "must be a field"),
        ({"metric": "SUM", "valueField": "stage"}, "not numeric"),
        ({"metric": "SUM"}, "valueField"),
        ({"metric": "MEAN"}, "COUNT or SUM"),
        ({"epsilon": 0}, "epsilon"),
        ({"epsilon": 1.5}, "epsilon"),
        ({"epsilon": True}, "epsilon"),
        ({"publicGroups": []}, "publicGroups"),
        ({"publicGroups": ["won", "won"]}, "publicGroups"),
        ({"maxPartitions": 0}, "maxPartitions"),
        ({"to": "2026-10-01T00:00:00Z"}, "after"),
        ({"from": "2024-01-01T00:00:00Z"}, "366 days"),
        ({"from": "2026-11-01"}, "time zone"),
        ({"metric": "SUM", "valueField": "amount", "lower": 5, "upper": 5}, "lower"),
    ],
)
def test_validation(setup, over, message):
    releases, budget, _ = setup
    with pytest.raises(PlatformError) as e:
        releases.release("spectre", DEALS["name"], req(**over))
    assert e.value.name == "InvalidArgument" and message in e.value.message
    assert budget.spent(DEALS["name"]) == 0.0


def test_row_cap(setup):
    releases, budget, _ = setup
    releases.max_rows = 3
    with pytest.raises(PlatformError, match="shorter window"):
        releases.release("spectre", DEALS["name"], req())
    assert budget.spent(DEALS["name"]) == 0.0


def test_source_without_release_support(tmp_path):
    catalog = Catalog(tmp_path / "c.json")
    catalog.register("spectre", DEALS["name"], DEALS)
    releases = StoredReleases(catalog, FakeIndex(), PrivacyBudget(tmp_path / "b.json", 1), backend=exact_backend)
    with pytest.raises(PlatformError) as e:
        releases.release("spectre", DEALS["name"], req())
    assert e.value.name == "NotConfigured"


def test_release_over_http(setup, redactor, tmp_path):
    releases, budget, _ = setup
    token = "s" * 40
    gw = Gateway(redactor, budget, "g" * 40, releases.catalog, None, None,
                 parse_product_tokens(f"spectre={token}"), None, releases=releases)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/api/v1/releases/datasets/{DEALS['name']}"

    def call(body, tok=token):
        r = urllib.request.Request(url, method="POST", data=json.dumps(body).encode(),
                                   headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        status, out = call(req(epsilon=1.0))
        assert status == 200 and out["groups"] == {"won": 2.0, "lost": 1.0}
        status, err = call(req(epsilon=1.0))
        assert status == 200
        status, err = call(req(epsilon=0.5))
        assert status == 409 and err["errorName"] == "DataPlatform:PrivacyBudgetExceeded"
        assert err["errorCode"] == "CONFLICT" and err["parameters"]["name"] == DEALS["name"]
        assert call(req(), tok="g" * 40)[0] == 401  # the pipeline token is not a product token
    finally:
        httpd.shutdown()
