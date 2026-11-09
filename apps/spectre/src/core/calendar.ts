import { randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";
import type { Appointment, Calendar, TimeRange } from "./growth-model.ts";
import type { Contact } from "./model.ts";
import { normalizeTags } from "./contacts-plus.ts";
import { findContact, digits } from "./forms.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;

/* ---------------- Time zones (built-in Intl, no libraries) ---------------- */

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. */
function partsIn(date: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** Offset (ms) of a zone at an instant: local wall time minus UTC. */
function offsetAt(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant for a wall-clock time in a zone. Resolves DST: a time that doesn't exist
 * (spring forward) moves forward to the next valid time; an ambiguous time (fall back) takes the earlier one.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Try the zone's offset just before and just after; keep the candidate whose wall clock matches.
  const before = guess - offsetAt(new Date(guess - 12 * 3_600_000), tz);
  const after = guess - offsetAt(new Date(guess + 12 * 3_600_000), tz);
  const matches = (t: number) => {
    const p = partsIn(new Date(t), tz);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.min === min;
  };
  const valid = [before, after].filter(matches);
  if (valid.length) return new Date(Math.min(...valid)); // ambiguous (fall back): the earlier one
  return new Date(before); // in a spring-forward gap: same moment as "an hour later" on the new clock
}


/* ---------------- Calendars ---------------- */

export function cleanCalendarInput(raw: Record<string, unknown>, ownerCid: string): Omit<Calendar, "id" | "workspace" | "createdAt"> {
  const name = String(raw.name ?? "").trim().slice(0, 100);
  if (!name) throw new SpectreError("invalid", "Name the calendar");
  const timezone = String(raw.timezone ?? "UTC");
  if (!validTimeZone(timezone)) throw new SpectreError("invalid", `Unknown time zone ${timezone}`);
  const durationMin = Math.round(Number(raw.durationMin ?? 30));
  if (!(durationMin >= 5 && durationMin <= 480)) throw new SpectreError("invalid", "Meetings are 5 minutes to 8 hours");
  const bufferMin = Math.max(0, Math.min(240, Math.round(Number(raw.bufferMin ?? 0)) || 0));
  const minNoticeHours = Math.max(0, Math.min(24 * 30, Number(raw.minNoticeHours ?? 4) || 0));
  const horizonDays = Math.max(1, Math.min(365, Math.round(Number(raw.horizonDays ?? 30)) || 30));
  const avIn = (raw.availability && typeof raw.availability === "object" ? raw.availability : { 1: [{ start: "09:00", end: "17:00" }], 2: [{ start: "09:00", end: "17:00" }], 3: [{ start: "09:00", end: "17:00" }], 4: [{ start: "09:00", end: "17:00" }], 5: [{ start: "09:00", end: "17:00" }] }) as Record<string, unknown>;
  const availability: Record<string, TimeRange[]> = {};
  for (let wd = 0; wd < 7; wd++) {
    const ranges = Array.isArray(avIn[wd]) ? (avIn[wd] as any[]) : [];
    const clean = ranges.filter((r) => HHMM.test(r?.start) && HHMM.test(r?.end) && r.start < r.end).slice(0, 6).map((r) => ({ start: r.start, end: r.end }));
    if (clean.length) availability[String(wd)] = clean.sort((a, b) => a.start.localeCompare(b.start));
  }
  if (!Object.keys(availability).length) throw new SpectreError("invalid", "Add at least one block of availability");
  return {
    name, description: String(raw.description ?? "").trim().slice(0, 500) || undefined, durationMin, bufferMin, timezone, availability,
    minNoticeHours, horizonDays, ownerCid, tags: normalizeTags(raw.tags), active: raw.active === undefined ? true : Boolean(raw.active),
  };
}

export async function createCalendar(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>): Promise<Calendar> {
  const cal: Calendar = { id: `cal_${randomUUID()}`, workspace: ws, ...cleanCalendarInput(raw, actor), createdAt: crm.now().toISOString() };
  crm.store.calendars.set(cal.id, cal);
  await crm.record(actor, `calendar:${cal.id}`, { event: "calendar.created" });
  return cal;
}

export async function updateCalendar(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, unknown>): Promise<Calendar> {
  const cal = crm.store.calendars.get(id);
  if (!cal || cal.workspace !== ws) throw new SpectreError("not_found", "Calendar not found");
  const next: Calendar = { ...cal, ...cleanCalendarInput({ ...cal, ...raw }, cal.ownerCid) };
  crm.store.calendars.set(id, next);
  await crm.record(actor, `calendar:${id}`, { event: "calendar.updated", active: next.active });
  return next;
}

/** Bookable start times (UTC ISO) between `from` and the calendar's horizon, at most `days` days. */
export function availableSlots(cal: Calendar, booked: Appointment[], now: Date, opts: { from?: Date; days?: number } = {}): string[] {
  const step = cal.durationMin * MIN;
  const earliest = now.getTime() + cal.minNoticeHours * 3_600_000;
  const horizon = now.getTime() + cal.horizonDays * 86_400_000;
  const from = Math.max(opts.from?.getTime() ?? now.getTime(), now.getTime());
  const until = Math.min(horizon, from + (opts.days ?? 7) * 86_400_000);
  const taken = booked.filter((a) => a.calendarId === cal.id && a.status === "booked")
    .map((a) => [Date.parse(a.start) - cal.bufferMin * MIN, Date.parse(a.end) + cal.bufferMin * MIN] as const);
  const out: string[] = [];
  // Walk calendar days in the calendar's own zone.
  const start = partsIn(new Date(from), cal.timezone);
  for (let i = 0; i <= Math.ceil((until - from) / 86_400_000) + 1; i++) {
    const dayUtc = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const { y, m, d } = { y: dayUtc.getUTCFullYear(), m: dayUtc.getUTCMonth() + 1, d: dayUtc.getUTCDate() };
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    for (const r of cal.availability[String(weekday)] ?? []) {
      const [sh, sm] = r.start.split(":").map(Number);
      const [eh, em] = r.end.split(":").map(Number);
      const blockStart = zonedToUtc(y, m, d, sh, sm, cal.timezone).getTime();
      const blockEnd = zonedToUtc(y, m, d, eh, em, cal.timezone).getTime();
      for (let t = blockStart; t + step <= blockEnd; t += step) {
        if (t < earliest || t < from || t >= until) continue;
        if (taken.some(([a, b]) => t < b && t + step > a)) continue;
        out.push(new Date(t).toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

export interface BookingInput {
  start: string;
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
}

/** Book a slot: re-checks availability, then finds or creates the contact and logs the meeting. */
export async function book(crm: SpectreCRM, cal: Calendar, input: BookingInput): Promise<{ appointment: Appointment; contact: Contact; created: boolean; addedTags: string[] }> {
  if (!cal.active) throw new SpectreError("inactive", "This calendar isn't taking bookings right now");
  const ws = cal.workspace;
  const actor = `booking:${cal.id}`;
  const name = String(input.name ?? "").trim().slice(0, 120);
  const email = String(input.email ?? "").trim().toLowerCase().slice(0, 200) || undefined;
  const phone = String(input.phone ?? "").trim().slice(0, 40) || undefined;
  if (!name) throw new SpectreError("invalid", "Please tell us your name");
  if (email && !EMAIL.test(email)) throw new SpectreError("invalid", "That email address doesn't look right");
  if (phone && digits(phone).length < 7) throw new SpectreError("invalid", "That phone number doesn't look right");
  if (!email && !phone) throw new SpectreError("invalid", "Please leave an email address or phone number");
  const start = new Date(String(input.start ?? ""));
  if (Number.isNaN(start.getTime())) throw new SpectreError("invalid", "Pick a time");
  const startIso = start.toISOString();
  // The slot must still be open (two people may pick it at once).
  const open = availableSlots(cal, crm.list("appointments", ws), crm.now(), { from: new Date(start.getTime() - 1), days: 1 });
  if (!open.includes(startIso)) throw new SpectreError("slot_taken", "Sorry, that time was just taken. Please pick another.");

  let contact = findContact(crm, ws, email, phone);
  if (contact?.optedOut) throw new SpectreError("opted_out", "This address has asked not to be contacted, so we can't book it here.");
  const created = !contact;
  const before = new Set(contact?.tags ?? []);
  if (!contact) contact = await crm.addContact(ws, actor, { name, email, phone, tags: cal.tags, source: `booking:${cal.id}` });
  else if (cal.tags.length) contact = await crm.updateContact(ws, actor, contact.id, { tags: normalizeTags([...(contact.tags ?? []), ...cal.tags]), email: contact.email ?? email, phone: contact.phone ?? phone });

  const end = new Date(start.getTime() + cal.durationMin * MIN).toISOString();
  const notes = String(input.notes ?? "").trim().slice(0, 2000) || undefined;
  const activity = await crm.logActivity(ws, actor, {
    kind: "meeting", summary: `${cal.name} booked for ${startIso.slice(0, 16).replace("T", " ")} UTC${notes ? `: ${notes}` : ""}`,
    contactIds: [contact.id], companyId: contact.companyId, at: startIso, inbound: true,
  });
  const appointment: Appointment = {
    id: `apt_${randomUUID()}`, workspace: ws, calendarId: cal.id, contactId: contact.id, start: startIso, end, status: "booked", notes,
    createdAt: crm.now().toISOString(), activityId: activity.id,
  };
  crm.store.appointments.set(appointment.id, appointment);
  return { appointment, contact, created, addedTags: (contact.tags ?? []).filter((t) => !before.has(t)) };
}

export async function cancelAppointment(crm: SpectreCRM, ws: string, actor: string, id: string): Promise<Appointment> {
  const a = crm.store.appointments.get(id);
  if (!a || a.workspace !== ws) throw new SpectreError("not_found", "Appointment not found");
  if (a.status === "cancelled") return a;
  const next = { ...a, status: "cancelled" as const };
  crm.store.appointments.set(id, next);
  await crm.logActivity(ws, actor, { kind: "note", summary: `Meeting on ${a.start.slice(0, 16).replace("T", " ")} UTC cancelled`, contactIds: [a.contactId] });
  return next;
}

/** An .ics file so attendees can add the meeting to any calendar app. */
export function icsFor(cal: Calendar, a: Appointment, organizer = "+SPCTR"): string {
  const fmt = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Infinitum//SPCTR//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${a.id}@spctr`, `DTSTAMP:${fmt(a.createdAt)}`, `DTSTART:${fmt(a.start)}`, `DTEND:${fmt(a.end)}`,
    `SUMMARY:${esc(cal.name)}`, `DESCRIPTION:${esc(`Booked with ${organizer}`)}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}
