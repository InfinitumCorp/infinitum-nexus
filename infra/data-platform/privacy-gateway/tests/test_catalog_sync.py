"""Replaying the catalog into DataHub, against a fake GMS that records proposals."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from cumulus_privacy import catalog_sync
from cumulus_privacy.catalog_sync import CatalogSync, physical_urn
from cumulus_privacy.platform import Catalog, DataHubSink, dataset_urn

from .test_platform import DEALS

MAIL = {**DEALS, "name": "cumulus-mail.message.sent", "product": "cumulus-mail", "owners": ["cid_owner01"],
        "upstream": [], "glossaryTerms": []}


@pytest.fixture()
def gms():
    seen, state = [], {"fail_for": None}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            p = body["proposal"]
            if state["fail_for"] and state["fail_for"] in p["entityUrn"]:
                self.send_response(500)
                self.end_headers()
                return
            seen.append({**p, "auth": self.headers.get("Authorization"), "path": self.path})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", seen, state
    httpd.shutdown()


@pytest.fixture()
def catalog(tmp_path):
    c = Catalog(tmp_path / "c.json")
    c.register("spectre", DEALS["name"], DEALS)
    c.register("cumulus-mail", MAIL["name"], MAIL)
    return c


def aspects(seen, urn):
    return {p["aspectName"]: json.loads(p["aspect"]["value"]) for p in seen if p["entityUrn"] == urn}


def test_sync_pushes_specs_owners_and_physical_lineage(gms, catalog):
    url, seen, _ = gms
    out = CatalogSync(catalog.all, DataHubSink(url, "tok-123")).run()
    assert out == {"pushed": 2, "failed": [], "lineageEdges": 3}
    assert all(p["auth"] == "Bearer tok-123" and p["path"] == "/aspects?action=ingestProposal" for p in seen)

    deals = aspects(seen, dataset_urn(DEALS["name"]))
    assert deals["ownership"]["owners"] == [{"owner": "urn:li:corpGroup:team-spectre", "type": "DATAOWNER"}]
    assert deals["datasetProperties"]["customProperties"]["storedIn"] == "data_platform.events"
    assert deals["upstreamLineage"]["upstreams"][0]["dataset"] == dataset_urn("spectre.deals")
    mail = aspects(seen, dataset_urn(MAIL["name"]))
    assert mail["ownership"]["owners"][0]["owner"] == "urn:li:corpuser:cid_owner01"

    events = aspects(seen, physical_urn("data_platform.events"))["upstreamLineage"]["upstreams"]
    assert [u["dataset"] for u in events] == [dataset_urn(MAIL["name"]), dataset_urn(DEALS["name"])]
    bi = aspects(seen, physical_urn("data_platform.events_bi"))["upstreamLineage"]["upstreams"]
    assert bi == [{"dataset": physical_urn("data_platform.events"), "type": "VIEW",
                   "auditStamp": {"time": 0, "actor": "urn:li:corpuser:datahub"}}]
    assert physical_urn("data_platform.events") == \
        "urn:li:dataset:(urn:li:dataPlatform:postgres,cumulus-eu.postgres.data_platform.events,PROD)"


def test_one_refused_spec_does_not_stop_the_rest(gms, catalog):
    url, seen, state = gms
    state["fail_for"] = DEALS["name"]
    out = CatalogSync(catalog.all, DataHubSink(url)).run()
    assert out["pushed"] == 1 and out["failed"] == [{"name": DEALS["name"], "error": "HTTPError"}]
    assert any(p["entityUrn"] == physical_urn("data_platform.events") for p in seen)


def test_empty_catalog_and_unreachable_datahub(tmp_path):
    empty = CatalogSync(Catalog(tmp_path / "none.json").all, DataHubSink("http://127.0.0.1:9")).run()
    assert empty == {"pushed": 0, "failed": [], "lineageEdges": 0}


def test_cli_uses_the_file_catalog_without_database_url(gms, catalog, monkeypatch, capsys):
    url, seen, _ = gms
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DATAHUB_GMS_URL", url)
    monkeypatch.setenv("PLATFORM_CATALOG_FILE", str(catalog.path))
    assert catalog_sync.main() == 0
    assert "pushed 2 datasets, 3 lineage edges, 0 failed" in capsys.readouterr().out
    monkeypatch.delenv("DATAHUB_GMS_URL")
    assert catalog_sync.main() == 2


def test_quality_runs_become_assertions_with_run_events(gms, catalog):
    from cumulus_privacy.catalog_sync import assertion_urn
    from cumulus_privacy.ingest_quality import MemoryQualityLog

    url, seen, _ = gms
    log = MemoryQualityLog()
    for at, complete in (("2026-11-26T10:00:00Z", 1.0), ("2026-11-27T10:00:00Z", 0.5)):
        log.record("spectre", {
            "dataset": DEALS["name"], "checkedAt": at, "rows": 4, "ok": complete == 1.0, "metrics": {},
            "results": [
                {"kind": "completeness", "target": "amount", "ok": complete == 1.0, "metric": complete,
                 "message": f"{complete:.3f} complete, need 0.900"},
                {"kind": "size", "target": "rows", "ok": True, "metric": 4.0, "message": "4 rows, need [1, 100]"},
            ],
        })
    out = CatalogSync(catalog.all, DataHubSink(url), quality_runs=log.runs).run()
    assert out["failed"] == [] and out["assertions"] == 2  # Mail has no runs

    ds = dataset_urn(DEALS["name"])
    completeness = assertion_urn(DEALS["name"], "completeness", "amount")
    info = [json.loads(p["aspect"]["value"]) for p in seen
            if p["entityUrn"] == completeness and p["aspectName"] == "assertionInfo"]
    assert len(info) == 1 and all(p["entityType"] == "assertion" for p in seen if p["entityUrn"] == completeness)
    assert info[0]["datasetAssertion"] == {"dataset": ds, "scope": "DATASET_COLUMN", "operator": "_NATIVE_",
                                           "nativeType": "completeness", "fields": [f"urn:li:schemaField:({ds},amount)"]}
    size = [json.loads(p["aspect"]["value"]) for p in seen
            if p["entityUrn"] == assertion_urn(DEALS["name"], "size", "rows") and p["aspectName"] == "assertionInfo"]
    assert size[0]["datasetAssertion"]["scope"] == "DATASET_ROWS" and "fields" not in size[0]["datasetAssertion"]

    events = sorted((json.loads(p["aspect"]["value"]) for p in seen
                     if p["entityUrn"] == completeness and p["aspectName"] == "assertionRunEvent"),
                    key=lambda e: e["timestampMillis"])
    assert [e["result"]["type"] for e in events] == ["SUCCESS", "FAILURE"]
    assert events[1]["result"]["actualAggregateValue"] == 0.5 and events[1]["asserteeUrn"] == ds
    assert events[0]["timestampMillis"] == 1795687200000
    # Stable URNs: a second sync updates the same assertions.
    assert assertion_urn(DEALS["name"], "completeness", "amount") == completeness


def test_without_a_quality_log_nothing_about_quality_is_sent(gms, catalog):
    url, seen, _ = gms
    out = CatalogSync(catalog.all, DataHubSink(url)).run()
    assert "assertions" not in out and not any(p["entityType"] == "assertion" for p in seen)
