import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

describe("+SPCTR contact filters and bulk tags", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const ids: Record<string, string> = {};
  const names = async (qs: string) => (await h.call("GET", `/api/crm/contacts?${qs}`, undefined, me.cookie)).body.contacts.map((c: { name: string }) => c.name).sort();

  before(async () => {
    h = await harness();
    me = await h.signUp("lena");
    for (const [name, extra] of [["Ana Petrova", { email: "ana@a.example", phone: "+1 415 555 0101" }], ["Ben Ode", { email: "ben@b.example" }], ["Cy Lim", { phone: "+1 415 555 0103" }]] as const) {
      ids[name] = (await h.call("POST", "/api/contacts", { name, ...extra }, me.cookie)).body.id;
    }
    await h.call("POST", `/api/crm/contacts/${ids["Ana Petrova"]}/tags`, { add: ["vip", "lead"] }, me.cookie);
    await h.call("POST", `/api/crm/contacts/${ids["Ben Ode"]}/tags`, { add: ["lead"] }, me.cookie);
  });
  after(() => h.close());

  it("filters by every tag, any tag, address and age", async () => {
    assert.deepEqual(await names("tags=lead,vip"), ["Ana Petrova"]);
    assert.deepEqual(await names("anyTags=vip,lead"), ["Ana Petrova", "Ben Ode"]);
    assert.deepEqual(await names("hasPhone=1"), ["Ana Petrova", "Cy Lim"]);
    assert.deepEqual(await names("hasEmail=0"), ["Cy Lim"]);
    assert.deepEqual(await names("q=ode"), ["Ben Ode"]);
    h.advance(10 * 86_400_000);
    await h.call("POST", "/api/contacts", { name: "Dee New" }, me.cookie);
    assert.deepEqual(await names("createdWithinDays=3"), ["Dee New"]);
  });

  it("bulk adds and removes tags in one call", async () => {
    const r = await h.call("POST", "/api/crm/contacts/bulk-tag", { ids: [ids["Ana Petrova"], ids["Ben Ode"], ids["Cy Lim"]], add: ["webinar"], remove: ["lead"] }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, 3);
    assert.deepEqual(await names("tags=lead"), []);
    assert.deepEqual(await names("tags=webinar"), ["Ana Petrova", "Ben Ode", "Cy Lim"]);
    const again = await h.call("POST", "/api/crm/contacts/bulk-tag", { ids: [ids["Cy Lim"]], remove: ["vip"] }, me.cookie);
    assert.equal(again.body.changed, 0, "nothing to remove");
    assert.equal((await h.call("POST", "/api/crm/contacts/bulk-tag", { ids: [ids["Cy Lim"]] }, me.cookie)).status, 400);
    const tags = (await h.call("GET", "/api/crm/contacts", undefined, me.cookie)).body.tags;
    assert.deepEqual(tags, [{ tag: "webinar", count: 3 }, { tag: "vip", count: 1 }]);
  });

  it("saves the current filter as a smart list that stays to its workspace", async () => {
    const l = await h.call("POST", "/api/crm/lists", { name: "Callable VIPs", filter: { tags: ["vip"], hasPhone: true } }, me.cookie);
    assert.equal(l.status, 200);
    const lists = (await h.call("GET", "/api/crm/lists", undefined, me.cookie)).body;
    assert.deepEqual(lists.map((x: { name: string; count: number }) => [x.name, x.count]), [["Callable VIPs", 1]]);
    const sam = await h.signUp("sam");
    assert.equal((await h.call("GET", `/api/crm/contacts?list=${l.body.id}`, undefined, sam.cookie)).status, 404);
    assert.equal((await h.call("POST", "/api/crm/contacts/bulk-tag", { ids: [ids["Ana Petrova"]], add: ["x"] }, sam.cookie)).status, 404);
  });
});
