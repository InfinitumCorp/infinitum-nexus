import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** End-to-end "Continue with GitHub" through Spectre's HTTP routes, with GitHub simulated. */
describe("+SPCTR social sign-in over HTTP", () => {
  let server: Server;
  let base: string;
  let cid: CidService;

  const github = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/login/oauth/access_token") return json({ access_token: "gho_test" });
    if (url.pathname === "/user") return json({ id: 9001, login: "morgan-k", name: "Morgan K" });
    if (url.pathname === "/user/emails") return json([{ email: "morgan@github.example", primary: true, verified: true }]);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    cid = new CidService({
      ledger, signer, rpId: "localhost", origins: ["http://localhost"],
      social: { providers: { github: { clientId: "gh-client", clientSecret: "gh-secret" } }, fetchImpl: github },
    });
    const crm = new SpectreCRM({ ledger, signer });
    const app = createApp({ cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false, origin: "https://spectre.example" });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const get = (path: string, cookie?: string) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const cookiesOf = (res: Response) => res.headers.getSetCookie();

  it("lists configured providers", async () => {
    const res = await get("/api/auth/providers");
    assert.deepEqual(await res.json(), [{ id: "github", label: "GitHub" }]);
  });

  it("signs in with GitHub end to end and creates the CID", async () => {
    const start = await get("/api/auth/oauth/github/start");
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("location")!);
    assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(to.searchParams.get("redirect_uri"), "https://spectre.example/api/auth/oauth/github/callback");
    const oauthCookie = cookiesOf(start).find((c) => c.startsWith("spctr_oauth="))!;
    assert.match(oauthCookie, /HttpOnly/);
    const state = to.searchParams.get("state")!;

    const cb = await get(`/api/auth/oauth/github/callback?code=abc&state=${state}`, oauthCookie.split(";")[0]);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/#/today");
    const session = cookiesOf(cb).find((c) => c.startsWith("spctr_session="))!;
    assert.ok(session);

    const me = await get("/api/me", session.split(";")[0]);
    const body = await me.json();
    assert.equal(body.username, "morgan-k");
    assert.equal(body.mailAddress, "morgan-k@cumuluscloud.app");

    const ids = await (await get("/api/me/identities", session.split(";")[0])).json();
    assert.equal(ids.linked[0].provider, "github");
    assert.equal(ids.linked[0].email, "morgan@github.example");
  });

  it("refuses a callback from a different browser and explains why", async () => {
    const start = await get("/api/auth/oauth/github/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await get(`/api/auth/oauth/github/callback?code=abc&state=${state}`); // no oauth cookie
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location")!, /^\/#\/signin-error\//);
    assert.ok(!cookiesOf(cb).some((c) => c.startsWith("spctr_session=")));
  });

  it("handles a cancelled sign-in", async () => {
    const cb = await get("/api/auth/oauth/github/callback?error=access_denied&state=x");
    assert.equal(decodeURIComponent(cb.headers.get("location")!), "/#/signin-error/Sign-in was cancelled.");
  });

  it("rejects providers that aren't configured", async () => {
    const res = await get("/api/auth/oauth/google/start");
    assert.equal(res.status, 400);
  });
});
