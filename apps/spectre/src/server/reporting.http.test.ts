import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

describe("+SPCTR Grow reporting", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const report = async (days?: number, cookie = me.cookie) => (await h.call("GET", `/api/crm/reports/growth${days ? `?days=${days}` : ""}`, undefined, cookie)).body;

  before(async () => {
    h = await harness();
    me = await h.signUp("rory");
    const co = (await h.call("POST", "/api/companies", { name: "Acme" }, me.cookie)).body.id;
    // Last period: one person, one won deal.
    const old = (await h.call("POST", "/api/contacts", { name: "Old Lead", companyId: co }, me.cookie)).body.id;
    const d0 = (await h.call("POST", "/api/deals", { companyId: co, name: "Old", amount: 300, closeDate: "2026-12-20", contactIds: [old] }, me.cookie)).body.id;
    await h.call("POST", `/api/deals/${d0}/stage`, { stage: "won" }, me.cookie);
    h.advance(40 * 86_400_000);
    // This period: three people (one from a form), two won and one lost deal, a form answer, a booking.
    const ids: string[] = [];
    for (const name of ["Ana Petrova", "Ben Ode", "Cy Lim"]) ids.push((await h.call("POST", "/api/contacts", { name, companyId: co }, me.cookie)).body.id);
    await h.call("POST", `/api/crm/contacts/${ids[0]}/fields`, { source: "Website form" }, me.cookie);
    for (const [i, stage, amount] of [[0, "won", 1000], [1, "won", 500], [2, "lost", 900]] as const) {
      const d = (await h.call("POST", "/api/deals", { companyId: co, name: `D${i}`, amount, closeDate: "2026-12-20", contactIds: [ids[i]!] }, me.cookie)).body.id;
      const m = await h.call("POST", `/api/deals/${d}/stage`, { stage, lostReason: "Budget cut" }, me.cookie);
      assert.equal(m.status, 200, JSON.stringify(m.body));
    }
    const at = h.crm.now().toISOString();
    h.crm.store.forms.set("fm_1", { id: "fm_1", workspace: me.cid, name: "Contact us" } as never);
    h.crm.store.submissions.set("fs_1", { id: "fs_1", workspace: me.cid, formId: "fm_1", contactId: ids[0]!, answers: { message: "secret answer" }, at });
    h.crm.store.appointments.set("ap_1", { id: "ap_1", workspace: me.cid, calendarId: "cal", contactId: ids[1]!, start: at, end: at, status: "booked", createdAt: at });
    h.crm.store.appointments.set("ap_2", { id: "ap_2", workspace: me.cid, calendarId: "cal", contactId: ids[2]!, start: at, end: at, status: "cancelled", createdAt: at });
  });
  after(() => h.close());

  it("counts this period against the one before", async () => {
    const r = await report(30);
    assert.equal(r.days, 30);
    assert.deepEqual(r.totals.newContacts, { now: 3, before: 1 });
    assert.deepEqual(r.totals.dealsWon, { now: 2, before: 1 });
    assert.deepEqual(r.totals.formSubmissions, { now: 1, before: 0 });
    assert.deepEqual(r.totals.appointmentsBooked, { now: 1, before: 0 }, "cancelled bookings don't count");
    assert.equal(r.wonValue, 1500);
    assert.equal(r.winRate, 67);
    assert.deepEqual(r.sources, [{ source: "Added by hand", count: 2 }, { source: "Website form", count: 1 }]);
    assert.deepEqual(r.forms, [{ name: "Contact us", count: 1 }]);
    assert.equal(r.series.length, 30);
    assert.equal(r.series.reduce((s: number, d: { contacts: number }) => s + d.contacts, 0), 3);
    assert.ok(!JSON.stringify(r).includes("secret answer"), "no answers in the report");
  });

  it("supports 7 and 90 days, falls back to 30, and stays in its workspace", async () => {
    assert.equal((await report(90)).series.length, 13, "weekly bars for 90 days");
    assert.equal((await report(7)).series.length, 7);
    assert.equal((await report(12)).days, 30);
    const sam = await h.signUp("sam");
    const r = await report(30, sam.cookie);
    assert.deepEqual([r.totals.newContacts.now, r.wonValue, r.winRate], [0, 0, null]);
  });
});
