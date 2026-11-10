import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUMULUS_COOKIE_DOMAIN,
  CUMULUS_ISSUER,
  CUMULUS_ORIGINS,
  MAIL_DOMAIN,
  cookieDomainForHost,
  readCumulusDomain,
} from "./domain.ts";

test("cumuluscloud.app is the default host for ID, Cloud, and Mail", () => {
  const domain = readCumulusDomain({});
  assert.equal(domain.domain, "cumuluscloud.app");
  assert.equal(MAIL_DOMAIN, "cumuluscloud.app");
  assert.equal(domain.mailDomain, "cumuluscloud.app");
  assert.equal(domain.idOrigin, "https://id.cumuluscloud.app");
  assert.equal(domain.cloudOrigin, "https://cloud.cumuluscloud.app");
  assert.equal(domain.mailOrigin, "https://mail.cumuluscloud.app");
  assert.equal(domain.issuer, CUMULUS_ISSUER);
  assert.equal(domain.issuer, "https://id.cumuluscloud.app");
  assert.equal(domain.rpId, "cumuluscloud.app");
  assert.equal(domain.cookieDomain, CUMULUS_COOKIE_DOMAIN);
  assert.deepEqual(domain.origins, [...CUMULUS_ORIGINS]);
});

test("environment variables override the cumuluscloud.app defaults", () => {
  const domain = readCumulusDomain({
    CUMULUS_DOMAIN: "example.com",
    CUMULUS_ID_HOST: "login.example.com",
    CUMULUS_COOKIE_DOMAIN: "example.com",
    CUMULUS_ISSUER: "https://login.example.com",
  });
  assert.equal(domain.domain, "example.com");
  assert.equal(domain.idHost, "login.example.com");
  assert.equal(domain.cloudHost, "cloud.example.com");
  assert.equal(domain.cookieDomain, ".example.com");
  assert.equal(domain.issuer, "https://login.example.com");
});

test("the shared cookie domain is set only on cumuluscloud.app", () => {
  assert.equal(cookieDomainForHost("id.cumuluscloud.app"), ".cumuluscloud.app");
  assert.equal(cookieDomainForHost("cloud.cumuluscloud.app"), ".cumuluscloud.app");
  assert.equal(cookieDomainForHost("mail.cumuluscloud.app"), ".cumuluscloud.app");
  assert.equal(cookieDomainForHost("localhost"), undefined);
  assert.equal(cookieDomainForHost("127.0.0.1"), undefined);
  assert.equal(cookieDomainForHost("evil.example"), undefined);
});
