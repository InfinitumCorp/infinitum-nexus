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
import { resetLearnedCache } from "../core/metatron-learned.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";
const DAY = 86_400_000;

describe("METATRON¹⁰⁰ scenarios, forecasts and signals over HTTP", () => {
  let server: Server;
  let base: string;
  let crm: SpectreCRM;
  let clock = Date.parse("2026-03-02T09:00:00Z"); // a Monday

  before(async () => {
    process.env.USE_METATRON = "1";
    resetLearnedCache();
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    crm = new SpectreCRM({ ledger, signer, clock: () => new Date(clock) });
    const app = createApp({ cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-spectre": "1", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get("set-cookie") };
  };

  async function signUp(username: string) {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username });
    const reg = auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" });
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: reg });
    const credentialId = [...auth.credentials.keys()][0];
    const resp = auth.get({ credentialId, challenge: f.body.options.challenge, origin: ORIGIN });
    const signin = await call("POST", "/api/auth/signin/finish", { response: resp });
    assert.equal(signin.status, 200, JSON.stringify(signin.body));
    return { cookie: signin.setCookie!.split(";")[0]!, cid: s.body.cid as string };
  }

  let cookie = "";
  let cid = "";

  it("requires sign-in", async () => {
    for (const [m, p] of [["GET", "/api/metatron/templates"], ["POST", "/api/metatron/compare"], ["GET", "/api/metatron/outlook"], ["GET", "/api/metatron/signals"]] as const) {
      assert.equal((await call(m, p, m === "POST" ? {} : undefined)).status, 401, p);
    }
    ({ cookie, cid } = await signUp("ada"));
  });

  it("lists templates and compares one with sensitivity", async () => {
    const t = await call("GET", "/api/metatron/templates", undefined, cookie);
    assert.equal(t.status, 200);
    assert.deepEqual(t.body.templates.map((x: { id: string }) => x.id), ["rate-decision", "supply-delay", "product-adoption", "cash-runway"]);

    const c = await call("POST", "/api/metatron/compare", { templateId: "supply-delay", runs: 200, seed: 7, sensitivity: true }, cookie);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.runs, 200);
    assert.equal(c.body.capped, false);
    assert.equal(c.body.scenarios.length, 3);
    assert.ok(c.body.baseline.events.stockout.probability >= 0);
    assert.equal(c.body.sensitivity.output, "lostSales");
    assert.ok(c.body.sensitivity.rows.length >= 1);
    assert.equal(c.body.baseline.finalRuns, undefined, "per-run arrays stay on the server");
  });

  it("lowers runs to fit the work budget for agent models", async () => {
    const c = await call("POST", "/api/metatron/compare", { templateId: "product-adoption", runs: 5000 }, cookie);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.capped, true);
    assert.ok(c.body.runs >= 20 && c.body.runs < 5000);
    const huge = await call("POST", "/api/metatron/simulate", { model: { steps: 1000, state: { x: 0 }, update: { x: "x" }, agents: { count: 100000, state: { a: 0 }, update: {} } } }, cookie);
    assert.equal(huge.status, 400);
    assert.match(huge.body.error, /too large/);
  });

  it("runs a custom model and explains bad formulas", async () => {
    const model = {
      steps: 6,
      variables: { growth: { kind: "normal", mean: 0.1, sd: 0.02 } },
      state: { users: 100 },
      update: { users: "users * (1 + growth)" },
    };
    const ok = await call("POST", "/api/metatron/simulate", { model, runs: 100, seed: 1, events: { doubled: "users >= 200" } }, cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.final.users.p50 > 150 && ok.body.final.users.p50 < 200);
    assert.equal(ok.body.series.users.mean.length, 6);
    assert.ok(ok.body.events.doubled.probability < 0.5);

    const bad = await call("POST", "/api/metatron/simulate", { model: { ...model, update: { users: "users * (1 + grwth)" } } }, cookie);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /update\.users: unknown name "grwth"/);
    const none = await call("POST", "/api/metatron/compare", { model }, cookie);
    assert.equal(none.status, 400);
    const unknown = await call("POST", "/api/metatron/compare", { templateId: "nope" }, cookie);
    assert.equal(unknown.status, 404);
  });

  it("forecasts a posted series", async () => {
    const values = Array.from({ length: 30 }, (_, i) => 50 + 2 * i + (i % 3));
    const f = await call("POST", "/api/metatron/forecast", { values, horizon: 4, level: 0.9 }, cookie);
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.point.length, 4);
    assert.ok(f.body.point[0] > 100 && f.body.point[0] < 120);
    assert.equal((await call("POST", "/api/metatron/forecast", { values: ["a"] }, cookie)).status, 400);
  });

  it("gives a pipeline outlook with a what-if, and weekly signals", async () => {
    const me = await call("GET", "/api/me", undefined, cookie);
    const ws = me.body.workspace as string;
    const co = await crm.addCompany(ws, cid, { name: "Contoso", industry: "retail" });
    // 12 weeks of history: steady new deals and activity, then a burst of wins.
    for (let w = 0; w < 12; w++) {
      clock += 7 * DAY;
      const d = await crm.addDeal(ws, cid, { companyId: co.id, name: `Hist ${w}`, amount: 5_000, closeDate: "2026-12-01" });
      await crm.logActivity(ws, cid, { kind: "call", summary: "check-in", dealId: d.id });
      if (w % 2 === 0) await crm.moveDeal(ws, cid, d.id, "won");
    }
    const soon = new Date(clock + 30 * DAY).toISOString().slice(0, 10);
    const later = new Date(clock + 400 * DAY).toISOString().slice(0, 10);
    for (let i = 0; i < 4; i++) {
      const d = await crm.addDeal(ws, cid, { companyId: co.id, name: `Open ${i}`, amount: 20_000, closeDate: soon });
      await crm.moveDeal(ws, cid, d.id, "negotiation");
    }
    await crm.addDeal(ws, cid, { companyId: co.id, name: "Next year", amount: 99_000, closeDate: later });

    const o = await call("GET", "/api/metatron/outlook?horizonDays=90&target=40000&whatIfStage=negotiation&whatIfChange=20", undefined, cookie);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const usd = o.body.byCurrency[0];
    // Only the 4 negotiation deals close within 90 days; 6 open history deals (December) and "Next year" wait.
    assert.equal(usd.deals, 4);
    assert.equal(o.body.later, 7);
    assert.equal(usd.pipeline, 80_000);
    assert.ok(usd.p10 <= usd.p50 && usd.p50 <= usd.p90);
    assert.ok(usd.expected > 0 && usd.expected < 80_000);
    assert.ok(usd.probTarget >= 0 && usd.probTarget <= 1);
    assert.equal(usd.drivers.length, 4);
    const w = o.body.whatIf.byCurrency[0];
    assert.ok(w.expected > usd.expected, "a better negotiation win rate books more");
    assert.ok(w.probTarget >= usd.probTarget);
    assert.equal((await call("GET", "/api/metatron/outlook?whatIfStage=won&whatIfChange=5", undefined, cookie)).status, 400);

    const s = await call("GET", "/api/metatron/signals?weeks=16", undefined, cookie);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.weeks.length, 16);
    assert.equal(s.body.series.newDeals.reduce((a: number, b: number) => a + b, 0), 17);
    assert.equal(s.body.series.wonValue.reduce((a: number, b: number) => a + b, 0), 30_000);
    assert.ok(Array.isArray(s.body.notable));
    assert.ok(s.body.bookings === null || s.body.bookings.point.length === 8);
  });
});
