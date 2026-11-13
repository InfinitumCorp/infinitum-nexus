# © Infinitum Corporation®. All rights reserved.
"""HTTP server for the data platform. The wire format is defined in
infra/data-platform/conjure/privacy.yml and platform.yml (Conjure).

Callers are services, not people. Pipelines call the privacy endpoints with
PRIVACY_GATEWAY_TOKEN; each product calls collection, catalog and search with its own token
(PLATFORM_PRODUCT_TOKENS="spectre=<token>;cumulus-mail=<token>"), which also fixes which
product's data it can touch. People never sign in here; they sign in to the products with
Cumulus ID, and the products call the platform.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .dp import BudgetExceeded, PrivacyBudget, release
from .ingest_quality import MemoryQualityLog
from .embed import GuestTokens, parse_embed_dashboards
from .pipeline import prepare_export
from .platform import Catalog, Collector, DataHubSink, Eraser, IngestLimits, OpenSearchIndex, PlatformError, Searcher
from .quality import run_suite
from .redaction import Redactor

MAX_BODY = 10 * 1024 * 1024


# Conjure error code for each HTTP status we return.
CONJURE_CODES = {
    HTTPStatus.BAD_REQUEST: "INVALID_ARGUMENT",
    HTTPStatus.UNAUTHORIZED: "UNAUTHORIZED",
    HTTPStatus.FORBIDDEN: "PERMISSION_DENIED",
    HTTPStatus.NOT_FOUND: "NOT_FOUND",
    HTTPStatus.CONFLICT: "CONFLICT",
    HTTPStatus.REQUEST_ENTITY_TOO_LARGE: "REQUEST_ENTITY_TOO_LARGE",
    HTTPStatus.TOO_MANY_REQUESTS: "CUSTOM_CLIENT",
    HTTPStatus.INTERNAL_SERVER_ERROR: "INTERNAL",
    HTTPStatus.SERVICE_UNAVAILABLE: "INTERNAL",
}


class ApiError(Exception):
    """`name` is the Conjure error name without namespace, e.g. PrivacyBudgetExceeded."""

    def __init__(self, status: HTTPStatus, name: str, message: str, namespace: str = "Privacy",
                 args: dict[str, Any] | None = None, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status, self.name, self.message = status, name, message
        self.namespace, self.safe_args, self.retry_after = namespace, args or {}, retry_after


@dataclass(frozen=True)
class Route:
    method: str
    template: str  # as written in Conjure, e.g. /api/v1/catalog/datasets/{name}
    handler: Callable[..., Any]
    auth: str  # "gateway" (PRIVACY_GATEWAY_TOKEN) or "product" (a product's token)

    @property
    def pattern(self) -> re.Pattern[str]:
        parts = re.split(r"(\{\w+\})", self.template)
        rx = "".join(f"(?P<{p[1:-1]}>[^/]+)" if p.startswith("{") else re.escape(p) for p in parts)
        return re.compile(f"^{rx}$")


def parse_product_tokens(raw: str) -> dict[str, str]:
    """'spectre=tok;mail=tok2' -> {token: product}. Tokens must be 32+ characters."""
    out: dict[str, str] = {}
    for part in filter(None, (p.strip() for p in raw.split(";"))):
        product, _, token = part.partition("=")
        if not product or len(token) < 32:
            raise ValueError("PLATFORM_PRODUCT_TOKENS entries are product=<32+ char token>")
        out[token] = product
    return out


def _require(body: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> Any:
    v = body.get(key)
    if not isinstance(v, kind):
        raise ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", f"{key} is required")
    return v


class Gateway:
    def __init__(
        self,
        redactor: Redactor,
        budget: PrivacyBudget,
        token: str,
        catalog: Catalog | None = None,
        collector: Collector | None = None,
        searcher: Searcher | None = None,
        product_tokens: dict[str, str] | None = None,
        eraser: Eraser | None = None,
        guest_tokens: GuestTokens | None = None,
    ) -> None:
        if len(token) < 32:
            raise ValueError("PRIVACY_GATEWAY_TOKEN must be at least 32 characters")
        self.redactor, self.budget, self.token = redactor, budget, token
        self.catalog, self.collector, self.searcher = catalog, collector, searcher
        self.product_tokens = product_tokens or {}
        self.eraser = eraser
        self.guest_tokens = guest_tokens
        self.routes = [
            Route("POST", "/api/v1/redact", self.redact, "gateway"),
            Route("POST", "/api/v1/exports/prepare", self.prepare, "gateway"),
            Route("POST", "/api/v1/quality/verify", self.verify, "gateway"),
            Route("POST", "/api/v1/releases/dp", self.dp_release, "gateway"),
            Route("POST", "/api/v1/collect/events", self.ingest, "product"),
            Route("PUT", "/api/v1/catalog/datasets/{name}", self.register_dataset, "product"),
            Route("GET", "/api/v1/catalog/datasets/{name}", self.get_dataset, "product"),
            Route("POST", "/api/v1/search/events", self.search, "product"),
            Route("POST", "/api/v1/erasure/subjects", self.erase, "product"),
            Route("GET", "/api/v1/quality/datasets/{name}/runs", self.quality_runs, "product"),
            Route("POST", "/api/v1/erasure/subjects/all-products", self.erase_everywhere, "gateway"),
            Route("POST", "/api/v1/embed/dashboards/{dashboardId}/guest-token", self.guest_token, "product"),
        ]

    def match(self, method: str, path: str) -> tuple[Route, dict[str, str]] | None:
        for r in self.routes:
            if r.method == method:
                m = r.pattern.match(path)
                if m:
                    return r, m.groupdict()
        return None

    def caller(self, route: Route, header: str | None) -> str | None:
        """The authenticated caller: "gateway" or a product name. None when unauthorized."""
        if not header or not header.startswith("Bearer "):
            return None
        presented = header[7:].encode()
        if route.auth == "gateway":
            return "gateway" if hmac.compare_digest(presented, self.token.encode()) else None
        found = None
        for token, product in self.product_tokens.items():  # compare against every token
            if hmac.compare_digest(presented, token.encode()):
                found = product
        return found

    def _platform(self, part: Any) -> Any:
        if part is None:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "NotConfigured", "this service is not configured", "DataPlatform")
        return part

    def ingest(self, b: dict[str, Any], caller: str = "", **_: str) -> Any:
        return self._platform(self.collector).ingest(caller, _require(b, "events", list))

    def register_dataset(self, b: dict[str, Any], caller: str = "", name: str = "") -> Any:
        return self._platform(self.catalog).register(caller, name, b)

    def get_dataset(self, b: dict[str, Any], caller: str = "", name: str = "") -> Any:
        return self._platform(self.catalog).read(caller, name)

    def guest_token(self, b: dict[str, Any], caller: str = "", dashboardId: str = "") -> Any:  # noqa: N803
        return self._platform(self.guest_tokens).mint(caller, dashboardId, b)

    def search(self, b: dict[str, Any], caller: str = "", **_: str) -> Any:
        return self._platform(self.searcher).search(caller, b)

    def quality_runs(self, b: dict[str, Any], caller: str = "", name: str = "") -> Any:
        return self._platform(self.collector).quality_runs(caller, name)

    def erase(self, b: dict[str, Any], caller: str = "", **_: str) -> Any:
        return self._platform(self.eraser).erase(caller, b.get("cid"))

    def erase_everywhere(self, b: dict[str, Any], **_: str) -> Any:
        return self._platform(self.eraser).erase(None, b.get("cid"))

    def health(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": "ok"}
        if self.collector is not None:
            out["storage"] = self.collector.limits.storage_state()
        return out

    def redact(self, b: dict[str, Any], **_: str) -> Any:
        r = self.redactor.redact_records(
            _require(b, "records", list), _require(b, "destination", str), b.get("fieldRules") or {}
        )
        return {"records": r.records, "rejected": r.rejected, "findings": r.findings}

    def prepare(self, b: dict[str, Any], **_: str) -> Any:
        return prepare_export(
            self.redactor,
            _require(b, "records", list),
            _require(b, "destination", str),
            b.get("fieldRules") or {},
            b.get("suite"),
            b.get("history") or [],
        ).to_dict()

    def verify(self, b: dict[str, Any], **_: str) -> Any:
        return run_suite(_require(b, "suite", dict), _require(b, "rows", list), b.get("history") or []).to_dict()

    def dp_release(self, b: dict[str, Any], **_: str) -> Any:
        try:
            out = release(
                _require(b, "rows", list),
                dataset=_require(b, "dataset", str),
                metric=_require(b, "metric", str),
                unit_key=_require(b, "unitKey", str),
                group_key=_require(b, "groupKey", str),
                public_groups=_require(b, "publicGroups", list),
                epsilon=float(_require(b, "epsilon", (int, float))),
                budget=self.budget,
                max_partitions=int(b.get("maxPartitions", 1)),
                value_key=b.get("valueKey"),
                lower=float(b.get("lower", 0.0)),
                upper=float(b.get("upper", 1.0)),
                suppress_below=float(b.get("suppressBelow", 0.0)),
            )
        except BudgetExceeded as e:
            raise ApiError(HTTPStatus.CONFLICT, "PrivacyBudgetExceeded", str(e)) from e
        except ImportError as e:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "DpLibraryUnavailable", "Google DP library is not installed") from e
        return out.to_dict()


def make_handler(gw: Gateway) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "cumulus-privacy-gateway"

        def _send(self, status: HTTPStatus, body: Any, retry_after: int | None = None) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            if retry_after:
                self.send_header("Retry-After", str(retry_after))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _error(self, e: ApiError) -> None:
            # Conjure SerializableError shape.
            self._send(
                e.status,
                {
                    "errorCode": CONJURE_CODES.get(e.status, "INTERNAL"),
                    "errorName": f"{e.namespace}:{e.name}",
                    "errorInstanceId": str(uuid.uuid4()),
                    "parameters": {"message": e.message, **e.safe_args},
                },
                e.retry_after,
            )

        def _dispatch(self) -> None:
            try:
                if self.command == "GET" and self.path == "/api/v1/health":
                    self._send(HTTPStatus.OK, gw.health())
                    return
                found = gw.match(self.command, self.path.split("?", 1)[0])
                if found is None:
                    raise ApiError(HTTPStatus.NOT_FOUND, "NotFound", "no such endpoint")
                route, params = found
                caller = gw.caller(route, self.headers.get("Authorization"))
                if caller is None:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "Unauthorized", "service token required")
                body: Any = {}
                if self.command != "GET":
                    length = int(self.headers.get("Content-Length") or 0)
                    if length > MAX_BODY:
                        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "InvalidArgument", "body over 10 MB")
                    if length <= 0:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", "JSON body required")
                    try:
                        body = json.loads(self.rfile.read(length))
                    except json.JSONDecodeError as e:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", "body is not JSON") from e
                    if not isinstance(body, dict):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", "body must be an object")
                self._send(HTTPStatus.OK, route.handler(body, caller=caller, **params))
            except ApiError as e:
                self._error(e)
            except PlatformError as e:
                self._error(ApiError(HTTPStatus(e.status), e.name, e.message, "DataPlatform", e.safe_args, e.retry_after))
            except ValueError as e:
                self._error(ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", str(e)))
            except Exception:  # noqa: BLE001 - never echo internals, which may include record data
                self._error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "Internal", "internal error"))

        do_GET = do_POST = do_PUT = _dispatch  # noqa: N815

        def log_message(self, fmt: str, *args: Any) -> None:
            # Method, path and status only: bodies may contain personal data.
            sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def main() -> None:
    token = os.environ.get("PRIVACY_GATEWAY_TOKEN", "")
    dsn = os.environ.get("DATABASE_URL")  # Supabase pooler, data_platform_gateway role
    epsilon = float(os.environ.get("PRIVACY_TOTAL_EPSILON", "3.0"))
    gms = os.environ.get("DATAHUB_GMS_URL")
    sink = DataHubSink(gms, os.environ.get("DATAHUB_GMS_TOKEN")) if gms else None
    index: Any = None
    if dsn:
        # Free-tier layout: everything in Supabase Postgres (Ireland). No OpenSearch needed.
        from .pgstore import PostgresBudget, PostgresCatalog, PostgresEventIndex, PostgresQualityLog

        budget: Any = PostgresBudget(dsn, epsilon)
        catalog: Any = PostgresCatalog(dsn, sink)
        index = PostgresEventIndex(dsn)
        quality_log: Any = PostgresQualityLog(dsn)
    else:
        budget = PrivacyBudget(os.environ.get("PRIVACY_BUDGET_FILE", "/var/lib/privacy-gateway/budget.json"), epsilon)
        catalog = Catalog(os.environ.get("PLATFORM_CATALOG_FILE", "/var/lib/privacy-gateway/catalog.json"), sink)
        index = OpenSearchIndex(
            os.environ.get("OPENSEARCH_URL", "http://localhost:9200"),
            refresh=os.environ.get("OPENSEARCH_REFRESH_ON_WRITE") == "1",
        )
        quality_log = MemoryQualityLog()
    redactor = Redactor()
    collector = searcher = None
    products = parse_product_tokens(os.environ.get("PLATFORM_PRODUCT_TOKENS", ""))
    # Free tier: Supabase allows 500 MB per database, so stop taking events at 450 MB by default.
    limit_mb = int(os.environ.get("PLATFORM_STORAGE_LIMIT_MB", "450" if dsn else "0"))
    limits = IngestLimits(
        max_batch=int(os.environ.get("PLATFORM_MAX_BATCH", "1000")),
        daily_quota=int(os.environ.get("PLATFORM_DAILY_EVENT_QUOTA", "0")),
        storage_limit_bytes=limit_mb * 1024 * 1024,
        storage=getattr(index, "storage_bytes", None),
    )
    eraser = Eraser(redactor, index)
    if products:
        collector = Collector(catalog, redactor, index, os.environ.get("PLATFORM_REGION", "EU"), limits, quality_log)
        searcher = Searcher(index)
    else:
        catalog = None
    if dsn:
        threading.Thread(target=_purge_daily, args=(index,), daemon=True).start()
    guest_tokens = None
    guest_secret = os.environ.get("SUPERSET_GUEST_TOKEN_SECRET", "")
    dashboards = parse_embed_dashboards(os.environ.get("PLATFORM_EMBED_DASHBOARDS", ""))
    if products and guest_secret and dashboards:
        guest_tokens = GuestTokens(guest_secret, dashboards, redactor,
                                   audience=os.environ.get("SUPERSET_GUEST_TOKEN_AUDIENCE", "superset"))
    gw = Gateway(redactor, budget, token, catalog, collector, searcher, products, eraser, guest_tokens)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8090"))
    httpd = ThreadingHTTPServer((host, port), make_handler(gw))
    print(f"privacy gateway on http://{host}:{port} ({'postgres' if dsn else 'local files + opensearch'})", file=sys.stderr)
    httpd.serve_forever()


def _purge_daily(index: Any) -> None:
    """Retention: delete events past their dataset's retentionDays, once a day."""
    while True:
        try:
            print(f"retention purge removed {index.purge_expired()} events", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - keep serving; try again tomorrow
            print(f"retention purge failed: {type(e).__name__}", file=sys.stderr)
        time.sleep(24 * 3600)


if __name__ == "__main__":
    main()
