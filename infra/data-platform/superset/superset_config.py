# © Infinitum Corporation®. All rights reserved.
"""Superset for Cumulus: people sign in with Cumulus ID (OIDC), never a Superset password.

Dashboards are embedded in Cumulus products with the Superset embedded SDK and guest tokens
minted by the product backend, so viewers inside a product never see a Superset login.
"""
import os

from flask_appbuilder.security.manager import AUTH_OAUTH
from superset.security import SupersetSecurityManager

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = os.environ["SUPERSET_DATABASE_URI"]

ISSUER = os.environ.get("CUMULUS_ID_ISSUER", "https://id.cumuluscloud.app/realms/cumulus").rstrip("/")

AUTH_TYPE = AUTH_OAUTH
AUTH_USER_REGISTRATION = True  # first Cumulus ID sign-in creates the Superset user
AUTH_USER_REGISTRATION_ROLE = "Gamma"
# Map Cumulus ID groups to Superset roles. Admin only through the group, never by default.
AUTH_ROLES_MAPPING = {"data-platform-admins": ["Admin"], "data-analysts": ["Alpha"]}
AUTH_ROLES_SYNC_AT_LOGIN = True

OAUTH_PROVIDERS = [
    {
        "name": "cumulus",
        "icon": "fa-cloud",
        "token_key": "access_token",
        "remote_app": {
            "client_id": os.environ.get("CUMULUS_ID_CLIENT_ID", ""),
            "client_secret": os.environ.get("CUMULUS_ID_CLIENT_SECRET", ""),
            "server_metadata_url": f"{ISSUER}/.well-known/openid-configuration",
            "client_kwargs": {"scope": "openid email profile", "code_challenge_method": "S256"},
        },
    }
]


class CumulusSecurityManager(SupersetSecurityManager):
    def oauth_user_info(self, provider, response=None):
        if provider != "cumulus":
            return super().oauth_user_info(provider, response)
        me = self.appbuilder.sm.oauth_remotes[provider].userinfo()
        return {
            # The CID is the stable identity. Accounts are never joined by email.
            "username": me["sub"],
            "email": me.get("email", ""),
            "first_name": me.get("given_name", ""),
            "last_name": me.get("family_name", ""),
            "role_keys": me.get("groups", []),
        }


CUSTOM_SECURITY_MANAGER = CumulusSecurityManager

# "Create a Cumulus ID" for people who do not have one yet; the Cumulus ID sign-in page
# offers it too, and returns them here signed in.
CUMULUS_ID_SIGNUP_URL = os.environ.get("CUMULUS_ID_SIGNUP_URL", "https://id.cumuluscloud.app/signup")

# Embedded analytics inside Cumulus products.
FEATURE_FLAGS = {"EMBEDDED_SUPERSET": True, "DASHBOARD_RBAC": True}
GUEST_ROLE_NAME = "Public"
GUEST_TOKEN_JWT_EXP_SECONDS = 300
_embed = os.environ.get("CUMULUS_EMBED_ORIGINS", "").split()
TALISMAN_ENABLED = True
TALISMAN_CONFIG = {
    "content_security_policy": {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'", "'strict-dynamic'"],
        "frame-ancestors": ["'self'", *_embed],
    },
    "content_security_policy_nonce_in": ["script-src"],
    "force_https": False,
}
SESSION_COOKIE_SAMESITE = "None" if _embed else "Lax"
SESSION_COOKIE_SECURE = bool(_embed)
WTF_CSRF_ENABLED = True

# No telemetry from this instance.
SCARF_ANALYTICS = False
