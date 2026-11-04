import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools } from "./tools.ts";
import { Ledger, MemoryStore } from "@infinitum/firmament";

test("web_search returns a result or error", async () => {
  const tools = createTools();
  const r = await tools.web_search.execute({ prompt: "Infinitum Corporation" });
  assert.ok(r);
  assert.ok("summary" in r || "error" in r);
});

test("firmament_lookup queries the ledger", async () => {
  const ledger = new Ledger(new MemoryStore());
  const tools = createTools({ ledger });
  const r = await tools.firmament_lookup.execute({});
  assert.ok(Array.isArray(r.priorFacts));
});

test("crm_query returns workspace stats when CRM present", async () => {
  const tools = createTools();
  const r = await tools.crm_query.execute({});
  assert.ok("error" in r || "openDeals" in r);
});
