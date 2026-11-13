/**
 * Upstream mode end to end, with two real servers:
 *   - "issuer": a Mail host in legacy mode. Its /api/id/* routes are registerProductIdp from
 *     @infinitum/cid, the same code id.cumuluscloud.app serves.
 *   - "mail": a Mail host started with upstreamIssuer = the issuer. It must never create a cid.
 */
import { createRouter } from "@infinitum/ai";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";
import { scalvsCleanAgent } from "./clean-agent.ts";

const MAIL_ORIGIN = "https://mail.cumuluscloud.app"; // a registered redirect origin for client "cumulus-mail"
const publicDir = join(import.meta.dirname, "..", "public");
const quiet = { scalvs: async () => ({ ok: true as const, text: "Brief." }), cleanAgent: scalvsCleanAgent({ router: createRouter({ providers: [] }) }), noTimers: true };

let issuerBase = "";
let mailBase = "";
let issuer: ReturnType<typeof createCumulus>;
let mail: ReturnType<typeof createCumulus>;
const servers: Server[] = [];

class Browser {
  jar = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }
  async call(method: string, pathOrUrl: string, body?: unknown, headers: Record<string, string> = { "x-cumulus": "1" }) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.base + pathOrUrl;
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value = ""] = pair!.split("=");
      if (/Max-Age=0/.test(line)) this.jar.delete(name!);
      else this.jar.set(name!, value);
    }
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, location: res.headers.get("location") };
  }
}

async function listen(app: ReturnType<typeof createMailApp>, port: number) {
  const server = app.server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  servers.push(server);
}

async function freePort() {
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** Create a Cumulus://ID on the issuer with a passkey; returns a browser signed in there. */
async function issuerAccount(username: string) {
  const b = new Browser(issuerBase);
  const auth = new VirtualAuthenticator();
  const a = await b.call("POST", "/api/auth/signup", { username });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const reg = auth.create({ challenge: a.data.options.challenge, origin: issuerBase, rpId: "localhost" });
  const fin = await b.call("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: reg });
  const credentialId = fin.data.options.allowCredentials[0].id;
  const s = await b.call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId, challenge: fin.data.options.challenge, origin: issuerBase }) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return { browser: b, cid: a.data.cid as string };
}

/** The full redirect dance: Mail -> issuer authorize -> Mail callback. Returns the Mail browser and the callback result. */
async function signInToMail(atIssuer: Browser) {
  const m = new Browser(mailBase);
  const start = await m.call("GET", "/api/auth/cid/start");
  assert.equal(start.status, 302);
  assert.ok(start.location!.startsWith(`${issuerBase}/api/id/authorize?`), start.location!);
  const authorized = await atIssuer.call("GET", start.location!);
  assert.equal(authorized.status, 302, JSON.stringify(authorized.data));
  const back = new URL(authorized.location!);
  assert.equal(back.origin + back.pathname, `${MAIL_ORIGIN}/api/auth/cid/callback`);
  // The browser lands on Mail's callback (served locally in this test).
  const done = await m.call("GET", `/api/auth/cid/callback${back.search}`);
  return { m, done };
}

before(async () => {
  const [p1, p2] = [await freePort(), await freePort()];
  issuerBase = `http://localhost:${p1}`;
  mailBase = `http://127.0.0.1:${p2}`;

  const s1 = generateSigner();
  issuer = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [s1.publicKey] }), signer: s1, rpId: "localhost", origins: [issuerBase], mailOrigin: issuerBase });
  await listen(createMailApp({ suite: issuer, publicDir, origin: issuerBase, secureCookies: false, ...quiet }), p1);

  const s2 = generateSigner();
  mail = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [s2.publicKey] }), signer: s2, rpId: "mail.cumuluscloud.app", origins: [MAIL_ORIGIN], mailOrigin: MAIL_ORIGIN, upstreamIssuer: issuerBase });
  await listen(createMailApp({ suite: mail, publicDir, origin: MAIL_ORIGIN, secureCookies: false, ...quiet }), p2);
});

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

