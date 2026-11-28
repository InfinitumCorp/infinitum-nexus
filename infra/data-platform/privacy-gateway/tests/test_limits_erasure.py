"""Ingest limits (batch size, daily quota, free-tier storage guard) and the right to erasure."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from cumulus_privacy.dp import PrivacyBudget
from cumulus_privacy.platform import Catalog, Collector, Eraser, IngestLimits, PlatformError, Searcher
from cumulus_privacy.server import Gateway, make_handler, parse_product_tokens

from .test_platform import DEALS, FakeIndex, _q, event

MAIL_SPEC = {**DEALS, "name": "cumulus-mail.message.sent", "product": "cumulus-mail"}


class Clock:
    def __init__(self, t=1_794_000_000.0):  # 2026-11-12, mid-day UTC
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture()
def world(redactor, tmp_path):
    catalog = Catalog(tmp_path / "catalog.json")
    catalog.register("spectre", DEALS["name"], DEALS)
    catalog.register("cumulus-mail", MAIL_SPEC["name"], MAIL_SPEC)
    index = FakeIndex()
    return catalog, index


def mail_event(**over):
    return event(product="cumulus-mail", eventType=MAIL_SPEC["name"], **over)


# ------------------------------------------------------------------ limits


def test_batch_size_is_capped(world, redactor):
    catalog, index = world
    c = Collector(catalog, redactor, index, "EU", IngestLimits(max_batch=2))
    c.ingest("spectre", [event(), event()])
    with pytest.raises(PlatformError) as e:
        c.ingest("spectre", [event(), event(), event()])
    assert e.value.status == 413


def test_daily_quota_per_product_resets_at_utc_midnight(world, redactor):
    catalog, index = world
    clock = Clock()
    limits = IngestLimits(daily_quota=3, clock=clock)
    c = Collector(catalog, redactor, index, "EU", limits)
    assert c.ingest("spectre", [event(), event(), event()])["accepted"] == 3
    with pytest.raises(PlatformError) as e:
        c.ingest("spectre", [event()])
    assert (e.value.status, e.value.name) == (429, "IngestQuotaExceeded")
    assert 0 < e.value.retry_after <= 86400
    # Another product has its own quota, and duplicates or rejects do not count.
    dup = mail_event()
    assert c.ingest("cumulus-mail", [dup, dup, mail_event(region="US")])["accepted"] == 1
    assert limits.used_today("cumulus-mail") == 1
    clock.t += e.value.retry_after
    assert c.ingest("spectre", [event()])["accepted"] == 1


def test_storage_guard_refuses_when_full_and_reports_state(world, redactor):
    catalog, index = world
    clock, size = Clock(), {"bytes": 100}
    limits = IngestLimits(storage_limit_bytes=1000, storage=lambda: size["bytes"], clock=clock)
    c = Collector(catalog, redactor, index, "EU", limits)
    assert limits.storage_state() == "ok"
    c.ingest("spectre", [event()])
    size["bytes"] = 850
    clock.t += IngestLimits.STORAGE_TTL + 1
    assert limits.storage_state() == "nearly_full"
    size["bytes"] = 1000
    assert limits.storage_state() == "nearly_full"  # cached for a minute: one query, not one per request
    clock.t += IngestLimits.STORAGE_TTL + 1
    with pytest.raises(PlatformError) as e:
        c.ingest("spectre", [event()])
    assert (e.value.status, e.value.name, e.value.retry_after) == (503, "StorageQuotaReached", 3600)
    assert len(index.docs) == 1


def test_storage_guard_off_and_broken_store():
    assert IngestLimits().storage_state() == "ok"

    def broken():
        raise OSError("db down")

    assert IngestLimits(storage_limit_bytes=10, storage=broken).storage_state() == "unknown"


def test_limits_reject_nonsense():
    for kw in ({"max_batch": 0}, {"daily_quota": -1}, {"storage_limit_bytes": -5}):
        with pytest.raises(ValueError):
            IngestLimits(**kw)


# ------------------------------------------------------------------ erasure


def test_product_erasure_is_scoped_to_the_product(world, redactor):
    catalog, index = world
    c = Collector(catalog, redactor, index, "EU")
    c.ingest("spectre", [event(), event(tenant="globex"), event(cid="cid_someone_else")])
    c.ingest("cumulus-mail", [mail_event()])
    eraser = Eraser(redactor, index)
    assert eraser.erase("spectre", "cid_person0001") == {"deleted": 2}  # both tenants
    assert eraser.erase("spectre", "cid_person0001") == {"deleted": 0}  # idempotent
    assert len(index.docs) == 2  # the other person, and Mail's event
    assert eraser.erase(None, "cid_person0001") == {"deleted": 1}  # everywhere: Mail's too
    assert [d["product"] for d in index.docs.values()] == ["spectre"]


def test_erasure_needs_a_cid(world, redactor):
    _, index = world
    for bad in (None, "", "   ", 42):
        with pytest.raises(PlatformError):
            Eraser(redactor, index).erase("spectre", bad)


def test_erasure_matches_the_collection_pseudonym_not_the_raw_cid(world, redactor):
    catalog, index = world
    Collector(catalog, redactor, index, "EU").ingest("spectre", [event()])
    stored = next(iter(index.docs.values()))
    assert "cid_person0001" not in json.dumps(stored)
    assert Eraser(redactor, index).erase("spectre", " cid_person0001 ") == {"deleted": 1}


# ------------------------------------------------------------------ over HTTP


def test_erasure_quota_and_health_over_http(world, redactor, tmp_path):
    catalog, index = world
    s_tok, m_tok, g_tok = "s" * 40, "m" * 40, "g" * 40
    limits = IngestLimits(daily_quota=1, storage_limit_bytes=1000, storage=lambda: 900)
    collector = Collector(catalog, redactor, index, "EU", limits)
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), g_tok, catalog, collector, Searcher(index),
                 parse_product_tokens(f"spectre={s_tok};cumulus-mail={m_tok}"), Eraser(redactor, index))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(method, path, body=None, token=s_tok):
        req = urllib.request.Request(
            base + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read()), r.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers

    try:
        status, body, _ = call("GET", "/api/v1/health")
        assert status == 200 and body == {"status": "ok", "storage": "nearly_full"}
        assert call("POST", "/api/v1/collect/events", {"events": [event()]})[1]["accepted"] == 1
        status, err, headers = call("POST", "/api/v1/collect/events", {"events": [event()]})
        assert status == 429 and err["errorName"] == "DataPlatform:IngestQuotaExceeded"
        assert err["errorCode"] == "CUSTOM_CLIENT" and int(headers["Retry-After"]) > 0
        assert call("POST", "/api/v1/search/events", _q())[1]["hits"]

        status, out, _ = call("POST", "/api/v1/erasure/subjects", {"cid": "cid_person0001"}, token=m_tok)
        assert (status, out) == (200, {"deleted": 0})  # Mail cannot erase Spectre's events
        assert call("POST", "/api/v1/erasure/subjects/all-products", {"cid": "x"}, token=s_tok)[0] == 401
        status, out, _ = call("POST", "/api/v1/erasure/subjects", {"cid": "cid_person0001"})
        assert (status, out) == (200, {"deleted": 1})
        assert call("POST", "/api/v1/search/events", _q())[1]["hits"] == []
        status, out, _ = call("POST", "/api/v1/erasure/subjects/all-products", {"cid": "cid_person0001"}, token=g_tok)
        assert (status, out) == (200, {"deleted": 0})
        status, err, _ = call("POST", "/api/v1/erasure/subjects", {})
        assert status == 400 and err["errorName"] == "DataPlatform:InvalidArgument"
    finally:
        httpd.shutdown()
