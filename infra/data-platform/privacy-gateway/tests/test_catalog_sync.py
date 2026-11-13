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
