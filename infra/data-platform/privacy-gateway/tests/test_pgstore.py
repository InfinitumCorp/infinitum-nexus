"""Postgres backends against a real Postgres with the Supabase migration applied.

Runs when TEST_DATABASE_URL points at a disposable superuser database (CI uses a postgres:17
service). The tests connect as the restricted data_platform_gateway role, so the grants and
row-level security in the migration are exercised too.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
ADMIN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not ADMIN, reason="set TEST_DATABASE_URL to a disposable Postgres")

from cumulus_privacy.dp import BudgetExceeded  # noqa: E402
from cumulus_privacy.platform import Collector, PlatformError, Searcher  # noqa: E402
from cumulus_privacy.pgstore import PostgresBudget, PostgresCatalog, PostgresEventIndex  # noqa: E402

from .test_platform import DEALS, _q, event  # noqa: E402

MIGRATION = Path(__file__).parents[4] / "supabase" / "migrations" / "20261113_data_platform.sql"
GATEWAY_PASSWORD = "test-only-" + "x" * 24  # disposable CI database only


@pytest.fixture(scope="module")
def gateway_dsn():
    sql = MIGRATION.read_text("utf-8")
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(sql)  # first run: tables, no role yet (notice only)
        for role in ("data_platform_gateway", "data_platform_reader"):
            if not c.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                c.execute(f"create role {role} login noinherit password '{GATEWAY_PASSWORD}'")
        c.execute(sql)  # second run: grants and policies
    return psycopg.conninfo.make_conninfo(ADMIN, user="data_platform_gateway", password=GATEWAY_PASSWORD)


@pytest.fixture()
def reader_dsn(gateway_dsn):
    return psycopg.conninfo.make_conninfo(ADMIN, user="data_platform_reader", password=GATEWAY_PASSWORD)


@pytest.fixture()
def clean(gateway_dsn):
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute("truncate data_platform.events, data_platform.datasets, data_platform.privacy_budget")
    return gateway_dsn


@pytest.fixture()
def stack(clean, redactor):
    catalog = PostgresCatalog(clean)
    catalog.register("spectre", DEALS["name"], DEALS)
    index = PostgresEventIndex(clean)
    return catalog, Collector(catalog, redactor, index, "EU"), Searcher(index), index


def test_catalog_round_trip_and_ownership(stack):
    catalog, *_ = stack
    assert catalog.read("spectre", DEALS["name"])["owners"] == ["team-spectre"]
    catalog.register("spectre", DEALS["name"], {**DEALS, "description": "changed"})
    assert catalog.get(DEALS["name"])["description"] == "changed"
    hijack = {**DEALS, "product": "cumulus-mail"}
    with pytest.raises(PlatformError) as e:
        catalog.register("cumulus-mail", DEALS["name"], hijack)
    assert e.value.name == "TenantNotAuthorized"
    assert catalog.get(DEALS["name"])["product"] == "spectre"
    assert [spec["name"] for spec in catalog.all()] == [DEALS["name"]]  # what catalog_sync replays


def test_ingest_search_and_scoping(stack):
    _, collector, searcher, _ = stack
    events = [event(occurredAt=f"2026-11-1{i}T10:00:00Z", objectId=f"d-{i}") for i in range(5)]
    assert collector.ingest("spectre", events + [events[0]])["duplicates"] == 1
    collector.ingest("spectre", [event(tenant="globex")])

    page1 = searcher.search("spectre", _q(pageSize=2))
    assert [h["objectId"] for h in page1["hits"]] == ["d-4", "d-3"]
    page2 = searcher.search("spectre", _q(pageSize=2, pageToken=page1["nextPageToken"]))
    assert [h["objectId"] for h in page2["hits"]] == ["d-2", "d-1"]
    assert len(searcher.search("spectre", _q(text="signed call"))["hits"]) == 5
    assert searcher.search("spectre", _q(text="jane"))["hits"] == []  # names were redacted
    assert searcher.search("spectre", _q(objectId="d-0"))["hits"][0]["objectId"] == "d-0"
    assert searcher.search("cumulus-mail", _q())["hits"] == []
    hit = searcher.search("spectre", _q(pageSize=1))["hits"][0]
    assert "apiKey" not in hit["payload"] and hit["payload"]["contactEmail"].startswith("<contactEmail:")


def test_gateway_role_cannot_rewrite_events(stack, clean):
    _, collector, *_ = stack
    collector.ingest("spectre", [event()])
    with psycopg.connect(clean) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("update data_platform.events set text = 'tampered'")


def test_bi_reader_sees_only_safe_columns(stack, reader_dsn):
    _, collector, *_ = stack
    collector.ingest("spectre", [event(), event(tenant="globex")])
    with psycopg.connect(reader_dsn, autocommit=True) as c:
        rows = c.execute("select product, tenant, event_type from data_platform.events_bi order by tenant").fetchall()
        assert [r[1] for r in rows] == ["acme", "globex"]
        for sql in ("select cid from data_platform.events", "select payload from data_platform.events",
                    "select text from data_platform.events", "select spec from data_platform.datasets",
                    "select * from data_platform.privacy_budget"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(sql)
        with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.ReadOnlySqlTransaction)):
            c.execute("delete from data_platform.events")


def test_erasure_and_storage_size(stack, redactor):
    from cumulus_privacy.platform import Eraser, IngestLimits

    _, collector, searcher, index = stack
    collector.ingest("spectre", [event(), event(tenant="globex"), event(cid="cid_other")])
    eraser = Eraser(redactor, index)
    assert eraser.erase("cumulus-mail", "cid_person0001") == {"deleted": 0}
    assert eraser.erase("spectre", "cid_person0001") == {"deleted": 2}
    assert eraser.erase(None, "cid_person0001") == {"deleted": 0}
    assert len(searcher.search("spectre", _q())["hits"]) == 1
    # The gateway role can read the database size, which drives the free-tier guard.
    size = index.storage_bytes()
    assert size > 1_000_000
    limits = IngestLimits(storage_limit_bytes=size, storage=index.storage_bytes)
    assert limits.storage_state() == "full"


def test_retention_purge(stack):
    _, collector, _, index = stack
    old = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
    fresh = datetime.now(timezone.utc).isoformat()
    collector.ingest("spectre", [event(occurredAt=old), event(occurredAt=fresh)])
    assert index.purge_expired() == 1  # DEALS keeps 365 days


def test_budget_is_shared_and_enforced(clean):
    a, b = PostgresBudget(clean, 1.5), PostgresBudget(clean, 1.5)  # two gateway instances
    a.charge("usage.daily", 1.0)
    assert b.remaining("usage.daily") == pytest.approx(0.5)
    with pytest.raises(BudgetExceeded):
        b.charge("usage.daily", 1.0)
    assert a.spent("usage.daily") == pytest.approx(1.0)
    assert a.spent(str(uuid.uuid4())) == 0.0
