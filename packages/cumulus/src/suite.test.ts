import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidError } from "@infinitum/cid";
import { GB, QuotaError } from "@infinitum/cloud";
import { MailError } from "@infinitum/mail";
import { WalletError } from "@infinitum/firm";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
import { createCumulus } from "./index.ts";

const RP_ID = "id.cumuluscloud.app";
const ORIGIN = "https://id.cumuluscloud.app";

function setup() {
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const suite = createCumulus({ ledger, signer, rpId: RP_ID, origins: [ORIGIN] });
  return { suite, ledger };
}

async function signUp(suite: ReturnType<typeof setup>["suite"], username: string) {
  const auth = new VirtualAuthenticator();
  const account = await suite.cid.createAccount({ username });
  const opts = await suite.cid.startAuthenticatorRegistration(account.cid, "passkey");
  const key = await suite.cid.finishAuthenticatorRegistration(account.cid, auth.create({ challenge: opts.challenge, origin: ORIGIN, rpId: RP_ID }), { kind: "passkey" });
  return { account, auth, key };
}

async function signIn(suite: ReturnType<typeof setup>["suite"], auth: VirtualAuthenticator, credentialId: string, device: string) {
  const { challenge } = await suite.cid.startSignIn();
  const r = await suite.cid.finishSignIn(auth.get({ credentialId, challenge, origin: ORIGIN }), device);
  assert.equal(r.status, "ok");
}

const inbox = async (suite: ReturnType<typeof setup>["suite"], cid: string) => (await suite.mail.view(cid)).messages.filter((m) => m.folder === "inbox");

describe("every Cumulus://ID comes with Mail, Cloud and a FIRM Wallet", () => {
  it("provisions a mailbox and wallet the moment the CID is created", async () => {
    const { suite } = setup();
    const { account } = await signUp(suite, "alex");
    assert.equal(await suite.mail.resolve("alex@cumuluscloud.app"), account.cid);
    const welcome = (await inbox(suite, account.cid)).find((m) => m.system === "welcome");
    assert.ok(welcome, "a welcome message is waiting");
    assert.match(welcome!.body, /15 GB/);
    assert.match(welcome!.body, /FIRM Wallet: 0x[0-9a-f]{40}/);
    const summary = await suite.summary(account.cid);
    assert.equal(summary.plan, "Free");
    assert.equal(summary.entitlements.mail, true);
    assert.equal(summary.entitlements.cloud, true);
    assert.equal(summary.entitlements.firmWallet, true);
    assert.deepEqual(summary.wallet.balances, { FIRM: "0", USDC: "0" });
    assert.equal(summary.mail.unread, 1);
  });

  it("product sender names are reserved so nobody can impersonate a security notice", async () => {
    const { suite } = setup();
    for (const name of ["security", "wallet", "cloud", "welcome", "postmaster"]) {
      await assert.rejects(suite.cid.createAccount({ username: name }), (e: unknown) => e instanceof CidError && e.code === "reserved");
    }
    const { account } = await signUp(suite, "alex");
    assert.equal(await suite.mail.addAlias(account.cid, "wallet@cumuluscloud.app"), false);
    assert.equal(await suite.mail.addAlias(account.cid, "alex.press@cumuluscloud.app"), true);
  });

  it("backfills CIDs created before the suite was wired in", async () => {
    const { suite } = setup();
    const { account } = await signUp(suite, "old");
    suite.stores.mail.mailboxes.clear();
    suite.stores.mail.addresses.clear();
    assert.equal(await suite.provisionAll(), 1);
    assert.equal(await suite.mail.resolve("old@cumuluscloud.app"), account.cid);
  });
});

describe("logins send security mail", () => {
  it("alerts on a new device and new keys, not on the device that signed up", async () => {
    const { suite } = setup();
    const { account, auth, key } = await signUp(suite, "alex");
    const notices = async () => (await inbox(suite, account.cid)).filter((m) => m.system === "security");
    const afterSignup = (await notices()).length; // the passkey added at sign-up
    await signIn(suite, auth, key.credentialId, "MacBook · VEIL");
    assert.equal((await notices()).length, afterSignup, "first device: no alert");
    await signIn(suite, auth, key.credentialId, "MacBook · VEIL");
    assert.equal((await notices()).length, afterSignup, "same device again: no alert");
    await signIn(suite, auth, key.credentialId, "Pixel · Chrome");
    const alert = (await notices()).find((m) => m.subject === "New sign-in to your Cumulus://ID");
    assert.ok(alert);
    assert.match(alert!.body, /Pixel · Chrome/);
    assert.equal(alert!.from.email, "security@cumuluscloud.app");
  });
});

