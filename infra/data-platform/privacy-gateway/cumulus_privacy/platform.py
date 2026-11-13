# © Infinitum Corporation®. All rights reserved.
"""Catalog, collection and search: the servers behind conjure/platform.yml.

* **Catalog** keeps every dataset's spec (owners, fields with classification and export rule,
  lineage, retention, region) in a local JSON registry and pushes it to DataHub as aspects.
  The registry is what the collector and the exports read, so redaction rules and the catalog
  cannot drift apart.
* **Collection** accepts events from a product. Each event must name a registered event type
  of that product, match its fields, and belong to this gateway's region (data stays where it
  lives). Its payload is redacted with the dataset's field rules before it is indexed.
* **Search** queries indexed events. The tenant filter and the caller's product are always
  applied on the server; a product can never read another product's events.

Callers are product backends, each with its own token. The person behind a request signs in
to that product with Cumulus ID; the product passes the tenant and CID on.
"""
from __future__ import annotations

import base64
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from .redaction import Destination, FieldRule, Redactor

CLASSIFICATIONS = {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "PERSONAL", "SPECIAL_CATEGORY"}
REGIONS = {"EU", "US", "RU"}
CONSENTS = {"ESSENTIAL", "ANALYTICS", "AI_IMPROVEMENT", "EXCHANGE"}
# Military and defense products never send data to this platform.
EXCLUDED_PRODUCTS = re.compile(r"^(aether|infinitum-defense|eon-military|argus-military)(\b|-)", re.I)
DATASET_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9_][a-z0-9_-]*)+$")
WRITE_ALIAS = "cumulus-events-write"
READ_PATTERN = "cumulus-events-*"


