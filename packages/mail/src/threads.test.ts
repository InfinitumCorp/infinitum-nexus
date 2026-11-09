import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "./postoffice.ts";

async function setup() {
  const po = new PostOffice();
  po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  po.provision({ cid: "b", address: "bea@cumuluscloud.app" });
  await po.send("b", { to: "alex@cumuluscloud.app", subject: "Lunch?", body: "Friday works." });
  await po.send("b", { to: "alex@cumuluscloud.app", subject: "Notes", body: "Attached." });
  const [one, two] = po.view("a").messages.filter((m) => m.folder === "inbox" && !m.system);
  return { po, one: one!, two: two! };
}

describe("Conversation actions", () => {
  it("archives several conversations at once and undoes exactly", async () => {
    const { po, one, two } = await setup();
    const r = po.actOnThreads("a", [one.threadId, two.threadId], "archive", "inbox");
    assert.equal(r.count, 2);
    assert.equal(po.message("a", one.id)?.folder, "archive");
    assert.equal(po.message("a", two.id)?.unread, false);
    assert.equal(po.restore("a", r.before), 2);
    assert.equal(po.message("a", one.id)?.folder, "inbox");
    assert.equal(po.message("a", two.id)?.unread, true, "unread comes back too");
  });

  it("marks unread, stars, trashes and moves back to inbox", async () => {
    const { po, one } = await setup();
    po.actOnThreads("a", [one.threadId], "read");
    assert.equal(po.message("a", one.id)?.unread, false);
    assert.equal(po.actOnThreads("a", [one.threadId], "unread").count, 1);
    assert.equal(po.message("a", one.id)?.unread, true);
    po.actOnThreads("a", [one.threadId], "star");
    assert.equal(po.message("a", one.id)?.starred, true);
    assert.equal(po.actOnThreads("a", [one.threadId], "star").count, 0, "already starred");
    po.actOnThreads("a", [one.threadId], "trash");
    assert.equal(po.message("a", one.id)?.folder, "trash");
    po.actOnThreads("a", [one.threadId], "inbox", "trash");
    assert.equal(po.message("a", one.id)?.folder, "inbox");
  });

  it("only touches the caller's own mailbox", async () => {
    const { po, one } = await setup();
    const r = po.actOnThreads("b", [one.threadId], "trash");
    po.restore("b", [{ id: one.id, folder: "trash", unread: false, starred: false }]);
    assert.equal(po.message("a", one.id)?.folder, "inbox");
    assert.ok(r.before.every((s) => po.message("b", s.id)));
  });
});