describe("mail between Cumulus addresses", () => {
  it("delivers into the recipient's inbox, threads replies, and queues outside mail", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    const sent = await suite.mail.send(a.cid, { to: "leah@cumuluscloud.app, priya@vyral.london", subject: "Notes", body: "Are the ODIN notes in Drive?" });
    assert.equal(sent.delivered, 1);
    assert.equal(sent.queued, 1);
    assert.equal((await suite.mail.outboundQueue())[0]?.to[0], "priya@vyral.london");
    const got = (await inbox(suite, b.cid)).find((m) => m.subject === "Notes")!;
    assert.equal(got.unread, true);
    assert.equal(got.from.email, "alex@cumuluscloud.app");

    await suite.mail.send(b.cid, { to: "alex@cumuluscloud.app", subject: "Re: Notes", body: "Yes.", threadId: got.threadId });
    const thread = (await suite.mail.view(a.cid)).messages.filter((m) => m.threadId === got.threadId);
    assert.equal(thread.length, 2, "the reply joins the sender's thread");
  });

  it("bounces unknown Cumulus addresses back to the sender", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const r = await suite.mail.send(a.cid, { to: "nobody-here@cumuluscloud.app", subject: "Hi", body: "Hi" });
    assert.deepEqual(r.bounced, ["nobody-here@cumuluscloud.app"]);
    assert.ok((await inbox(suite, a.cid)).some((m) => m.system === "postmaster"));
  });

  it("marks each recipient's delivery and keeps one copy when you mail yourself", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    await signUp(suite, "leah");
    const r = await suite.mail.send(a.cid, {
      to: "leah@cumuluscloud.app, nobody-here@cumuluscloud.app, priya@vyral.london", subject: "Hops", body: "Hi",
      attachments: [{ name: "plan.pdf", size: 2048 }],
    });
    const sent = (await suite.mail.message(a.cid, r.id))!;
    const status = Object.fromEntries((sent.delivery ?? []).map((h) => [h.email, h.status]));
    assert.deepEqual(status, { "leah@cumuluscloud.app": "inside", "nobody-here@cumuluscloud.app": "bounced", "priya@vyral.london": "outbound" });
    assert.equal(sent.attachments?.[0]?.name, "plan.pdf");

    const self = await suite.mail.send(a.cid, { to: "alex@cumuluscloud.app", subject: "Note to self", body: "Hi" });
    assert.equal(self.delivered, 1);
    assert.equal((await inbox(suite, a.cid)).filter((m) => m.subject === "Note to self").length, 1);
  });

  it("one person can't read or change another person's mailbox", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    const welcomeA = (await inbox(suite, a.cid))[0]!;
    await suite.mail.move(b.cid, welcomeA.id, "trash"); // id from someone else's mailbox
    assert.equal((await suite.mail.message(a.cid, welcomeA.id))?.folder, "inbox");
    assert.equal(await suite.mail.message(b.cid, welcomeA.id), undefined);
  });
});

describe("shared 15 GB free tier", () => {
  it("mail and Cloud draw from the same storage, and a full account can't send", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    await suite.mail.send(a.cid, { to: "alex@cumuluscloud.app", subject: "Note to self", body: "x".repeat(10_000) });
    await suite.cloud.put("video.mp4", a.cid, 14.99 * GB);
    const usage = await suite.quota.usage(a.cid);
    assert.ok(usage.byProduct.mail > 0 && usage.byProduct.cloud > 0);
    assert.equal(usage.limitBytes, 15 * GB);
    await assert.rejects(suite.cloud.put("more.bin", a.cid, 0.1 * GB), QuotaError);
    await assert.rejects(suite.mail.send(a.cid, { to: "alex@cumuluscloud.app", subject: "Big", body: "x".repeat(20_000_000) }), (e: unknown) => e instanceof MailError && e.code === "quota_exceeded");
  });

  it("sharing a Cloud file mails the recipient", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    await suite.cloud.put("odin-briefing.pdf", a.cid, 2_000_000);
    await suite.shareFile(a.cid, "odin-briefing.pdf", "leah@cumuluscloud.app");
    const notice = (await inbox(suite, b.cid)).find((m) => m.system === "cloud");
    assert.match(notice!.subject, /alex@cumuluscloud\.app shared “odin-briefing\.pdf”/);
  });
});

