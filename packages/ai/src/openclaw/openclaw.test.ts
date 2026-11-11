import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenClaw,
  createOpenClawRoutes,
  openClawFromEnv,
  openClawRoutesFromEnv,
  parseOpenClawMention,
  OpenClawError,
  OPENCLAW_NOT_CONNECTED,
} from "./openclaw.mjs";

const reply = (content: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status });
const fake = (fn: (url: string, init: RequestInit) => Response | Promise<Response>) => fn as unknown as typeof fetch;

describe("parseOpenClawMention", () => {
  it("finds @openclaw anywhere and takes it out of the task", () => {
    assert.deepEqual(parseOpenClawMention("@openclaw draft a follow-up to Northwind"), { task: "draft a follow-up to Northwind" });
    assert.deepEqual(parseOpenClawMention("Northwind went quiet. @OpenClaw ping them on Telegram"), { task: "Northwind went quiet. ping them on Telegram" });
    assert.deepEqual(parseOpenClawMention("＠openclaw: book the room"), { task: "book the room" });
    assert.deepEqual(parseOpenClawMention("@openclaw"), { task: "" });
  });

  it("ignores emails, longer handles and plain text", () => {
    assert.equal(parseOpenClawMention("write to me@openclaw.ai"), null);
    assert.equal(parseOpenClawMention("see openclaw.ai/@openclaw"), null);
    assert.equal(parseOpenClawMention("@openclaws are here"), null);
    assert.equal(parseOpenClawMention("what is at risk?"), null);
    assert.equal(parseOpenClawMention(undefined), null);
  });
});

describe("createOpenClaw", () => {
  it("calls the chat endpoint with the agent, the person's session and the token", async () => {
    const calls: { url: string; init: RequestInit; self: unknown }[] = [];
    const fetchImpl = (function (this: unknown, url: string, init: RequestInit) {
      calls.push({ url, init, self: this });
      return Promise.resolve(reply("Sent Northwind a follow-up."));
    }) as unknown as typeof fetch;
    const claw = createOpenClaw({ url: "https://claw.example.ts.net/", token: "tok_secret", agent: "openclaw/sales", fetch: fetchImpl });
    assert.equal(await claw.ask("follow up with Northwind", { user: "spctr:cid_1", context: "summary" }), "Sent Northwind a follow-up.");
    assert.equal(calls[0].url, "https://claw.example.ts.net/v1/chat/completions");
    assert.equal(calls[0].self, undefined, "fetch must be called as a plain function (Workers)");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok_secret");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, "openclaw/sales");
    assert.equal(body.user, "spctr:cid_1");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: "system", content: "summary" }, { role: "user", content: "follow up with Northwind" }]);
  });

  it("accepts content given as parts and caps long answers", async () => {
    const parts = createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => reply([{ type: "text", text: "a" }, { type: "text", text: "b" }])) });
    assert.equal(await parts.ask("x"), "ab");
    const long = createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => reply("z".repeat(50_000))) });
    assert.equal((await long.ask("x")).length, 20_000);
  });

  it("handleMention returns null without a mention and asks for a task after a bare one", async () => {
    const claw = createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => reply("done")) });
    assert.equal(await claw.handleMention("hello"), null);
    assert.deepEqual(await claw.handleMention("@openclaw do it", { user: "u" }), { text: "done", agent: "openclaw" });
    await assert.rejects(claw.handleMention("@openclaw"), (err: OpenClawError) => err.status === 400);
  });

  it("explains gateway failures without leaking the token", async () => {
    const cases: [number, RegExp][] = [[401, /refused Mail's token/], [404, /chatCompletions/], [429, /busy/], [500, /returned 500/]];
    for (const [status, msg] of cases) {
      const claw = createOpenClaw({ url: "https://claw.test", token: "tok_secret", product: "Mail", fetch: fake(() => new Response("tok_secret", { status })) });
      await assert.rejects(claw.ask("x"), (err: OpenClawError) => {
        assert.match(err.message, msg);
        assert.ok(!err.message.includes("tok_secret"));
        return true;
      });
    }
    const down = createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => { throw new TypeError("network"); }) });
    await assert.rejects(down.ask("x"), /Couldn't reach/);
    const empty = createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => reply("  ")) });
    await assert.rejects(empty.ask("x"), /empty/);
  });

  it("times out a stuck agent", async () => {
    const hang = fake((_u, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const claw = createOpenClaw({ url: "https://claw.test", token: "t", timeoutMs: 20, fetch: hang });
    await assert.rejects(claw.ask("x"), (err: OpenClawError) => err.status === 504);
  });

  it("refuses unsafe configuration", () => {
    assert.throws(() => createOpenClaw({ url: "http://claw.example.com", token: "t" }), /https/);
    assert.throws(() => createOpenClaw({ url: "https://user:pw@claw.test", token: "t" }), /OPENCLAW_GATEWAY_TOKEN/);
    assert.throws(() => createOpenClaw({ url: "https://claw.test", token: "" }), /not set/);
    assert.throws(() => createOpenClaw({ url: "https://claw.test", token: "t", agent: "gpt-4o" }), /not an OpenClaw agent/);
    assert.doesNotThrow(() => createOpenClaw({ url: "http://127.0.0.1:18789", token: "t" }));
    assert.equal(openClawFromEnv({}), null);
    assert.equal(openClawFromEnv({ OPENCLAW_GATEWAY_URL: "https://claw.test", OPENCLAW_GATEWAY_TOKEN: "t" })!.agent, "openclaw");
  });
});

