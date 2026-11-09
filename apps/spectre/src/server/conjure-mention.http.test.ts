import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { createConjureLive } from "@infinitum/conjure";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

describe("+SPCTR @conjure in Ask", () => {
  let server: Server;
  let base: string;
  const sent: any[] = [];
  let polls = 0;

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const crm = new SpectreCRM({ ledger, signer });
    // A fake hosted Conjure service.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const p = { id: "pr_abc", product: "spectre", question: "will Northwind sign?", agents: 16, rounds: 3, stats: [], createdAt: "2026-11-08T00:00:00Z", poles: { for: "Northwind signs", against: "no" } };
      if (init.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ...p, status: "queued", round: 0 }), { status: 202 });
      }
      polls++;
      return new Response(JSON.stringify({ ...p, status: "done", round: 3, report: { outcome: "Northwind signs in January.", probability: 0.64, confidence: "medium", forecast: "", drivers: ["COO backs it"], signals: [], assumptions: [] } }));
    }) as unknown as typeof fetch;
    const conjureLive = createConjureLive({ url: "https://conjure.test", key: "cjp_spectre_test", fetchImpl });
    const ai = { model: "m", apiKey: undefined };
    const app = createApp({ cid, crm, ai, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN, conjureLive });
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

  it("starts a live forecast seeded from the deal, and only its workspace can follow it", async () => {
    const me = await signUp("alex");
    const co = await call("POST", "/api/companies", { name: "Northwind Logistics" }, me);
    const deal = await call("POST", "/api/deals", { companyId: co.body.id, name: "Fleet rollout", amount: 180000, closeDate: "2026-12-20", stage: "proposal", contactIds: [] }, me);

    // Plain Ask still needs the AI key; @conjure goes to Conjure instead.
    const r = await call("POST", "/api/ask", { question: "@conjure will Northwind sign?", dealId: deal.body.id }, me);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.conjure.id, "pr_abc");
    assert.match(r.body.answer, /Conjure™ is forecasting/);
    assert.equal(sent[0].question, "will Northwind sign?");
    assert.equal(sent[0].source, "deal");
    assert.match(sent[0].context, /Fleet rollout with Northwind Logistics/);

    const live = await call("GET", "/api/conjure/live/pr_abc", undefined, me);
    assert.equal(live.status, 200);
    assert.match(live.body.text, /64% likely that Northwind signs/);

    const other = await signUp("sam");
    assert.equal((await call("GET", "/api/conjure/live/pr_abc", undefined, other)).status, 404);
    assert.equal(polls, 1);
  });

  it("a question without @conjure is a normal Ask", async () => {
    const me = await signUp("kim");
    const r = await call("POST", "/api/ask", { question: "Which deals are at risk?" }, me);
    assert.equal(r.status, 503); // no AI key in this test: the plain path, not Conjure
    assert.equal(sent.length, 1);
  });
});
