import test from "node:test";
import assert from "node:assert/strict";
import { assessRegionBlock, isRegionBlocked } from "../lib/region.js";
import { RU_BLOCKED, RU_BLOCKED_SOURCE } from "../lib/region-blocks.js";

const list = new Set(["blocked.example", "only.sub.example"]);

test("region list matches a host and its subdomains, not lookalikes", () => {
  assert.ok(isRegionBlocked("blocked.example", list));
  assert.ok(isRegionBlocked("www.BLOCKED.example.", list));
  assert.ok(isRegionBlocked("a.only.sub.example", list));
  assert.equal(isRegionBlocked("sub.example", list), false);
  assert.equal(isRegionBlocked("notblocked.example", list), false);
  assert.equal(isRegionBlocked("", list), false);
});

test("blocked host with a block-like error raises one issue, offering Tor", () => {
  const issue = assessRegionBlock("https://www.blocked.example/x", "net::ERR_CONNECTION_RESET", "off", list);
  assert.equal(issue.kind, "region-blocked");
  assert.deepEqual(issue.fixes, [{ action: "tor", label: "Open over Tor" }]);
  assert.match(issue.detail, /www\.blocked\.example/);
});

test("no issue when routed, for other errors, or for unlisted hosts", () => {
  const url = "https://blocked.example/";
  assert.equal(assessRegionBlock(url, "net::ERR_TIMED_OUT", "veil", list), null);
  assert.equal(assessRegionBlock(url, "net::ERR_TIMED_OUT", "tor", list), null);
  assert.equal(assessRegionBlock(url, "net::ERR_ABORTED", "off", list), null);
  assert.equal(assessRegionBlock(url, "net::ERR_CERT_AUTHORITY_INVALID", "off", list), null);
  assert.equal(assessRegionBlock("https://open.example/", "net::ERR_TIMED_OUT", "off", list), null);
  assert.equal(assessRegionBlock("not a url", "net::ERR_TIMED_OUT", "off", list), null);
});

test("generated list is the pinned re:filter release and covers known blocks", () => {
  assert.equal(RU_BLOCKED_SOURCE.release, "07112026");
  assert.equal(RU_BLOCKED_SOURCE.count, RU_BLOCKED.size);
  assert.ok(RU_BLOCKED.size > 10_000);
  for (const host of ["www.instagram.com", "facebook.com", "x.com", "linkedin.com"]) assert.ok(isRegionBlocked(host), host);
  for (const host of ["yandex.ru", "google.com", "infinitumveil.app"]) assert.equal(isRegionBlocked(host), false, host);
});
