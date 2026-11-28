import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSearch } from "@infinitum/ai/search";
import { webSeed } from "./web-seed.ts";

const engine = (results: { title: string; url: string; snippet: string }[]) => ({ name: "stub", async search() { return results; } });

describe("webSeed", () => {
  it("builds seed material from a cited web brief and its sources", async () => {
    const search = createSearch({
      engines: [engine([{ title: "Central bank minutes", url: "https://example.org/minutes", snippet: "Two members favoured a cut." }])],
      crawl: async (url) => ({ url, title: "Minutes", description: "", text: "Two of nine members favoured a 25bp cut; inflation 2.4%." }),
      chat: async () => "Two of nine members favoured a cut [1]; inflation is 2.4% [1].",
    });
    const w = await webSeed(search, "Will the bank cut rates in December?");
    assert.match(w.seed, /Two of nine members favoured a cut \[1\]/);
    assert.match(w.seed, /\[1\] Central bank minutes \(https:\/\/example.org\/minutes\)/);
    assert.ok(w.seed.length >= 40, "long enough to seed a simulation");
    assert.deepEqual(w.sources, [{ n: 1, title: "Central bank minutes", url: "https://example.org/minutes" }]);
  });

  it("refuses an empty question and a search with no results", async () => {
    const empty = createSearch({ engines: [engine([])] });
    await assert.rejects(webSeed(empty, "  "), /question/);
    await assert.rejects(webSeed(empty, "Will it rain?"), /seed material/);
  });
});
