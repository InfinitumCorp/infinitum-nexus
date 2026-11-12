# © Infinitum Corporation®. All rights reserved.
"""HTTP server for the privacy gateway. The wire format is defined in
infra/data-platform/conjure/cumulus-data-platform.yml (Conjure), base path /api/v1.

Callers are services, not people, so the gateway takes a service bearer token
(PRIVACY_GATEWAY_TOKEN). People never sign in here; they sign in to the products with
Cumulus ID, and the products call the gateway.
"""
from __future__ import annotations

import hmac
import json
import os
import sys
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .dp import BudgetExceeded, PrivacyBudget, release
from .pipeline import prepare_export
from .quality import run_suite
from .redaction import Redactor

MAX_BODY = 10 * 1024 * 1024


# Conjure error code for each HTTP status we return.
CONJURE_CODES = {
    HTTPStatus.BAD_REQUEST: "INVALID_ARGUMENT",
    HTTPStatus.UNAUTHORIZED: "UNAUTHORIZED",
    HTTPStatus.NOT_FOUND: "NOT_FOUND",
    HTTPStatus.CONFLICT: "CONFLICT",
    HTTPStatus.REQUEST_ENTITY_TOO_LARGE: "REQUEST_ENTITY_TOO_LARGE",
    HTTPStatus.INTERNAL_SERVER_ERROR: "INTERNAL",
    HTTPStatus.SERVICE_UNAVAILABLE: "INTERNAL",
}


class ApiError(Exception):
    """`name` is the Conjure error name without namespace, e.g. PrivacyBudgetExceeded."""

    def __init__(self, status: HTTPStatus, name: str, message: str) -> None:
        super().__init__(message)
        self.status, self.name, self.message = status, name, message


def _require(body: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> Any:
    v = body.get(key)
    if not isinstance(v, kind):
        raise ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", f"{key} is required")
    return v


class Gateway:
    def __init__(self, redactor: Redactor, budget: PrivacyBudget, token: str) -> None:
        if len(token) < 32:
            raise ValueError("PRIVACY_GATEWAY_TOKEN must be at least 32 characters")
        self.redactor, self.budget, self.token = redactor, budget, token
        self.routes: dict[str, Callable[[dict[str, Any]], Any]] = {
            "/api/v1/redact": self.redact,
            "/api/v1/exports/prepare": self.prepare,
            "/api/v1/quality/verify": self.verify,
            "/api/v1/releases/dp": self.dp_release,
        }

    def authorized(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode(), self.token.encode())

    def redact(self, b: dict[str, Any]) -> Any:
        r = self.redactor.redact_records(
            _require(b, "records", list), _require(b, "destination", str), b.get("fieldRules") or {}
        )
        return {"records": r.records, "rejected": r.rejected, "findings": r.findings}

    def prepare(self, b: dict[str, Any]) -> Any:
        return prepare_export(
            self.redactor,
            _require(b, "records", list),
            _require(b, "destination", str),
            b.get("fieldRules") or {},
            b.get("suite"),
            b.get("history") or [],
        ).to_dict()

    def verify(self, b: dict[str, Any]) -> Any:
        return run_suite(_require(b, "suite", dict), _require(b, "rows", list), b.get("history") or []).to_dict()

    def dp_release(self, b: dict[str, Any]) -> Any:
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

        def _send(self, status: HTTPStatus, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
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
                    "errorName": f"Privacy:{e.name}",
                    "errorInstanceId": str(uuid.uuid4()),
                    "parameters": {"message": e.message},
                },
            )

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/api/v1/health":
                self._send(HTTPStatus.OK, {"status": "ok"})
            else:
                self._error(ApiError(HTTPStatus.NOT_FOUND, "NotFound", "no such endpoint"))

        def do_POST(self) -> None:  # noqa: N802
            try:
                route = gw.routes.get(self.path)
                if route is None:
                    raise ApiError(HTTPStatus.NOT_FOUND, "NotFound", "no such endpoint")
                if not gw.authorized(self.headers.get("Authorization")):
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "Unauthorized", "service token required")
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
                self._send(HTTPStatus.OK, route(body))
            except ApiError as e:
                self._error(e)
            except ValueError as e:
                self._error(ApiError(HTTPStatus.BAD_REQUEST, "InvalidArgument", str(e)))
            except Exception:  # noqa: BLE001 - never echo internals, which may include record data
                self._error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "Internal", "internal error"))

        def log_message(self, fmt: str, *args: Any) -> None:
            # Method, path and status only: bodies may contain personal data.
            sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def main() -> None:
    token = os.environ.get("PRIVACY_GATEWAY_TOKEN", "")
    budget = PrivacyBudget(
        os.environ.get("PRIVACY_BUDGET_FILE", "/var/lib/privacy-gateway/budget.json"),
        float(os.environ.get("PRIVACY_TOTAL_EPSILON", "3.0")),
    )
    gw = Gateway(Redactor(), budget, token)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8090"))
    httpd = ThreadingHTTPServer((host, port), make_handler(gw))
    print(f"privacy gateway on http://{host}:{port}", file=sys.stderr)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
