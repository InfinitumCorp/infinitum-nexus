import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";

let base = "";
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;

before(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  const signer = generateSigner();
  const suite = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: [base], mailOrigin: base });
  server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

const post = async (path: string, body: unknown, cookie = "") => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: JSON.stringify(body) });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: (await res.json()) as any, cookie: set ? set.split(";")[0]! : "" };
};

async function signUp(username: string) {
  const auth = new VirtualAuthenticator();
  const a = await post("/api/auth/signup", { username });
  const b = await post("/api/auth/signup/finish", { cid: a.body.cid, response: auth.create({ challenge: a.body.options.challenge, origin: base, rpId: "localhost" }) });
  const c = await post("/api/auth/signin/finish", { response: auth.get({ credentialId: b.body.options.allowCredentials[0].id, challenge: b.body.options.challenge, origin: base }) });
  return c.cookie;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const stateOf = (cookie: string) => fetch(`${base}/api/state`, { headers: { "x-cumulus": "1", cookie } });

describe("Signing in the desktop app through the browser", () => {
  it("the browser approves, and the app gets its own session for the same account", async () => {
    const browser = await signUp("deskuser");
    const { verifier, challenge } = pkce();
    const grant = await post("/api/auth/desktop/grant", { challenge }, browser);
    assert.equal(grant.status, 200);
    const redeem = await post("/api/auth/desktop/redeem", { code: grant.body.code, verifier });
    assert.equal(redeem.status, 200);
    assert.notEqual(redeem.cookie, browser);
    const me = (await (await stateOf(redeem.cookie)).json()) as any;
    assert.equal(me.me.email, "deskuser@cumuluscloud.app");
  });

  it("a code works once, and never without the app's verifier", async () => {
    const browser = await signUp("deskuser2");
    const { verifier, challenge } = pkce();
    const stolen = await post("/api/auth/desktop/grant", { challenge }, browser);
    assert.equal((await post("/api/auth/desktop/redeem", { code: stolen.body.code, verifier: pkce().verifier })).status, 400);
    // The wrong verifier burned the code, so even the real app has to start again.
    assert.equal((await post("/api/auth/desktop/redeem", { code: stolen.body.code, verifier })).status, 400);

    const ok = await post("/api/auth/desktop/grant", { challenge }, browser);
    assert.equal((await post("/api/auth/desktop/redeem", { code: ok.body.code, verifier })).status, 200);
    assert.equal((await post("/api/auth/desktop/redeem", { code: ok.body.code, verifier })).status, 400);
  });

  it("only someone signed in can approve, and only a well-formed request", async () => {
    assert.equal((await post("/api/auth/desktop/grant", { challenge: pkce().challenge })).status, 401);
    const browser = await signUp("deskuser3");
    assert.equal((await post("/api/auth/desktop/grant", { challenge: "short" }, browser)).status, 400);
  });
});
