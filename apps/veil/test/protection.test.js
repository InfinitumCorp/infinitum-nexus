import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { BLOCKED_HOSTS, BLOCKLIST, blocklistRules, isBlockedHost, ruleCategory } from "../lib/blocklist.js";
import { assessError, assessRedirect, assessUrl, mergeIssues } from "../lib/safety.js";
import { assessDownload } from "../lib/downloads.js";
import { CLASSES, generateFor, generatePassword, meetsRules, parseRules, rulesFor } from "../lib/passgen.js";
import { check, hostMatches, protect, publicView, trust } from "../lib/password-guard.js";
import { PASSWORD_RULES } from "../lib/password-rules.js";
import { chromeManifest, firefoxManifest } from "../scripts/manifests.js";

// ---------- Blocklist ----------

test("blocklist matches listed hosts and their subdomains only", () => {
  assert.ok(isBlockedHost("doubleclick.net"));
  assert.ok(isBlockedHost("stats.g.doubleclick.net"));
  assert.ok(isBlockedHost("CONNECT.FACEBOOK.NET."));
  assert.equal(isBlockedHost("facebook.com"), false);
  assert.equal(isBlockedHost("notdoubleclick.net"), false);
  assert.equal(isBlockedHost(""), false);
});

test("blocklist rules are third-party only and never block the page itself", () => {
  const rules = blocklistRules();
  assert.equal(rules.length, Object.keys(BLOCKLIST).length);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) {
    assert.equal(r.action.type, "block");
    assert.equal(r.condition.domainType, "thirdParty");
    assert.deepEqual(r.condition.excludedResourceTypes, ["main_frame"]);
    assert.equal(ruleCategory(r.id), r.category);
  }
  assert.equal(BLOCKED_HOSTS.length, new Set(Object.values(BLOCKLIST).flat()).size);
});

test("the manifest asks for blocking and download permissions in both builds", () => {
  for (const m of [chromeManifest("1.0.0"), firefoxManifest("1.0.0")]) {
    for (const p of ["declarativeNetRequest", "declarativeNetRequestFeedback", "downloads"]) assert.ok(m.permissions.includes(p), p);
    assert.deepEqual(m.content_scripts[0].js, ["lib/content-pii.js", "content.js"]);
    assert.equal(m.web_accessible_resources, undefined, "content scripts stay invisible to pages");
  }
});

// ---------- Connection safety ----------

test("plain HTTP gets an alert with an HTTPS fix, except .onion and localhost", () => {
  const [issue] = assessUrl("http://example.com/a?b=1");
  assert.equal(issue.kind, "http-only");
  assert.equal(issue.fixes[0].action, "https");
  assert.equal(issue.fixes[0].url, "https://example.com/a?b=1");
  assert.deepEqual(assessUrl("http://abcdefghijklmnop.onion/"), []);
  assert.deepEqual(assessUrl("http://localhost:3000/"), []);
  assert.deepEqual(assessUrl("https://example.com/"), []);
  assert.deepEqual(assessUrl("chrome://settings"), []);
});

test("look-alike punycode hosts, downgrades and certificate errors are flagged", () => {
  assert.equal(assessUrl("https://xn--pple-43d.com/")[0].kind, "lookalike");
  assert.equal(assessRedirect("https://bank.example/", "http://bank.example/login").kind, "downgrade");
  assert.equal(assessRedirect("http://a.example/", "https://a.example/"), null);
  assert.equal(assessError("https://x.example/", "net::ERR_CERT_DATE_INVALID").kind, "cert-invalid");
  assert.equal(assessError("https://x.example/", "net::ERR_NAME_NOT_RESOLVED"), null);
  const merged = mergeIssues([{ kind: "a", v: 1 }], [{ kind: "a", v: 2 }, null, { kind: "b" }]);
  assert.deepEqual(merged, [{ kind: "a", v: 2 }, { kind: "b" }]);
});

// ---------- Downloads ----------

test("risky downloads are held; documents pass", () => {
  assert.equal(assessDownload({ filename: "report.pdf", mime: "application/pdf", url: "https://x.example/r.pdf" }).risky, false);
  const dbl = assessDownload({ filename: "C:\\Users\\a\\Downloads\\invoice.pdf.exe", mime: "application/octet-stream", url: "https://x.example/" });
  assert.equal(dbl.reasons[0].kind, "double-extension");
  assert.equal(assessDownload({ filename: "photo.jpg", mime: "application/x-msdownload" }).reasons[0].kind, "type-mismatch");
  assert.equal(assessDownload({ filename: "setup.exe", mime: "image/png" }).reasons[0].kind, "type-mismatch");
  const exe = assessDownload({ filename: "tool.exe", mime: "application/octet-stream", url: "http://x.example/tool.exe" });
  assert.deepEqual(exe.reasons.map((r) => r.kind), ["executable", "insecure-source"]);
  assert.equal(assessDownload({ filename: "tool.exe", url: "http://abc.onion/tool.exe" }).reasons.length, 1);
});

// ---------- Password generator ----------

test("password rules parse, including custom classes with ']' and ';'", () => {
  const p = parseRules("minlength: 8; maxlength: 16; required: lower, upper; required: digit; allowed: [-!@#$%^&*()_+=;:]]; max-consecutive: 2;");
  assert.equal(p.minLength, 8);
  assert.equal(p.maxLength, 16);
  assert.equal(p.maxConsecutive, 2);
  assert.equal(p.required.length, 2);
  assert.equal(p.required[0], CLASSES.lower + CLASSES.upper);
  assert.ok(p.allowed.includes("]") && p.allowed.includes(";") && p.allowed.includes("-"));
});

