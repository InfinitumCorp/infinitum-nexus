import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { applySetCookies, createHandler, jarSetCookie, packJar, unpackJar, upstreamCookie } from "./server.mjs";

test("jar round-trips and ignores junk", () => {
  const jar = { spctr_session: "a.b", spctr_next: "%2Fx" };
  assert.deepEqual(unpackJar(packJar(jar)), jar);
  assert.deepEqual(unpackJar("not-valid"), {});
});

test("set-cookie adds, replaces and removes", () => {
  let jar = applySetCookies({}, ["spctr_session=t1; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000; Secure"]);
  jar = applySetCookies(jar, ["spctr_oauth=st; Path=/api/auth/oauth; Max-Age=600"]);
  assert.deepEqual(jar, { spctr_session: "t1", spctr_oauth: "st" });
  jar = applySetCookies(jar, ["spctr_oauth=; Path=/api/auth/oauth; Max-Age=0", "spctr_session=t2; Path=/"]);
  assert.deepEqual(jar, { spctr_session: "t2" });
  assert.match(jarSetCookie({}), /Max-Age=0/);
});

test("upstream sees the jar's cookies, not the jar", () => {
  const { header } = upstreamCookie(`other=1; __session=${packJar({ spctr_session: "t" })}`);
  assert.equal(header, "other=1; spctr_session=t");
});

async function pair(cookieJar) {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ cookie: req.headers.cookie, mirror: req.headers["x-spctr-mirror"] });
    if (req.url === "/login") {
      res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/home`, "set-cookie": ["spctr_session=tok; Path=/; HttpOnly"] });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hi");
  });
  await new Promise((r) => upstream.listen(0, r));
  const mirror = createServer(createHandler({ upstream: `http://127.0.0.1:${upstream.address().port}`, cookieJar }));
  await new Promise((r) => mirror.listen(0, r));
  return { seen, base: `http://127.0.0.1:${mirror.address().port}`, close: () => { mirror.close(); upstream.close(); } };
}

test("behind Firebase: cookies travel in __session and redirects stay on the mirror", async () => {
  const p = await pair(true);
  const r = await fetch(`${p.base}/login`, { redirect: "manual", headers: { "x-forwarded-host": "ru.id.example" } });
  assert.equal(r.headers.get("location"), "https://ru.id.example/home");
  const set = r.headers.get("set-cookie");
  assert.match(set, /^__session=/);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const jar = set.split(";")[0];
  await fetch(`${p.base}/me`, { headers: { cookie: jar, "x-forwarded-host": "ru.id.example" } });
  assert.equal(p.seen[1].cookie, "spctr_session=tok");
  assert.equal(p.seen[1].mirror, "https://ru.id.example");
  p.close();
});

test("without the jar, cookies pass through unchanged", async () => {
  const p = await pair(false);
  const r = await fetch(`${p.base}/login`, { redirect: "manual" });
  assert.match(r.headers.get("set-cookie"), /^spctr_session=tok/);
  p.close();
});
