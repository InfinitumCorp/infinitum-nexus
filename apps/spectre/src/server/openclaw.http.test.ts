import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";
import { createOpenClaw } from "./openclaw.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

describe("+SPCTR @scalvs in Ask", () => {
  const servers: Server[] = [];
  const sent: any[] = [];

  async function start(withClaw: boolean) {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const crm = new SpectreCRM({ ledger, signer });
    // A fake OpenClaw gateway.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Drafted a follow-up for Northwind." } }] }));
    }) as unknown as typeof fetch;
    const openclaw = withClaw ? createOpenClaw({ url: "https://claw.test", token: "tok_secret", agent: "openclaw/sales", fetchImpl }) : null;
    const app = createApp({ cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN, openclaw, conjureLive: null });
    const server = app.server();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

  const call = async (base: string, method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-spectre": "1", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const signUp = async (base: string, username: string) => {
    const auth = new VirtualAuthenticator();
    const s = await call(base, "POST", "/api/auth/signup", { username });
    const f = await call(base, "POST", "/api/auth/signup/finish", { cid: s.body.cid, response: auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" }) });
    const res = await fetch(base + "/api/auth/signin/finish", { method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" },
      body: JSON.stringify({ response: auth.get({ credentialId: [...auth.credentials.keys()][0], challenge: f.body.options.challenge, origin: ORIGIN }) }) });
    return { cookie: res.headers.get("set-cookie")!.split(";")[0], cid: s.body.cid as string };
  };

  let base: string;
  before(async () => { base = await start(true); });

  it("hands the task and the workspace summary to the OpenClaw agent", async () => {
    const me = await signUp(base, "morgan");
    await call(base, "POST", "/api/companies", { name: "Northwind", kind: "enterprise" }, me.cookie);
    const res = await call(base, "POST", "/api/ask", { question: "@scalvs draft a follow-up to Northwind" }, me.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, "Drafted a follow-up for Northwind.");
    assert.deepEqual(res.body.openclaw, { agent: "openclaw/sales" });
    const req = sent.at(-1);
    assert.equal(req.model, "openclaw/sales");
    assert.equal(req.user, `spctr:${me.cid}`);
    assert.equal(req.messages.at(-1).content, "draft a follow-up to Northwind");
    assert.match(req.messages[0].content, /Northwind/);
    assert.ok(!JSON.stringify(res.body).includes("tok_secret"));
  });

  it("reports the connection without the gateway URL or token", async () => {
    const me = await signUp(base, "riley");
    const res = await call(base, "GET", "/api/openclaw", undefined, me.cookie);
    assert.deepEqual(res.body, { connected: true, agent: "openclaw/sales" });
    assert.equal((await call(base, "GET", "/api/openclaw")).status, 401);
  });

  it("asks for a task after a bare @scalus", async () => {
    const me = await signUp(base, "casey");
    const res = await call(base, "POST", "/api/ask", { question: "@scalus" }, me.cookie);
    assert.equal(res.status, 400);
  });

  it("says how to connect OpenClaw when it isn't set up", async () => {
    const off = await start(false);
    const me = await signUp(off, "jordan");
    const res = await call(off, "POST", "/api/ask", { question: "@scalvs what's at risk?" }, me.cookie);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /OPENCLAW_GATEWAY_URL/);
    assert.deepEqual((await call(off, "GET", "/api/openclaw", undefined, me.cookie)).body, { connected: false, agent: null });
  });
});