test("generated passwords meet every vendored site rule", () => {
  let n = 0;
  for (const [host, rule] of Object.entries(PASSWORD_RULES)) {
    const pw = generatePassword(rule);
    assert.ok(meetsRules(pw, rule), `${host}: ${rule} -> ${pw}`);
    n++;
  }
  assert.ok(n > 400);
});

test("default passwords are 20 characters with every class, and sites resolve to parents", () => {
  const pw = generatePassword(null);
  assert.equal(pw.length, 20);
  for (const set of [CLASSES.lower, CLASSES.upper, CLASSES.digit, CLASSES.special]) assert.ok([...pw].some((c) => set.includes(c)));
  const some = Object.keys(PASSWORD_RULES)[0];
  assert.equal(rulesFor(`login.${some}`).host, some);
  assert.equal(rulesFor("unlisted.invalid"), null);
  assert.equal(generateFor("unlisted.invalid").rulesFrom, null);
});

test("the generator draws without modulo bias", () => {
  // A source that returns values above the rejection limit first must be retried, not reduced.
  const values = [0xffffffff, 5];
  let i = 0;
  const pw = generatePassword("minlength: 1; maxlength: 1; required: digit;", { length: 1, random: (a) => { a[0] = values[Math.min(i++, 1)]; } });
  assert.equal(pw, "5");
});

// ---------- Password reuse ----------

test("a protected password warns only on sites it doesn't belong to", async () => {
  const entry = await protect("correct horse battery", ["https://www.bank.example/login", "mail.example"], { iterations: 1000 });
  assert.equal("correct horse battery" in entry, false);
  assert.equal(JSON.stringify(entry).includes("correct horse"), false);
  assert.deepEqual(entry.hosts, ["bank.example", "mail.example"]);
  const entries = [entry];
  assert.deepEqual(await check(entries, "correct horse battery", "secure.bank.example"), { reused: false, id: entry.id });
  const hit = await check(entries, "correct horse battery", "bank-example.phish.test");
  assert.equal(hit.reused, true);
  assert.deepEqual(hit.hosts, ["bank.example", "mail.example"]);
  assert.equal((await check(entries, "correct horse batterz", "phish.test")).reused, false);
  const trusted = trust(entries, entry.id, "www.newsite.example");
  assert.equal((await check(trusted, "correct horse battery", "newsite.example")).reused, false);
  assert.deepEqual(Object.keys(publicView(trusted)[0]).sort(), ["hosts", "id", "length"]);
  await assert.rejects(protect("short", ["a.example"]));
  await assert.rejects(protect("long enough", []));
  assert.ok(hostMatches("a.b.example", "b.example"));
  assert.equal(hostMatches("b.example", "a.b.example"), false);
});

// ---------- Personal data in forms ----------

function loadPII() {
  const sandbox = { URL };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../lib/content-pii.js", import.meta.url), "utf8"), sandbox);
  const api = sandbox.VeilPII;
  // Results come from another realm; copy them so deepEqual compares values.
  const plain = (fn) => (...args) => JSON.parse(JSON.stringify(fn(...args)));
  return { ...api, formKinds: plain(api.formKinds), reasons: plain(api.reasons), fieldKinds: plain(api.fieldKinds) };
}

test("personal data is recognised by type, name, autocomplete and value", () => {
  const pii = loadPII();
  assert.ok(pii.luhn("4111111111111111"));
  assert.equal(pii.luhn("4111111111111112"), false);
  const kinds = pii.formKinds([
    { type: "text", name: "q", value: "shoes" },
    { type: "email", name: "x", value: "a@b.example" },
    { type: "text", name: "cardnumber", value: "4111 1111 1111 1111" },
    { type: "text", name: "id", value: "123-45-6789" },
    { type: "hidden", name: "email", value: "a@b.example" },
    { type: "password", name: "pw", value: "hunter22" },
    { type: "text", autocomplete: "shipping street-address", value: "1 Main St" },
  ]);
  assert.deepEqual(kinds.sort(), ["address", "card", "email", "national-id", "password"]);
  assert.deepEqual(pii.formKinds([{ type: "text", name: "search", value: "hello" }]), []);
});

test("forms are held over plain HTTP or to another site, never for .onion or same-site HTTPS", () => {
  const pii = loadPII();
  const k = ["email"];
  assert.deepEqual(pii.reasons("https://shop.example/", "/login", k), []);
  assert.deepEqual(pii.reasons("https://shop.example/", "https://auth.shop.example/", k), []);
  assert.deepEqual(pii.reasons("http://shop.example/", "/login", k), ["insecure"]);
  assert.deepEqual(pii.reasons("https://shop.example/", "https://collect.other.example/", k), ["other-site"]);
  assert.deepEqual(pii.reasons("http://abc.onion/", "/login", k), []);
  assert.deepEqual(pii.reasons("http://localhost/", "/login", k), []);
  assert.deepEqual(pii.reasons("http://shop.example/", "/search", []), []);
  assert.match(pii.message(["email", "card"], ["insecure"], "shop.example"), /your email, a payment card number without encryption/);
});
