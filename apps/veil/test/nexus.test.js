import { test } from "node:test";
import assert from "node:assert/strict";
import { APPS, DEFAULT_ORIGINS, badgeText, launcher, parseSummary, resolveOrigins, safeOrigin } from "../lib/nexus.js";

const spectreMe = {
  cid: "cid_1", username: "alex", mailAddress: "alex@cumulusmail.cloud", handle: "@alex.veil", workspace: "cid_1",
  cumulus: {
    cid: "cid_1", plan: "Free", entitlements: ["x"],
    mail: { unread: 3, url: "https://mail.example" },
    storage: { label: "1.2 MB of 15 GB", pct: 0.4, mail: "1 MB", cloud: "0.2 MB" },
    wallet: { address: "0xabc", balances: { FIRM: "12.5", USDC: "0", "<img>": "1", VEIL: "nope" } },
  },
};

test("Ask uses the CNDCTR public host by default", () => {
  assert.equal(DEFAULT_ORIGINS.architect, "https://cndctr.app");
});

test("SCALVS.ai uses the purchased public host by default", () => {
  assert.equal(DEFAULT_ORIGINS.scalvs, "https://scalvs.app");
  const by = Object.fromEntries(launcher(resolveOrigins({}), null).map((a) => [a.id, a]));
  assert.equal(by.scalvs.url, "https://scalvs.app");
});

test("lists the seven free-tier products from the product page", () => {
  assert.deepEqual(APPS.map((a) => a.id), ["cid", "mail", "cloud", "scalvs", "architect", "metatron", "wallet"]);
});

test("only plain http(s) origins are accepted", () => {
  assert.equal(safeOrigin("https://mail.example/inbox?x=1"), "https://mail.example");
  for (const bad of ["javascript:alert(1)", "file:///c:/x", "chrome://settings", "https://u:p@x.example", 42, null, "nope"]) {
    assert.equal(safeOrigin(bad), null, String(bad));
  }
});

test("production pins VEIL, CNDCTR, and SCALVS and ignores stored hosts", () => {
  const stored = {
    veil: "https://evil.example",
    architect: "http://127.0.0.1:3001",
    scalvs: "https://user:secret@scalvs.app/path",
    mail: "https://mail.example/",
  };
  const o = resolveOrigins(stored);
  assert.equal(o.veil, "https://infinitumveil.app");
  assert.equal(o.architect, "https://cndctr.app");
  assert.equal(o.scalvs, "https://scalvs.app");
  assert.equal(o.mail, "https://mail.example");
});

test("dev builds accept only localhost and 127.0.0.1 for pinned products", () => {
  const o = resolveOrigins({
    veil: "http://localhost:3000",
    architect: "https://127.0.0.1:3001",
    scalvs: "https://evil.example",
  }, { dev: true });
  assert.equal(o.veil, "http://localhost:3000");
  assert.equal(o.architect, "https://127.0.0.1:3001");
  assert.equal(o.scalvs, "https://scalvs.app");
  const v6 = resolveOrigins({ architect: "http://[::1]:3001" }, { dev: true });
  assert.equal(v6.architect, "https://cndctr.app");
});

test("stored origins override defaults only when valid", () => {
  const o = resolveOrigins({ mail: "https://mail.example/", cid: "javascript:x", evil: "https://e.example" });
  assert.equal(o.mail, "https://mail.example");
  assert.equal(o.cid, DEFAULT_ORIGINS.cid);
  assert.equal(o.evil, undefined);
});

test("parses the +SPCTR /api/me shape and drops junk", () => {
  const s = parseSummary(spectreMe);
  assert.equal(s.cid, "cid_1");
  assert.equal(s.mail.unread, 3);
  assert.equal(s.mail.url, "https://mail.example");
  assert.equal(s.storage.label, "1.2 MB of 15 GB");
  assert.deepEqual(s.wallet.balances, { FIRM: "12.5", USDC: "0" });
  assert.equal(s.entitlements, undefined);
});

test("parses the Cumulus::Mail /api/me shape (summary at top level)", () => {
  const s = parseSummary({ ...spectreMe.cumulus, username: "alex", mailAddress: "alex@cumulusmail.cloud" });
  assert.equal(s.username, "alex");
  assert.equal(s.mail.unread, 3);
});

test("rejects summaries without a CID and clamps bad numbers", () => {
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary({ username: "x" }), null);
  const s = parseSummary({ cid: "c", mail: { unread: -4, url: "javascript:x" }, storage: { pct: 900 } });
  assert.equal(s.mail.unread, 0);
  assert.equal(s.mail.url, null);
  assert.equal(s.storage.pct, 100);
});

test("launcher uses the account's mail origin, unread badge and storage", () => {
  const apps = launcher(resolveOrigins({}), parseSummary(spectreMe));
  const by = Object.fromEntries(apps.map((a) => [a.id, a]));
  assert.equal(by.mail.url, "https://mail.example");
  assert.equal(by.mail.badge, 3);
  assert.equal(by.mail.blurb, "alex@cumulusmail.cloud");
  assert.match(by.cloud.blurb, /1\.2 MB of 15 GB/);
  assert.equal(by.cloud.url, null);
  assert.equal(by.wallet.panel, "wallet");
  assert.equal(by.architect.url, DEFAULT_ORIGINS.architect);
});

test("launcher works before sign-in", () => {
  const by = Object.fromEntries(launcher(resolveOrigins({}), null).map((a) => [a.id, a]));
  assert.equal(by.mail.url, DEFAULT_ORIGINS.mail);
  assert.equal(by.mail.badge, 0);
});

test("badge text", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(250), "99+");
  assert.equal(badgeText(NaN), "");
});