describe("createOpenClawRoutes", () => {
  const sent: any[] = [];
  const claw = createOpenClaw({
    url: "https://claw.test", token: "tok_secret", agent: "openclaw/ops",
    fetch: fake((_u, init) => { sent.push(JSON.parse(String(init.body))); return reply("On it."); }),
  });
  const routes = createOpenClawRoutes({ openclaw: claw, product: "scalvs" });
  const post = (body: unknown, type = "application/json") => new Request("https://app.test/api/openclaw", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

  it("leaves other paths to the product", async () => {
    assert.equal(await routes(new Request("https://app.test/api/other"), { user: "u1" }), null);
  });

  it("needs a signed-in person", async () => {
    assert.equal((await routes(post({ text: "@openclaw x" }), {}))!.status, 401);
  });

  it("reports the connection without the gateway URL or token", async () => {
    const res = await routes(new Request("https://app.test/api/openclaw"), { user: "u1" });
    const body = await res!.json();
    assert.deepEqual(body, { connected: true, agent: "openclaw/ops" });
  });

  it("sends the task, the context and a per-person session", async () => {
    const res = await routes(post({ text: "@openclaw file this under Q4", context: "Thread: Q4 budget" }), { user: "cid_9", context: "Signed in as Ada" });
    assert.equal(res!.status, 200);
    const body = await res!.json();
    assert.deepEqual(body, { mention: true, text: "On it.", agent: "openclaw/ops" });
    const req = sent.at(-1);
    assert.equal(req.user, "scalvs:cid_9");
    assert.equal(req.messages[0].content, "Thread: Q4 budget\n\nSigned in as Ada");
    assert.equal(req.messages[1].content, "file this under Q4");
    assert.ok(!JSON.stringify(body).includes("tok_secret"));
  });

  it("says mention: false for ordinary text and rejects bad input", async () => {
    assert.deepEqual(await (await routes(post({ text: "hello" }), { user: "u" }))!.json(), { mention: false });
    assert.equal((await routes(post({ text: "@openclaw" }), { user: "u" }))!.status, 400);
    assert.equal((await routes(post({ nope: 1 }), { user: "u" }))!.status, 400);
    assert.equal((await routes(post({ text: "@openclaw x" }, "text/plain"), { user: "u" }))!.status, 415);
    assert.equal((await routes(new Request("https://app.test/api/openclaw", { method: "DELETE" }), { user: "u" }))!.status, 405);
  });

  it("is off until configured and says how to connect", async () => {
    const off = openClawRoutesFromEnv({}, { product: "mail" });
    assert.deepEqual(await (await off(new Request("https://app.test/api/openclaw"), { user: "u" }))!.json(), { connected: false, agent: null });
    const res = await off(post({ text: "@openclaw x" }), { user: "u" });
    assert.equal(res!.status, 503);
    assert.equal((await res!.json()).error, OPENCLAW_NOT_CONNECTED);
    // Plain text still passes through when OpenClaw is off.
    assert.deepEqual(await (await off(post({ text: "hi" }), { user: "u" }))!.json(), { mention: false });
  });

  it("stays off, not broken, with a bad URL", async () => {
    const bad = openClawRoutesFromEnv({ OPENCLAW_GATEWAY_URL: "http://claw.example.com", OPENCLAW_GATEWAY_TOKEN: "t" });
    assert.equal((await bad(post({ text: "@openclaw x" }), { user: "u" }))!.status, 503);
  });

  it("supports a per-user gateway", async () => {
    const perUser = createOpenClawRoutes({ openclaw: (user: string) => (user === "u1" ? claw : null) });
    assert.equal((await perUser(post({ text: "@openclaw x" }), { user: "u1" }))!.status, 200);
    assert.equal((await perUser(post({ text: "@openclaw x" }), { user: "u2" }))!.status, 503);
  });

  it("passes gateway errors through", async () => {
    const busy = createOpenClawRoutes({ openclaw: createOpenClaw({ url: "https://claw.test", token: "t", fetch: fake(() => new Response("", { status: 429 })) }) });
    const res = await busy(post({ text: "@openclaw x" }), { user: "u" });
    assert.equal(res!.status, 429);
    assert.match((await res!.json()).error, /busy/);
  });
});
