import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from cumulus_privacy.dp import PrivacyBudget
from cumulus_privacy.server import Gateway, make_handler

TOKEN = "t" * 40


@pytest.fixture()
def base(redactor, tmp_path):
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1.0), TOKEN)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(base, path, body, token=TOKEN):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_health(base):
    with urllib.request.urlopen(base + "/api/v1/health") as r:
        assert json.loads(r.read()) == {"status": "ok"}


def test_rejects_missing_or_wrong_token(base):
    assert call(base, "/api/v1/redact", {}, token="nope")[0] == 401


def test_redact_endpoint(base):
    status, body = call(base, "/api/v1/redact", {"destination": "ai", "records": [{"t": "mail a@b.com"}]})
    assert status == 200
    assert body["records"] == [{"t": "mail <EMAIL_ADDRESS>"}]
    assert body["findings"] == {"EMAIL_ADDRESS": 1}


def test_bad_destination_is_400(base):
    status, body = call(base, "/api/v1/redact", {"destination": "twitter", "records": []})
    assert status == 400 and body["errorName"] == "Privacy:INVALID_ARGUMENT"


def test_budget_exhaustion_is_409(base):
    dp = {
        "dataset": "d",
        "metric": "count",
        "unitKey": "cid",
        "groupKey": "g",
        "publicGroups": ["a"],
        "epsilon": 2.0,
        "rows": [],
    }
    status, body = call(base, "/api/v1/releases/dp", dp)
    assert status == 409 and body["errorName"] == "Privacy:PRIVACY_BUDGET_EXCEEDED"


def test_verify_endpoint(base):
    status, body = call(
        base,
        "/api/v1/quality/verify",
        {"suite": {"dataset": "x", "checks": [{"kind": "size", "min": 2}]}, "rows": [{"a": 1}]},
    )
    assert status == 200 and body["ok"] is False
