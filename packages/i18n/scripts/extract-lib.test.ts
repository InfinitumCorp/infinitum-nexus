import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromSource, isUiText, mergeCatalog } from "./extract-lib.ts";

test("isUiText keeps copy and drops code-ish strings", () => {
  for (const s of ["New task", "Agents", "Interrupted by a page reload.", "{0} plan · {1} credits left", "Describe an outcome…"]) assert.ok(isUiText(s), s);
  for (const s of ["btn primary sm", "awaiting_approval", "agentIds", "#/command", "./store.js", "GET", "Content-Type", "color: #000;", "https://scalvs.app", "x", "{0}", "application/json", ": null} {shareUrl ? (", ", body: JSON.stringify(", "M12 2L2 7l10 5 10-5-10-5z", "width=device-width, initial-scale=1", "app-main grid gap-4 lg:grid-cols-[320px_1fr]", "text-xs uppercase tracking-[0.16em] text-muted-foreground", "interface ApiError extends Error", "finally", "Bearer {0}", "button[data-plan], button[data-portal]", "10px ui-monospace, Consolas, monospace", "800 15px ui-monospace, Consolas, monospace", "t a backup: if you forget it, restore.", "; else if (!st.session) body =", "(iso ? new Date(iso).toLocaleDateString(undefined,"]) assert.ok(!isUiText(s), s);
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

test("numeric character references decode to the text the page renders", () => {
  const found = extractFromSource('<footer><span>AI-powered. Blockchain-governed&#8482;.</span><span>&#169; 2026 Infinitum Corporation</span><span>Next &#x2192;</span></footer>', ".html");
  assert.deepEqual(found.sort(), ["AI-powered. Blockchain-governed™.", "Next →", "© 2026 Infinitum Corporation"].sort());
});

test("a regex literal containing // or quotes does not hide the strings after it", () => {
  const src = [
    "function download() {",
    String.raw`  const name = ${"`"}report-${"${"}cid.replace(/^cid:\/\/infinitum\//, "")}.json${"`"};`,
    String.raw`  const q = s.replace(/["']/g, "");`,
    String.raw`  const url = path.replace(/\/+$/, "");`,
    "}",
    'toast("Report downloaded");',
    'const label = active ? "Retire" : "Reinstate";',
  ].join("\n");
  const got = extractFromSource(src, ".tsx").sort();
  assert.deepEqual(got, ["Reinstate", "Report downloaded", "Retire"]);
});

test("JSX closing and self-closing tags are not mistaken for a regex", () => {
  const src = '<div class="row"><Copy text={a} /><button type="button" onClick={() => setQr(null)}>{qr ? "Hide QR" : "Show QR"}</button></div>';
  assert.deepEqual(extractFromSource(src, ".tsx").sort(), ["Hide QR", "Show QR"]);
});

test("division is not mistaken for a regex", () => {
  const src = "const half = total / 2; const rate = done / all; x /= 3;\ntoast(\"Halfway there\");";
  assert.deepEqual(extractFromSource(src, ".js"), ["Halfway there"]);
});
