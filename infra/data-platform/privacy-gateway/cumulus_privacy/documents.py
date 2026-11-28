# © Infinitum Corporation®. All rights reserved.
"""Tenant-scoped full-text search over product documents (help articles, notes, deal files).

Products put documents with their product token; the gateway stores them per
(product, collection, tenant, documentId) after redacting personal data out of the title and
body with Presidio, the same way it redacts event text. Search is always scoped to the calling
product and one tenant, and optionally narrowed by collection and labels.

Visibility inside a tenant:

* A document sent with no ``viewers`` is visible to everyone searching that tenant.
* A document sent with ``viewers`` stays restricted and is visible only to a search made for one of those people, or for
  its owner. People are stored as analytics pseudonyms of their Cumulus ID, never raw.

Right to erasure: ``erase`` deletes the documents a person owns and removes them from every
viewer list, so no pseudonym of theirs stays behind.

Expiry: a document sent with ``expiresAt`` stops matching searches at that time, and the
gateway's daily retention purge deletes it (``purge_expired``). It must lie in the future and at
most ``MAX_EXPIRY_DAYS`` ahead, so a typo can't keep personal data for a century.

Backends: Postgres (free tier, ``data_platform.documents`` with a weighted tsvector),
OpenSearch (the full stack, index ``cumulus-documents``) and an in-memory store for tests.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol

from .platform import EXCLUDED_PRODUCTS, PlatformError, _bad, _iso, _parse_time
from .redaction import Destination

COLLECTION = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
DOCUMENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
TENANT = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")
LABEL = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,62}$")
MAX_TITLE = 300
MAX_BODY = 200_000
MAX_LABELS = 20
MAX_VIEWERS = 500
MAX_PAGE = 50
MAX_BATCH = 100
MAX_EXPIRY_DAYS = 3650
SNIPPET_WORDS = 30


class DocumentStore(Protocol):
    def upsert(self, doc: dict[str, Any]) -> bool:
        """Insert or replace by (product, collection, tenant, documentId). True when new."""
        ...

    def remove(self, product: str, collection: str, tenant: str, document_id: str) -> int: ...

    def search(self, product: str, tenant: str, text: str, collections: list[str], labels: list[str],
               viewer: str | None, limit: int) -> list[dict[str, Any]]: ...

    def erase(self, cid_pseudonym: str, product: str | None) -> int: ...

    def purge_expired(self) -> int:
        """Delete documents whose expiresAt has passed; return how many."""


def _tenant(v: Any) -> str:
    if not isinstance(v, str) or not TENANT.match(v):
        raise _bad("tenant must be lower-case letters, digits, '.', '_' or '-' (at most 63)")
    return v


def _labels(v: Any) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > MAX_LABELS or not all(isinstance(x, str) and LABEL.match(x) for x in v):
        raise _bad(f"labels must be at most {MAX_LABELS} lower-case labels")
    return sorted(set(v))


class Documents:
    """``limits`` is the gateway's IngestLimits. Documents share the free-tier database with
    events, so a put is refused once the storage guard reports full; remove and erasure still
    work, since they free space."""

    def __init__(self, redactor: Any, store: Any, limits: Any = None) -> None:
        self.redactor, self.store, self.limits = redactor, store, limits

    def _pseudonym(self, cid: str) -> str:
        return self.redactor.pseudonym("cid", cid.strip(), Destination.ANALYTICS)

    def _strip_pii(self, text: str) -> str:
        """Removes what Presidio detects from a search query. Stored text keeps keyed
        pseudonyms, so a redacted query would still match an exact email or name: that would let
        a caller test whether a person appears in a tenant's documents. Dropping it avoids that."""
        spans = sorted((r.start, r.end) for r in self.redactor.analyze(text))
        out, at = [], 0
        for start, end in spans:
            if start >= at:
                out.append(text[at:start])
                at = end
            else:
                at = max(at, end)
        out.append(text[at:])
        return " ".join("".join(out).split())

    def _redact(self, text: str) -> str:
        return self.redactor.redact_text(text, Destination.ANALYTICS)[0] if text.strip() else text

    @staticmethod
    def _key(caller: str, collection: str, document_id: str) -> None:
        if EXCLUDED_PRODUCTS.match(caller):
            raise PlatformError(403, "TenantNotAuthorized", "military and defense products are excluded")
        if not COLLECTION.match(collection):
            raise _bad("collection must be lower-case letters, digits, '_' or '-' (at most 63)")
        if not DOCUMENT_ID.match(document_id):
            raise _bad("documentId must be letters, digits, '.', '_', ':' or '-' (at most 128)")

    def _guard(self) -> None:
        if self.limits is not None and self.limits.storage_state() == "full":
            raise PlatformError(503, "StorageQuotaReached",
                                "the data store is full; documents are not stored until space is freed",
                                retry_after=3600)

    def put(self, caller: str, collection: str, document_id: str, b: Mapping[str, Any]) -> dict[str, Any]:
        self._key(caller, collection, document_id)
        self._guard()
        self.store.upsert(self._prepare(caller, collection, document_id, b))
        return {"collection": collection, "documentId": document_id}

    def put_many(self, caller: str, collection: str, b: Mapping[str, Any]) -> dict[str, Any]:
        """Up to MAX_BATCH documents of one collection. All are validated and redacted before any
        is written, so a bad document rejects the whole batch with its position in the message."""
        items = b.get("documents")
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH:
            raise _bad(f"documents must be a list of 1 to {MAX_BATCH} documents")
        self._key(caller, collection, "x")
        ids = [d.get("documentId") if isinstance(d, Mapping) else None for d in items]
        if len(set(map(str, ids))) != len(ids):
            raise _bad("documents: each documentId may appear once per batch")
        self._guard()
        prepared = []
        for i, d in enumerate(items):
            try:
                if not isinstance(d, Mapping) or not isinstance(d.get("documentId"), str):
                    raise _bad("documentId is required")
                self._key(caller, collection, d["documentId"])
                prepared.append(self._prepare(caller, collection, d["documentId"], d))
            except PlatformError as e:
                raise _bad(f"documents[{i}]: {e.message}") from e
        created = sum(1 for doc in prepared if self.store.upsert(doc))
        return {"collection": collection, "stored": len(prepared), "created": created}

    def _prepare(self, caller: str, collection: str, document_id: str, b: Mapping[str, Any]) -> dict[str, Any]:
        tenant = _tenant(b.get("tenant"))
        title, body = b.get("title"), b.get("body")
        if not isinstance(title, str) or not title.strip() or len(title) > MAX_TITLE:
            raise _bad(f"title is required (at most {MAX_TITLE} characters)")
        if not isinstance(body, str) or len(body) > MAX_BODY:
            raise _bad(f"body must be text of at most {MAX_BODY} characters")
        url = b.get("url")
        if url is not None and (not isinstance(url, str) or not url.startswith("https://") or len(url) > 2048):
            raise _bad("url must be an https:// link")
        updated = _parse_time(b.get("updatedAt"), "updatedAt")
        expires = b.get("expiresAt")
        if expires is not None:
            expires = _parse_time(expires, "expiresAt")
            now = datetime.now(timezone.utc)
            if not now < expires <= now + timedelta(days=MAX_EXPIRY_DAYS):
                raise _bad(f"expiresAt must be in the future and at most {MAX_EXPIRY_DAYS} days ahead")
        owner = b.get("ownerCid")
        if owner is not None and (not isinstance(owner, str) or not owner.strip()):
            raise _bad("ownerCid must be a Cumulus ID")
        viewers = b.get("viewers")
        if viewers is not None and (
            not isinstance(viewers, list) or len(viewers) > MAX_VIEWERS
            or not all(isinstance(v, str) and v.strip() for v in viewers)
        ):
            raise _bad(f"viewers must be a list of at most {MAX_VIEWERS} Cumulus IDs")
        doc = {
            "product": caller,
            "collection": collection,
            "tenant": tenant,
            "documentId": document_id,
            "title": self._redact(title),
            "body": self._redact(body),
            "url": url,
            "labels": _labels(b.get("labels")),
            "ownerCid": self._pseudonym(owner) if owner else None,
            "viewers": sorted({self._pseudonym(v) for v in viewers or []}),
            # Kept separately from the list: erasing the last viewer must not open the document
            # to the whole tenant.
            "restricted": bool(viewers),
            "updatedAt": _iso(updated),
            "expiresAt": _iso(expires) if expires else None,
        }
        return doc

    def remove(self, caller: str, collection: str, document_id: str, b: Mapping[str, Any]) -> dict[str, int]:
        self._key(caller, collection, document_id)
        return {"deleted": self.store.remove(caller, collection, _tenant(b.get("tenant")), document_id)}

    def search(self, caller: str, q: Mapping[str, Any]) -> dict[str, Any]:
        if EXCLUDED_PRODUCTS.match(caller):
            raise PlatformError(403, "TenantNotAuthorized", "military and defense products are excluded")
        tenant = _tenant(q.get("tenant"))
        text = q.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise _bad("text is required (at most 500 characters)")
        collections = q.get("collections") or []
        if not isinstance(collections, list) or not all(isinstance(c, str) and COLLECTION.match(c) for c in collections):
            raise _bad("collections must be collection names")
        size = q.get("pageSize")
        size = 20 if size is None else size
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_PAGE:
            raise _bad(f"pageSize must be 1 to {MAX_PAGE}")
        viewer = q.get("viewer")
        if viewer is not None and (not isinstance(viewer, str) or not viewer.strip()):
            raise _bad("viewer must be a Cumulus ID")
        labels = _labels(q.get("labels"))
        terms = self._strip_pii(text)
        if not terms:  # the query was only personal data
            return {"hits": []}
        hits = self.store.search(caller, tenant, terms, sorted(set(collections)), labels,
                                 self._pseudonym(viewer) if viewer else None, size)
        return {"hits": hits}


