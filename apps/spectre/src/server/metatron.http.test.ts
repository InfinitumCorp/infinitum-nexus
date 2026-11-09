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

describe("METATRON learned model over HTTP", () => {
  let server: Server;
  let base: string;
  let crm: SpectreCRM;
  let clock = Date.parse("2026-01-01T00:00:00Z");

  before(async () => {
    process.env.USE_METATRON = "1";
    resetLearnedCache();
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    crm = new SpectreCRM({ ledger, signer, clock: () => new Date(clock) });
    const ai = {};
    const app = createApp({ cid, crm, ai, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN });
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

  it("requires sign-in", async () => {
    assert.equal((await call("GET", "/api/metatron/backtest")).status, 401);
    assert.equal((await call("GET", "/api/metatron")).status, 401);
  });

  it("reports the default model and an unready backtest, then switches once enough deals close", async () => {
    const { cookie, cid } = await signUp("morgan");
    const me = await call("GET", "/api/me", undefined, cookie);
    const ws = me.body.workspace as string;
    const co = await crm.addCompany(ws, cid, { name: "Northwind", industry: "logistics" });

    const status0 = await call("GET", "/api/metatron", undefined, cookie);
    assert.equal(status0.status, 200);
    assert.equal(status0.body.model, "metatron-default-v1");
    assert.equal(status0.body.closedDeals, 0);
    const bt0 = await call("GET", "/api/metatron/backtest", undefined, cookie);
    assert.deepEqual(bt0.body, { ready: false, reason: "needs 30 closed deals, has 0", closedDeals: 0 });

    // 40 closed deals: customers who replied mostly bought.
    for (let i = 0; i < 40; i++) {
      clock += DAY;
      const d = await crm.addDeal(ws, cid, { companyId: co.id, name: `Deal ${i}`, amount: 10_000, closeDate: "2026-06-01" });
      const replied = i % 2 === 0;
      await crm.logActivity(ws, cid, { kind: "email", summary: "follow-up", dealId: d.id, inbound: replied });
      clock += DAY;
      const won = replied ? i % 10 !== 0 : i % 10 === 5;
      await crm.moveDeal(ws, cid, d.id, won ? "won" : "lost", won ? undefined : "No budget");
    }

    const status1 = await call("GET", "/api/metatron", undefined, cookie);
    assert.equal(status1.body.model, "metatron-logistic-v1");
    assert.equal(status1.body.closedDeals, 40);
    const metrics = await call("GET", "/api/metrics", undefined, cookie);
    assert.equal(metrics.body.metatronModel, "metatron-logistic-v1");

    const bt = await call("GET", "/api/metatron/backtest?holdout=0.25", undefined, cookie);
    assert.equal(bt.status, 200);
    assert.equal(bt.body.ready, true);
    assert.equal(bt.body.trainSize, 30);
    assert.equal(bt.body.testSize, 10);
    assert.ok(["learned", "default"].includes(bt.body.better));
    assert.ok(typeof bt.body.learned.brier === "number");

    const open = await crm.addDeal(ws, cid, { companyId: co.id, name: "Open", amount: 10_000, closeDate: "2026-06-01" });
    const detail = await call("GET", `/api/deals/${open.id}`, undefined, cookie);
    assert.ok(detail.body.score.probability > 0 && detail.body.score.probability < 1);
    assert.ok(detail.body.score.factors.length > 0);
    // Every deal closed from "lead", so the model learned stage from history.
    const closed = (await crm.list("deals", ws)).filter((d) => d.stage === "won" || d.stage === "lost");
    assert.ok(closed.every((d) => d.closedFrom === "lead"));
  });
});
