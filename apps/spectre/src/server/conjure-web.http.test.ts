/** Conjure seeds a forecast from the web (Infinitum Search) when no material is given. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { createSearch } from "@infinitum/ai/search";
import type { Complete } from "@infinitum/conjure";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

const seeds: string[] = [];
const complete: Complete = async (system, user) => {
  if (system.includes("map the world")) {
    seeds.push(user);
    return JSON.stringify({ summary: "s", poles: { for: "cut", against: "hold" }, entities: [{ id: "e1", name: "Bank", kind: "organization", description: "central bank" }], relations: [], facts: ["f"] });
  }
  if (system.includes("diverse, realistic personas")) {
    const n = Number(/Create (\d+)/.exec(user)![1]);
    return JSON.stringify({ personas: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, entityId: "e1", role: "economist", traits: "t", goals: "g", stance: 0, influence: 3 })) });
  }
  return "{}";
};

describe("+SPCTR Conjure seeded from the web", () => {
  let server: Server;
  let base: string;
  const searched: string[] = [];

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const crm = new SpectreCRM({ ledger, signer });
    const search = createSearch({
      engines: [{ name: "stub", async search(q: string) { searched.push(q); return [{ title: "Bank minutes", url: "https://example.org/minutes", snippet: "Two members favoured a cut." }]; } }],
      crawl: async (url: string) => ({ url, title: "Minutes", description: "", text: "Two of nine members favoured a cut." }),
      chat: async () => "Two of nine members favoured a cut [1].",
    });
    const app = createApp({ cid, crm, ai: { router: undefined }, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN, conjureComplete: complete, search });
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

  it("researches the question, seeds the world model with the cited brief, and keeps the sources", async () => {
    const me = await signUp("alex");
    const r = await call("POST", "/api/conjure", { question: "Will the bank cut rates in December?", agents: 4, rounds: 1 }, me);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(searched.length, 1);
    assert.match(searched[0]!, /Will the bank cut rates in December\?/);
    assert.match(seeds.at(-1)!, /Two of nine members favoured a cut \[1\]/);
    assert.match(seeds.at(-1)!, /https:\/\/example.org\/minutes/);
    assert.deepEqual(r.body.webSources, [{ n: 1, title: "Bank minutes", url: "https://example.org/minutes" }]);
  });

  it("uses the material it's given without searching", async () => {
    const me = await signUp("sam");
    const before = searched.length;
    const r = await call("POST", "/api/conjure", { question: "Cut?", seed: "The bank's last three meetings held rates; inflation is falling toward target.", agents: 4, rounds: 1 }, me);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(searched.length, before);
    assert.equal(r.body.webSources, undefined);
  });
});