def _visible(doc: Mapping[str, Any], viewer: str | None) -> bool:
    if not doc.get("restricted"):
        return True
    return viewer is not None and (viewer in doc["viewers"] or viewer == doc.get("ownerCid"))


def _expired(doc: Mapping[str, Any], now: datetime | None = None) -> bool:
    exp = doc.get("expiresAt")
    return bool(exp) and _parse_time(exp, "expiresAt") <= (now or datetime.now(timezone.utc))


def _snippet(body: str, words: list[str]) -> str:
    tokens = body.split()
    low = [t.lower() for t in tokens]
    start = next((i for i, t in enumerate(low) if any(w in t for w in words)), 0)
    start = max(0, start - 5)
    return " ".join(tokens[start:start + SNIPPET_WORDS])


class MemoryDocumentStore:
    """For tests and local runs. Matches when every query word appears in the title or body."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        self._lock = threading.Lock()

    def upsert(self, doc: dict[str, Any]) -> bool:
        key = (doc["product"], doc["collection"], doc["tenant"], doc["documentId"])
        with self._lock:
            new = key not in self.docs
            self.docs[key] = dict(doc)
        return new

    def remove(self, product: str, collection: str, tenant: str, document_id: str) -> int:
        with self._lock:
            return 1 if self.docs.pop((product, collection, tenant, document_id), None) else 0

    def search(self, product, tenant, text, collections, labels, viewer, limit):
        words = [w.lower() for w in re.findall(r"\w+", text)]
        found = []
        for d in self.docs.values():
            if d["product"] != product or d["tenant"] != tenant or not _visible(d, viewer) or _expired(d):
                continue
            if collections and d["collection"] not in collections:
                continue
            if not set(labels) <= set(d["labels"]):
                continue
            hay = f"{d['title']} {d['body']}".lower()
            if not words or not all(w in hay for w in words):
                continue
            score = sum(d["title"].lower().count(w) * 2 + d["body"].lower().count(w) for w in words)
            found.append((score, d["updatedAt"], d))
        found.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return [_hit(d, _snippet(d["body"], words)) for _, _, d in found[:limit]]

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        n = 0
        with self._lock:
            for key, d in list(self.docs.items()):
                if product and d["product"] != product:
                    continue
                if d.get("ownerCid") == cid_pseudonym:
                    del self.docs[key]
                    n += 1
                elif cid_pseudonym in d["viewers"]:
                    d["viewers"] = [v for v in d["viewers"] if v != cid_pseudonym]
        return n

    def purge_expired(self) -> int:
        with self._lock:
            gone = [k for k, d in self.docs.items() if _expired(d)]
            for k in gone:
                del self.docs[k]
        return len(gone)


def _hit(d: Mapping[str, Any], snippet: str) -> dict[str, Any]:
    updated = d["updatedAt"]
    if isinstance(updated, datetime):
        updated = _iso(updated)
    return {
        "collection": d["collection"],
        "documentId": d["documentId"],
        "title": d["title"],
        "snippet": snippet,
        "url": d.get("url"),
        "labels": list(d.get("labels") or []),
        "updatedAt": updated,
    }


DOCUMENTS_INDEX = "cumulus-documents"


class OpenSearchDocumentStore:
    """DocumentStore on OpenSearch (search/documents-index.json, installed by bootstrap.sh).

    The document id is a hash of (product, collection, tenant, documentId), so put and remove can
    only ever touch the caller's own document. Every search filters on product and tenant and
    applies the same visibility rule as Postgres. The query is a simple_query_string over title
    (weighted twice) and body with AND between words, so quotes and -word work and nothing in it
    is query DSL."""

    def __init__(self, url: str, refresh: bool = False, timeout: float = 10.0, index: str = DOCUMENTS_INDEX) -> None:
        self.url, self.refresh, self.timeout, self.index = url.rstrip("/"), refresh, timeout, index

    def _call(self, method: str, path: str, body: Any = None) -> tuple[int, dict[str, Any]]:
        req = urllib.request.Request(
            self.url + path, method=method, headers={"Content-Type": "application/json"},
            data=None if body is None else json.dumps(body).encode(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    @staticmethod
    def doc_id(product: str, collection: str, tenant: str, document_id: str) -> str:
        return hashlib.sha256(f"{product}\x1f{collection}\x1f{tenant}\x1f{document_id}".encode()).hexdigest()

    def _fail(self, what: str, status: int) -> PlatformError:
        return PlatformError(500, "SearchUnavailable", f"document {what} failed ({status})")

    def upsert(self, doc: dict[str, Any]) -> bool:
        did = self.doc_id(doc["product"], doc["collection"], doc["tenant"], doc["documentId"])
        q = "?refresh=wait_for" if self.refresh else ""
        status, out = self._call("PUT", f"/{self.index}/_doc/{did}{q}", doc)
        if status >= 300:
            raise self._fail("write", status)
        return out.get("result") == "created"

    def remove(self, product: str, collection: str, tenant: str, document_id: str) -> int:
        q = "?refresh=wait_for" if self.refresh else ""
        status, out = self._call("DELETE", f"/{self.index}/_doc/{self.doc_id(product, collection, tenant, document_id)}{q}")
        if status == 404:
            return 0
        if status >= 300:
            raise self._fail("delete", status)
        return 1 if out.get("result") == "deleted" else 0

    def search(self, product, tenant, text, collections, labels, viewer, limit):
        filters: list[dict[str, Any]] = [{"term": {"product": product}}, {"term": {"tenant": tenant}}]
        if collections:
            filters.append({"terms": {"collection": list(collections)}})
        filters += [{"term": {"labels": label}} for label in labels]
        visible: list[dict[str, Any]] = [{"term": {"restricted": False}}]
        if viewer is not None:
            visible += [{"term": {"viewers": viewer}}, {"term": {"ownerCid": viewer}}]
        # Documents past their expiresAt are hidden before the daily purge deletes them.
        filters.append({"bool": {"must_not": [{"range": {"expiresAt": {"lte": "now"}}}]}})
        filters.append({"bool": {"should": visible, "minimum_should_match": 1}})
        body = {
            "size": int(limit),
            "_source": ["collection", "documentId", "title", "body", "url", "labels", "updatedAt"],
            "query": {"bool": {
                "filter": filters,
                "must": [{"simple_query_string": {"query": text, "fields": ["title^2", "body"],
                                                  "default_operator": "and",
                                                  "flags": "AND|OR|NOT|PHRASE|PREFIX|WHITESPACE|PRECEDENCE"}}],
            }},
            "sort": [{"_score": "desc"}, {"updatedAt": "desc"}],
            "highlight": {"fields": {"body": {"fragment_size": 200, "number_of_fragments": 1}},
                          "pre_tags": [""], "post_tags": [""]},
        }
        status, out = self._call("POST", f"/{self.index}/_search", body)
        if status >= 300:
            raise self._fail("search", status)
        words = [w.lower() for w in re.findall(r"\w+", text)]
        hits = []
        for h in out.get("hits", {}).get("hits", []):
            src = h["_source"]
            snippet = (h.get("highlight", {}).get("body") or [_snippet(src.get("body", ""), words)])[0]
            hits.append(_hit(src, snippet))
        return hits

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        scope: list[dict[str, Any]] = [{"term": {"product": product}}] if product else []
        status, out = self._call(
            "POST", f"/{self.index}/_delete_by_query?refresh=true&conflicts=proceed",
            {"query": {"bool": {"filter": [{"term": {"ownerCid": cid_pseudonym}}, *scope]}}},
        )
        if status >= 300 or out.get("failures"):
            raise PlatformError(500, "SearchUnavailable", f"erasure failed ({status}); repeat it, it is idempotent")
        deleted = int(out.get("deleted", 0))
        # Shared documents keep restricted=true, so dropping the last viewer never opens them up.
        status, out = self._call(
            "POST", f"/{self.index}/_update_by_query?refresh=true&conflicts=proceed",
            {"query": {"bool": {"filter": [{"term": {"viewers": cid_pseudonym}}, *scope]}},
             "script": {"lang": "painless", "params": {"p": cid_pseudonym},
                        "source": "ctx._source.viewers.removeIf(v -> v == params.p)"}},
        )
        if status >= 300 or out.get("failures"):
            raise PlatformError(500, "SearchUnavailable", f"erasure failed ({status}); repeat it, it is idempotent")
        return deleted

    def purge_expired(self) -> int:
        """Daily retention: delete documents whose expiresAt has passed."""
        status, out = self._call(
            "POST", f"/{self.index}/_delete_by_query?refresh=true&conflicts=proceed",
            {"query": {"range": {"expiresAt": {"lte": "now"}}}},
        )
        if status >= 300 or out.get("failures"):
            raise self._fail("purge", status)
        return int(out.get("deleted", 0))
