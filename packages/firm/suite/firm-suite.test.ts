import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore plain browser module
import { PRODUCTS, esc, links, loadWallet, normaliseWallet, render } from "./firm-suite.js";

const here = dirname(fileURLToPath(import.meta.url));

test("every commercial product is in the registry; no military edition is", () => {
  for (const id of ["scalvs", "architect", "spectre", "metatron", "fabric", "cumulus-cloud", "cumulus-mail", "cumulus-exchange", "veil", "eidetic", "hrvst"]) {
    assert.ok(PRODUCTS[id], id);
  }
  for (const [id, p] of Object.entries(PRODUCTS) as [string, { wordmark: string }][]) {
    assert.doesNotMatch(p.wordmark, /MIL|ODIN/, id);
    assert.match(p.wordmark, /<sup class="tm">™<\/sup>/, id);
  }
});

test("links carry the product as ref", () => {
  assert.deepEqual(links("scalvs"), { wallet: "https://firmwallet.app/?ref=scalvs", network: "https://firmnetwork.app/?ref=scalvs" });
});

test("early access state shows the suite and the product token", () => {
  const html = render({ product: "scalvs" });
  assert.match(html, /FIRM Wallet<sup class="tm">™<\/sup>/);
  assert.match(html, /Firmament Network<sup class="tm">™<\/sup>/);
  assert.match(html, /\$SCLV/);
  assert.match(html, /\$FIRM/);
  assert.match(html, /firmwallet\.app\/\?ref=scalvs/);
  assert.match(html, /data-state="early"/);
  assert.doesNotMatch(html, /Infinitum Corporation/);
});

test("wallet state shows real balances, escaped", () => {
  const wallet = normaliseWallet({ address: "0xabc<script>", balances: { USDC: "12.50", FIRM: "3", "bad key": "9" } });
  const html = render({ product: "cumulus-mail", state: "wallet", wallet });
  assert.match(html, /<b>12\.50<\/b> <span>\$USDC/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /bad key/);
});

test("normaliseWallet refuses payloads without an address", () => {
  assert.equal(normaliseWallet({ balances: { FIRM: "1" } }), null);
  assert.equal(normaliseWallet(null), null);
});

test("loadWallet maps responses to states", async () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  assert.equal((await loadWallet("/api/wallet", reply(401, {}))).state, "signin");
  assert.equal((await loadWallet("/api/wallet", reply(500, {}))).state, "early");
  const ok = await loadWallet("/api/wallet", reply(200, { address: "0x1", balances: { FIRM: "0" } }));
  assert.equal(ok.state, "wallet");
  assert.equal(ok.wallet.address, "0x1");
  assert.equal((await loadWallet("", reply(200, {}))).state, "early");
  assert.equal((await loadWallet("/x", async () => { throw new Error("offline"); })).state, "early");
});

test("signin state links to the host's sign-in", () => {
  assert.match(render({ product: "veil", state: "signin", signinHref: "/login" }), /href="\/login"/);
});

test("esc escapes HTML", () => {
  assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("synced copies match the canonical files", () => {
  const copies = JSON.parse(readFileSync(join(here, "copies.json"), "utf8")) as string[];
  const root = join(here, "..", "..", "..");
  for (const file of ["firm-suite.js", "firm-suite.css"]) {
    const canonical = readFileSync(join(here, file), "utf8");
    for (const dir of copies) assert.equal(readFileSync(join(root, dir, file), "utf8"), canonical, `${dir}/${file} drifted; run node packages/firm/suite/sync.mjs`);
  }
});

test("several products show each token once, links tagged with the first", () => {
  const html = render({ product: "spectre metatron spectre" });
  assert.equal(html.match(/\$SPCTR/g)?.length, 1);
  assert.match(html, /\$MTRN/);
  assert.match(html, /METATRON¹⁰⁰<sup class="tm">™<\/sup>/);
  assert.match(html, /\?ref=spectre"/);
});
