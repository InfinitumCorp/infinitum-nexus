import test from "node:test";
import assert from "node:assert/strict";
import { applySetCookies, packJar, unpackJar, parseCookies, rewriteLocation } from "./server.mjs";

test("jar round-trips", () => {
  const jar = { cmail_session: "abc.def", cmail_oauth: "x" };
  assert.deepEqual(unpackJar(packJar(jar)), jar);
  assert.deepEqual(unpackJar("not-valid"), {});
});
test("set-cookie adds and removes", () => {
  let jar = applySetCookies({}, ["cmail_session=tok; HttpOnly; Path=/; Max-Age=2592000; Secure"]);
  assert.deepEqual(jar, { cmail_session: "tok" });
  jar = applySetCookies(jar, ["cmail_oauth=st; Path=/api/auth/oauth; Max-Age=600"]);
  assert.deepEqual(jar, { cmail_session: "tok", cmail_oauth: "st" });
  jar = applySetCookies(jar, ["cmail_oauth=; Path=/api/auth/oauth; Max-Age=0", "cmail_session=; Path=/; Max-Age=0"]);
  assert.deepEqual(jar, {});
});
test("cookies parse", () => assert.deepEqual(parseCookies("a=1; __session=xyz"), { a: "1", __session: "xyz" }));
test("redirects stay on the mirror", () => {
  assert.equal(rewriteLocation("https://mail.cumuluscloud.app/inbox?x=1", "https://ru2.mail.cumuluscloud.app"), "https://ru2.mail.cumuluscloud.app/inbox?x=1");
  assert.equal(rewriteLocation("https://id.cumuluscloud.app/x", "https://ru2.mail.cumuluscloud.app"), "https://id.cumuluscloud.app/x");
});