describe("FIRM Wallet with Mail", () => {
  it("pays by mail: money and message move together, and the payment is on Firmament", async () => {
    const { suite, ledger } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    await suite.credit(a.cid, "USDC", "204", "Cumulus Data Exchange");
    const r = await suite.mail.send(a.cid, { to: "leah@cumuluscloud.app", subject: "Dinner", body: "My half.", payment: { asset: "USDC", amount: "42.50" } });
    assert.equal(r.payment?.amount, "42.5");
    assert.deepEqual((await suite.wallets.balances(a.cid)).USDC, "161.5");
    assert.deepEqual((await suite.wallets.balances(b.cid)).USDC, "42.5");
    const got = (await inbox(suite, b.cid)).find((m) => m.subject === "Dinner")!;
    assert.equal(got.payment?.amount, "42.5");
    const payments = (await ledger.query({ product: "firm-wallet" })).filter((e) => e.type === "payment");
    assert.equal(payments.length, 2); // the credit and the mail payment
    assert.equal(payments[1]!.payload.amount, "42.5");
    assert.ok(!JSON.stringify(payments).includes("Dinner"), "mail content stays off the ledger");
  });

  it("a failed payment sends nothing", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    await assert.rejects(
      suite.mail.send(a.cid, { to: "leah@cumuluscloud.app", subject: "Pay", body: "x", payment: { asset: "USDC", amount: "5" } }),
      (e: unknown) => e instanceof WalletError && e.code === "insufficient_funds",
    );
    assert.equal((await inbox(suite, b.cid)).some((m) => m.subject === "Pay"), false);
    assert.equal((await suite.mail.view(a.cid)).messages.some((m) => m.subject === "Pay"), false);
    await assert.rejects(suite.mail.send(a.cid, { to: "priya@vyral.london", subject: "Pay", body: "x", payment: { asset: "USDC", amount: "1" } }), MailError);
  });

  it("direct wallet sends resolve mail or wallet addresses and mail both receipts", async () => {
    const { suite } = setup();
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    await suite.credit(a.cid, "FIRM", "10", "Settlement");
    const leahWallet = (await suite.wallets.get(b.cid))!.address;
    await suite.pay(a.cid, leahWallet, "FIRM", "3", "thanks");
    await suite.pay(a.cid, "leah@cumuluscloud.app", "FIRM", "2");
    assert.equal((await suite.wallets.balances(b.cid)).FIRM, "5");
    assert.equal((await inbox(suite, b.cid)).filter((m) => m.system === "wallet").length, 2);
    assert.ok((await inbox(suite, a.cid)).some((m) => m.subject.startsWith("You sent 3 FIRM")));
  });
});

describe("Cumulus Tunnel across the suite", () => {
  it("seals mail on disk with no key for anyone to manage, and reads it after a restart", async () => {
    const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { emptyCumulusStores, loadCumulusStores, saveCumulusStores, loadOrCreateMasterKey } = await import("./index.ts");
    const dir = mkdtempSync(join(tmpdir(), "cumulus-tunnel-"));
    const masterKey = loadOrCreateMasterKey(dir, {});
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const stores = emptyCumulusStores();
    const suite = createCumulus({ ledger, signer, rpId: RP_ID, origins: [ORIGIN], stores, masterKey });
    const a = (await signUp(suite, "alex")).account;
    const b = (await signUp(suite, "leah")).account;
    await suite.mail.send(a.cid, { to: "leah@cumuluscloud.app", subject: "Board deck", body: "Draft attached in Cloud." });
    assert.equal((await inbox(suite, b.cid)).find((m) => m.subject === "Board deck")?.tunnel?.verified, true);
    saveCumulusStores(dir, stores, { tunnel: suite.tunnel });

    const mailJson = readFileSync(join(dir, "mail.json"), "utf8");
    assert.ok(!mailJson.includes("Board deck") && !mailJson.includes("Draft attached"), "subjects and bodies are sealed");
    assert.ok(!readFileSync(join(dir, "tunnel.json"), "utf8").includes("PRIVATE KEY"));
    assert.ok(readdirSync(dir).includes("tunnel-master.key"));

    const restored = loadCumulusStores(dir, emptyCumulusStores());
    const again = createCumulus({ ledger, signer, rpId: RP_ID, origins: [ORIGIN], stores: restored, masterKey: loadOrCreateMasterKey(dir, {}) });
    assert.equal((await again.mail.view(b.cid)).messages.find((m) => m.subject === "Board deck")?.body, "Draft attached in Cloud.\n\nalex\nalex@cumuluscloud.app");
    assert.equal(again.tunnel.fingerprint(a.cid), suite.tunnel.fingerprint(a.cid));
  });
});
