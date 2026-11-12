import json
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from cumulus_privacy.dp import PrivacyBudget
from cumulus_privacy.platform import (
    Catalog,
    Collector,
    DataHubSink,
    PlatformError,
    Searcher,
    dataset_urn,
)
from cumulus_privacy.server import CONJURE_CODES, Gateway, make_handler, parse_product_tokens

PLATFORM = yaml.safe_load((Path(__file__).parents[2] / "conjure" / "platform.yml").read_text("utf-8"))
OBJECTS = PLATFORM["types"]["definitions"]["objects"]


class FakeIndex:
    """In-memory stand-in for OpenSearch that evaluates the query shapes Searcher emits."""

    def __init__(self):
        self.docs: dict[str, dict] = {}

    def create(self, doc_id, doc):
        if doc_id in self.docs:
            return False
        self.docs[doc_id] = json.loads(json.dumps(doc))
        return True

    @staticmethod
    def _ms(iso):
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)

    def search(self, body):
        q = body["query"]["bool"]
        rows = []
        for d in self.docs.values():
            ok = True
            for f in q["filter"]:
                if "term" in f:
                    (k, v), = f["term"].items()
                    ok &= d.get(k) == v
                else:
                    r = f["range"]["occurredAt"]
                    t = self._ms(d["occurredAt"])
                    ok &= self._ms(r["gte"]) <= t <= self._ms(r["lte"])
            for m in q.get("must", []):
                ok &= all(w.lower() in d["text"].lower() for w in m["match"]["text"].split())
            if ok:
                rows.append(d)
        rows.sort(key=lambda d: (self._ms(d["occurredAt"]), d["eventId"]), reverse=True)
        if "search_after" in body:
            after = tuple(body["search_after"])
            rows = [d for d in rows if (self._ms(d["occurredAt"]), d["eventId"]) < after]
        rows = rows[: body["size"]]
        return {"hits": {"hits": [{"_source": d, "sort": [self._ms(d["occurredAt"]), d["eventId"]]} for d in rows]}}


class FakeSink:
    def __init__(self, fail=False):
        self.pushed, self.fail = [], fail

    def push(self, spec):
        if self.fail:
            raise urllib.error.URLError("down")
        self.pushed.append(spec["name"])


DEALS = {
    "name": "spectre.deal.stage_changed",
    "product": "spectre",
    "owners": ["team-spectre"],
    "description": "A deal moved to another pipeline stage.",
    "fields": [
        {"name": "dealId", "type": "string", "classification": "INTERNAL", "rule": "KEEP"},
        {"name": "stage", "type": "string", "classification": "INTERNAL", "rule": "KEEP"},
        {"name": "amount", "type": "double", "classification": "CONFIDENTIAL", "rule": "KEEP"},
        {"name": "note", "type": "string", "classification": "PERSONAL", "rule": "TEXT"},
        {"name": "contactEmail", "type": "string", "classification": "PERSONAL", "rule": "PSEUDONYMIZE"},
        {"name": "apiKey", "type": "string", "classification": "CONFIDENTIAL", "rule": "DROP"},
    ],
    "upstream": ["spectre.deals"],
    "retentionDays": 365,
    "region": "EU",
    "glossaryTerms": ["Deal"],
}


def event(**over):
    e = {
        "eventId": str(uuid.uuid4()),
        "product": "spectre",
        "tenant": "acme",
        "cid": "cid_person0001",
        "eventType": "spectre.deal.stage_changed",
        "schemaVersion": 1,
        "occurredAt": "2026-11-12T10:00:00Z",
        "region": "EU",
        "consent": ["ESSENTIAL", "ANALYTICS"],
        "objectType": "deal",
        "objectId": "d-1",
        "payload": {
            "dealId": "d-1",
            "stage": "won",
            "amount": 1200.0,
            "note": "Signed after a call with Jane Doe, jane@example.com",
            "contactEmail": "jane@example.com",
            "apiKey": "never-index-this",
        },
    }
    e.update(over)
    return e


@pytest.fixture()
def platform(redactor, tmp_path):
    sink = FakeSink()
    catalog = Catalog(tmp_path / "catalog.json", sink)
    index = FakeIndex()
    catalog.register("spectre", DEALS["name"], DEALS)
    return catalog, Collector(catalog, redactor, index, "EU"), Searcher(index), index, sink


# ------------------------------------------------------------------ catalog


def test_register_persists_and_pushes_to_datahub(platform, tmp_path):
    catalog, *_, sink = platform
    assert sink.pushed == ["spectre.deal.stage_changed"]
    assert catalog.read("spectre", DEALS["name"])["fields"][3]["rule"] == "TEXT"
    reopened = Catalog(tmp_path / "catalog.json")
    assert reopened.get(DEALS["name"])["owners"] == ["team-spectre"]


