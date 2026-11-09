import assert from "node:assert/strict";
import { test } from "node:test";
import { CndctrConfigError, loadConfig } from "./config.ts";

test("defaults to the Cumulus ID realm and the cndctr audience", () => {
  const config = loadConfig({});
  assert.equal(config.issuer, "https://id.cumuluscloud.app/realms/cumulus");
  assert.equal(config.jwksUri, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs");
  assert.equal(config.authorizationEndpoint, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/auth");
  assert.equal(config.audience, "cndctr");
  assert.equal(config.port, 3011);
  assert.equal(config.bind, "127.0.0.1");
  assert.equal(config.publicOrigin, null);
});

test("builds the issuer from the Cumulus host and realm", () => {
  const config = loadConfig({ CUMULUS_ID_HOST: "id.example.com", CUMULUS_KEYCLOAK_REALM: "cumulus" });
  assert.equal(config.issuer, "https://id.example.com/realms/cumulus");
});

test("rejects a JWKS URI on another origin", () => {
  assert.throws(() => loadConfig({ CNDCTR_JWKS_URI: "https://evil.example/certs" }), CndctrConfigError);
  assert.throws(() => loadConfig({ CNDCTR_OIDC_CLIENT_ID: "has space" }), CndctrConfigError);
  assert.throws(() => loadConfig({ CNDCTR_PUBLIC_ORIGIN: "http://cndctr.app" }), CndctrConfigError);
});
