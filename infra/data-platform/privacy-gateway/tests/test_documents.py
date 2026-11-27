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
