import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConjureMention, formatForecast, createConjureLive, handleConjureMention, conjureLiveFromEnv, ConjureApiError } from "./mention.ts";

describe("@conjure mention", () => {
  it("takes the question after the mention and the text before as context", () => {
    assert.deepEqual(parseConjureMention("CFO went quiet. @conjure will Acme sign by March?"), { question: "will Acme sign by March?", context: "CFO went quiet." });
  });
  it("uses the text before when nothing follows", () => {
    assert.equal(parseConjureMention("Will rates fall in June? @Conjure")!.question, "Will rates fall in June?");
  });
  it("ignores emails, longer handles and plain text", () => {
    for (const t of ["sales@conjure.com", "@conjured", "conjure", "a/@conjure", 42]) assert.equal(parseConjureMention(t), null, String(t));
  });
  it("formats a forecast as a reply", () => {
    const text = formatForecast({ agents: 16, rounds: 3, poles: { for: "it signs", against: "no" }, report: { outcome: "Signs late.", probability: 0.62, confidence: "medium", forecast: "", drivers: ["budget"], signals: [], assumptions: [] } });
    assert.match(text, /62% likely that it signs/);
  });
});

describe("hosted Conjure client", () => {
  /** A fake Conjure service: queued → running → done over three polls. */
  function fakeService() {
    const calls: { method: string; url: string; auth: string | null; body: any }[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method!, url, auth: headers.get("authorization"), body });
      if (headers.get("authorization") !== "Bearer cjp_spectre_x") return new Response(JSON.stringify({ error: "sign in required" }), { status: 401 });
      const base = { id: "pr_1", product: "spectre", question: "will Acme renew?", agents: 8, rounds: 2, stats: [], createdAt: "2026-11-08T00:00:00Z", poles: { for: "Acme renews", against: "no" } };
      if (init.method === "POST") return new Response(JSON.stringify({ ...base, status: "queued", round: 0 }), { status: 202 });
      polls++;
      if (polls < 3) return new Response(JSON.stringify({ ...base, status: "running", round: polls }));
      return new Response(JSON.stringify({ ...base, status: "done", round: 2, report: { outcome: "Renews", probability: 0.7, confidence: "medium", forecast: "", drivers: [], signals: [], assumptions: [] } }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("runs a mention to a finished forecast and reports progress", async () => {
    const svc = fakeService();
    const client = createConjureLive({ url: "https://conjure.test/", key: "cjp_spectre_x", fetchImpl: svc.fetchImpl, pollMs: 1 });
    const progress: string[] = [];
    const out = await handleConjureMention(client, "Champion left. @conjure will Acme renew?", { user: "u1", source: "deal", context: "Deal: Acme renewal", onProgress: (p) => progress.push(`${p.status}:${p.round}`) });
    assert.equal(out!.prediction!.status, "done");
    assert.match(out!.text, /70% likely that Acme renews/);
    assert.deepEqual(progress, ["running:1", "running:2", "done:2"]);
    const start = svc.calls[0];
    assert.equal(start.url, "https://conjure.test/v1/predictions");
    assert.equal(start.body.question, "will Acme renew?");
    assert.equal(start.body.context, "Champion left.\n\nDeal: Acme renewal");
  });

  it("returns null without a mention and a hint for a bare one, without calling the service", async () => {
    const svc = fakeService();
    const client = createConjureLive({ url: "https://conjure.test", key: "cjp_spectre_x", fetchImpl: svc.fetchImpl });
    assert.equal(await handleConjureMention(client, "hello"), null);
    assert.match((await handleConjureMention(client, "@conjure"))!.text, /Ask Conjure/);
    assert.equal(svc.calls.length, 0);
  });

  it("surfaces service errors with their status", async () => {
    const svc = fakeService();
    const client = createConjureLive({ url: "https://conjure.test", key: "wrong", fetchImpl: svc.fetchImpl });
    await assert.rejects(client.start("q"), (e: unknown) => e instanceof ConjureApiError && e.status === 401);
  });

  it("is off when CONJURE_URL or CONJURE_PRODUCT_KEY is missing", () => {
    assert.equal(conjureLiveFromEnv({}), null);
    assert.equal(conjureLiveFromEnv({ CONJURE_URL: "https://x" }), null);
    assert.ok(conjureLiveFromEnv({ CONJURE_URL: "https://x", CONJURE_PRODUCT_KEY: "cjp_x_y" }));
  });
});
