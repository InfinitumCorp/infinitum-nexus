import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { createSearch } from "@infinitum/ai/search";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

describe("+SPCTR @search in Ask", () => {
  const servers: Server[] = [];
  const asked: string[] = [];
  const prompts: string[] = [];

  async function start(withSearch: boolean) {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const crm = new SpectreCRM({ ledger, signer });
    const pages = (async (url: string) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(`<title>Northwind news</title><article>${"Northwind raised a Series B. ".repeat(20)}</article>`, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const search = withSearch
      ? createSearch({
          engines: [{ name: "test", search: async (q: string) => { asked.push(q); return [{ title: "Northwind news", url: "https://news.example/northwind", snippet: "Series B" }]; } }],
          fetch: pages,
          chat: async (messages) => { prompts.push(messages.map((m) => m.content).join("\n")); return "Northwind raised a Series B [1]."; },
        })
      : null;
    const app = createApp({ cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN, openclaw: null, conjureLive: null, search });
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

  it("answers from the web with numbered sources, sending only the question", async () => {
    const me = await signUp(base, "morgan");
    await call(base, "POST", "/api/companies", { name: "Secretco", kind: "enterprise" }, me.cookie);
    const res = await call(base, "POST", "/api/ask", { question: "@search did Northwind raise money?" }, me.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, "Northwind raised a Series B [1].\n\nSources\n[1] Northwind news — https://news.example/northwind");
    assert.equal(res.body.search.sources[0].url, "https://news.example/northwind");
    assert.equal(asked.at(-1), "did Northwind raise money?");
    assert.ok(!prompts.at(-1)!.includes("Secretco"), "workspace data must not reach the web search");
  });

  it("needs a signed-in person, and asks for a question after a bare @search", async () => {
    assert.equal((await call(base, "GET", "/api/web-search")).status, 401);
    const me = await signUp(base, "casey");
    assert.deepEqual((await call(base, "GET", "/api/web-search", undefined, me.cookie)).body, { connected: true, engines: ["test"], answers: true });
    assert.equal((await call(base, "POST", "/api/ask", { question: "@search" }, me.cookie)).status, 400);
  });

  it("says how to connect search when it isn't set up", async () => {
    const off = await start(false);
    const me = await signUp(off, "jordan");
    const res = await call(off, "POST", "/api/ask", { question: "@search anything" }, me.cookie);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /SEARXNG_URL/);
    assert.deepEqual((await call(off, "GET", "/api/web-search", undefined, me.cookie)).body, { connected: false, engines: [], answers: false });
  });
});