describe("Cumulus://Mail in upstream mode", () => {
  it("signs in through the issuer and keeps the issuer's cid, mailbox and all", async () => {
    const { browser, cid } = await issuerAccount("alex");
    const { m, done } = await signInToMail(browser);
    assert.equal(done.status, 302);
    assert.equal(done.location, "/");
    assert.equal(m.jar.has("cmail_cid"), false, "the PKCE cookie is cleared");

    const me = await m.call("GET", "/api/me");
    assert.equal(me.status, 200, JSON.stringify(me.data));
    assert.equal(me.data.cid, cid, "Mail's account is the issuer's cid");
    assert.equal(me.data.mailAddress, "alex@cumuluscloud.app");
    assert.ok(await mail.mail.has(cid), "the mailbox is provisioned under the issuer's cid");
    assert.equal(mail.stores.cid.accounts.size, 1);

    // The issuer token Mail used was revoked; only the person's own issuer session remains.
    assert.equal((await issuer.cid.listSessions(cid)).length, 1);

    // Signing in again reuses the same account.
    const again = await signInToMail(browser);
    assert.equal((await again.m.call("GET", "/api/me")).data.cid, cid);
    assert.equal(mail.stores.cid.accounts.size, 1);
  });

  it("refuses to create accounts locally and tells the UI where to go", async () => {
    const b = new Browser(mailBase);
    const signup = await b.call("POST", "/api/auth/signup", { username: "newbie" });
    assert.equal(signup.status, 400);
    assert.equal(signup.data.code, "signup_at_issuer");
    assert.equal((await b.call("GET", "/api/auth/issuer")).data.issuer, issuerBase);
    assert.equal(mail.stores.cid.byUsername.has("newbie"), false);
    const create = await b.call("GET", "/api/auth/cid/start?create=1");
    assert.equal(new URL(create.location!).searchParams.get("prompt"), "create");
  });

  it("forwards the legacy /api/id/* alias to the issuer, keeping method and body", async () => {
    const b = new Browser(mailBase);
    const q = "client_id=scalvs&redirect_uri=https%3A%2F%2Fscalvs.app%2F&code_challenge=x";
    const get = await b.call("GET", `/api/id/authorize?${q}`);
    assert.equal(get.status, 307);
    assert.equal(get.location, `${issuerBase}/api/id/authorize?${q}`);
    const post = await b.call("POST", "/api/id/token", { code: "c" }, {});
    assert.equal(post.status, 307);
    assert.equal(post.location, `${issuerBase}/api/id/token`);
  });

  it("rejects a callback that wasn't started in this browser, and a cancelled sign-in", async () => {
    const { browser } = await issuerAccount("kim");
    const victim = new Browser(mailBase);
    await victim.call("GET", "/api/auth/cid/start");
    // An attacker's own code and state, replayed into the victim's browser.
    const attacker = new Browser(mailBase);
    const start = await attacker.call("GET", "/api/auth/cid/start");
    const back = new URL((await browser.call("GET", start.location!)).location!);
    const forged = await victim.call("GET", `/api/auth/cid/callback${back.search}`);
    assert.equal(forged.status, 302);
    assert.match(forged.location!, /^\/#\/signin-error\//);
    assert.equal(victim.jar.has("cmail_session"), false);
    const cancelled = await victim.call("GET", "/api/auth/cid/callback?error=access_denied");
    assert.match(cancelled.location!, /cancelled/);
  });

  it("does not merge a pre-cutover Mail-only account that holds the same username", async () => {
    // Simulate an account created on Mail before CUMULUS_ID_ISSUER was set.
    const legacyCid = "cid_99999999-9999-4999-8999-999999999999";
    mail.stores.cid.accounts.set(legacyCid, { cid: legacyCid, username: "sam", mailAddress: "sam@cumuluscloud.app", handle: "@sam.veil", createdAt: new Date().toISOString(), entitlements: (await mail.cid.getAccount([...mail.stores.cid.accounts.keys()][0]!)).entitlements });
    mail.stores.cid.byUsername.set("sam", legacyCid);
    const { browser, cid } = await issuerAccount("sam");
    const { m, done } = await signInToMail(browser);
    assert.match(decodeURIComponent(done.location!), /belongs to an older account/);
    assert.equal(m.jar.has("cmail_session"), false);
    assert.equal(mail.stores.cid.accounts.has(cid), false);
    assert.equal(mail.stores.cid.byUsername.get("sam"), legacyCid);
  });
});
