import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults, summarize } from "./research-parser.ts";

test("parseResults extracts leadership and funding", () => {
  const facts = parseResults([
    { title: "Jane Doe named CEO of Acme", snippet: "Leadership change", url: "https://example.com" },
    { title: "Acme raised Series B", snippet: "Funding news" },
  ]);
  assert.ok(facts.some((f) => f.field === "leadership"));
  assert.ok(facts.some((f) => f.field === "funding"));
});

test("summarize returns a short string", () => {
  const s = summarize([{ field: "leadership", value: "Jane Doe", source: "x" }], "Acme");
  assert.ok(s.includes("leadership"));
});
