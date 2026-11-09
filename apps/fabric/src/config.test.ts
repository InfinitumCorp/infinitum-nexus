import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FABRIC_JWT_ISSUER, FabricConfigError, loadConfig } from "./config.ts";

test("issuer defaults to the Cumulus ID realm", () => {
  const config = loadConfig({});
  assert.equal(config.issuer, DEFAULT_FABRIC_JWT_ISSUER);
  assert.equal(config.issuer, "https://id.cumuluscloud.app/realms/cumulus");
  assert.equal(config.jwksUri, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs");
  assert.equal(config.audience, "fabric");
  assert.equal(config.rootDomain, "infinitumfabric.app");
  assert.equal(config.tokenEndpoint, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/token");
});

test("Cumulus host and realm build the issuer, and FABRIC_JWT_ISSUER wins", () => {
  const derived = loadConfig({ CUMULUS_ID_HOST: "id.example.test", CUMULUS_KEYCLOAK_REALM: "staff" });
  assert.equal(derived.issuer, "https://id.example.test/realms/staff");
  const explicit = loadConfig({
    CUMULUS_ID_HOST: "id.example.test",
    FABRIC_JWT_ISSUER: "https://login.example.test/realms/cumulus",
  });
  assert.equal(explicit.issuer, "https://login.example.test/realms/cumulus");
});

test("rejects wildcard, off-origin keys, and postgres URLs", () => {
  assert.throws(() => loadConfig({ FABRIC_JWT_ISSUER: "https://*.cumuluscloud.app/realms/cumulus" }), FabricConfigError);
  assert.throws(() => loadConfig({ FABRIC_JWKS_URI: "https://evil.example/certs" }), FabricConfigError);
  assert.throws(() => loadConfig({ FABRIC_DATABASE_URL: "postgres://localhost/fabric" }), FabricConfigError);
  assert.throws(() => loadConfig({ FABRIC_PUBLIC_ORIGIN: "https://infinitumfabric.app/app" }), FabricConfigError);
  assert.throws(() => loadConfig({ FABRIC_PUBLIC_ORIGIN: "*" }), FabricConfigError);
});
