# © Infinitum Corporation®. All rights reserved.
"""Superset guest tokens for dashboards embedded in Cumulus products.

The product backend signs its user in with Cumulus ID as usual, then asks the gateway (with
its product token) for a guest token for one dashboard, one tenant and that person's CID. The
gateway:

* allows only dashboards registered to that product (``PLATFORM_EMBED_DASHBOARDS``);
* pins the token with a row-level-security clause to ``product`` and ``tenant``, so a viewer
  sees only their own tenant's rows in every chart of the dashboard;
* names the guest user by the CID's analytics pseudonym, never the raw CID or an email;
* signs the token itself with the secret Superset verifies guest tokens with
  (``SUPERSET_GUEST_TOKEN_SECRET``, HS256), so no Superset service account or password exists.

The claims match what Superset's security manager issues and checks: ``user``, ``resources``,
``rls_rules``, ``iat``, ``exp``, ``aud`` and ``type: guest``.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from .platform import EXCLUDED_PRODUCTS, PlatformError, _bad
from .redaction import Destination

TENANT = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")
PRODUCT = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MIN_SECRET = 32


def parse_embed_dashboards(raw: str) -> dict[str, set[str]]:
    """``spectre=<uuid>,<uuid>;fabric=<uuid>`` -> {product: {embedded dashboard uuids}}."""
    out: dict[str, set[str]] = {}
    for part in filter(None, (p.strip() for p in raw.split(";"))):
        product, sep, ids = part.partition("=")
        product = product.strip()
        if not sep or not PRODUCT.match(product):
            raise ValueError("PLATFORM_EMBED_DASHBOARDS entries look like product=<uuid>,<uuid>")
        if EXCLUDED_PRODUCTS.match(product):
            raise ValueError(f"{product} is excluded from the data platform")
        for d in filter(None, (i.strip() for i in ids.split(","))):
            out.setdefault(product, set()).add(str(uuid.UUID(d)))
    return out


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign_hs256(claims: Mapping[str, Any], secret: str) -> str:
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def verify_hs256(token: str, secret: str) -> dict[str, Any]:
    """For tests and diagnostics: checks the signature and returns the claims."""
    head, body, sig = token.split(".")
    want = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(_b64(want), sig):
        raise ValueError("bad signature")
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


class GuestTokens:
    def __init__(
        self,
        secret: str,
        dashboards: Mapping[str, set[str]],
        redactor: Any,
        audience: str = "superset",
        ttl_seconds: int = 300,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if len(secret) < MIN_SECRET:
            raise ValueError(f"SUPERSET_GUEST_TOKEN_SECRET must be at least {MIN_SECRET} characters")
        if not 30 <= ttl_seconds <= 3600:
            raise ValueError("guest tokens live between 30 seconds and 1 hour")
        self.secret, self.dashboards, self.redactor = secret, dashboards, redactor
        self.audience, self.ttl, self.clock = audience, ttl_seconds, clock

    def mint(self, caller: str, dashboard_id: str, req: Mapping[str, Any]) -> dict[str, Any]:
        if EXCLUDED_PRODUCTS.match(caller):
            raise PlatformError(403, "TenantNotAuthorized", "military and defense products are excluded")
        try:
            dashboard = str(uuid.UUID(dashboard_id))
        except ValueError as e:
            raise _bad("dashboardId must be the embedded dashboard's UUID") from e
        if dashboard not in self.dashboards.get(caller, set()):
            # Another product's dashboard looks the same as a missing one.
            raise PlatformError(404, "DashboardNotFound", "no such embedded dashboard", {"dashboardId": dashboard})
        tenant = req.get("tenant")
        if not isinstance(tenant, str) or not TENANT.match(tenant):
            raise _bad("tenant must be lower-case letters, digits, '.', '_' or '-' (at most 63)")
        cid = req.get("cid")
        if not isinstance(cid, str) or not cid.strip():
            raise _bad("cid is required: the Cumulus ID of the signed-in viewer")

        viewer = self.redactor.pseudonym("cid", cid.strip(), Destination.ANALYTICS)
        now = int(self.clock())
        claims = {
            "user": {"username": f"{caller}:{viewer}", "first_name": "", "last_name": ""},
            "resources": [{"type": "dashboard", "id": dashboard}],
            # Both values are validated above, so the clause cannot be injected into.
            "rls_rules": [{"clause": f"product = '{caller}' AND tenant = '{tenant}'"}],
            "iat": now,
            "exp": now + self.ttl,
            "aud": self.audience,
            "type": "guest",
        }
        expires = datetime.fromtimestamp(now + self.ttl, tz=timezone.utc)
        return {"token": sign_hs256(claims, self.secret), "expiresAt": expires.isoformat().replace("+00:00", "Z")}
