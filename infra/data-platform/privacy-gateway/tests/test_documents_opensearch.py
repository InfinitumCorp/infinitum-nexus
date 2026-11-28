"""OpenSearchDocumentStore against a fake OpenSearch that records requests. The real index is
exercised end to end by smoke/documents_smoke.py in the stack-smoke job."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from cumulus_privacy.documents import Documents, OpenSearchDocumentStore
from cumulus_privacy.platform import PlatformError

MAPPING = json.loads((Path(__file__).parents[2] / "search" / "documents-index.json").read_text("utf-8"))


@pytest.fixture()
def fake_os():
    seen, replies = [], []

    class H(BaseHTTPRequestHandler):
        def _go(self):
            n = int(self.headers.get("Content-Length") or 0)
            seen.append({"method": self.command, "path": self.path,
                         "body": json.loads(self.rfile.read(n)) if n else None})
            status, body = replies.pop(0) if replies else (200, {})
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_PUT = do_POST = do_DELETE = _go  # noqa: N815

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield OpenSearchDocumentStore(f"http://127.0.0.1:{httpd.server_address[1]}", refresh=True), seen, replies
    httpd.shutdown()


DOC = {"tenant": "acme", "title": "Renewal playbook", "body": "How we handle a contract renewal call.",
       "updatedAt": "2026-11-20T10:00:00Z", "labels": ["sales"], "ownerCid": "cid_owner0001",
       "viewers": ["cid_viewer0001"]}


def test_put_writes_a_strict_mapping_document_under_a_hashed_id(fake_os, redactor):
    store, seen, replies = fake_os
    replies.append((201, {"result": "created"}))
    Documents(redactor, store).put("spectre", "playbooks", "pb:1", DOC)
    req = seen[0]
    did = OpenSearchDocumentStore.doc_id("spectre", "playbooks", "acme", "pb:1")
    assert req["method"] == "PUT" and req["path"] == f"/cumulus-documents/_doc/{did}?refresh=wait_for"
    assert set(req["body"]) <= set(MAPPING["mappings"]["properties"])  # nothing the strict mapping rejects
    assert req["body"]["restricted"] is True
    assert "cid_owner0001" not in json.dumps(req["body"]) and "cid_viewer0001" not in json.dumps(req["body"])
    # Different product, tenant or collection: a different document.
    assert len({did, OpenSearchDocumentStore.doc_id("cumulus-mail", "playbooks", "acme", "pb:1"),
                OpenSearchDocumentStore.doc_id("spectre", "playbooks", "globex", "pb:1"),
                OpenSearchDocumentStore.doc_id("spectre", "playbook", "sacme", "pb:1")}) == 4


def test_search_is_always_scoped_to_product_tenant_and_visibility(fake_os, redactor):
    store, seen, replies = fake_os
    src = {"collection": "playbooks", "documentId": "pb-1", "title": "Renewal playbook", "body": "renewal call",
           "url": None, "labels": ["sales"], "updatedAt": "2026-11-20T10:00:00Z"}
    replies += [(200, {"hits": {"hits": [{"_source": src, "highlight": {"body": ["a renewal call"]}}]}}),
                (200, {"hits": {"hits": [{"_source": src}]}})]
    docs = Documents(redactor, store)
    out = docs.search("spectre", {"tenant": "acme", "text": "renewal", "collections": ["playbooks"],
                                  "labels": ["sales", "emea"], "viewer": "cid_viewer0001", "pageSize": 5})
    assert out["hits"][0]["snippet"] == "a renewal call" and out["hits"][0]["documentId"] == "pb-1"
    q = seen[0]["body"]
    assert seen[0]["path"] == "/cumulus-documents/_search" and q["size"] == 5
    f = q["query"]["bool"]["filter"]
    assert f[0] == {"term": {"product": "spectre"}} and f[1] == {"term": {"tenant": "acme"}}
    assert {"terms": {"collection": ["playbooks"]}} in f
    assert {"term": {"labels": "emea"}} in f and {"term": {"labels": "sales"}} in f
    visible = f[-1]["bool"]["should"]
    assert visible[0] == {"term": {"restricted": False}} and len(visible) == 3
    assert "cid_viewer0001" not in json.dumps(q)  # the viewer is sent as a pseudonym
    assert q["query"]["bool"]["must"][0]["simple_query_string"]["default_operator"] == "and"

    # No viewer: only unrestricted documents. No highlight: a snippet from the body.
    out = docs.search("spectre", {"tenant": "acme", "text": "renewal"})
    assert seen[1]["body"]["query"]["bool"]["filter"][-1]["bool"]["should"] == [{"term": {"restricted": False}}]
    assert out["hits"][0]["snippet"] == "renewal call"


def test_remove_and_missing_documents(fake_os):
    store, seen, replies = fake_os
    replies += [(200, {"result": "deleted"}), (404, {"result": "not_found"})]
    assert store.remove("spectre", "notes", "acme", "n1") == 1
    assert store.remove("spectre", "notes", "acme", "n1") == 0
    assert seen[0]["method"] == "DELETE"
    assert seen[0]["path"].startswith(f"/cumulus-documents/_doc/{OpenSearchDocumentStore.doc_id('spectre', 'notes', 'acme', 'n1')}")


def test_erase_deletes_owned_and_strips_viewer_lists(fake_os):
    store, seen, replies = fake_os
    replies += [(200, {"deleted": 2, "failures": []}), (200, {"updated": 3, "failures": []})]
    assert store.erase("pseudo-1", "spectre") == 2
    delete, update = seen
    assert delete["path"].startswith("/cumulus-documents/_delete_by_query")
    assert delete["body"]["query"]["bool"]["filter"] == [{"term": {"ownerCid": "pseudo-1"}}, {"term": {"product": "spectre"}}]
    assert update["path"].startswith("/cumulus-documents/_update_by_query")
    assert update["body"]["query"]["bool"]["filter"][0] == {"term": {"viewers": "pseudo-1"}}
    assert update["body"]["script"]["params"] == {"p": "pseudo-1"} and "restricted" not in update["body"]["script"]["source"]
    replies += [(200, {"deleted": 0, "failures": []}), (200, {"updated": 0, "failures": []})]
    store.erase("pseudo-1", None)  # pipeline token: every product
    assert seen[2]["body"]["query"]["bool"]["filter"] == [{"term": {"ownerCid": "pseudo-1"}}]


@pytest.mark.parametrize("call", ["upsert", "search", "erase"])
def test_opensearch_errors_become_search_unavailable(fake_os, call):
    store, _, replies = fake_os
    replies += [(503, {"error": "down"})] * 2
    with pytest.raises(PlatformError) as e:
        if call == "upsert":
            store.upsert({"product": "spectre", "collection": "n", "tenant": "acme", "documentId": "x"})
        elif call == "search":
            store.search("spectre", "acme", "x", [], [], None, 5)
        else:
            store.erase("p", None)
    assert e.value.name == "SearchUnavailable"


def test_mapping_is_strict_and_people_fields_are_keywords():
    props = MAPPING["mappings"]["properties"]
    assert MAPPING["mappings"]["dynamic"] == "strict"
    assert {props[k]["type"] for k in ("product", "tenant", "ownerCid", "viewers")} == {"keyword"}
    assert props["url"]["index"] is False


def test_expired_documents_are_hidden_and_purged(fake_os):
    store, seen, replies = fake_os
    assert MAPPING["mappings"]["properties"]["expiresAt"] == {"type": "date"}
    replies.append((200, {"hits": {"hits": []}}))
    store.search("spectre", "acme", "renewal", [], [], None, 5)
    assert {"bool": {"must_not": [{"range": {"expiresAt": {"lte": "now"}}}]}} in seen[0]["body"]["query"]["bool"]["filter"]
    replies.append((200, {"deleted": 4, "failures": []}))
    assert store.purge_expired() == 4
    assert seen[1]["path"].startswith("/cumulus-documents/_delete_by_query")
    assert seen[1]["body"] == {"query": {"range": {"expiresAt": {"lte": "now"}}}}
    replies.append((500, {}))
    with pytest.raises(PlatformError):
        store.purge_expired()
