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

/** SCALVS.ai agents inside +SPCTR, with Claude replaced by a script. */
describe("+SPCTR SCALVS.ai agents over HTTP", () => {
  let server: Server;
  let base: string;
  let ledger: Ledger;
  let crm: SpectreCRM;
  let apiKey: string | undefined = "test-key";
  const script: unknown[] = [];
  const requests: any[] = [];

  before(async () => {
    const signer = generateSigner();
    ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    crm = new SpectreCRM({ ledger, signer });
    const ai = {
      model: "test-model",
      get apiKey() { return apiKey; },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(script.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }), { status: 200 });
      }) as typeof fetch,
    };
    const app = createApp({ cid, crm, ai, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-spectre": "1", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  async function signUp(username: string) {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username });
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" }) });
    const res = await fetch(base + "/api/auth/signin/finish", {
      method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" },
      body: JSON.stringify({ response: auth.get({ credentialId: [...auth.credentials.keys()][0], challenge: f.body.options.challenge, origin: ORIGIN }) }),
    });
    return { cookie: res.headers.get("set-cookie")!.split(";")[0], cid: s.body.cid as string };
  }

  const toolUse = (name: string, input: Record<string, unknown>) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }], usage: { input_tokens: 10, output_tokens: 5 } });
  const final = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });

  let me: { cookie: string; cid: string };
  let dealId: string;
  let companyId: string;

  it("lists the six agents from the website", async () => {
    me = await signUp("alex");
    const r = await call("GET", "/api/agents", undefined, me.cookie);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.agents.map((a: any) => a.name), ["Researcher", "Prospector", "Deal coach", "Account manager", "Proposal writer", "Analyst"]);
    assert.equal(r.body.aiConnected, true);
    assert.deepEqual(r.body.agents.find((a: any) => a.id === "analyst").canPropose, [], "the Analyst only reads");
  });

  it("runs an agent that reads real records and proposes a task, which waits for approval", async () => {
    const co = await call("POST", "/api/companies", { name: "Northwind Logistics" }, me.cookie);
    companyId = co.body.id;
    const deal = await call("POST", "/api/deals", { companyId, name: "Fleet rollout", amount: 120000, closeDate: "2026-12-15", stage: "proposal" }, me.cookie);
    assert.equal(deal.status, 200, JSON.stringify(deal.body));
    dealId = deal.body.id;

    script.push(toolUse("list_open_deals", {}), toolUse("create_task", { summary: "Call Northwind about the proposal", dealId, dueDate: "2026-11-10" }), final("Fleet rollout needs a call. I proposed a task; it's waiting for your approval."));
    const r = await call("POST", "/api/agents/deal-coach/run", { prompt: "What should I do on my deals?" }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.run.output, /waiting for your approval/);
    assert.deepEqual(r.body.run.steps.map((s: any) => s.tool), ["list_open_deals", "create_task"]);
    // The model saw the real deal, with its score.
    const seen = JSON.parse(requests.at(-2).messages[2].content[0].content);
    assert.equal(seen[0].name, "Fleet rollout");
    assert.equal(typeof seen[0].winProbability, "number");

    assert.equal(r.body.proposals.length, 1);
    assert.match(r.body.proposals[0].summary, /Task on Fleet rollout: Call Northwind/);
    assert.equal(crm.list("activities", me.cid).filter((a) => a.kind === "task").length, 0, "nothing changed before approval");
  });

  it("approving carries out the action and records who approved it", async () => {
    const pending = await call("GET", "/api/agents/proposals", undefined, me.cookie);
    assert.equal(pending.body.length, 1);
    const id = pending.body[0].id;
    const ok = await call("POST", `/api/agents/proposals/${id}/approve`, {}, me.cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "approved");
    const task = crm.list("activities", me.cid).find((a) => a.kind === "task")!;
    assert.equal(task.summary, "Call Northwind about the proposal");
    assert.equal(task.dueAt, "2026-11-10T09:00:00.000Z");
    assert.equal(task.actorCid, me.cid);
    assert.equal((await call("POST", `/api/agents/proposals/${id}/approve`, {}, me.cookie)).status, 409, "can't approve twice");

    const events = (await ledger.query({ product: "spectre", subject: "agent:deal-coach" })).map((e) => e.payload.event);
    assert.deepEqual(events, ["agent.run", "proposal.approved"]);
    assert.equal((await ledger.verify()).ok, true);
  });

  it("dismissing changes nothing", async () => {
    script.push(toolUse("add_fact", { companyId, field: "funding", value: "Series B", source: "https://news.example/nw" }), final("Proposed one fact."));
    const r = await call("POST", "/api/agents/researcher/run", { prompt: "research Northwind" }, me.cookie);
    const id = r.body.proposals[0].id;
    const d = await call("POST", `/api/agents/proposals/${id}/dismiss`, {}, me.cookie);
    assert.equal(d.body.status, "dismissed");
    assert.equal(crm.company(me.cid, companyId).facts.length, 0);
  });

  it("keeps each workspace's proposals private", async () => {
    script.push(toolUse("log_note", { text: "secret plan", dealId }), final("ok"));
    const r = await call("POST", "/api/agents/deal-coach/run", { prompt: "note" }, me.cookie);
    const other = await signUp("sam");
    assert.equal((await call("POST", `/api/agents/proposals/${r.body.proposals[0].id}/approve`, {}, other.cookie)).status, 404);
    assert.equal((await call("GET", "/api/agents/proposals", undefined, other.cookie)).body.length, 0);
  });

  it("runs every read tool against real data without errors", async () => {
    script.push(
      toolUse("list_accounts", {}), toolUse("get_account", { companyId }), toolUse("get_deal", { dealId }),
      toolUse("pipeline_forecast", { months: 2 }), toolUse("data_health", {}), final("Summary."),
    );
    // Analyst lacks get_account/get_deal: those come back as unknown tools; the rest must succeed.
    const r = await call("POST", "/api/agents/analyst/run", { prompt: "board summary" }, me.cookie);
    const steps = r.body.run.steps;
    assert.deepEqual(steps.filter((s: any) => !s.error).map((s: any) => s.tool), ["list_accounts", "pipeline_forecast", "data_health"]);
    assert.deepEqual(steps.filter((s: any) => s.error).map((s: any) => s.error), ["unknown tool", "unknown tool"]);
    assert.equal(steps.find((s: any) => s.tool === "pipeline_forecast").result.forecast.length, 2);

    script.push(toolUse("get_account", { companyId }), toolUse("get_deal", { dealId }), final("ok"));
    const coach = await call("POST", "/api/agents/deal-coach/run", { prompt: "look" }, me.cookie);
    assert.ok(coach.body.run.steps.every((s: any) => !s.error), JSON.stringify(coach.body.run.steps));
    assert.equal(coach.body.run.steps[0].result.deals[0].name, "Fleet rollout");
  });

  it("rehearses a deal with the Deal coach, grounded in that deal", async () => {
    script.push(final("Likely objections: price, timing. (Assumption: procurement joins.)"));
    const r = await call("POST", "/api/rehearse", { dealId }, me.cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.run.agentId, "deal-coach");
    assert.match(requests.at(-1).messages[0].content, new RegExp(dealId));
  });

  it("says plainly when AI isn't connected instead of faking output", async () => {
    apiKey = undefined;
    const r = await call("POST", "/api/agents/researcher/run", { prompt: "research" }, me.cookie);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /ANTHROPIC_API_KEY/);
    assert.equal((await call("GET", "/api/agents", undefined, me.cookie)).body.aiConnected, false);
    apiKey = "test-key";
  });

  it("keeps the other routes that used to be broken working", async () => {
    assert.equal((await call("GET", "/api/execution/pending", undefined, me.cookie)).status, 200);
    script.push(final("No obvious prospects yet."));
    assert.equal((await call("POST", "/api/prospect", {}, me.cookie)).status, 200);
  });
});
