"""Tenant-scoped document search (documents.Documents)."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from cumulus_privacy.documents import Documents, MemoryDocumentStore
from cumulus_privacy.dp import PrivacyBudget
from cumulus_privacy.platform import Eraser, PlatformError
from cumulus_privacy.server import Gateway, make_handler, parse_product_tokens

PLATFORM = yaml.safe_load((Path(__file__).parents[2] / "conjure" / "platform.yml").read_text("utf-8"))
OBJECTS = PLATFORM["types"]["definitions"]["objects"]
T = "2026-11-20T10:00:00Z"


def doc(**over):
    d = {"tenant": "acme", "title": "Renewal playbook", "body": "How we handle a contract renewal call.",
         "updatedAt": T, "labels": ["sales"]}
    d.update(over)
    return d


@pytest.fixture()
def docs(redactor):
    return Documents(redactor, MemoryDocumentStore())


def q(**over):
    r = {"tenant": "acme", "text": "renewal"}
    r.update(over)
    return r


def test_put_search_and_scoping(docs):
    ref = docs.put("spectre", "playbooks", "pb-1", doc(url="https://spectre.example/pb-1"))
    assert ref == {"collection": "playbooks", "documentId": "pb-1"}
    assert set(ref) == set(OBJECTS["DocumentRef"]["fields"])
    docs.put("spectre", "playbooks", "pb-2", doc(tenant="globex"))
    docs.put("cumulus-mail", "playbooks", "pb-3", doc())
    out = docs.search("spectre", q())
    assert set(out) == set(OBJECTS["DocumentSearchResponse"]["fields"])
    assert [h["documentId"] for h in out["hits"]] == ["pb-1"]  # not the other tenant, not Mail's
    hit = out["hits"][0]
    assert set(hit) == set(OBJECTS["DocumentHit"]["fields"])
    assert hit["url"] == "https://spectre.example/pb-1" and "renewal" in hit["snippet"]
    # Upsert replaces in place.
    docs.put("spectre", "playbooks", "pb-1", doc(title="Renewal playbook v2"))
    assert [h["title"] for h in docs.search("spectre", q())["hits"]] == ["Renewal playbook v2"]


def test_filters_and_ranking(docs):
    docs.put("spectre", "playbooks", "a", doc(title="Pricing", body="renewal mentioned once", labels=["sales"]))
    docs.put("spectre", "playbooks", "b", doc(title="Renewal guide", body="renewal renewal", labels=["sales", "emea"]))
    docs.put("spectre", "notes", "c", doc(title="Renewal note", labels=["emea"]))
    assert [h["documentId"] for h in docs.search("spectre", q())["hits"]][0] == "b"
    assert {h["documentId"] for h in docs.search("spectre", q(collections=["notes"]))["hits"]} == {"c"}
    assert {h["documentId"] for h in docs.search("spectre", q(labels=["emea"]))["hits"]} == {"b", "c"}
    assert {h["documentId"] for h in docs.search("spectre", q(labels=["emea", "sales"]))["hits"]} == {"b"}
    assert len(docs.search("spectre", q(pageSize=1))["hits"]) == 1


def test_personal_data_is_redacted_before_storage(docs):
    docs.put("spectre", "notes", "n1", doc(body="Signed after a call with Jane Doe, jane@example.com. Next step: the renewal."))
    stored = next(iter(docs.store.docs.values()))
    assert "jane@example.com" not in stored["body"] and "Jane Doe" not in stored["body"]
    # A query is stripped of personal data, so nobody can probe for a person by email or name.
    assert docs.search("spectre", q(text="jane@example.com"))["hits"] == []
    assert len(docs.search("spectre", q(text="renewal jane@example.com"))["hits"]) == 1
    assert len(docs.search("spectre", q())["hits"]) == 1


def test_viewers_and_owner(docs):
    docs.put("spectre", "notes", "open", doc())
    docs.put("spectre", "notes", "private", doc(ownerCid="cid_owner0001", viewers=["cid_viewer0001"]))
    def ids(**over):
        return {h["documentId"] for h in docs.search("spectre", q(**over))["hits"]}
    assert ids() == {"open"}
    assert ids(viewer="cid_viewer0001") == {"open", "private"}
    assert ids(viewer="cid_owner0001") == {"open", "private"}
    assert ids(viewer="cid_stranger01") == {"open"}
    stored = docs.store.docs[("spectre", "notes", "acme", "private")]
    assert "cid_viewer0001" not in json.dumps(stored) and "cid_owner0001" not in json.dumps(stored)


def test_erasure_deletes_owned_and_keeps_restricted_documents_restricted(docs, redactor):
    docs.put("spectre", "notes", "mine", doc(ownerCid="cid_person0001"))
    docs.put("spectre", "notes", "shared", doc(ownerCid="cid_other0001", viewers=["cid_person0001"]))
    docs.put("cumulus-mail", "notes", "mail", doc(ownerCid="cid_person0001"))

    class NoEvents:
        def erase(self, pseudonym, product):
            return 0

    eraser = Eraser(redactor, NoEvents(), docs.store)
    assert eraser.erase("spectre", "cid_person0001") == {"deleted": 1}
    assert ("spectre", "notes", "acme", "mine") not in docs.store.docs
    assert ("cumulus-mail", "notes", "acme", "mail") in docs.store.docs  # other product untouched
    shared = docs.store.docs[("spectre", "notes", "acme", "shared")]
    assert shared["viewers"] == []
    # Its only viewer is gone, but it must not become visible to the whole tenant.
    assert docs.search("spectre", q())["hits"] == []
    assert eraser.erase(None, "cid_person0001") == {"deleted": 1}  # pipeline token: every product


def test_remove(docs):
    docs.put("spectre", "notes", "n1", doc())
    assert docs.remove("spectre", "notes", "n1", {"tenant": "globex"}) == {"deleted": 0}
    assert docs.remove("cumulus-mail", "notes", "n1", {"tenant": "acme"}) == {"deleted": 0}
    assert docs.remove("spectre", "notes", "n1", {"tenant": "acme"}) == {"deleted": 1}
    assert docs.search("spectre", q())["hits"] == []


@pytest.mark.parametrize(
    "collection, document_id, over, message",
    [
        ("Bad Name", "x", {}, "collection"),
        ("notes", "../etc", {}, "documentId"),
        ("notes", "x", {"tenant": "Acme"}, "tenant"),
        ("notes", "x", {"tenant": "a' or '1'='1"}, "tenant"),
        ("notes", "x", {"title": ""}, "title"),
        ("notes", "x", {"title": "t" * 301}, "title"),
        ("notes", "x", {"body": None}, "body"),
        ("notes", "x", {"url": "http://plain.example"}, "https"),
        ("notes", "x", {"labels": ["Not Lower"]}, "labels"),
        ("notes", "x", {"labels": [f"l{i}" for i in range(21)]}, "labels"),
        ("notes", "x", {"viewers": "cid_a"}, "viewers"),
        ("notes", "x", {"ownerCid": " "}, "ownerCid"),
        ("notes", "x", {"updatedAt": "2026-11-20"}, "time zone"),
    ],
)
def test_put_validation(docs, collection, document_id, over, message):
    with pytest.raises(PlatformError) as e:
        docs.put("spectre", collection, document_id, doc(**over))
    assert e.value.name == "InvalidArgument" and message in e.value.message


@pytest.mark.parametrize(
    "over, message",
    [({"text": ""}, "text"), ({"text": "x" * 501}, "text"), ({"pageSize": 0}, "pageSize"),
     ({"pageSize": 51}, "pageSize"), ({"collections": ["Bad"]}, "collections"), ({"viewer": ""}, "viewer"),
     ({"tenant": None}, "tenant")],
)
def test_search_validation(docs, over, message):
    with pytest.raises(PlatformError) as e:
        docs.search("spectre", q(**over))
    assert message in e.value.message


def test_military_products_are_excluded(docs):
    for call in (lambda: docs.put("aether", "notes", "x", doc()), lambda: docs.search("aether", q())):
        with pytest.raises(PlatformError) as e:
            call()
        assert e.value.name == "TenantNotAuthorized"


def test_documents_over_http(docs, redactor, tmp_path):
    spectre, mail = "s" * 40, "m" * 40
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40, None, None, None,
                 parse_product_tokens(f"spectre={spectre};cumulus-mail={mail}"), documents=docs)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/api/v1/documents"

    def call(method, path, body, tok=spectre):
        r = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode(),
                                   headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        assert call("PUT", "/collections/notes/documents/n1", doc())[0] == 200
        status, out = call("POST", "/search", q())
        assert status == 200 and [h["documentId"] for h in out["hits"]] == ["n1"]
        assert call("POST", "/search", q(), tok=mail)[1]["hits"] == []
        status, err = call("PUT", "/collections/notes/documents/n2", doc(tenant="BAD"))
        assert status == 400 and err["errorName"] == "DataPlatform:InvalidArgument"
        assert call("POST", "/collections/notes/documents/n1/remove", {"tenant": "acme"})[1] == {"deleted": 1}
        assert call("POST", "/search", q(), tok="g" * 40)[0] == 401
    finally:
        httpd.shutdown()


def test_not_configured(redactor, tmp_path):
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40)
    with pytest.raises(Exception) as e:
        gw.search_documents(q(), caller="spectre")
    assert getattr(e.value, "name", "") == "NotConfigured"


class _Limits:
    def __init__(self, state):
        self.state = state

    def storage_state(self):
        return self.state


def test_puts_stop_when_the_store_is_full_but_removal_still_works(redactor):
    limits = _Limits("ok")
    docs = Documents(redactor, MemoryDocumentStore(), limits)
    docs.put("spectre", "notes", "n1", doc())
    limits.state = "nearly_full"
    docs.put("spectre", "notes", "n2", doc())  # still accepted
    limits.state = "full"
    with pytest.raises(PlatformError) as e:
        docs.put("spectre", "notes", "n3", doc())
    assert (e.value.status, e.value.name, e.value.retry_after) == (503, "StorageQuotaReached", 3600)
    assert ("spectre", "notes", "acme", "n3") not in docs.store.docs
    assert docs.remove("spectre", "notes", "n1", {"tenant": "acme"}) == {"deleted": 1}  # frees space
    assert len(docs.search("spectre", q())["hits"]) == 1
    limits.state = "unknown"  # a failing size probe must not block writes
    docs.put("spectre", "notes", "n4", doc())


def test_full_store_over_http_is_a_503_with_retry_after(redactor, tmp_path):
    spectre = "s" * 40
    docs = Documents(redactor, MemoryDocumentStore(), _Limits("full"))
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40, None, None, None,
                 parse_product_tokens(f"spectre={spectre}"), documents=docs)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/api/v1/documents/collections/notes/documents/n1"
    r = urllib.request.Request(url, method="PUT", data=json.dumps(doc()).encode(),
                               headers={"Authorization": f"Bearer {spectre}", "Content-Type": "application/json"})
    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(r)
        assert e.value.code == 503 and e.value.headers["Retry-After"] == "3600"
        assert json.loads(e.value.read())["errorName"] == "DataPlatform:StorageQuotaReached"
    finally:
        httpd.shutdown()


def item(document_id, **over):
    return {"documentId": document_id, **doc(**over)}


def test_batch_put_is_all_or_nothing(docs):
    out = docs.put_many("spectre", "help", {"documents": [item("a1"), item("a2", title="Renewal FAQ")]})
    assert out == {"collection": "help", "stored": 2, "created": 2}
    assert set(out) == set(OBJECTS["DocumentBatchResponse"]["fields"])
    assert set(OBJECTS["DocumentBatchItem"]["fields"]) == {"documentId", *OBJECTS["DocumentUpsert"]["fields"]}
    out = docs.put_many("spectre", "help", {"documents": [item("a1", title="Renewal v2"), item("a3")]})
    assert out == {"collection": "help", "stored": 2, "created": 1}
    assert {h["documentId"] for h in docs.search("spectre", q())["hits"]} == {"a1", "a2", "a3"}

    before = dict(docs.store.docs)
    with pytest.raises(PlatformError) as e:
        docs.put_many("spectre", "help", {"documents": [item("b1"), item("b2", tenant="BAD")]})
    assert e.value.name == "InvalidArgument" and e.value.message.startswith("documents[1]: tenant")
    assert docs.store.docs == before  # nothing written


def test_batch_put_redacts_like_single_puts(docs):
    docs.put_many("spectre", "notes", {"documents": [item("p1", body="Signed after a call with Jane Doe, jane@example.com. Next step: the renewal.")]})
    stored = docs.store.docs[("spectre", "notes", "acme", "p1")]
    assert "jane@example.com" not in stored["body"] and "Jane Doe" not in stored["body"]


@pytest.mark.parametrize("body, message", [
    ({}, "documents must be"),
    ({"documents": []}, "documents must be"),
    ({"documents": [item(f"d{i}") for i in range(101)]}, "documents must be"),
    ({"documents": [item("d1"), item("d1")]}, "once per batch"),
    ({"documents": [{"title": "x"}]}, "documents[0]: documentId"),
    ({"documents": [item("../x")]}, "documents[0]: documentId"),
])
def test_batch_validation(docs, body, message):
    with pytest.raises(PlatformError) as e:
        docs.put_many("spectre", "help", body)
    assert message in e.value.message


def test_batch_put_respects_scope_and_the_storage_guard(redactor):
    docs = Documents(redactor, MemoryDocumentStore(), _Limits("full"))
    with pytest.raises(PlatformError) as e:
        docs.put_many("spectre", "help", {"documents": [item("a1")]})
    assert e.value.name == "StorageQuotaReached" and not docs.store.docs
    with pytest.raises(PlatformError) as e:
        docs.put_many("aether", "help", {"documents": [item("a1")]})
    assert e.value.name == "TenantNotAuthorized"
    with pytest.raises(PlatformError):
        docs.put_many("spectre", "Bad Collection", {"documents": [item("a1")]})


def test_batch_over_http(docs, redactor, tmp_path):
    spectre = "s" * 40
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40, None, None, None,
                 parse_product_tokens(f"spectre={spectre}"), documents=docs)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/api/v1/documents/collections/help/batch"
    r = urllib.request.Request(url, method="POST", data=json.dumps({"documents": [item("h1"), item("h2")]}).encode(),
                               headers={"Authorization": f"Bearer {spectre}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            assert json.loads(resp.read()) == {"collection": "help", "stored": 2, "created": 2}
    finally:
        httpd.shutdown()


def _soon(days=1):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat().replace("+00:00", "Z")


def test_expiry_hides_then_purges(docs):
    assert "expiresAt" in OBJECTS["DocumentUpsert"]["fields"] and "expiresAt" in OBJECTS["DocumentBatchItem"]["fields"]
    docs.put("spectre", "playbooks", "keep", doc())
    docs.put("spectre", "playbooks", "temp", doc(expiresAt=_soon()))
    assert {h["documentId"] for h in docs.search("spectre", q())["hits"]} == {"keep", "temp"}
    assert docs.store.purge_expired() == 0
    # Time passes: the stored expiry is now behind us.
    docs.store.docs[("spectre", "playbooks", "acme", "temp")]["expiresAt"] = "2020-01-01T00:00:00Z"
    assert [h["documentId"] for h in docs.search("spectre", q())["hits"]] == ["keep"]  # hidden before the purge runs
    assert docs.store.purge_expired() == 1
    assert ("spectre", "playbooks", "acme", "temp") not in docs.store.docs
    # Putting the document again without expiresAt keeps it for good.
    docs.put("spectre", "playbooks", "keep", doc(expiresAt=_soon()))
    docs.put("spectre", "playbooks", "keep", doc())
    assert docs.store.docs[("spectre", "playbooks", "acme", "keep")]["expiresAt"] is None


@pytest.mark.parametrize("value", ["2020-01-01T00:00:00Z", "tomorrow", "2026-12-01T00:00:00", 5, "far"])
def test_expiry_must_be_a_near_future_time(docs, value):
    if value == "far":
        value = _soon(3651)
    with pytest.raises(PlatformError) as e:
        docs.put("spectre", "playbooks", "x", doc(expiresAt=value))
    assert e.value.status == 400 and "expiresAt" in e.value.message
    with pytest.raises(PlatformError) as e:  # and in a batch, with the position
        docs.put_many("spectre", "playbooks", {"documents": [{**doc(), "documentId": "ok"},
                                                             {**doc(expiresAt=value), "documentId": "bad"}]})
    assert "documents[1]" in e.value.message
    assert docs.store.docs == {}


def test_daily_purge_covers_events_and_documents(capsys):
    from cumulus_privacy.server import purge_once

    class Store:
        def __init__(self, n=0, fail=False):
            self.n, self.fail = n, fail

        def purge_expired(self):
            if self.fail:
                raise RuntimeError("db down")
            return self.n

    purge_once(Store(fail=True), Store(3))  # a failing event purge doesn't skip the documents
    err = capsys.readouterr().err
    assert "purge of events failed: RuntimeError" in err and "removed 3 documents" in err
    purge_once(Store(2), None)
    assert "removed 2 events" in capsys.readouterr().err
