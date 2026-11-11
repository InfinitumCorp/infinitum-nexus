import { queuedRouter, scriptedRouter, textReply, toolReply } from "@infinitum/ai/testing";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import type { Complete } from "@infinitum/conjure";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

/** Minimal scripted model for Conjure prompts. */
const prompts: string[] = [];
const complete: Complete = async (system, user) => {
  prompts.push(user);
  if (system.includes("map the world")) return JSON.stringify({ summary: "s", poles: { for: "they sign", against: "they don't" }, entities: [{ id: "e1", name: "Northwind", kind: "organization", description: "buyer" }], relations: [], facts: ["f"] });
  if (system.includes("diverse, realistic personas")) {
    const n = Number(/Create (\d+)/.exec(user)![1]);
    return JSON.stringify({ personas: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, entityId: "e1", role: "buyer", traits: "t", goals: "g", stance: 0, influence: 3 })) });
  }
  if (system.includes("play several people")) {
    const ids = [...user.matchAll(/AGENT (a\d+):/g)].map((m) => m[1]);
    return JSON.stringify({ actions: ids.map((id) => ({ agentId: id, action: "post", text: `${id}: pricing worries me`, stanceShift: 0.1 })) });
  }
  return "In character: price is my main concern.";
};

describe("+SPCTR Conjure simulations over HTTP", () => {
  let server: Server;
  let base: string;
  let crm: SpectreCRM;
  let apiKey: string | undefined = "k";
  const reportReplies: unknown[] = [];

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    crm = new SpectreCRM({ ledger, signer });
    const scripted = scriptedRouter(() => reportReplies.shift());
    const ai = { get router() { return apiKey ? scripted.router : undefined; } };
    const app = createApp({ cid, crm, ai, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN, conjureComplete: complete });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-spectre": "1", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const signUp = async (username: string) => {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username });
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" }) });
    const res = await fetch(base + "/api/auth/signin/finish", { method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" },
      body: JSON.stringify({ response: auth.get({ credentialId: [...auth.credentials.keys()][0], challenge: f.body.options.challenge, origin: ORIGIN }) }) });
    return res.headers.get("set-cookie")!.split(";")[0];
  };

  let me: string;
  let simId: string;

  it("simulates a deal, seeded from its real records", async () => {
    me = await signUp("alex");
    const co = await call("POST", "/api/companies", { name: "Northwind Logistics", industry: "Logistics" }, me);
    const ct = await call("POST", "/api/contacts", { name: "Dana Ruiz", title: "COO", companyId: co.body.id, influence: "decision-maker" }, me);
    const deal = await call("POST", "/api/deals", { companyId: co.body.id, name: "Fleet rollout", amount: 180000, closeDate: "2026-12-20", stage: "proposal", contactIds: [ct.body.id] }, me);
    await call("POST", "/api/activities", { kind: "email", summary: "Dana asked for a 10% discount", inbound: true, dealId: deal.body.id }, me);

    const r = await call("POST", "/api/conjure", { dealId: deal.body.id, agents: 10, rounds: 3 }, me);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    simId = r.body.id;
    assert.equal(r.body.question, 'Will Northwind Logistics sign "Fleet rollout" by 2026-12-20?');
    assert.equal(r.body.agents, 10);
    assert.match(prompts[0], /Dana Ruiz, COO \(decision-maker\)/);
    assert.match(prompts[0], /asked for a 10% discount/);
  });

  it("runs rounds, accepts an injected event, and shows the feed", async () => {
    assert.equal((await call("POST", `/api/conjure/${simId}/step`, {}, me)).body.round, 1);
    const inj = await call("POST", `/api/conjure/${simId}/inject`, { text: "A competitor offers 20% off" }, me);
    assert.equal(inj.body.injections[0].round, 2);
    const r2 = await call("POST", `/api/conjure/${simId}/step`, {}, me);
    assert.equal(r2.body.round, 2);
    assert.ok(r2.body.latest.meanStance > 0);
    const full = await call("GET", `/api/conjure/${simId}`, undefined, me);
    assert.ok(full.body.feed.some((x: any) => x.author === "NEWS" && /competitor/.test(x.text)));
    assert.ok(full.body.feed.some((x: any) => x.author === "P0"));
  });

  it("forks to compare futures", async () => {
    const f = await call("POST", `/api/conjure/${simId}/fork`, { round: 1 }, me);
    assert.equal(f.status, 200);
    assert.equal(f.body.round, 1);
    assert.deepEqual(f.body.forkedFrom, { id: simId, round: 1 });
    const list = await call("GET", "/api/conjure", undefined, me);
    assert.equal(list.body.simulations.length, 2);
  });

  it("writes a report and interviews an agent", async () => {
    reportReplies.push(textReply(JSON.stringify({ outcome: "Likely to sign after a discount", probability: 0.64, forecast: "…", drivers: ["price"], signals: ["procurement call"], assumptions: [], confidence: "medium" })));
    const rep = await call("POST", `/api/conjure/${simId}/report`, {}, me);
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.equal(rep.body.probability, 0.64);
    const list = await call("GET", "/api/conjure", undefined, me);
    assert.equal(list.body.simulations.find((s: any) => s.id === simId).outcome, "Likely to sign after a discount");
    const iv = await call("POST", `/api/conjure/${simId}/interview`, { agentId: "a1", question: "What worries you?" }, me);
    assert.match(iv.body.answer, /price/);
  });

  it("keeps simulations private to the workspace and explains bad input", async () => {
    const other = await signUp("sam");
    assert.equal((await call("GET", `/api/conjure/${simId}`, undefined, other)).status, 404);
    const bad = await call("POST", "/api/conjure", { question: "Q?", seed: "short" }, me);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /seed material/);
  });
});
