import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIRM_ROOT_DOMAIN, FirmDomainError, firmRootDomain } from "./domain.ts";

test("FIRM_ROOT_DOMAIN defaults to firmwallet.app", () => {
  assert.equal(DEFAULT_FIRM_ROOT_DOMAIN, "firmwallet.app");
  assert.equal(firmRootDomain({}), "firmwallet.app");
});

test("accepts a bare hostname and normalizes case", () => {
  assert.equal(firmRootDomain({ FIRM_ROOT_DOMAIN: "  FirmWallet.APP  " }), "firmwallet.app");
  assert.equal(firmRootDomain({ FIRM_ROOT_DOMAIN: "localhost" }), "localhost");
});

test("rejects URLs, ports, paths, wildcards and addresses", () => {
  for (const raw of [
    "",
    "https://firmwallet.app",
    "firmwallet.app:443",
    "firmwallet.app/path",
    "firmwallet.app?x=1",
    "*.firmwallet.app",
    "user@firmwallet.app",
    "firmwallet.app.",
    "-bad.app",
    "1.2.3.4",
  ]) {
    assert.throws(() => firmRootDomain({ FIRM_ROOT_DOMAIN: raw }), FirmDomainError);
  }
});