class PlatformError(Exception):
    """An error in the DataPlatform namespace (conjure/platform.yml)."""

    def __init__(self, status: int, name: str, message: str, args: Mapping[str, Any] | None = None,
                 retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status, self.name, self.message, self.safe_args = status, name, message, dict(args or {})
        self.retry_after = retry_after


def _bad(message: str) -> PlatformError:
    return PlatformError(400, "InvalidArgument", message)


def _parse_time(v: Any, field: str) -> datetime:
    if not isinstance(v, str):
        raise _bad(f"{field} must be an ISO-8601 datetime")
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError as e:
        raise _bad(f"{field} must be an ISO-8601 datetime") from e
    if t.tzinfo is None:
        raise _bad(f"{field} needs a time zone offset")
    return t.astimezone(timezone.utc)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- catalog


def dataset_urn(name: str, env: str = "PROD") -> str:
    return f"urn:li:dataset:(urn:li:dataPlatform:cumulus,{name},{env})"


def validate_spec(name: str, spec: Mapping[str, Any]) -> dict[str, Any]:
    if not DATASET_NAME.match(name):
        raise _bad("dataset name must look like product.entity (lower case)")
    if spec.get("name") != name:
        raise _bad("spec.name must equal the dataset name in the path")
    for key, kind in (("product", str), ("description", str), ("owners", list), ("fields", list),
                      ("upstream", list), ("retentionDays", int), ("region", str), ("glossaryTerms", list)):
        if not isinstance(spec.get(key), kind) or isinstance(spec.get(key), bool):
            raise _bad(f"spec.{key} is required")
    if not spec["owners"]:
        raise _bad("a dataset needs at least one owner")
    if spec["retentionDays"] <= 0:
        raise _bad("retentionDays must be positive")
    if spec["region"] not in REGIONS:
        raise _bad(f"region must be one of {sorted(REGIONS)}")
    seen = set()
    fields = []
    for f in spec["fields"]:
        if not isinstance(f, Mapping) or not isinstance(f.get("name"), str) or not isinstance(f.get("type"), str):
            raise _bad("each field needs a name and a type")
        if f["name"] in seen:
            raise _bad(f"field {f['name']} is declared twice")
        seen.add(f["name"])
        if f.get("classification") not in CLASSIFICATIONS:
            raise _bad(f"field {f['name']}: classification must be one of {sorted(CLASSIFICATIONS)}")
        try:
            rule = FieldRule(f.get("rule", ""))
        except ValueError as e:
            raise _bad(f"field {f['name']}: rule must be KEEP, TEXT, PSEUDONYMIZE or DROP") from e
        if f["classification"] in ("PERSONAL", "SPECIAL_CATEGORY") and rule is FieldRule.KEEP:
            raise _bad(f"field {f['name']}: personal data cannot use rule KEEP")
        fields.append({**f, "rule": rule.name})
    return {**spec, "fields": fields}


class DataHubSink:
    """Pushes a dataset spec to DataHub GMS as metadata change proposals (REST API
    ``POST /aspects?action=ingestProposal``)."""

    def __init__(self, gms_url: str, token: str | None = None, timeout: float = 10.0) -> None:
        self.gms_url = gms_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @staticmethod
    def proposals(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
        urn = dataset_urn(spec["name"])
        stamp = {"time": 0, "actor": "urn:li:corpuser:datahub"}
        type_map = {"string": "StringType", "integer": "NumberType", "double": "NumberType",
                    "boolean": "BooleanType", "datetime": "TimeType", "list": "ArrayType", "map": "MapType"}

        def owner_urn(o: str) -> str:
            return o if o.startswith("urn:li:") else f"urn:li:corpuser:{o}"

        classes = sorted({f["classification"] for f in spec["fields"]})
        aspects: dict[str, Any] = {
            "datasetProperties": {
                "name": spec["name"],
                "description": spec["description"],
                "customProperties": {
                    "product": spec["product"],
                    "region": spec["region"],
                    "retentionDays": str(spec["retentionDays"]),
                },
            },
            "ownership": {
                "owners": [{"owner": owner_urn(o), "type": "DATAOWNER"} for o in spec["owners"]],
                "lastModified": stamp,
            },
            "globalTags": {"tags": [{"tag": f"urn:li:tag:classification-{c.lower()}"} for c in classes]},
            "schemaMetadata": {
                "schemaName": spec["name"],
                "platform": "urn:li:dataPlatform:cumulus",
                "version": 0,
                "hash": "",
                "platformSchema": {"com.linkedin.schema.OtherSchema": {"rawSchema": ""}},
                "fields": [
                    {
                        "fieldPath": f["name"],
                        "nativeDataType": f["type"],
                        "type": {"type": {f"com.linkedin.schema.{type_map.get(f['type'], 'StringType')}": {}}},
                        "description": f.get("description") or "",
                        "globalTags": {"tags": [{"tag": f"urn:li:tag:classification-{f['classification'].lower()}"}]},
                    }
                    for f in spec["fields"]
                ],
            },
        }
        if spec["upstream"]:
            aspects["upstreamLineage"] = {
                "upstreams": [{"dataset": dataset_urn(u), "type": "TRANSFORMED", "auditStamp": stamp} for u in spec["upstream"]]
            }
        if spec["glossaryTerms"]:
            aspects["glossaryTerms"] = {
                "terms": [{"urn": t if t.startswith("urn:li:") else f"urn:li:glossaryTerm:{t}"} for t in spec["glossaryTerms"]],
                "auditStamp": stamp,
            }
        return [
            {
                "entityType": "dataset",
                "entityUrn": urn,
                "changeType": "UPSERT",
                "aspectName": name,
                "aspect": {"value": json.dumps(value), "contentType": "application/json"},
            }
            for name, value in aspects.items()
        ]

    def push(self, spec: Mapping[str, Any]) -> None:
        headers = {"Content-Type": "application/json", "X-RestLi-Protocol-Version": "2.0.0"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        for p in self.proposals(spec):
            req = urllib.request.Request(
                f"{self.gms_url}/aspects?action=ingestProposal",
                data=json.dumps({"proposal": p}).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                r.read()


class Catalog:
    def __init__(self, path: str | Path, sink: Any | None = None) -> None:
        self.path = Path(path)
        self.sink = sink
        self._lock = threading.Lock()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text("utf-8"))

    def get(self, name: str) -> dict[str, Any] | None:
        return self._load().get(name)

    def _put(self, name: str, spec: dict[str, Any]) -> None:
        """Store the spec unless the name belongs to another product."""
        with self._lock:
            reg = self._load()
            existing = reg.get(name)
            if existing and existing["product"] != spec["product"]:
                raise PlatformError(403, "TenantNotAuthorized", "dataset belongs to another product")
            reg[name] = spec
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(reg, sort_keys=True, indent=1), "utf-8")
            tmp.replace(self.path)

    def register(self, caller: str, name: str, spec: Mapping[str, Any]) -> dict[str, str]:
        clean = validate_spec(name, spec)
        if clean["product"] != caller:
            raise PlatformError(403, "TenantNotAuthorized", "a product can only register its own datasets")
        self._put(name, clean)
        if self.sink is not None:
            try:
                self.sink.push(clean)
            except (urllib.error.URLError, OSError) as e:
                # Saved locally; a repeat PUT is idempotent and re-pushes.
                raise PlatformError(500, "CatalogUnavailable", "saved, but DataHub did not accept it; retry the PUT") from e
        return {"name": name, "urn": dataset_urn(name)}

    def read(self, caller: str, name: str) -> dict[str, Any]:
        spec = self.get(name)
        if spec is None or spec["product"] != caller:
            # Another product's dataset looks the same as a missing one.
            raise PlatformError(404, "DatasetNotFound", "no such dataset", {"name": name})
        return spec


# --------------------------------------------------------------------------- index


class EventIndex(Protocol):
    def create(self, doc_id: str, doc: dict[str, Any]) -> bool:
        """Index a new document. False when the id already exists."""

    def search(self, body: dict[str, Any]) -> dict[str, Any]: ...

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        """Delete every event about this person (in one product, or all). Returns the count."""


class OpenSearchIndex:
    def __init__(self, url: str, refresh: bool = False, timeout: float = 10.0) -> None:
        self.url = url.rstrip("/")
        self.refresh = refresh
        self.timeout = timeout

    def _call(self, method: str, path: str, body: Any) -> tuple[int, dict[str, Any]]:
        req = urllib.request.Request(
            self.url + path, data=json.dumps(body).encode(), method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def create(self, doc_id: str, doc: dict[str, Any]) -> bool:
        q = "?refresh=wait_for" if self.refresh else ""
        status, out = self._call("PUT", f"/{WRITE_ALIAS}/_create/{doc_id}{q}", doc)
        if status == 409:
            return False
        if status >= 300:
            raise PlatformError(500, "SearchUnavailable", f"index refused the event ({status})")
        return True

    def search(self, body: dict[str, Any]) -> dict[str, Any]:
        status, out = self._call("POST", f"/{READ_PATTERN}/_search", body)
        if status >= 300:
            raise PlatformError(500, "SearchUnavailable", f"search failed ({status})")
        return out

    def release_rows(self, product: str, event_type: str, start: datetime, end: datetime, limit: int) -> list[dict[str, Any]]:
        """Events for a differentially private release. One request: OpenSearch returns at most
        10,000 hits, so the caller's row cap is clamped there."""
        body = {
            "size": min(int(limit), 10_000),
            "_source": ["cid", "consent", "payload"],
            "query": {"bool": {"filter": [
                {"term": {"product": product}},
                {"term": {"eventType": event_type}},
                {"exists": {"field": "cid"}},
                {"range": {"occurredAt": {"gte": _iso(start), "lt": _iso(end)}}},
            ]}},
        }
        status, out = self._call("POST", f"/{READ_PATTERN}/_search", body)
        if status >= 300:
            raise PlatformError(500, "SearchUnavailable", f"search failed ({status})")
        return [h["_source"] for h in out.get("hits", {}).get("hits", [])]

    def erase(self, cid_pseudonym: str, product: str | None) -> int:
        filters: list[dict[str, Any]] = [{"term": {"cid": cid_pseudonym}}]
        if product:
            filters.append({"term": {"product": product}})
        status, out = self._call("POST", f"/{READ_PATTERN}/_delete_by_query?refresh=true&conflicts=proceed",
                                 {"query": {"bool": {"filter": filters}}})
        if status >= 300 or out.get("failures"):
            raise PlatformError(500, "SearchUnavailable", f"erasure failed ({status}); repeat it, it is idempotent")
        return int(out.get("deleted", 0))


# --------------------------------------------------------------------------- collection

_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "double": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "list": lambda v: isinstance(v, list),
    "map": lambda v: isinstance(v, dict),
}


class IngestLimits:
    """Keeps one product, or the free database, from being overrun.

    * ``max_batch``: events per request.
    * ``daily_quota``: accepted events per product per UTC day (0 = no limit). Counted in memory,
      which is exact for the single gateway on the box and resets on restart.
    * ``storage_limit_bytes``: refuse new events once the store reports this size (0 = off).
      Supabase's free plan allows 500 MB per database, so the box profile sets 450 MB.
    """

    STORAGE_TTL = 60.0

    def __init__(self, max_batch: int = 1000, daily_quota: int = 0, storage_limit_bytes: int = 0,
                 storage: Callable[[], int] | None = None, clock: Callable[[], float] = time.time) -> None:
        if max_batch < 1 or daily_quota < 0 or storage_limit_bytes < 0:
            raise ValueError("limits must be positive")
        self.max_batch, self.daily_quota, self.storage_limit = max_batch, daily_quota, storage_limit_bytes
        self.storage, self.clock = storage, clock
        self._lock = threading.Lock()
        self._day = ""
        self._counts: dict[str, int] = {}
        self._size: tuple[float, int] | None = None

    def _today(self) -> str:
        day = datetime.fromtimestamp(self.clock(), tz=timezone.utc).strftime("%Y-%m-%d")
        if day != self._day:
            self._day, self._counts = day, {}
        return day

    def _seconds_to_midnight(self) -> int:
        now = self.clock()
        return max(1, int(86400 - now % 86400))

    def storage_bytes(self) -> int | None:
        if self.storage is None:
            return None
        now = self.clock()
        if self._size is None or now - self._size[0] > self.STORAGE_TTL:
            self._size = (now, int(self.storage()))
        return self._size[1]

    def storage_state(self) -> str:
        """ok, nearly_full (80 percent of the limit) or full. ok when no limit is set."""
        if not self.storage_limit:
            return "ok"
        try:
            size = self.storage_bytes()
        except Exception:  # noqa: BLE001 - health must not fail because of this
            return "unknown"
        if size is None:
            return "ok"
        if size >= self.storage_limit:
            return "full"
        return "nearly_full" if size >= 0.8 * self.storage_limit else "ok"

    def admit(self, caller: str, n: int) -> None:
        if n > self.max_batch:
            raise PlatformError(413, "InvalidArgument", f"at most {self.max_batch} events per request")
        if self.storage_state() == "full":
            raise PlatformError(503, "StorageQuotaReached",
                                "the event store is full; events are not stored until space is freed",
                                retry_after=3600)
        if self.daily_quota:
            with self._lock:
                self._today()
                if self._counts.get(caller, 0) + n > self.daily_quota:
                    raise PlatformError(429, "IngestQuotaExceeded",
                                        f"daily limit of {self.daily_quota} events reached",
                                        {"product": caller}, retry_after=self._seconds_to_midnight())

    def record(self, caller: str, accepted: int) -> None:
        with self._lock:
            self._today()
            self._counts[caller] = self._counts.get(caller, 0) + accepted

    def used_today(self, caller: str) -> int:
        with self._lock:
            self._today()
            return self._counts.get(caller, 0)


class Collector:
    def __init__(self, catalog: Catalog, redactor: Redactor, index: EventIndex, region: str,
                 limits: IngestLimits | None = None) -> None:
        if region not in REGIONS:
            raise ValueError(f"PLATFORM_REGION must be one of {sorted(REGIONS)}")
        self.catalog, self.redactor, self.index, self.region = catalog, redactor, index, region
        self.limits = limits or IngestLimits()

    def _check(self, caller: str, e: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
        """Returns (indexable document, event id) or raises PlatformError with a reason."""
        try:
            event_id = str(uuid.UUID(str(e.get("eventId"))))
        except ValueError as err:
            raise _bad("eventId must be a UUID") from err
        if e.get("product") != caller:
            raise PlatformError(403, "TenantNotAuthorized", "event product does not match the caller")
        if not isinstance(e.get("tenant"), str) or not e["tenant"]:
            raise _bad("tenant is required")
        if e.get("region") != self.region:
            raise _bad(f"event region {e.get('region')} cannot be stored in {self.region}")
        consent = e.get("consent")
        if not isinstance(consent, list) or not set(consent) <= CONSENTS:
            raise _bad("consent must be a list of ESSENTIAL, ANALYTICS, AI_IMPROVEMENT, EXCHANGE")
        occurred = _parse_time(e.get("occurredAt"), "occurredAt")
        spec = self.catalog.get(str(e.get("eventType")))
        if spec is None or spec["product"] != caller:
            raise PlatformError(400, "SchemaMismatch", "event type is not registered for this product",
                                {"eventType": e.get("eventType")})
        if spec["region"] != self.region:
            raise _bad("event type is registered in another region")
        payload = e.get("payload")
        if not isinstance(payload, dict):
            raise _bad("payload must be an object")
        fields = {f["name"]: f for f in spec["fields"]}
        unknown = sorted(set(payload) - set(fields))
        if unknown:
            raise PlatformError(400, "SchemaMismatch", f"fields not in the schema: {', '.join(unknown)}",
                                {"eventType": spec["name"]})
        for k, v in payload.items():
            check = _TYPE_CHECKS.get(fields[k]["type"])
            if v is not None and check is not None and not check(v):
                raise PlatformError(400, "SchemaMismatch", f"field {k} is not a {fields[k]['type']}",
                                    {"eventType": spec["name"]})
        if not isinstance(e.get("schemaVersion"), int):
            raise _bad("schemaVersion must be an integer")

        rules = {k: FieldRule[f["rule"]] for k, f in fields.items()}
        red, _found = self.redactor.redact_record(payload, Destination.ANALYTICS, rules)
        text = " ".join(str(red[k]) for k, f in fields.items() if f["rule"] == "TEXT" and isinstance(red.get(k), str))
        doc = {
            "eventId": event_id,
            "product": caller,
            "tenant": e["tenant"],
            "eventType": spec["name"],
            "schemaVersion": e["schemaVersion"],
            "occurredAt": _iso(occurred),
            "region": self.region,
            "consent": sorted(set(consent)),
            "objectType": e.get("objectType"),
            "objectId": e.get("objectId"),
            "text": text,
            "payload": red,
        }
        if e.get("cid"):
            doc["cid"] = self.redactor.pseudonym("cid", str(e["cid"]), Destination.ANALYTICS)
        return doc, event_id

    def ingest(self, caller: str, events: list[Any]) -> dict[str, Any]:
        if EXCLUDED_PRODUCTS.match(caller):
            raise PlatformError(403, "TenantNotAuthorized", "military and defense products are excluded")
        self.limits.admit(caller, len(events))
        accepted = duplicates = 0
        rejected = []
        for e in events:
            eid = str(e.get("eventId")) if isinstance(e, Mapping) else ""
            try:
                if not isinstance(e, Mapping):
                    raise _bad("event must be an object")
                doc, eid = self._check(caller, e)
            except PlatformError as err:
                rejected.append({"eventId": eid, "reason": err.message})
                continue
            if self.index.create(eid, doc):
                accepted += 1
            else:
                duplicates += 1
        self.limits.record(caller, accepted)
        return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


# --------------------------------------------------------------------------- search


class Searcher:
    def __init__(self, index: EventIndex) -> None:
        self.index = index

    @staticmethod
    def build(caller: str, q: Mapping[str, Any]) -> dict[str, Any]:
        tenant = q.get("tenant")
        if not isinstance(tenant, str) or not tenant:
            raise _bad("tenant is required")
        if q.get("product") not in (None, caller):
            raise PlatformError(403, "TenantNotAuthorized", "a product can only search its own events")
        start, end = _parse_time(q.get("from"), "from"), _parse_time(q.get("to"), "to")
        if end < start:
            raise _bad("to is before from")
        size = q.get("pageSize") or 50
        if not isinstance(size, int) or not 1 <= size <= 200:
            raise _bad("pageSize must be 1 to 200")
        filters: list[dict[str, Any]] = [
            {"term": {"product": caller}},
            {"term": {"tenant": tenant}},
            {"range": {"occurredAt": {"gte": _iso(start), "lte": _iso(end)}}},
        ]
        for key in ("eventType", "objectType", "objectId"):
            if q.get(key):
                filters.append({"term": {key: str(q[key])}})
        body: dict[str, Any] = {
            "size": size,
            "query": {"bool": {"filter": filters}},
            "sort": [{"occurredAt": "desc"}, {"eventId": "desc"}],
            "_source": ["eventId", "product", "eventType", "occurredAt", "objectType", "objectId", "payload"],
        }
        if q.get("text"):
            body["query"]["bool"]["must"] = [{"match": {"text": str(q["text"])}}]
        if q.get("pageToken"):
            try:
                after = json.loads(base64.urlsafe_b64decode(str(q["pageToken"]).encode()))
                assert isinstance(after, list) and len(after) == 2
            except Exception as e:  # noqa: BLE001
                raise _bad("pageToken is not valid") from e
            body["search_after"] = after
        return body

    def search(self, caller: str, q: Mapping[str, Any]) -> dict[str, Any]:
        body = self.build(caller, q)
        out = self.index.search(body)
        raw = out.get("hits", {}).get("hits", [])
        hits = []
        for h in raw:
            s = h["_source"]
            hits.append({k: s.get(k) for k in ("eventId", "product", "eventType", "occurredAt", "objectType", "objectId", "payload")})
        token = None
        if len(raw) == body["size"] and raw[-1].get("sort"):
            token = base64.urlsafe_b64encode(json.dumps(raw[-1]["sort"]).encode()).decode()
        return {"hits": hits, "nextPageToken": token}


# --------------------------------------------------------------------------- erasure


class Eraser:
    """Right to erasure (GDPR Art. 17). Events store only a keyed pseudonym of the Cumulus ID,
    so the raw CID is pseudonymized the same way as at collection and matched on that.

    A product erases its own events about a person. The pipeline token (``product=None``)
    erases them from every product, for when a person deletes their Cumulus ID.
    """

    def __init__(self, redactor: Redactor, index: EventIndex) -> None:
        self.redactor, self.index = redactor, index

    def erase(self, product: str | None, cid: Any) -> dict[str, int]:
        if not isinstance(cid, str) or not cid.strip():
            raise _bad("cid is required")
        pseudonym = self.redactor.pseudonym("cid", cid.strip(), Destination.ANALYTICS)
        return {"deleted": self.index.erase(pseudonym, product)}
