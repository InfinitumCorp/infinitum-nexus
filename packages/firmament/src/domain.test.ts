import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FIRMAMENT_ROOT_DOMAIN, FirmamentDomainError, firmamentRootDomain } from "./domain.ts";

test("FIRMAMENT_ROOT_DOMAIN defaults to firmnetwork.app", () => {
  assert.equal(DEFAULT_FIRMAMENT_ROOT_DOMAIN, "firmnetwork.app");
  assert.equal(firmamentRootDomain({}), "firmnetwork.app");
});

test("accepts a bare hostname and normalizes case", () => {
  assert.equal(firmamentRootDomain({ FIRMAMENT_ROOT_DOMAIN: "  FirmNetwork.APP  " }), "firmnetwork.app");
  assert.equal(firmamentRootDomain({ FIRMAMENT_ROOT_DOMAIN: "localhost" }), "localhost");
});

test("rejects URLs, ports, paths, wildcards and addresses", () => {
  for (const raw of [
    "",
    "https://firmnetwork.app",
    "firmnetwork.app:443",
    "firmnetwork.app/path",
    "firmnetwork.app?x=1",
    "*.firmnetwork.app",
    "user@firmnetwork.app",
    "firmnetwork.app.",
    "-bad.app",
    "1.2.3.4",
  ]) {
    assert.throws(() => firmamentRootDomain({ FIRMAMENT_ROOT_DOMAIN: raw }), FirmamentDomainError);
  }
});
