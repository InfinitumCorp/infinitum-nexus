import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

describe("+SPCTR calendars and booking", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  let calId: string;
  before(async () => { h = await harness(); me = await h.signUp("alex"); }); // clock: Thu 2026-11-05 09:00 UTC
  after(() => h.close());

  it("validates calendars", async () => {
    assert.equal((await h.call("POST", "/api/crm/calendars", { name: "Intro", timezone: "Mars/Olympus" }, me.cookie)).status, 400);
    assert.equal((await h.call("POST", "/api/crm/calendars", { name: "Intro", availability: { 1: [{ start: "17:00", end: "09:00" }] } }, me.cookie)).status, 400);
    const r = await h.call("POST", "/api/crm/calendars", {
      name: "Intro call", timezone: "Europe/Moscow", durationMin: 30, minNoticeHours: 4, tags: ["Booked Call"],
      availability: { 1: [{ start: "09:00", end: "12:00" }], 2: [{ start: "09:00", end: "12:00" }], 3: [{ start: "09:00", end: "12:00" }], 4: [{ start: "09:00", end: "12:00" }], 5: [{ start: "09:00", end: "12:00" }] },
    }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    calId = r.body.id;
  });

  it("offers times in the calendar's own zone, after the notice period, skipping weekends", async () => {
    const r = await h.call("GET", `/api/public/calendars/${calId}?days=5`);
    assert.equal(r.status, 200);
    assert.ok(!("workspace" in r.body) && !("ownerCid" in r.body));
    // Thursday 12:00 Moscow has passed; Friday 09:00-12:00 Moscow = 06:00-09:00 UTC.
    assert.deepEqual(r.body.slots.slice(0, 6), [
      "2026-11-06T06:00:00.000Z", "2026-11-06T06:30:00.000Z", "2026-11-06T07:00:00.000Z",
      "2026-11-06T07:30:00.000Z", "2026-11-06T08:00:00.000Z", "2026-11-06T08:30:00.000Z",
    ]);
    assert.equal(r.body.slots[6], "2026-11-09T06:00:00.000Z", "next is Monday; no weekend slots");
  });

  it("booking creates the contact, the meeting and the appointment, and fires events", async () => {
    const r = await h.call("POST", `/api/public/calendars/${calId}/book`, { start: "2026-11-06T07:00:00.000Z", name: "Lin Chen", email: "Lin@Agency.example", notes: "About the tender" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.ics, /BEGIN:VCALENDAR[\s\S]*DTSTART:20261106T070000Z[\s\S]*DTEND:20261106T073000Z/);
    const c = h.crm.list("contacts", me.cid)[0];
    assert.equal(c.email, "lin@agency.example");
    assert.deepEqual(c.tags, ["booked-call"]);
    assert.equal(c.source, `booking:${calId}`);
    const meeting = h.crm.list("activities", me.cid).find((a) => a.kind === "meeting")!;
    assert.match(meeting.summary, /Intro call booked for 2026-11-06 07:00 UTC: About the tender/);
    assert.deepEqual(h.events.map((e) => e.event.type), ["contact.created", "tag.added", "appointment.booked"]);
    const list = await h.call("GET", "/api/crm/appointments", undefined, me.cookie);
    assert.equal(list.body[0].contactName, "Lin Chen");
  });

  it("never double-books a time", async () => {
    const again = await h.call("POST", `/api/public/calendars/${calId}/book`, { start: "2026-11-06T07:00:00.000Z", name: "Someone Else", email: "else@x.example" });
    assert.equal(again.status, 409);
    const slots = (await h.call("GET", `/api/public/calendars/${calId}?days=2`)).body.slots;
    assert.ok(!slots.includes("2026-11-06T07:00:00.000Z"));
  });

  it("rejects times outside availability and inside the notice period", async () => {
    const offHours = await h.call("POST", `/api/public/calendars/${calId}/book`, { start: "2026-11-06T15:00:00.000Z", name: "X", email: "x@x.example" });
    assert.equal(offHours.status, 409);
    const tooSoon = await h.call("POST", `/api/public/calendars/${calId}/book`, { start: "2026-11-05T10:00:00.000Z", name: "X", email: "x@x.example" });
    assert.equal(tooSoon.status, 409);
    const noContact = await h.call("POST", `/api/public/calendars/${calId}/book`, { start: "2026-11-06T08:00:00.000Z", name: "X" });
    assert.equal(noContact.status, 400);
  });

  it("cancelling frees the time again", async () => {
    const appt = (await h.call("GET", "/api/crm/appointments", undefined, me.cookie)).body[0];
    await h.call("POST", `/api/crm/appointments/${appt.id}/cancel`, {}, me.cookie);
    const slots = (await h.call("GET", `/api/public/calendars/${calId}?days=2`)).body.slots;
    assert.ok(slots.includes("2026-11-06T07:00:00.000Z"));
  });

  it("closed calendars stop taking bookings, and calendars stay private to their workspace", async () => {
    const other = await h.signUp("sam");
    assert.equal((await h.call("PATCH", `/api/crm/calendars/${calId}`, { active: false }, other.cookie)).status, 404);
    await h.call("PATCH", `/api/crm/calendars/${calId}`, { active: false }, me.cookie);
    assert.equal((await h.call("GET", `/api/public/calendars/${calId}`)).status, 404);
  });

  it("lets the booking page be embedded", async () => {
    const page = await fetch(h.base + "/book.html");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), null);
  });
});