def test_products_cannot_register_or_read_each_others_datasets(platform):
    catalog, *_ = platform
    with pytest.raises(PlatformError) as e:
        catalog.register("cumulus-mail", DEALS["name"], DEALS)
    assert e.value.name == "TenantNotAuthorized"
    with pytest.raises(PlatformError) as e:
        catalog.read("cumulus-mail", DEALS["name"])
    assert e.value.name == "DatasetNotFound"  # indistinguishable from missing


@pytest.mark.parametrize(
    "change, message",
    [
        ({"name": "Spectre Deals"}, "spec.name"),
        ({"owners": []}, "owner"),
        ({"region": "MARS"}, "region"),
        ({"fields": [{"name": "email", "type": "string", "classification": "PERSONAL", "rule": "KEEP"}]}, "KEEP"),
        ({"fields": [{"name": "x", "type": "string", "classification": "SECRETISH", "rule": "TEXT"}]}, "classification"),
    ],
)
def test_spec_validation(tmp_path, change, message):
    with pytest.raises(PlatformError) as e:
        Catalog(tmp_path / "c.json").register("spectre", DEALS["name"], {**DEALS, **change})
    assert message in e.value.message


def test_datahub_failure_keeps_the_local_copy(tmp_path):
    catalog = Catalog(tmp_path / "c.json", FakeSink(fail=True))
    with pytest.raises(PlatformError) as e:
        catalog.register("spectre", DEALS["name"], DEALS)
    assert e.value.name == "CatalogUnavailable"
    assert catalog.get(DEALS["name"]) is not None


def test_datahub_proposals():
    props = {p["aspectName"]: p for p in DataHubSink.proposals({**DEALS, "fields": [
        {**f, "rule": f["rule"]} for f in DEALS["fields"]]})}
    assert set(props) == {"datasetProperties", "ownership", "globalTags", "schemaMetadata", "upstreamLineage", "glossaryTerms"}
    assert all(p["entityUrn"] == dataset_urn(DEALS["name"]) for p in props.values())
    schema = json.loads(props["schemaMetadata"]["aspect"]["value"])
    note = next(f for f in schema["fields"] if f["fieldPath"] == "note")
    assert note["globalTags"]["tags"][0]["tag"] == "urn:li:tag:classification-personal"
    lineage = json.loads(props["upstreamLineage"]["aspect"]["value"])
    assert lineage["upstreams"][0]["dataset"] == dataset_urn("spectre.deals")
    owners = json.loads(props["ownership"]["aspect"]["value"])["owners"]
    assert owners == [{"owner": "urn:li:corpuser:team-spectre", "type": "DATAOWNER"}]


# ------------------------------------------------------------------ collection


def test_ingest_redacts_before_indexing(platform):
    _, collector, _, index, _ = platform
    e = event()
    out = collector.ingest("spectre", [e])
    assert out == {"accepted": 1, "duplicates": 0, "rejected": []}
    doc = index.docs[e["eventId"]]
    assert "apiKey" not in doc["payload"]
    assert "jane@example.com" not in json.dumps(doc)
    assert "Jane Doe" not in json.dumps(doc)
    assert doc["payload"]["contactEmail"].startswith("<contactEmail:")
    assert doc["payload"]["stage"] == "won" and doc["payload"]["amount"] == 1200.0
    assert doc["cid"].startswith("<cid:") and "cid_person0001" not in json.dumps(doc)
    assert "Signed after a call" in doc["text"]


def test_ingest_is_idempotent(platform):
    _, collector, *_ = platform
    e = event()
    collector.ingest("spectre", [e])
    assert collector.ingest("spectre", [e]) == {"accepted": 0, "duplicates": 1, "rejected": []}


@pytest.mark.parametrize(
    "over, reason",
    [
        ({"region": "RU"}, "cannot be stored in EU"),
        ({"product": "cumulus-mail"}, "does not match"),
        ({"eventType": "spectre.unknown"}, "not registered"),
        ({"payload": {"dealId": "d", "surprise": 1}}, "not in the schema"),
        ({"payload": {"amount": "lots"}}, "not a double"),
        ({"eventId": "not-a-uuid"}, "UUID"),
        ({"consent": ["SELL_IT"]}, "consent"),
        ({"occurredAt": "2026-11-12T10:00:00"}, "time zone"),
    ],
)
def test_ingest_rejects_bad_events(platform, over, reason):
    _, collector, *_ = platform
    out = collector.ingest("spectre", [event(**over)])
    assert out["accepted"] == 0 and reason in out["rejected"][0]["reason"]


