import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenClaw, openClawFromEnv, parseOpenClawMention, OpenClawError } from "./openclaw.ts";

const reply = (content: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status });

describe("OpenClaw client", () => {
  it("parses @openclaw anywhere in the text", () => {
    assert.deepEqual(parseOpenClawMention("@openclaw draft a follow-up to Northwind"), { task: "draft a follow-up to Northwind" });
    assert.deepEqual(parseOpenClawMention("Northwind went quiet. @OpenClaw ping them on Telegram"), { task: "Northwind went quiet. ping them on Telegram" });
    assert.deepEqual(parseOpenClawMention("@openclaw"), { task: "" });
    assert.equal(parseOpenClawMention("email openclaw@example.com"), null);
    assert.equal(parseOpenClawMention("what is at risk?"), null);
  });

  it("calls the gateway's chat endpoint with the agent, the person's session and the token", async () => {
    const calls: { url: string; init: RequestInit; self: unknown }[] = [];
    const fetchImpl = (function (this: unknown, url: string, init: RequestInit) {
      calls.push({ url, init, self: this });
      return Promise.resolve(reply("Sent Northwind a follow-up."));
    }) as unknown as typeof fetch;
    const claw = createOpenClaw({ url: "https://claw.example.ts.net/", token: "tok_secret", agent: "openclaw/sales", fetchImpl });
    const answer = await claw.ask("follow up with Northwind", { user: "spctr:cid_1", context: "summary" });
    assert.equal(answer, "Sent Northwind a follow-up.");
    assert.equal(calls[0].url, "https://claw.example.ts.net/v1/chat/completions");
    assert.equal(calls[0].self, undefined, "fetch must be called as a plain function (Workers)");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok_secret");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, "openclaw/sales");
    assert.equal(body.user, "spctr:cid_1");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: "system", content: "summary" }, { role: "user", content: "follow up with Northwind" }]);
  });

  it("accepts content given as parts", async () => {
    const claw = createOpenClaw({ url: "https://claw.test", token: "t", fetchImpl: (async () => reply([{ type: "text", text: "a" }, { type: "text", text: "b" }])) as unknown as typeof fetch });
    assert.equal(await claw.ask("x", { user: "u" }), "ab");
  });

  it("explains gateway failures without leaking the token", async () => {
    const cases: [number, RegExp][] = [[401, /refused/], [404, /chatCompletions/], [429, /busy/], [500, /returned 500/]];
    for (const [status, msg] of cases) {
      const claw = createOpenClaw({ url: "https://claw.test", token: "tok_secret", fetchImpl: (async () => new Response("no", { status })) as unknown as typeof fetch });
      await assert.rejects(claw.ask("x", { user: "u" }), (err: OpenClawError) => {
        assert.match(err.message, msg);
        assert.ok(!err.message.includes("tok_secret"));
        return true;
      });
    }
    const down = createOpenClaw({ url: "https://claw.test", token: "t", fetchImpl: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch });
    await assert.rejects(down.ask("x", { user: "u" }), /Couldn't reach/);
    const empty = createOpenClaw({ url: "https://claw.test", token: "t", fetchImpl: (async () => reply("  ")) as unknown as typeof fetch });
    await assert.rejects(empty.ask("x", { user: "u" }), /empty/);
  });

  it("times out a stuck agent", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const claw = createOpenClaw({ url: "https://claw.test", token: "t", timeoutMs: 20, fetchImpl: hang });
    await assert.rejects(claw.ask("x", { user: "u" }), (err: OpenClawError) => err.status === 504);
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
