/** Infinitum Search in Mail: POST /api/web-search answers with checked citations, signed-in only, rate-limited. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { createSearch } from "@infinitum/ai/search";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";

const signer = generateSigner();
const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
let base = "";
const servers: ReturnType<ReturnType<typeof createMailApp>["server"]>[] = [];

async function start(search: Parameters<typeof createMailApp>[0]["search"]) {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const origin = `http://localhost:${port}`;
  const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [origin], mailOrigin: origin });
  const server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin, secureCookies: false, search }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  servers.push(server);
  return origin;
}
after(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); });

async function signedIn(origin: string, username: string) {
  let cookie = "";
  const auth = new VirtualAuthenticator();
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(origin + path, { method, headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, data: await res.json().catch(() => null) as any };
  };
  const a = await call("POST", "/api/auth/signup", { username });
  const b = await call("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: auth.create({ challenge: a.data.options.challenge, origin, rpId: "localhost" }) });
  await call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: b.data.options.allowCredentials[0].id, challenge: b.data.options.challenge, origin }) });
  return call;
}

const stub = () => createSearch({
  engines: [{ name: "stub", async search() { return [{ title: "DMARC explained", url: "https://example.org/dmarc", snippet: "DMARC aligns SPF and DKIM." }]; } }],
  crawl: async (url: string) => ({ url, title: "DMARC", description: "", text: "DMARC aligns SPF and DKIM with the From domain." }),
  chat: async () => "DMARC checks that SPF or DKIM align with the From domain [1]. It was invented in 1850 [4].",
});

describe("Mail web search", () => {
  let origin = "";
  before(async () => { origin = await start(stub()); base = origin; });

  it("answers with checked citations for a signed-in user, and refuses strangers", async () => {
    const anon = await fetch(`${base}/api/web-search`, { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1" }, body: JSON.stringify({ query: "x" }) });
    assert.equal(anon.status, 401);
    const call = await signedIn(origin, "dana");
    assert.deepEqual((await call("GET", "/api/web-search")).data, { connected: true, engines: ["stub"], answers: true });
    const r = await call("POST", "/api/web-search", { query: "what does DMARC check?" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.cited, [1]);
    assert.doesNotMatch(r.data.answer, /\[4\]/);
    assert.equal(r.data.sources[0].url, "https://example.org/dmarc");
    assert.equal((await call("POST", "/api/web-search", { query: " " })).status, 400);
  });

  it("limits each account to 12 searches a minute", async () => {
    const call = await signedIn(origin, "busy");
    for (let i = 0; i < 12; i++) assert.equal((await call("POST", "/api/web-search", { query: "q" })).status, 200);
    assert.equal((await call("POST", "/api/web-search", { query: "q" })).status, 429);
  });

  it("says how to turn it on when no engine is set", async () => {
    const o = await start(null);
    const call = await signedIn(o, "lee");
    const r = await call("POST", "/api/web-search", { query: "q" });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /SEARXNG_URL/);
  });
});
