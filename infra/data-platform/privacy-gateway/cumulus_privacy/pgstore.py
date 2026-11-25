# © Infinitum Corporation®. All rights reserved.
"""Postgres backends, so the whole platform runs on the Supabase free tier in Ireland.

* ``PostgresEventIndex`` stores redacted events and serves search with Postgres full-text
  search, in place of a separately hosted OpenSearch. It accepts the same query body that
  ``Searcher`` builds, so the API does not change when a region later moves to OpenSearch.
* ``PostgresCatalog`` keeps dataset specs.
* ``PostgresBudget`` keeps the differential-privacy ledger, with a row lock so two gateway
  instances cannot overspend together.

Tables come from supabase/migrations/20261113_data_platform.sql. Connect with the
``data_platform_gateway`` role through Supabase's pooler (DATABASE_URL, never committed).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .dp import BudgetExceeded
from .platform import Catalog, PlatformError


def _connect(dsn: str) -> psycopg.Connection:
    # prepare_threshold=None: Supabase's transaction pooler does not keep prepared statements.
    return psycopg.connect(dsn, prepare_threshold=None, autocommit=False)


class PostgresCatalog(Catalog):
    def __init__(self, dsn: str, sink: Any | None = None) -> None:
        super().__init__(path="unused", sink=sink)
        self.dsn = dsn

    def get(self, name: str) -> dict[str, Any] | None:
        with _connect(self.dsn) as c:
            row = c.execute("select spec from data_platform.datasets where name = %s", (name,)).fetchone()
        return row[0] if row else None

    def all(self) -> list[dict[str, Any]]:
        with _connect(self.dsn) as c:
            return [r[0] for r in c.execute("select spec from data_platform.datasets order by name").fetchall()]

    def _put(self, name: str, spec: dict[str, Any]) -> None:
        with _connect(self.dsn) as c:
            row = c.execute(
                """insert into data_platform.datasets (name, product, spec) values (%s, %s, %s)
                   on conflict (name) do update set spec = excluded.spec, updated_at = now()
                   where data_platform.datasets.product = excluded.product
                   returning name""",
                (name, spec["product"], Jsonb(spec)),
            ).fetchone()
        if row is None:
            raise PlatformError(403, "TenantNotAuthorized", "dataset belongs to another product")


class PostgresBudget:
    """Same interface as dp.PrivacyBudget."""

    def __init__(self, dsn: str, total_epsilon: float) -> None:
        if not total_epsilon > 0:
            raise ValueError("total_epsilon must be positive")
        self.dsn = dsn
        self.total = float(total_epsilon)

    def spent(self, dataset: str) -> float:
        with _connect(self.dsn) as c:
            row = c.execute("select spent from data_platform.privacy_budget where dataset = %s", (dataset,)).fetchone()
        return float(row[0]) if row else 0.0

    def remaining(self, dataset: str) -> float:
        return max(0.0, self.total - self.spent(dataset))

    def charge(self, dataset: str, epsilon: float) -> None:
        if not epsilon > 0:
            raise ValueError("epsilon must be positive")
        with _connect(self.dsn) as c:
            c.execute(
                "insert into data_platform.privacy_budget (dataset, spent) values (%s, 0) on conflict do nothing",
                (dataset,),
            )
            used = float(
                c.execute(
                    "select spent from data_platform.privacy_budget where dataset = %s for update", (dataset,)
                ).fetchone()[0]
            )
            if used + epsilon > self.total + 1e-12:
                raise BudgetExceeded(f"{dataset}: release needs epsilon {epsilon}, only {self.total - used:.4f} left")
            c.execute("update data_platform.privacy_budget set spent = %s where dataset = %s", (used + epsilon, dataset))


def _ms(t: datetime) -> int:
    return int(t.timestamp() * 1000)


def _ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


class PostgresEventIndex:
    """EventIndex on Postgres. Understands exactly the query shapes ``Searcher.build`` emits:
    bool.filter of term/range on occurredAt, bool.must match on text, sort by occurredAt and
    eventId descending, size and search_after."""

    COLUMNS = {
        "product": "product",
        "tenant": "tenant",
        "eventType": "event_type",
        "objectType": "object_type",
        "objectId": "object_id",
    }

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    def create(self, doc_id: str, doc: dict[str, Any]) -> bool:
        with _connect(self.dsn) as c:
            row = c.execute(
                """insert into data_platform.events (event_id, product, tenant, cid, event_type, schema_version,
                       occurred_at, region, consent, object_type, object_id, text, payload)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (event_id) do nothing returning event_id""",
                (
                    doc_id, doc["product"], doc["tenant"], doc.get("cid"), doc["eventType"], doc["schemaVersion"],
                    _ts(doc["occurredAt"]), doc["region"], doc["consent"], doc.get("objectType"),
                    doc.get("objectId"), doc["text"], Jsonb(doc["payload"]),
                ),
            ).fetchone()
        return row is not None

    def search(self, body: dict[str, Any]) -> dict[str, Any]:
        where, args = [], []
        q = body["query"]["bool"]
        for f in q["filter"]:
            if "term" in f:
                (k, v), = f["term"].items()
                if k not in self.COLUMNS:
                    raise PlatformError(400, "InvalidArgument", f"cannot filter on {k}")
                where.append(f"{self.COLUMNS[k]} = %s")
                args.append(v)
            elif "range" in f and set(f["range"]) == {"occurredAt"}:
                r = f["range"]["occurredAt"]
                where.append("occurred_at between %s and %s")
                args += [_ts(r["gte"]), _ts(r["lte"])]
            else:
                raise PlatformError(400, "InvalidArgument", "unsupported filter")
        for m in q.get("must", []):
            where.append("tsv @@ plainto_tsquery('simple', %s)")
            args.append(m["match"]["text"])
        if "search_after" in body:
            ms, eid = body["search_after"]
            where.append("(occurred_at, event_id::text) < (%s, %s)")
            args += [datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc), str(eid)]
        sql = f"""select event_id::text, product, event_type, occurred_at, object_type, object_id, payload
                  from data_platform.events where {' and '.join(where) or 'true'}
                  order by occurred_at desc, event_id::text desc limit %s"""
        args.append(int(body["size"]))
        with _connect(self.dsn) as c:
            rows = c.execute(sql, args).fetchall()
        hits = []
        for eid, product, etype, occurred, otype, oid, payload in rows:
            src = {
                "eventId": eid,
                "product": product,
                "eventType": etype,
                "occurredAt": occurred.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "objectType": otype,
                "objectId": oid,
                "payload": payload if isinstance(payload, dict) else json.loads(payload),
            }
            hits.append({"_source": src, "sort": [_ms(occurred), eid]})
        return {"hits": {"hits": hits}}

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        sql = "delete from data_platform.events where cid = %s"
        args: list[Any] = [cid_pseudonym]
        if product:
            sql += " and product = %s"
            args.append(product)
        with _connect(self.dsn) as c:
            return c.execute(sql, args).rowcount

    def release_rows(self, product: str, event_type: str, start: datetime, end: datetime, limit: int) -> list[dict[str, Any]]:
        """Events for a differentially private release (event_release.StoredReleases)."""
        with _connect(self.dsn) as c:
            rows = c.execute(
                """select cid, consent, payload from data_platform.events
                   where product = %s and event_type = %s and occurred_at >= %s and occurred_at < %s
                     and cid is not null
                   limit %s""",
                (product, event_type, start, end, int(limit)),
            ).fetchall()
        return [
            {"cid": cid, "consent": list(consent or []), "payload": p if isinstance(p, dict) else json.loads(p)}
            for cid, consent, p in rows
        ]

    def storage_bytes(self) -> int:
        """Size of the whole database: the Supabase free-plan limit applies to all of it."""
        with _connect(self.dsn) as c:
            return int(c.execute("select pg_database_size(current_database())").fetchone()[0])

    def purge_expired(self) -> int:
        with _connect(self.dsn) as c:
            return int(c.execute("select data_platform.purge_expired_events()").fetchone()[0])


class PostgresDocumentStore:
    """documents.DocumentStore on Postgres full-text search: title weighted above body,
    ranked with ts_rank, snippet from ts_headline. The query is parsed with
    websearch_to_tsquery, so quotes and "-word" work and nothing in it is SQL."""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    def upsert(self, doc: dict[str, Any]) -> bool:
        with _connect(self.dsn) as c:
            row = c.execute(
                """insert into data_platform.documents (product, collection, tenant, document_id, title, body,
                       url, labels, owner_cid, viewers, restricted, updated_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (product, collection, tenant, document_id) do update set
                       title = excluded.title, body = excluded.body, url = excluded.url,
                       labels = excluded.labels, owner_cid = excluded.owner_cid, viewers = excluded.viewers,
                       restricted = excluded.restricted, updated_at = excluded.updated_at, stored_at = now()
                   returning (xmax = 0)""",
                (doc["product"], doc["collection"], doc["tenant"], doc["documentId"], doc["title"], doc["body"],
                 doc.get("url"), doc["labels"], doc.get("ownerCid"), doc["viewers"], doc["restricted"],
                 _ts(doc["updatedAt"])),
            ).fetchone()
        return bool(row and row[0])

    def remove(self, product: str, collection: str, tenant: str, document_id: str) -> int:
        with _connect(self.dsn) as c:
            return c.execute(
                """delete from data_platform.documents
                   where product = %s and collection = %s and tenant = %s and document_id = %s""",
                (product, collection, tenant, document_id),
            ).rowcount

    def search(self, product: str, tenant: str, text: str, collections: list[str], labels: list[str],
               viewer: str | None, limit: int) -> list[dict[str, Any]]:
        where = ["product = %(product)s", "tenant = %(tenant)s", "tsv @@ q",
                 "(not restricted or %(viewer)s = any(viewers) or owner_cid = %(viewer)s)"]
        if collections:
            where.append("collection = any(%(collections)s)")
        if labels:
            where.append("labels @> %(labels)s")
        sql = f"""select collection, document_id, title,
                         ts_headline('simple', body, q, 'MaxWords=30, MinWords=10, MaxFragments=1'),
                         url, labels, updated_at
                  from data_platform.documents, websearch_to_tsquery('simple', %(text)s) q
                  where {' and '.join(where)}
                  order by ts_rank(tsv, q) desc, updated_at desc
                  limit %(limit)s"""
        args = {"product": product, "tenant": tenant, "text": text, "viewer": viewer,
                "collections": collections, "labels": labels, "limit": int(limit)}
        with _connect(self.dsn) as c:
            rows = c.execute(sql, args).fetchall()
        return [
            {"collection": col, "documentId": did, "title": title, "snippet": snip, "url": url,
             "labels": list(labs or []), "updatedAt": upd.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
            for col, did, title, snip, url, labs, upd in rows
        ]

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        scope, args = ("and product = %s", [product]) if product else ("", [])
        with _connect(self.dsn) as c:
            n = c.execute(f"delete from data_platform.documents where owner_cid = %s {scope}",
                          [cid_pseudonym, *args]).rowcount
            c.execute(f"""update data_platform.documents set viewers = array_remove(viewers, %s)
                          where %s = any(viewers) {scope}""", [cid_pseudonym, cid_pseudonym, *args])
        return n
