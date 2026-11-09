import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromSource, isUiText, mergeCatalog } from "./extract-lib.ts";

test("isUiText keeps copy and drops code-ish strings", () => {
  for (const s of ["New task", "Agents", "Interrupted by a page reload.", "{0} plan · {1} credits left", "Describe an outcome…"]) assert.ok(isUiText(s), s);
  for (const s of ["btn primary sm", "awaiting_approval", "agentIds", "#/command", "./store.js", "GET", "Content-Type", "color: #000;", "https://scalvs.app", "x", "{0}", "application/json"]) assert.ok(!isUiText(s), s);
});

test("template literals become placeholders and markup is split", () => {
  const src = "const a = `<h2>${draft.id ? `Edit ${esc(draft.name)}` : 'New'}</h2><p class=\"muted\">${n} / ${m} active agents</p><input placeholder=\"Give your agents a task\">`;\n" +
    "toast('Run stopped'); const cls = 'btn ghost sm';";
  const got = extractFromSource(src, ".js").sort();
  assert.deepEqual(got, ["Edit {0}", "Give your agents a task", "New", "Run stopped", "{0} / {1} active agents"].sort());
});

test("expressions that render markup split the text", () => {
  const src = "x = `Create an agent in ${link(`<a>Agents</a>`)} first.`;";
  const got = extractFromSource(src, ".js");
  assert.ok(got.includes("Create an agent in"));
  assert.ok(got.includes("first."));
});

test("html text and attributes; jsx text", () => {
  assert.deepEqual(extractFromSource('<nav><a href="#/x" title="Open studio">\n  New task\n</a><script>t("Hello there")</script></nav>', ".html").sort(), ["Hello there", "New task", "Open studio"]);
  assert.deepEqual(extractFromSource("return <p className=\"x\">You have {count} new messages</p>;", ".tsx").sort(), ["You have", "new messages"]);
});

test("mergeCatalog prunes vanished text keys but keeps named keys", () => {
  assert.deepEqual(mergeCatalog({ Old: "Old", "nav.home": "Home" }, ["New"]), { "nav.home": "Home", New: "New" });
});
