import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";
import { scalvsCleanAgent } from "./clean-agent.ts";

const signer = generateSigner();
const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
let base = "";
let suite: ReturnType<typeof createCumulus>;
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;

class Browser {
  cookie = "";
  readonly auth = new VirtualAuthenticator();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-cumulus": "1" }) {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  }
  async signUp(username: string) {
    const origin = base;
    const a = await this.call("POST", "/api/auth/signup", { username });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const reg = this.auth.create({ challenge: a.data.options.challenge, origin, rpId: "localhost" });
    const b = await this.call("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: reg });
    assert.equal(b.status, 200, JSON.stringify(b.data));
    const credentialId = b.data.options.allowCredentials[0].id;
    const c = await this.call("POST", "/api/auth/signin/finish", { response: this.auth.get({ credentialId, challenge: b.data.options.challenge, origin }) });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    return a.data.cid as string;
  }
}

before(async () => {
  // Bind first so the passkey origin matches the port.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [base], mailOrigin: base });
  server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false, scalvs: async () => ({ ok: true, text: "Brief." }), cleanAgent: scalvsCleanAgent({ model: "m" }) }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

describe("Cumulus://Mail over HTTP", () => {
  it("is unlisted: robots.txt disallows everything and pages are noindex", async () => {
    const b = new Browser();
    const robots = await b.call("GET", "/robots.txt");
    assert.match(robots.data, /Disallow: \//);
    const page = await b.call("GET", "/");
    assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.match(page.data, /noindex/);
  });

  it("publishes the mail domain and allows only exact Cumulus origins", async () => {
    const b = new Browser();
    const config = await b.call("GET", "/cumulus-config.js");
    assert.equal(config.status, 200);
    assert.match(String(config.data), /"mailDomain":"cumuluscloud\.app"/);
    assert.equal(String(config.data).includes("*"), false);
    const allowed = await b.call("OPTIONS", "/api/state", undefined, { origin: "https://id.cumuluscloud.app" });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://id.cumuluscloud.app");
    assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");
    const denied = await b.call("GET", "/", undefined, { origin: "https://evil.example" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const cid = await b.signUp("river@cumuluscloud.app");
    assert.match(cid, /^cid_/);
    assert.equal((await b.call("GET", "/api/state")).data.me.email, "river@cumuluscloud.app");
  });

  it("needs a Cumulus://ID session and the request header", async () => {
    const b = new Browser();
    assert.equal((await b.call("GET", "/api/state")).status, 401);
    await b.signUp("nora");
    assert.equal((await b.call("POST", "/api/send", { to: "x@cumuluscloud.app", subject: "x", body: "x" }, {})).status, 403, "no CSRF header");
  });

  it("signs up, finds the welcome mail, mails another person and pays by mail", async () => {
    const alex = new Browser();
    const leah = new Browser();
    const alexCid = await alex.signUp("alex");
    const leahCid = await leah.signUp("leah");

    const state = await alex.call("GET", "/api/state");
    assert.equal(state.data.me.email, "alex@cumuluscloud.app");
    assert.ok(state.data.messages.some((m: any) => m.subject === "Welcome to your Cumulus://ID"));
    assert.equal(state.data.account.plan, "Free");
    assert.equal(state.data.account.entitlements.firmWallet, true);

    await suite.credit(alexCid, "USDC", "50", "Cumulus Data Exchange");
    const sent = await alex.call("POST", "/api/send", { to: "leah@cumuluscloud.app", subject: "Your share", body: "Here you go.", payment: { asset: "USDC", amount: "12.25" } });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.payment.amount, "12.25");

    const leahState = await leah.call("GET", "/api/state");
    const got = leahState.data.messages.find((m: any) => m.subject === "Your share");
    assert.equal(got.payment.amount, "12.25");
    assert.equal(suite.wallets.balances(leahCid).USDC, "12.25");

    const wallet = await leah.call("GET", "/api/wallet");
    assert.equal(wallet.data.balances.USDC, "12.25");
    assert.equal(wallet.data.history[0].counterparty, "alex@cumuluscloud.app");

    const pay = await leah.call("POST", "/api/wallet/pay", { to: "alex@cumuluscloud.app", asset: "USDC", amount: "100" });
    assert.equal(pay.status, 400);
    assert.match(pay.data.error, /Not enough USDC/);

    // Leah can't touch Alex's messages by id.
    const alexMsg = state.data.messages[0];
    await leah.call("POST", "/api/move", { id: alexMsg.id, folder: "trash" });
    const after = await alex.call("GET", "/api/state");
    assert.equal(after.data.messages.find((m: any) => m.id === alexMsg.id).folder, "inbox");
    assert.equal((await leah.call("GET", `/api/message?id=${alexMsg.id}`)).status, 404);
  });

  it("revoking Mail in Cumulus://ID permissions cuts access", async () => {
    const b = new Browser();
    const cidValue = await b.signUp("revoker");
    assert.equal((await b.call("GET", "/api/state")).status, 200);
    await suite.cid.revoke(cidValue, "cumulus-mail");
    assert.equal((await b.call("GET", "/api/state")).status, 403);
  });

  it("signing out ends the session", async () => {
    const b = new Browser();
    await b.signUp("leaver");
    assert.equal((await b.call("POST", "/api/auth/signout", {})).status, 200);
    assert.equal((await b.call("GET", "/api/state")).status, 401);
  });

  it("SCALVS Clean suggests, the owner approves, and it can be undone", async () => {
    const owner = new Browser();
    await owner.signUp("tidy");
    const bulk = new Browser();
    await bulk.signUp("digest");
    for (const n of [1, 2, 3]) await bulk.call("POST", "/api/send", { to: "tidy@cumuluscloud.app", subject: `Weekly ${n}`, body: "News. Unsubscribe." });

    const review = await owner.call("POST", "/api/clean/scalvs", {});
    assert.equal(review.status, 200, JSON.stringify(review.data));
    const mute = review.data.clean.suggestions.find((s: any) => s.kind === "mute");
    assert.equal(mute?.email, "digest@cumuluscloud.app");
    const approved = await owner.call("POST", "/api/clean/approve", { id: mute.id });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.data.clean.rules.muted, ["digest@cumuluscloud.app"]);
    assert.equal(approved.data.state.messages.filter((m: any) => m.subject.startsWith("Weekly") && m.folder === "archive").length, 3);

    const undo = await owner.call("POST", "/api/clean/undo", { id: approved.data.clean.log[0].id });
    assert.equal(undo.data.restored, 3);
    const rules = await owner.call("POST", "/api/clean/rules", { auto: false, newslettersAfterDays: 3, emptyTrashAfterDays: null });
    assert.equal(rules.data.clean.rules.auto, false);
    assert.equal(rules.data.clean.rules.newslettersAfterDays, 3);
    assert.equal((await owner.call("POST", "/api/clean/mute", { email: "security@cumuluscloud.app" })).status, 400);
  });
});

describe("SCALVS Clean agent", () => {
  it("turns SCALVS proposals into suggestions and drops ids it wasn't shown", async () => {
    const calls: any[] = [];
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "list_inbox", input: {} }] },
      { stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t2", name: "archive_messages", input: { ids: ["m1", "not-yours"], reason: "Old newsletter" } },
        { type: "tool_use", id: "t3", name: "trash_messages", input: { ids: ["starred"], reason: "Junk" } },
      ] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Mostly newsletters." }] },
    ];
    const fetchImpl = (async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as typeof fetch;
    const at = new Date("2026-11-01T00:00:00Z").toISOString();
    const base = { threadId: "x", folder: "inbox" as const, to: [], cc: [], body: "Unsubscribe", at, unread: false, labels: [] };
    const agent = scalvsCleanAgent({ apiKey: "test-key", model: "m", fetchImpl });
    const out = await agent({
      messages: [
        { ...base, id: "m1", from: { name: "Paper", email: "news@paper.example" }, subject: "Daily", starred: false },
        { ...base, id: "starred", from: { name: "Paper", email: "news@paper.example" }, subject: "Keep", starred: true },
      ],
      rules: { auto: true, newslettersAfterDays: 7, notificationsAfterDays: 14, bouncesAfterDays: 30, emptyTrashAfterDays: null, muted: [] },
      preview: [],
      now: new Date("2026-11-05T00:00:00Z"),
    });
    assert.deepEqual(out.suggestions.map((s) => [s.kind, s.ids]), [["archive", ["m1"]]]);
    assert.equal(out.note, "Mostly newsletters.");
    assert.match(calls[0].system, /untrusted/);
  });
  it("acts on conversations in bulk and undoes over HTTP", async () => {
    const ivy = new Browser();
    const jo = new Browser();
    await ivy.signUp("ivyb");
    await jo.signUp("joan");
    for (const subject of ["One", "Two"]) assert.equal((await jo.call("POST", "/api/send", { to: "ivyb@cumuluscloud.app", subject, body: "Hi" })).status, 200);
    const inbox = (await ivy.call("GET", "/api/state")).data.messages.filter((m: any) => m.folder === "inbox" && ["One", "Two"].includes(m.subject));
    assert.equal(inbox.length, 2);
    const ids = inbox.map((m: any) => m.threadId);
    assert.equal((await ivy.call("POST", "/api/threads", { threadIds: ids, action: "nuke" })).status, 400);
    const done = await ivy.call("POST", "/api/threads", { threadIds: ids, action: "archive", box: "inbox" });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.count, 2);
    assert.ok(done.data.state.messages.filter((m: any) => ids.includes(m.threadId)).every((m: any) => m.folder === "archive"));
    assert.equal((await jo.call("POST", "/api/undo", { id: done.data.undo })).status, 404, "someone else can't undo it");
    const back = await ivy.call("POST", "/api/undo", { id: done.data.undo });
    assert.equal(back.data.restored, 2);
    assert.ok(back.data.state.messages.filter((m: any) => ids.includes(m.threadId)).every((m: any) => m.folder === "inbox"));
    assert.equal((await ivy.call("POST", "/api/undo", { id: done.data.undo })).status, 404, "undo works once");
  });
  it("schedules a send, lists it in Scheduled and cancels it over HTTP", async () => {
    const kim = new Browser();
    await kim.signUp("kimsched");
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const r = await kim.call("POST", "/api/schedule", { to: "nora@cumuluscloud.app", subject: "Later on", body: "Hi", sendAt: when });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const draft = r.data.state.messages.find((m: any) => m.id === r.data.id);
    assert.equal(draft.folder, "drafts");
    assert.equal(draft.sendAt, when);
    assert.equal((await kim.call("POST", "/api/schedule", { to: "nora@cumuluscloud.app", subject: "x", body: "x", sendAt: "2001-01-01T00:00:00Z" })).status, 400);
    const c = await kim.call("POST", "/api/schedule/cancel", { id: r.data.id });
    assert.equal(c.status, 200);
    assert.equal(c.data.messages.find((m: any) => m.id === r.data.id).sendAt, undefined);
    assert.equal((await kim.call("POST", "/api/schedule/cancel", { id: r.data.id })).status, 404);
  });
});

it("mounts the shared Labyrinth UI while keeping an unconfigured repository API unavailable", async () => {
  const b = new Browser();
  const ui = await b.call("GET", "/labyrinth");
  assert.equal(ui.status, 200);
  assert.match(ui.data, /Labyrinth/);
  assert.match(ui.data, /data-product="cumulus-mail"/);
  assert.equal(ui.headers.get("cache-control"), "no-store");
  assert.match(ui.headers.get("x-robots-tag") ?? "", /noindex/);
  const js = await b.call("GET", "/labyrinth/assets/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  const unavailable = await b.call("POST", "/api/labyrinth", { product: "cumulus-mail", action: "list" }, { "x-labyrinth": "1" });
  assert.equal(unavailable.status, 503);
});
