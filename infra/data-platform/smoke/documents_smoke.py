"""End-to-end smoke test of document search on the running stack (real OpenSearch).

    python3 smoke/documents_smoke.py http://127.0.0.1:8090 <spectre token> <cumulus-mail token>

Standard library only. Uses its own people (cid_docowner01, cid_docviewer1), so it does not
change what the event erasure step counts.
"""
import json
import sys
import urllib.error
import urllib.request

BASE, SPECTRE, MAIL = sys.argv[1], sys.argv[2], sys.argv[3]
DOCS = "/api/v1/documents"
T = "2026-11-28T10:00:00Z"


def call(method, path, body=None, token=SPECTRE):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def put(doc_id, **over):
    doc = {"tenant": "acme", "title": "Renewal playbook", "body": "How we handle a contract renewal call.",
           "updatedAt": T, "labels": ["sales"]}
    doc.update(over)
    status, out = call("PUT", f"{DOCS}/collections/playbooks/documents/{doc_id}", doc)
    assert status == 200 and out == {"collection": "playbooks", "documentId": doc_id}, (status, out)


def ids(token=SPECTRE, **q):
    query = {"tenant": "acme", "text": "renewal"}
    query.update(q)
    status, out = call("POST", f"{DOCS}/search", query, token)
    assert status == 200, (status, out)
    return {h["documentId"] for h in out["hits"]}


put("open-1", url="https://spectre.example/open-1")
put("private-1", ownerCid="cid_docowner01", viewers=["cid_docviewer1"])
put("pii-1", title="Call notes", body="Renewal agreed with Jane Doe, jane@example.com.")

assert ids() == {"open-1", "pii-1"}, ids()
assert ids(viewer="cid_docviewer1") == {"open-1", "pii-1", "private-1"}
assert ids(viewer="cid_docowner01") == {"open-1", "pii-1", "private-1"}
assert ids(token=MAIL) == set(), "another product must see nothing"
assert ids(tenant="globex") == set(), "another tenant must see nothing"
assert ids(text="jane@example.com") == set(), "a query that is only personal data finds nothing"
status, out = call("POST", f"{DOCS}/search", {"tenant": "acme", "text": "agreed"})
assert all("jane@example.com" not in h["snippet"] and "Jane Doe" not in h["snippet"] for h in out["hits"]), out
print("search scoped and redacted:", sorted(ids(viewer="cid_docowner01")))

assert call("POST", f"{DOCS}/collections/playbooks/documents/open-1/remove", {"tenant": "acme"})[1] == {"deleted": 1}
assert call("POST", f"{DOCS}/collections/playbooks/documents/open-1/remove", {"tenant": "acme"})[1] == {"deleted": 0}

# Erasing the only viewer must not open the document to the tenant; erasing the owner deletes it.
assert call("POST", "/api/v1/erasure/subjects", {"cid": "cid_docviewer1"})[1] == {"deleted": 0}
assert ids(viewer="cid_docviewer1") == {"pii-1"}
assert ids() == {"pii-1"}
assert call("POST", "/api/v1/erasure/subjects", {"cid": "cid_docowner01"})[1] == {"deleted": 1}
assert ids(viewer="cid_docowner01") == {"pii-1"}
print("documents smoke ok")
