import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FABRIC_ROOT_DOMAIN, FabricDomainError, fabricRootDomain } from "./domain.ts";

test("FABRIC_ROOT_DOMAIN defaults to infinitumfabric.app", () => {
  assert.equal(DEFAULT_FABRIC_ROOT_DOMAIN, "infinitumfabric.app");
  assert.equal(fabricRootDomain({}), "infinitumfabric.app");
});

test("accepts a bare hostname and normalizes case", () => {
  assert.equal(fabricRootDomain({ FABRIC_ROOT_DOMAIN: "  InfinitumFabric.APP  " }), "infinitumfabric.app");
  assert.equal(fabricRootDomain({ FABRIC_ROOT_DOMAIN: "localhost" }), "localhost");
});

test("rejects URLs, ports, paths, wildcards and addresses", () => {
  for (const raw of [
    "",
    "https://infinitumfabric.app",
    "infinitumfabric.app:443",
    "infinitumfabric.app/path",
    "infinitumfabric.app?x=1",
    "*.infinitumfabric.app",
    "user@infinitumfabric.app",
    "infinitumfabric.app.",
    "-bad.app",
    "1.2.3.4",
  ]) {
    assert.throws(() => fabricRootDomain({ FABRIC_ROOT_DOMAIN: raw }), FabricDomainError);
  }
});
