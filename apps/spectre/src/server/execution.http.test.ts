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
const DAY = 86_400_000;

describe("AI actions over HTTP", () => {
  let server: Server;
  let base: string;
  let crm: SpectreCRM;
  let clock = Date.parse("2026-03-02T09:00:00Z"); // a Monday

  before(async () => {
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

  it("logs AI action notes only in the caller's workspace, once a day", async () => {
    assert.equal((await call("POST", "/api/execution/run", {})).status, 401);
    const ada = await signUp("ada");
    const bob = await signUp("bob");
    const co = (await call("POST", "/api/companies", { name: "Northwind" }, ada.cookie)).body;
    const deal = (await call("POST", "/api/deals", { companyId: co.id, name: "Routing pilot", amount: 48000, closeDate: "2026-04-30" }, ada.cookie)).body;
    clock += 40 * DAY; // no contact for weeks: the re-engagement rule matches

    const first = await call("POST", "/api/execution/run", {}, ada.cookie);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.pending >= 1);
    assert.ok(first.body.logged >= 1);
    assert.ok(first.body.results.every((r: { dealId: string }) => r.dealId === deal.id));

    const notes = crm.list("activities", ada.cid).filter((a) => a.summary.startsWith("[auto] "));
    assert.equal(notes.length, first.body.logged);
    assert.ok(notes.every((a) => a.dealId === deal.id && a.kind === "note" && a.actorCid === ada.cid));
    assert.equal(crm.list("activities", bob.cid).length, 0, "nothing written to another workspace");
    assert.equal(crm.list("activities", "demo").length, 0, "nothing written to a shared demo workspace");

    const again = await call("POST", "/api/execution/run", {}, ada.cookie);
    assert.equal(again.body.logged, 0, "the same notes aren't repeated the same day");
    assert.equal(crm.list("activities", ada.cid).filter((a) => a.summary.startsWith("[auto] ")).length, notes.length);

    const empty = await call("POST", "/api/execution/run", {}, bob.cookie);
    assert.deepEqual([empty.body.pending, empty.body.logged], [0, 0]);
  });
});
