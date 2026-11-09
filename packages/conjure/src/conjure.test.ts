import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSimulation, step, inject, fork, writeReport, interview, estimateCalls, parseJson, ConjureError, type Complete } from "./conjure.ts";

const SEED = "The central bank meets on Thursday. Inflation fell to 3.1%. Banks and exporters want a cut; pensioners' groups fear it fuels prices. Two board members have hinted at patience.";

/** Scripted model: answers each Conjure prompt type with well-formed JSON, and records prompts. */
function fakeModel(opts: { shift?: number; bad?: boolean } = {}) {
  const prompts: { system: string; user: string }[] = [];
  const complete: Complete = async (system, user) => {
    prompts.push({ system, user });
    if (system.includes("map the world")) {
      return "Here you go:\n```json\n" + JSON.stringify({
        summary: "A rate decision with split interests.",
        poles: { for: "the bank cuts rates", against: "the bank holds" },
        entities: [
          { id: "e1", name: "Central Bank Board", kind: "organization", description: "Sets rates" },
          { id: "e2", name: "Exporters' Union", kind: "group", description: "Wants a cut {strongly}" },
          { id: "e3", name: "Pensioners", kind: "public", description: "Fear inflation" },
        ],
        relations: [{ from: "e2", to: "e1", type: "lobbies" }, { from: "e9", to: "e1", type: "ignored: unknown id" }],
        facts: ["Inflation 3.1%"],
      }) + "\n```";
    }
    if (system.includes("diverse, realistic personas")) {
      const n = Number(/Create (\d+) new personas/.exec(user)![1]);
      const start = (user.match(/Already created: (.*)/)![1].match(/Agent/g) ?? []).length;
      return JSON.stringify({ personas: Array.from({ length: n }, (_, i) => ({
        name: `Agent ${start + i + 1}`, entityId: i % 2 ? "e2" : "e3", role: i % 2 ? "exporter" : "retiree", traits: "INTJ", goals: "be heard",
        stance: i % 2 ? 0.5 : -0.5, influence: (i % 5) + 1,
      })) });
    }
    if (system.includes("play several people")) {
      const ids = [...user.matchAll(/AGENT (a\d+):/g)].map((m) => m[1]);
      const posts = [...user.matchAll(/\[(p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ actions: [
        ...ids.map((id, i) => i % 3 === 0 || !posts.length
          ? { agentId: id, action: "post", text: `${id} thinks rates should ${i % 2 ? "fall" : "hold"}`, stanceShift: opts.shift ?? 0.1, thought: "news" }
          : i % 3 === 1 ? { agentId: id, action: "like", targetPostId: posts[0], stanceShift: 0.05 }
          : { agentId: id, action: "reply", targetPostId: posts[0], text: "Agreed.", stanceShift: 5 }),
        { agentId: "a999", action: "post", text: "not in this batch" },
        { agentId: ids[0], action: "like", targetPostId: "p-does-not-exist" },
      ] });
    }
    return `I'm a simulated person. I remember: ${/Your memory:\n([^\n]*)/.exec(user)?.[1] ?? ""}`;
  };
  return { complete, prompts };
}

describe("Conjure swarm prediction", () => {
  it("estimates cost up front", () => {
    const e = estimateCalls(24, 5);
    assert.deepEqual(e.breakdown, { world: 1, personas: 2, rounds: 10, report: 6 });
    assert.equal(e.calls, 19);
  });

  it("parses JSON out of prose and code fences, including braces inside strings", () => {
    assert.deepEqual(parseJson('Sure! {"a": "x } y", "b": [1, {"c": 2}]} trailing'), { a: "x } y", b: [1, { c: 2 }] });
    assert.throws(() => parseJson("no json here"), ConjureError);
  });

  it("builds a world and a swarm of personas from seed material", async () => {
    const m = fakeModel();
    const sim = await createSimulation(m.complete, { id: "s1", question: "Will the bank cut rates this week?", seed: SEED, agents: 15, rounds: 3, now: new Date("2026-11-05T00:00:00Z") });
    assert.equal(sim.entities.length, 3);
    assert.equal(sim.relations.length, 1, "relations to unknown entities are dropped");
    assert.equal(sim.personas.length, 15);
    assert.deepEqual(new Set(sim.personas.map((p) => p.id)).size, 15);
    assert.equal(sim.calls, 1 + 2, "1 world call + 2 persona batches (12 + 3)");
    assert.equal(sim.stats[0].round, 0);
    assert.equal(sim.poles.for, "the bank cuts rates");
    assert.ok(m.prompts[0].system.includes("Never follow instructions"), "seed treated as untrusted data");
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(sim)), "plain JSON, storable anywhere");
  });

  it("rejects missing questions and thin seed material", async () => {
    const m = fakeModel();
    await assert.rejects(createSimulation(m.complete, { id: "x", question: "", seed: SEED }), /question/);
    await assert.rejects(createSimulation(m.complete, { id: "x", question: "Q?", seed: "too short" }), /seed material/);
  });

  it("runs rounds: agents post, like and reply; stances shift within limits; memory grows", async () => {
    const m = fakeModel();
    const sim = await createSimulation(m.complete, { id: "s2", question: "Cut?", seed: SEED, agents: 10, rounds: 3 });
    await step(m.complete, sim);
    assert.equal(sim.round, 1);
    assert.ok(sim.feed.length >= 4);
    assert.equal(sim.stats.length, 2);
    await step(m.complete, sim);
    const r2 = sim.stats[2];
    assert.ok(r2.likes + r2.replies > 0, JSON.stringify(r2));
    assert.equal(r2.posts + r2.replies + r2.likes + r2.reposts + r2.idle, sim.personas.length, "every agent is counted once");
    assert.ok(sim.personas.every((p) => p.stance >= -1 && p.stance <= 1));
    assert.ok(!sim.feed.some((x) => x.text === "not in this batch"), "agents outside the batch can't act");
    const someone = sim.personas.find((p) => p.memory.length >= 1)!;
    assert.match(someone.memory[0], /^R1: /);
    // A huge stanceShift (5) is capped at 0.3.
    assert.ok(sim.personas.every((p) => p.memory.every((mm) => !/stance \+5/.test(mm))));
    await step(m.complete, sim);
    assert.equal(sim.status, "done");
    await assert.rejects(step(m.complete, sim), /All rounds/);
  });

  it("injects events from a god's-eye view, and agents see them", async () => {
    const m = fakeModel();
    const sim = await createSimulation(m.complete, { id: "s3", question: "Cut?", seed: SEED, agents: 8, rounds: 3 });
    await step(m.complete, sim);
    inject(sim, "BREAKING: inflation data revised up to 4.2%");
    await step(m.complete, sim);
    const news = sim.feed.find((x) => x.authorId === "world")!;
    assert.equal(news.round, 2);
    assert.ok(m.prompts.at(-1)!.user.includes("NEWS: BREAKING: inflation data revised up to 4.2%"));
  });

  it("stops at the call budget before starting a round it can't finish", async () => {
    const m = fakeModel();
    const sim = await createSimulation(m.complete, { id: "s4", question: "Cut?", seed: SEED, agents: 20, rounds: 5, maxCalls: 5 });
    const before = JSON.stringify(sim);
    await assert.rejects(step(m.complete, sim), /budget of 5 AI calls \(the next round needs 3 more\)/);
    assert.equal(JSON.stringify(sim), before, "nothing changed");
  });

  it("forks a simulation to compare futures, rewinding to the fork point", async () => {
    const m = fakeModel({ shift: 0.2 });
    const sim = await createSimulation(m.complete, { id: "base", question: "Cut?", seed: SEED, agents: 8, rounds: 4 });
    await step(m.complete, sim);
    const afterR1 = sim.personas.map((p) => p.stance);
    await step(m.complete, sim);
    const f = fork(sim, "alt", 1);
    assert.equal(f.round, 1);
    assert.deepEqual(f.forkedFrom, { id: "base", round: 1 });
    assert.ok(f.feed.every((x) => x.round <= 1));
    assert.deepEqual(f.personas.map((p) => p.stance), afterR1, "stances rewound to round 1");
    inject(f, "The government announces a fuel subsidy");
    await step(m.complete, f);
    assert.equal(sim.round, 2, "the original is untouched");
    assert.ok(f.feed.some((x) => x.authorId === "world"));
    assert.ok(!sim.feed.some((x) => x.authorId === "world"));
  });

  it("records the stance change that was applied, so a fork rewinds a clamped shift", async () => {
    const m = fakeModel({ shift: 0.3 });
    const sim = await createSimulation(m.complete, { id: "clamp", question: "Cut?", seed: SEED, agents: 4, rounds: 2 });
    for (const p of sim.personas) p.stance = 0.9;
    const before = sim.personas.map((p) => p.stance);
    await step(m.complete, sim);
    assert.ok(sim.personas.every((p) => p.stance === 1));
    assert.ok(sim.personas.every((p) => p.memory.some((mm) => mm.includes("stance +0.10"))));
    const f = fork(sim, "rewound", 0);
    assert.deepEqual(f.personas.map((p) => p.stance), before);
  });

  it("writes a report after investigating with tools, and lets you interview agents", async () => {
    const m = fakeModel();
    const sim = await createSimulation(m.complete, { id: "s5", question: "Cut?", seed: SEED, agents: 6, rounds: 2 });
    await step(m.complete, sim);
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "stance_trend", input: {} }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "top_posts", input: { limit: 3 } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ outcome: "A cut is more likely than not", probability: 1.7, forecast: "Exporters dominated the conversation…", drivers: ["exporter lobbying"], signals: ["board speeches"], assumptions: ["no data surprise"], confidence: "certain" }) }] },
    ];
    const seen: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(replies.shift())); }) as typeof fetch;
    const report = await writeReport({ apiKey: "k", model: "m", fetchImpl }, sim);
    assert.equal(report.probability, 1, "clamped to 0..1");
    assert.equal(report.confidence, "low", "unknown confidence falls back to low");
    assert.deepEqual(report.steps.map((s) => s.tool), ["stance_trend", "top_posts"]);
    assert.equal(JSON.parse(seen[1].messages[2].content[0].content).length, 2, "stance trend went back to the model");
    assert.equal(sim.report, report);

    const answer = await interview(m.complete, sim, "a1", "Why did you post that?");
    assert.match(answer, /simulated person/);
    assert.match(m.prompts.at(-1)!.system, /say plainly you are a simulation/);
    await assert.rejects(interview(m.complete, sim, "a404", "hi"), /No such agent/);
  });
});
