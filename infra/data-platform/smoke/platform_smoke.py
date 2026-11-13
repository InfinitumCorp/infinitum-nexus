"""End-to-end smoke test of catalog, collection and search against the running stack.

    python3 smoke/platform_smoke.py http://127.0.0.1:8090 <spectre token> <cumulus-mail token>

Standard library only, so it runs on a bare CI runner.
"""
import json
import sys
import urllib.error
import urllib.request
import uuid

BASE, SPECTRE, MAIL = sys.argv[1], sys.argv[2], sys.argv[3]

SPEC = {
    "name": "spectre.deal.stage_changed",
    "product": "spectre",
    "owners": ["team-spectre"],
    "description": "A deal moved to another pipeline stage.",
    "fields": [
        {"name": "dealId", "type": "string", "classification": "INTERNAL", "rule": "KEEP"},
        {"name": "stage", "type": "string", "classification": "INTERNAL", "rule": "KEEP"},
        {"name": "note", "type": "string", "classification": "PERSONAL", "rule": "TEXT"},
        {"name": "contactEmail", "type": "string", "classification": "PERSONAL", "rule": "PSEUDONYMIZE"},
    ],
    "upstream": [],
    "retentionDays": 365,
    "region": "EU",
    "glossaryTerms": [],
}


def call(method, path, body=None, token=SPECTRE):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


status, ref = call("PUT", f"/api/v1/catalog/datasets/{SPEC['name']}", SPEC)
assert status == 200, (status, ref)
print("registered", ref["urn"])

eid = str(uuid.uuid4())
evt = {
    "eventId": eid, "product": "spectre", "tenant": "acme", "cid": "cid_smoke0001",
    "eventType": SPEC["name"], "schemaVersion": 1, "occurredAt": "2026-11-12T10:00:00Z",
    "region": "EU", "consent": ["ESSENTIAL"], "objectType": "deal", "objectId": "d-1",
    "payload": {"dealId": "d-1", "stage": "won", "note": "Signed after a call with Jane Doe, jane@example.com",
                "contactEmail": "jane@example.com"},
}
status, out = call("POST", "/api/v1/collect/events", {"events": [evt, evt]})
assert status == 200 and out == {"accepted": 1, "duplicates": 1, "rejected": []}, (status, out)
print("ingested", out)

q = {"tenant": "acme", "from": "2026-11-01T00:00:00Z", "to": "2026-11-30T00:00:00Z", "text": "signed"}
status, res = call("POST", "/api/v1/search/events", q)
assert status == 200 and [h["eventId"] for h in res["hits"]] == [eid], (status, res)
hit = json.dumps(res["hits"][0])
assert "jane@example.com" not in hit and "Jane Doe" not in hit, hit
print("found", res["hits"][0]["payload"])

assert call("POST", "/api/v1/search/events", q, token=MAIL)[1]["hits"] == [], "another product saw Spectre's events"
assert call("POST", "/api/v1/search/events", {**q, "tenant": "globex"})[1]["hits"] == [], "tenant filter leaked"
assert call("GET", f"/api/v1/catalog/datasets/{SPEC['name']}", token=MAIL)[0] == 404
print("platform smoke ok")
