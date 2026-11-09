import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "./postoffice.ts";
import { inBox } from "./logic.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

function setup() {
  let now = NOW;
  const po = new PostOffice({ clock: () => now });
  po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  po.provision({ cid: "b", address: "bea@cumuluscloud.app" });
  return { po, at: (iso: string) => { now = new Date(iso); } };
}

describe("Schedule send", () => {
  it("waits in Scheduled, then goes out on its own when due", async () => {
    const { po, at } = setup();
    const { id, sendAt } = po.schedule("a", { to: "bea@cumuluscloud.app", subject: "Tomorrow", body: "See you." }, hours(20));
    assert.equal(sendAt, hours(20));
    const draft = po.message("a", id)!;
    assert.equal(inBox(draft, "scheduled"), true);
    assert.equal(inBox(draft, "drafts"), false, "not mixed in with drafts");
    assert.equal(await po.sendDue("a"), 0, "not yet");
    assert.equal(po.view("b").messages.filter((m) => m.subject === "Tomorrow").length, 0);

    at(hours(21));
    assert.equal(await po.sendAllDue(), 1);
    assert.equal(po.message("a", id), undefined, "the scheduled draft is gone");
    assert.equal(po.view("a").messages.filter((m) => m.folder === "sent" && m.subject === "Tomorrow").length, 1);
    assert.equal(po.view("b").messages.filter((m) => m.folder === "inbox" && m.subject === "Tomorrow").length, 1);
    assert.equal(await po.sendAllDue(), 0, "sent once");
  });

  it("can be canceled back into Drafts", () => {
    const { po } = setup();
    const { id } = po.schedule("a", { to: "bea@cumuluscloud.app", subject: "Later", body: "x" }, hours(2));
    assert.equal(po.unschedule("a", id), true);
    const draft = po.message("a", id)!;
    assert.equal(draft.sendAt, undefined);
    assert.equal(inBox(draft, "drafts"), true);
    assert.equal(po.unschedule("a", id), false);
  });

  it("refuses times in the past, far future, payments and bad addresses", () => {
    const { po } = setup();
    const ok = { to: "bea@cumuluscloud.app", subject: "x", body: "x" };
    assert.throws(() => po.schedule("a", ok, hours(-1)), /future/);
    assert.throws(() => po.schedule("a", ok, hours(24 * 400)), /year/);
    assert.throws(() => po.schedule("a", ok, "soon"), /future/);
    assert.throws(() => po.schedule("a", { ...ok, payment: { asset: "USDC", amount: "5" } }, hours(1)), /right away/);
    assert.throws(() => po.schedule("a", { ...ok, to: "nobody" }, hours(1)), /real address/);
  });

  it("puts a message that can't go out back in Drafts with a notice", async () => {
    const { po, at } = setup();
    const { id } = po.schedule("a", { to: "bea@cumuluscloud.app", subject: "Oops", body: "x" }, hours(1));
    po.message("a", id)!.to = []; // the recipient list went bad after scheduling
    at(hours(2));
    assert.equal(await po.sendDue("a"), 0);
    const draft = po.message("a", id)!;
    assert.equal(draft.folder, "drafts");
    assert.equal(draft.sendAt, undefined);
    assert.ok(po.view("a").messages.some((m) => m.subject === "A scheduled message wasn't sent"));
  });
});
