import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "./postoffice.ts";
import { classify, isProtected, planSweep, DEFAULT_CLEAN_RULES } from "./clean.ts";
import type { MailMessage } from "./model.ts";

const NOW = new Date("2026-11-05T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function msg(over: Partial<MailMessage> & { id: string }): MailMessage {
  return {
    threadId: over.id, folder: "inbox", from: { name: "Leah", email: "leah@cumuluscloud.app" }, to: [], cc: [],
    subject: "Hi", body: "Hello", at: daysAgo(1), unread: false, starred: false, labels: [], ...over,
  };
}

describe("SCALVS Clean", () => {
  it("tells people from newsletters, notices, receipts and bounces", () => {
    assert.equal(classify(msg({ id: "a" })), "person");
    assert.equal(classify(msg({ id: "b", from: { name: "Shop", email: "news@shop.example" } })), "newsletter");
    assert.equal(classify(msg({ id: "c", body: "Big sale. Unsubscribe here." , from: { name: "X", email: "anna@x.example" } })), "newsletter");
    assert.equal(classify(msg({ id: "d", system: "cloud" })), "notification");
    assert.equal(classify(msg({ id: "e", system: "wallet" })), "receipt");
    assert.equal(classify(msg({ id: "f", system: "postmaster" })), "bounce");
  });

  it("never touches starred, paid, security or unread personal mail", () => {
    assert.ok(isProtected(msg({ id: "a", starred: true })));
    assert.ok(isProtected(msg({ id: "b", payment: { asset: "USDC", amount: "1", txId: "t" } })));
    assert.ok(isProtected(msg({ id: "c", system: "security" })));
    assert.ok(isProtected(msg({ id: "d", unread: true })));
    assert.ok(!isProtected(msg({ id: "e", unread: true, from: { name: "N", email: "noreply@x.example" } })));
  });

  it("archives old read newsletters and leaves new or unread ones", () => {
    const news = { name: "News", email: "newsletter@paper.example" };
    const plan = planSweep([
      msg({ id: "old", from: news, at: daysAgo(10) }),
      msg({ id: "new", from: news, at: daysAgo(2) }),
      msg({ id: "unread", from: news, at: daysAgo(10), unread: true }),
      msg({ id: "person", at: daysAgo(40) }),
      msg({ id: "bounce", system: "postmaster", at: daysAgo(31) }),
    ], DEFAULT_CLEAN_RULES, NOW);
    assert.deepEqual(plan.map((a) => [a.kind, a.ids]), [["archive", ["old"]], ["trash", ["bounce"]]]);
  });

  it("cleans a real mailbox, mutes senders, routes their new mail and undoes", async () => {
    let now = NOW;
    const po = new PostOffice({ clock: () => now });
    po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    po.provision({ cid: "b", address: "deals@cumuluscloud.app" });
    await po.send("b", { to: "alex@cumuluscloud.app", subject: "50% off", body: "Unsubscribe any time." });
    const promo = po.view("a").messages[0]!;
    po.markThreadRead("a", promo.threadId);
    assert.equal(po.previewClean("a").length, 0, "too new to clean");

    now = new Date(NOW.getTime() + 8 * 86_400_000);
    const done = await po.runClean("a");
    assert.equal(done[0]?.kind, "archive");
    assert.equal(po.message("a", promo.id)?.folder, "archive");
    assert.equal(po.undoClean("a", done[0]!.id), 1);
    assert.equal(po.message("a", promo.id)?.folder, "inbox");

    await po.muteSender("a", "deals@cumuluscloud.app");
    assert.equal(po.message("a", promo.id)?.folder, "archive");
    await po.send("b", { to: "alex@cumuluscloud.app", subject: "Last chance", body: "Hurry" });
    assert.equal(po.view("a").messages.find((m) => m.subject === "Last chance")?.folder, "archive");
    await assert.rejects(po.muteSender("a", "security@cumuluscloud.app"), /can't be muted/);
  });

  it("runs on its own at most once an hour and only when switched on", async () => {
    let now = NOW;
    const po = new PostOffice({ clock: () => now });
    po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    po.notify("a", "postmaster", { subject: "Not delivered", body: "x" });
    now = new Date(NOW.getTime() + 31 * 86_400_000);
    assert.equal((await po.autoClean("a")).length, 1);
    po.notify("a", "postmaster", { subject: "Not delivered 2", body: "x" });
    now = new Date(now.getTime() + 31 * 86_400_000);
    assert.equal((await po.autoClean("a")).length, 1, "an hour has passed");
    po.setCleanRules("a", { auto: false });
    now = new Date(now.getTime() + 2 * 3_600_000);
    assert.equal((await po.autoClean("a")).length, 0);
  });
});
