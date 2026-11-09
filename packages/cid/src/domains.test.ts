import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CUMULUS_DOMAIN_DEFAULTS,
  assertExactOrigin,
  cidIssuerMetadata,
  cumulusCorsHeaders,
  cumulusDomains,
  exactCorsOrigin,
  PRODUCT_HOST_DEFAULTS,
} from "./domains.ts";
import { APP_ORIGINS, cidRedirectUri } from "./service.ts";

const defaults = {
  CUMULUS_ROOT_DOMAIN: undefined,
  CUMULUS_ID_HOST: undefined,
  CUMULUS_KEYCLOAK_REALM: undefined,
  CUMULUS_CLOUD_HOST: undefined,
  CUMULUS_MAIL_HOST: undefined,
  METATRON_HOST: undefined,
};

describe("Cumulus domain", () => {
  it("uses cumuluscloud.app and the id, cloud and mail hosts by default", () => {
    const domains = cumulusDomains(defaults);
    assert.equal(domains.rootDomain, CUMULUS_DOMAIN_DEFAULTS.rootDomain);
    assert.equal(domains.mailDomain, "cumuluscloud.app");
    assert.equal(domains.idHost, "id.cumuluscloud.app");
    assert.equal(domains.cloudHost, "cloud.cumuluscloud.app");
    assert.equal(domains.mailHost, "mail.cumuluscloud.app");
    assert.equal(domains.realm, "cumulus");
    assert.deepEqual(cidIssuerMetadata(domains), {
      issuer: "https://id.cumuluscloud.app/realms/cumulus",
      jwks_uri: "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs",
      id_host: "id.cumuluscloud.app",
    });
    assert.deepEqual(domains.corsOrigins, [
      "https://id.cumuluscloud.app",
      "https://cloud.cumuluscloud.app",
      "https://mail.cumuluscloud.app",
      "https://mttrn.app",
    ]);
    assert.equal(domains.corsOrigins.includes("*"), false);
  });

  it("allows METATRON at mttrn.app and rejects a wildcard override", () => {
    const domains = cumulusDomains(defaults);
    assert.equal(PRODUCT_HOST_DEFAULTS.metatron, "mttrn.app");
    assert.equal(domains.productOrigins.metatron, "https://mttrn.app");
    assert.equal(exactCorsOrigin("https://mttrn.app", domains.corsOrigins), "https://mttrn.app");
    assert.equal(exactCorsOrigin("https://evil.mttrn.app", domains.corsOrigins), null);
    assert.equal(cumulusDomains({ ...defaults, METATRON_HOST: "staging.mttrn.app" }).productOrigins.metatron, "https://staging.mttrn.app");
    for (const bad of ["*", "*.mttrn.app", "https://mttrn.app", "mttrn.app/path"]) {
      assert.throws(() => cumulusDomains({ ...defaults, METATRON_HOST: bad }), /exact hostname/, bad);
    }
    assert.equal(APP_ORIGINS.metatron, "https://mttrn.app");
    assert.equal(cidRedirectUri("metatron", "google"), "https://mttrn.app/api/auth/oauth/google/callback");
    assert.throws(() => cidRedirectUri("odin", "google"), /no registered web origin/);
  });

  it("derives hosts from the root domain and accepts an explicit host under that root", () => {
    const derived = cumulusDomains({ ...defaults, CUMULUS_ROOT_DOMAIN: "Example.Test" });
    assert.equal(derived.idHost, "id.example.test");
    assert.equal(derived.issuer, "https://id.example.test/realms/cumulus");
    assert.equal(derived.jwksUri, "https://id.example.test/realms/cumulus/protocol/openid-connect/certs");
    assert.equal(derived.mailDomain, "example.test");
    const explicit = cumulusDomains({
      ...defaults,
      CUMULUS_ROOT_DOMAIN: "cumuluscloud.app",
      CUMULUS_ID_HOST: "login.cumuluscloud.app",
      CUMULUS_KEYCLOAK_REALM: "Staff",
    });
    assert.equal(explicit.realm, "staff");
    assert.equal(explicit.issuer, "https://login.cumuluscloud.app/realms/staff");
    assert.equal(explicit.jwksUri, "https://login.cumuluscloud.app/realms/staff/protocol/openid-connect/certs");
    assert.equal(explicit.corsOrigins[0], "https://login.cumuluscloud.app");
  });

  it("rejects wildcards, URLs and hosts outside the root domain", () => {
    for (const bad of ["*", "*.cumuluscloud.app", "https://id.cumuluscloud.app", "id.cumuluscloud.app/jwks", "id.cumuluscloud.app:443", ""]) {
      assert.throws(() => cumulusDomains({ ...defaults, CUMULUS_ID_HOST: bad }), /exact hostname/, bad);
    }
    assert.throws(
      () => cumulusDomains({ ...defaults, CUMULUS_ID_HOST: "id.cumuluscloud.app.evil.com" }),
      /subdomains/,
    );
    assert.throws(() => cumulusDomains({ ...defaults, CUMULUS_CLOUD_HOST: "cloud.evil.com" }), /subdomains/);
    for (const bad of ["*", "cumulus/admin", "../cumulus", "cumulus.realm", ""]) {
      assert.throws(() => cumulusDomains({ ...defaults, CUMULUS_KEYCLOAK_REALM: bad }), /realm name/, bad);
    }
  });
});

describe("exact CORS origins", () => {
  const allowed = cumulusDomains(defaults).corsOrigins;

  it("echoes only an allowlisted origin and never a wildcard", () => {
    assert.equal(exactCorsOrigin("https://id.cumuluscloud.app", allowed), "https://id.cumuluscloud.app");
    assert.equal(exactCorsOrigin("https://mail.cumuluscloud.app/", allowed), "https://mail.cumuluscloud.app");
    for (const blocked of [
      "*",
      "https://*.cumuluscloud.app",
      "https://id.cumuluscloud.app.evil.com",
      "https://evil.com",
      "https://notid.cumuluscloud.app",
      "null",
      "https://id.cumuluscloud.app/path",
      "https://user:pass@id.cumuluscloud.app",
    ]) {
      assert.equal(exactCorsOrigin(blocked, allowed), null, blocked);
    }
    const headers = cumulusCorsHeaders("https://cloud.cumuluscloud.app", allowed);
    assert.equal(headers["Access-Control-Allow-Origin"], "https://cloud.cumuluscloud.app");
    assert.equal(JSON.stringify(headers).includes("*"), false);
    const denied = cumulusCorsHeaders("*", allowed);
    assert.equal(denied["Access-Control-Allow-Origin"], undefined);
    assert.equal(Object.values(denied).includes("*"), false);
    assert.equal(cumulusCorsHeaders("https://cloud.cumuluscloud.app", ["*"])["Access-Control-Allow-Origin"], undefined);
  });

  it("rejects wildcard and path origins in the allowlist", () => {
    assert.equal(assertExactOrigin("https://id.cumuluscloud.app"), "https://id.cumuluscloud.app");
    assert.equal(assertExactOrigin("http://localhost:3000"), "http://localhost:3000");
    assert.throws(() => assertExactOrigin("*"), /exact/);
    assert.throws(() => assertExactOrigin("https://*.cumuluscloud.app"), /exact/);
    assert.throws(() => assertExactOrigin("https://id.cumuluscloud.app/jwks"), /path/);
  });
});
