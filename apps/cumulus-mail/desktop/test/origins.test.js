const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PRIMARY, isOurOrigin, pickOrigin, parseAppLink, linkFromArgv, unreadFromTitle } = require("../origins.js");

test("stays on Cumulus://Mail origins only", () => {
  assert.ok(isOurOrigin("https://mail.cumuluscloud.app/#/inbox"));
  assert.ok(isOurOrigin("https://ru.mail.cumuluscloud.app/"));
  assert.ok(!isOurOrigin("https://mail.cumuluscloud.app.evil.com/"));
  assert.ok(!isOurOrigin("http://mail.cumuluscloud.app/"));
  assert.ok(!isOurOrigin("not a url"));
});

test("works with no mirror: the primary is used when it answers", async () => {
  const calls = [];
  const origin = await pickOrigin(async (url) => { calls.push(url); return { ok: true }; });
  assert.equal(origin, PRIMARY);
  assert.equal(calls.length, 1);
});

test("falls back to the mirror only when the primary is unreachable", async () => {
  const origin = await pickOrigin(async (url) => { if (url.startsWith(PRIMARY)) throw new Error("blocked"); return { ok: true }; });
  assert.equal(origin, "https://ru.mail.cumuluscloud.app");
});

test("with the primary and mirror both down, stays on the primary (offline page, retries)", async () => {
  assert.equal(await pickOrigin(async () => { throw new Error("down"); }), PRIMARY);
});

test("reads sign-in and mailto links", () => {
  assert.deepEqual(parseAppLink("cumulus-mail://signin?code=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"), { type: "signin", code: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" });
  assert.equal(parseAppLink("cumulus-mail://signin?code=bad code"), null);
  assert.equal(parseAppLink("cumulus-mail://other?code=abcdefghijklmnopqrstuvwxyz"), null);
  assert.deepEqual(parseAppLink("mailto:pat@example.com,sam@example.com?subject=Hi%20there&body=Hello"), { type: "compose", to: "pat@example.com, sam@example.com", subject: "Hi there", body: "Hello" });
  assert.equal(parseAppLink("https://example.com"), null);
});

test("finds the link on the command line and the unread count in the title", () => {
  assert.equal(linkFromArgv(["app.exe", "--flag", "mailto:a@b.c"]), "mailto:a@b.c");
  assert.equal(linkFromArgv(["app.exe"]), null);
  assert.equal(unreadFromTitle("Inbox (12) · Cumulus://Mail"), 12);
  assert.equal(unreadFromTitle("Inbox"), 0);
});
