"""Superset guest tokens for embedded dashboards (embed.GuestTokens)."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from cumulus_privacy.dp import PrivacyBudget
from cumulus_privacy.embed import GuestTokens, parse_embed_dashboards, sign_hs256, verify_hs256
from cumulus_privacy.platform import PlatformError
from cumulus_privacy.server import Gateway, make_handler, parse_product_tokens

PLATFORM = yaml.safe_load((Path(__file__).parents[2] / "conjure" / "platform.yml").read_text("utf-8"))
OBJECTS = PLATFORM["types"]["definitions"]["objects"]
SECRET = "k" * 48
DASH = "3f6c2a8e-1b7d-4c55-9a0e-2d4f6b8c1e90"
MAIL_DASH = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"


@pytest.fixture()
def tokens(redactor):
    dashboards = parse_embed_dashboards(f"spectre={DASH}; cumulus-mail={MAIL_DASH}")
    return GuestTokens(SECRET, dashboards, redactor, clock=lambda: 1_800_000_000)


def test_token_is_scoped_to_product_tenant_and_dashboard(tokens, redactor):
    out = tokens.mint("spectre", DASH.upper(), {"tenant": "acme", "cid": "cid_person0001"})
    assert set(out) == set(OBJECTS["GuestTokenResponse"]["fields"])
    claims = verify_hs256(out["token"], SECRET)
    assert claims["type"] == "guest" and claims["aud"] == "superset"
    assert claims["exp"] - claims["iat"] == 300 and out["expiresAt"] == "2027-01-15T08:05:00Z"
    assert claims["resources"] == [{"type": "dashboard", "id": DASH}]
    assert claims["rls_rules"] == [{"clause": "product = 'spectre' AND tenant = 'acme'"}]
    # The viewer is named by the analytics pseudonym, the same one stored with their events.
    assert "cid_person0001" not in out["token"] and "cid_person0001" not in json.dumps(claims)
    from cumulus_privacy.redaction import Destination

    assert claims["user"]["username"] == "spectre:" + redactor.pseudonym("cid", "cid_person0001", Destination.ANALYTICS)


def test_superset_can_decode_it(redactor):
    jwt = pytest.importorskip("jwt")  # PyJWT, which Superset uses to check guest tokens
    live = GuestTokens(SECRET, parse_embed_dashboards(f"spectre={DASH}"), redactor)  # real clock
    out = live.mint("spectre", DASH, {"tenant": "acme", "cid": "cid_person0001"})
    claims = jwt.decode(out["token"], SECRET, algorithms=["HS256"], audience="superset")
    assert claims["type"] == "guest"
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(out["token"], "x" * 48, algorithms=["HS256"], audience="superset")
    with pytest.raises(jwt.InvalidAudienceError):
        jwt.decode(out["token"], SECRET, algorithms=["HS256"], audience="another-superset")


def test_products_only_get_their_own_dashboards(tokens):
    for caller, dash in (("spectre", MAIL_DASH), ("fabric", DASH)):
        with pytest.raises(PlatformError) as e:
            tokens.mint(caller, dash, {"tenant": "acme", "cid": "c"})
        assert e.value.name == "DashboardNotFound" and e.value.status == 404
    with pytest.raises(PlatformError) as e:
        tokens.mint("aether", DASH, {"tenant": "acme", "cid": "c"})
    assert e.value.name == "TenantNotAuthorized"


@pytest.mark.parametrize(
    "dash, body, message",
    [
        ("not-a-uuid", {"tenant": "acme", "cid": "c"}, "UUID"),
        (DASH, {"tenant": "acme' OR '1'='1", "cid": "c"}, "tenant"),
        (DASH, {"tenant": "Acme", "cid": "c"}, "tenant"),
        (DASH, {"tenant": "", "cid": "c"}, "tenant"),
        (DASH, {"cid": "c"}, "tenant"),
        (DASH, {"tenant": "acme"}, "cid"),
        (DASH, {"tenant": "acme", "cid": "  "}, "cid"),
    ],
)
def test_validation(tokens, dash, body, message):
    with pytest.raises(PlatformError) as e:
        tokens.mint("spectre", dash, body)
    assert e.value.name == "InvalidArgument" and message in e.value.message


def test_configuration_is_checked(redactor):
    assert parse_embed_dashboards("") == {}
    assert parse_embed_dashboards(f"spectre={DASH},{MAIL_DASH}")["spectre"] == {DASH, MAIL_DASH}
    for bad in ("spectre", "spectre=nope", f"Spectre!={DASH}", f"aether={DASH}", f"infinitum-defense-x={DASH}"):
        with pytest.raises(ValueError):
            parse_embed_dashboards(bad)
    with pytest.raises(ValueError):
        GuestTokens("short", {}, redactor)
    with pytest.raises(ValueError):
        GuestTokens(SECRET, {}, redactor, ttl_seconds=86400)


def test_signature_check():
    t = sign_hs256({"a": 1}, SECRET)
    assert verify_hs256(t, SECRET) == {"a": 1}
    head, body, sig = t.split(".")
    with pytest.raises(ValueError):
        verify_hs256(f"{head}.{body}.{sig[:-2]}AA", SECRET)


def test_guest_token_over_http(tokens, redactor, tmp_path):
    spectre, mail = "s" * 40, "m" * 40
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40, None, None, None,
                 parse_product_tokens(f"spectre={spectre};cumulus-mail={mail}"), None, tokens)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/api/v1/embed/dashboards"

    def call(dash, body, tok):
        r = urllib.request.Request(f"{base}/{dash}/guest-token", method="POST", data=json.dumps(body).encode(),
                                   headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        status, out = call(DASH, {"tenant": "acme", "cid": "cid_person0001"}, spectre)
        assert status == 200 and verify_hs256(out["token"], SECRET)["resources"][0]["id"] == DASH
        status, err = call(DASH, {"tenant": "acme", "cid": "cid_person0001"}, mail)
        assert status == 404 and err["errorName"] == "DataPlatform:DashboardNotFound"
        assert err["parameters"]["dashboardId"] == DASH
        assert call(DASH, {"tenant": "acme", "cid": "c"}, "g" * 40)[0] == 401
    finally:
        httpd.shutdown()


def test_not_configured_without_a_secret(redactor, tmp_path):
    gw = Gateway(redactor, PrivacyBudget(tmp_path / "b.json", 1), "g" * 40)
    with pytest.raises(Exception) as e:
        gw.guest_token({"tenant": "acme", "cid": "c"}, caller="spectre", dashboardId=DASH)
    assert getattr(e.value, "name", "") == "NotConfigured"
