import { queuedRouter, scriptedRouter, textReply, toolReply } from "@infinitum/ai/testing";
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

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

describe("+SPCTR app over HTTP", () => {
  let server: Server;
  let base: string;
  let cid: CidService;
  let ledger: Ledger;
  let changes = 0;
  let aiCalls: { body: any }[] = [];
  let aiKey: string | undefined;

  before(async () => {
    const signer = generateSigner();
    ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const crm = new SpectreCRM({ ledger, signer });
    const scripted = scriptedRouter((body) => {
      aiCalls.push({ body });
      return textReply("Northwind fleet rollout is most at risk.");
    });
    const ai = { get router() { return aiKey ? scripted.router : undefined; } };
    const app = createApp({ cid, crm, ai, publicDir: join(here, "../../public"), secureCookies: false, origin: "http://localhost", onChange: () => changes++ });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const call = async (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = { "x-spectre": "1" }) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get("set-cookie") };
  };

  async function signUp(username: string) {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const reg = auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" });
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: reg });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const credentialId = [...auth.credentials.keys()][0];
    const resp = auth.get({ credentialId, challenge: f.body.options.challenge, origin: ORIGIN });
    const signin = await call("POST", "/api/auth/signin/finish", { response: resp });
    assert.equal(signin.status, 200, JSON.stringify(signin.body));
    assert.match(signin.setCookie ?? "", /spctr_session=.+HttpOnly.+SameSite=Lax/);
    return { cookie: signin.setCookie!.split(";")[0], cid: s.body.cid as string, auth, credentialId };
  }

  it("serves the web app", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\+SPCTR/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const traversal = await fetch(base + "/..%2f..%2fpackage.json");
    assert.equal(traversal.status, 404);
  });

  it("signs up with a passkey, signs in, and grants Spectre access on the CID (recorded on Firmament)", async () => {
    const { cookie, cid: id } = await signUp("alex");
    const me = await call("GET", "/api/me", undefined, cookie);
    assert.equal(me.body.mailAddress, "alex@cumuluscloud.app");
    assert.ok(await cid.can(id, "spectre", "crm:write"));
    const grants = await ledger.query({ type: "grant", subject: id });
    assert.equal(grants.length, 1);
  });

  it("runs the CRM: accounts, people, deals, activity, today view, deal detail with audit trail", async () => {
    const { cookie } = await signUp("sam");
    const co = await call("POST", "/api/companies", { name: "Northwind Logistics", domain: "northwind.example", kind: "company" }, cookie);
    const ct = await call("POST", "/api/contacts", { name: "Dana Ruiz", title: "COO", companyId: co.body.id, influence: "decision-maker", email: "dana@northwind.example" }, cookie);
    await call("POST", "/api/relationships", { from: "me", to: ct.body.id, strength: 4 }, cookie);
    const deal = await call("POST", "/api/deals", { companyId: co.body.id, name: "Fleet rollout", amount: 120000, closeDate: "2026-12-15", contactIds: [ct.body.id] }, cookie);
    assert.equal(deal.status, 200, JSON.stringify(deal.body));
    await call("POST", `/api/deals/${deal.body.id}/stage`, { stage: "proposal" }, cookie);
    await call("POST", "/api/activities", { kind: "meeting", summary: "Walked through proposal", dealId: deal.body.id }, cookie);

    const today = await call("GET", "/api/today", undefined, cookie);
    assert.equal(today.body.totals.openDeals, 1);
    assert.equal(today.body.actions.length, 1);
    assert.equal(today.body.forecast.length, 3);

    const detail = await call("GET", `/api/deals/${deal.body.id}`, undefined, cookie);
    assert.ok(detail.body.score.probability > 0);
    assert.ok(detail.body.next.action);
    assert.deepEqual(detail.body.history.map((h: any) => h.payload.event), ["created", "stage_changed"]);

    const account = await call("GET", `/api/companies/${co.body.id}`, undefined, cookie);
    assert.equal(account.body.warmPath.steps.length, 1);
    assert.deepEqual(account.body.gaps, ["No champion identified"]);
    assert.ok(changes > 0, "persistence hook runs after writes");
  });

  it("keeps each person's workspace private", async () => {
    const a = await signUp("owner1");
    const b = await signUp("owner2");
    const co = await call("POST", "/api/companies", { name: "Secret Co" }, a.cookie);
    assert.equal((await call("GET", `/api/companies/${co.body.id}`, undefined, b.cookie)).status, 404);
    assert.equal((await call("GET", "/api/companies", undefined, b.cookie)).body.length, 0);
  });

  it("rejects unsigned-in requests and cross-site form posts", async () => {
    assert.equal((await call("GET", "/api/today")).status, 401);
    const { cookie } = await signUp("csrf-test");
    const forged = await call("POST", "/api/companies", { name: "Evil" }, cookie, {});
    assert.equal(forged.status, 403);
  });

  it("cuts off access the moment Spectre is revoked in the CID permissions dashboard", async () => {
    const { cookie, cid: id } = await signUp("revoker");
    assert.equal((await call("GET", "/api/today", undefined, cookie)).status, 200);
    await cid.revoke(id, "spectre");
    const res = await call("GET", "/api/today", undefined, cookie);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /revoked/);
  });

  it("signs out by revoking the CID session", async () => {
    const { cookie } = await signUp("leaver");
    await call("POST", "/api/auth/signout", {}, cookie);
    assert.equal((await call("GET", "/api/me", undefined, cookie)).status, 401);
  });

  it("merges duplicates from Data health and re-points deals", async () => {
    const { cookie } = await signUp("cleaner");
    const a = await call("POST", "/api/companies", { name: "Contoso Ltd", domain: "contoso.example" }, cookie);
    const b = await call("POST", "/api/companies", { name: "Contoso", domain: "contoso.example" }, cookie);
    const deal = await call("POST", "/api/deals", { companyId: b.body.id, name: "Renewal", amount: 5000, closeDate: "2026-12-01" }, cookie);
    const health = await call("GET", "/api/data-health", undefined, cookie);
    assert.equal(health.body.duplicateCompanies.length, 1);
    const g = health.body.duplicateCompanies[0];
    await call("POST", "/api/data-health/merge", { kind: "company", keepId: g.keep.id, mergeIds: g.duplicates.map((d: any) => d.id) }, cookie);
    const list = await call("GET", "/api/companies", undefined, cookie);
    assert.equal(list.body.length, 1);
    const d = await call("GET", `/api/deals/${deal.body.id}`, undefined, cookie);
    assert.equal(d.body.deal.companyId, a.body.id);
  });

  it("answers plain-language questions through Claude when connected, and says so when not", async () => {
    const { cookie } = await signUp("asker");
    aiKey = undefined;
    const off = await call("POST", "/api/ask", { question: "Which deals are at risk?" }, cookie);
    assert.equal(off.status, 503);
    assert.match(off.body.error, /isn't connected/);

    aiKey = "test-key";
    aiCalls = [];
    await call("POST", "/api/companies", { name: "Northwind" }, cookie);
    const on = await call("POST", "/api/ask", { question: "Which deals are at risk?" }, cookie);
    assert.equal(on.status, 200);
    assert.equal(on.body.answer, "Northwind fleet rollout is most at risk.");
    const sent = aiCalls[0].body;
    assert.equal(sent.model, "test-model");
    assert.match(sent.messages[1].content, /Northwind/);
    assert.ok(!sent.messages[1].content.includes("@"), "contact emails aren't sent to the model");
  });
});