def test_military_products_are_excluded(platform):
    _, collector, *_ = platform
    with pytest.raises(PlatformError) as e:
        collector.ingest("aether", [])
    assert e.value.name == "TenantNotAuthorized"


# ------------------------------------------------------------------ search


def _q(**over):
    q = {"tenant": "acme", "from": "2026-11-01T00:00:00Z", "to": "2026-11-30T00:00:00Z"}
    q.update(over)
    return q


def test_search_is_scoped_to_tenant_and_product(platform):
    _, collector, searcher, *_ = platform
    collector.ingest("spectre", [event(), event(tenant="globex")])
    hits = searcher.search("spectre", _q())["hits"]
    assert len(hits) == 1 and set(hits[0]) == set(OBJECTS["SearchHit"]["fields"])
    assert searcher.search("cumulus-mail", _q())["hits"] == []  # other product sees nothing
    with pytest.raises(PlatformError):
        searcher.search("cumulus-mail", _q(product="spectre"))


def test_search_filters_text_and_pages(platform):
    _, collector, searcher, *_ = platform
    collector.ingest("spectre", [event(occurredAt=f"2026-11-1{i}T10:00:00Z", objectId=f"d-{i}") for i in range(5)])
    page1 = searcher.search("spectre", _q(pageSize=2))
    assert [h["objectId"] for h in page1["hits"]] == ["d-4", "d-3"]
    page2 = searcher.search("spectre", _q(pageSize=2, pageToken=page1["nextPageToken"]))
    assert [h["objectId"] for h in page2["hits"]] == ["d-2", "d-1"]
    assert searcher.search("spectre", _q(objectId="d-0"))["hits"][0]["objectId"] == "d-0"
    assert len(searcher.search("spectre", _q(text="signed call"))["hits"]) == 5
    assert searcher.search("spectre", _q(text="jane"))["hits"] == []  # names were redacted
    assert searcher.search("spectre", _q(**{"from": "2026-11-13T00:00:00Z", "to": "2026-11-13T23:00:00Z"}))["hits"][0]["objectId"] == "d-3"


def test_search_validation(platform):
    searcher = platform[2]
    for bad in (_q(tenant=""), _q(pageSize=500), _q(to="2026-10-01T00:00:00Z"), _q(pageToken="%%%")):
        with pytest.raises(PlatformError):
            searcher.search("spectre", bad)


# ------------------------------------------------------------------ over HTTP


def test_platform_over_http(platform, redactor, tmp_path):
    catalog, collector, searcher, *_ = platform
    spectre_token, mail_token = "s" * 40, "m" * 40
    tokens = parse_product_tokens(f"spectre={spectre_token}; cumulus-mail={mail_token}")
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40, catalog, collector, searcher, tokens)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(method, path, body=None, token=spectre_token):
        req = urllib.request.Request(
            base + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        status, ref = call("PUT", f"/api/v1/catalog/datasets/{DEALS['name']}", DEALS)
        assert status == 200 and set(ref) == set(OBJECTS["DatasetRef"]["fields"])
        status, spec = call("GET", f"/api/v1/catalog/datasets/{DEALS['name']}")
        assert status == 200 and set(spec) == set(OBJECTS["DatasetSpec"]["fields"])
        status, out = call("POST", "/api/v1/collect/events", {"events": [event()]})
        assert status == 200 and out["accepted"] == 1 and set(out) == set(OBJECTS["IngestResponse"]["fields"])
        status, res = call("POST", "/api/v1/search/events", _q())
        assert status == 200 and len(res["hits"]) == 1 and set(res) == set(OBJECTS["SearchResponse"]["fields"])
        # Mail's token cannot read Spectre's dataset, and the gateway token is not a product token.
        status, err = call("GET", f"/api/v1/catalog/datasets/{DEALS['name']}", token=mail_token)
        assert status == 404 and err["errorName"] == "DataPlatform:DatasetNotFound"
        assert err["parameters"]["name"] == DEALS["name"]
        assert call("POST", "/api/v1/search/events", _q(), token="g" * 40)[0] == 401
        # And a product token cannot use the privacy endpoints.
        assert call("POST", "/api/v1/redact", {"destination": "AI", "records": []})[0] == 401
        status, err = call("POST", "/api/v1/search/events", _q(product="cumulus-mail"))
        assert status == 403 and err["errorCode"] == "PERMISSION_DENIED"
    finally:
        httpd.shutdown()


def test_platform_error_codes_are_conjure_codes():
    declared = {e["code"] for e in PLATFORM["types"]["definitions"]["errors"].values()}
    assert declared <= set(CONJURE_CODES.values())


def test_token_parsing():
    assert parse_product_tokens("") == {}
    with pytest.raises(ValueError):
        parse_product_tokens("spectre=short")
