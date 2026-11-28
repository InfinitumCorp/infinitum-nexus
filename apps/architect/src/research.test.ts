/** Architect's research instrument runs the real Infinitum Search pipeline (stub engine, reader, model). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearch } from "@infinitum/ai/search";
import { createResearchInstrument } from "./instruments.ts";

test("research returns a cited answer, drops invented citations, and lists cited sources as evidence", async () => {
  const search = createSearch({
    engines: [{ name: "stub", async search() { return [
      { title: "Workers limits", url: "https://example.org/limits", snippet: "128 MB memory per isolate." },
      { title: "Other", url: "https://example.org/other", snippet: "Unrelated." },
    ]; } }],
    crawl: async (url: string) => ({ url, title: "page", description: "", text: `Text of ${url}` }),
    chat: async () => "Each isolate gets 128 MB [1], and unlimited CPU [7].",
  });
  const research = createResearchInstrument(() => search);
  const { output, evidence } = await research.execute({ query: "Workers memory limit" }, []) as { output: Record<string, unknown>; evidence: string[] };
  assert.deepEqual(output.cited, [1]);
  assert.doesNotMatch(String(output.summary), /\[7\]/);
  assert.equal(output.engine, "stub");
  assert.deepEqual(output.titles, ["Workers limits", "Other"]);
  assert.ok(evidence.includes("source:https://example.org/limits"));
  assert.ok(!evidence.includes("source:https://example.org/other"), "only cited sources count as evidence");
  assert.deepEqual((await research.execute({}, [])).output, { error: "empty query" });
});
