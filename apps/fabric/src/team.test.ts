import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FabricIdentity } from "./auth.ts";
import { FabricServiceError, touchUser } from "./service.ts";
import { FabricStore } from "./store.ts";
import { TeamService, parseQuery, parseReminder, type TeamEvent } from "./team.ts";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
function person(n: number, username: string): FabricIdentity {
  const hex = String(n).repeat(8).slice(0, 8);
  return { sub: `${hex}-1111-4111-8111-111111111111`, issuer: ISSUER, username, email: null, name: username[0]!.toUpperCase() + username.slice(1), expiresAt: 0 };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fabric-team-"));
  const path = join(dir, "fabric.sqlite");
  const store = new FabricStore(path);
  let now = Date.parse("2026-11-12T10:00:00.000Z");
  const events: { subs: string[]; event: TeamEvent }[] = [];
  const team = new TeamService(store, randomBytes(32), { publish: (subs, event) => events.push({ subs, event }), clock: () => new Date(now) });
  const alice = person(1, "alice");
  const bob = person(2, "bob");
  const cara = person(3, "cara");
  const dan = person(4, "dan");
  for (const p of [alice, bob, cara, dan]) touchUser(store, p);
  return {
    dir, path, store, team, events, alice, bob, cara, dan,
    advance(ms: number) { now += ms; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const status = (code: number) => (e: unknown) => e instanceof FabricServiceError && e.status === code;

test("workspaces, invites, default channels, channels and permissions", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme Robotics");
    assert.equal(ws.slug, "acme-robotics");
    assert.equal(ws.role, "owner");
    assert.equal(t.team.createWorkspace(t.alice, "Acme Robotics").slug, "acme-robotics-2");
    assert.throws(() => t.team.sidebar(t.bob, ws.id), status(404));
    assert.throws(() => t.team.joinWorkspace(t.bob, "nope-nope-nope"), status(404));
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const bar = t.team.sidebar(t.bob, ws.id);
    assert.deepEqual(bar.channels.map((c) => c.name), ["general", "random"]);

    const eng = t.team.createChannel(t.alice, ws.id, { name: "Eng Team", topic: "Build things" });
    assert.equal(eng.name, "eng-team");
    assert.throws(() => t.team.createChannel(t.bob, ws.id, { name: "eng-team" }), status(409));
    assert.throws(() => t.team.send(t.bob, eng.id, { text: "hi" }), status(403));
    t.team.joinChannel(t.bob, eng.id);
    t.team.send(t.bob, eng.id, { text: "hi" });

    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true, members: ["bob"] });
    assert.throws(() => t.team.list(t.cara, secret.id), status(404));
    assert.throws(() => t.team.joinChannel(t.cara, secret.id), status(404));
    assert.equal(t.team.browseChannels(t.cara, ws.id).some((c) => c.name === "secret"), false);
    assert.equal(t.team.browseChannels(t.bob, ws.id).some((c) => c.name === "secret"), true);

    assert.throws(() => t.team.updateChannel(t.bob, eng.id, { name: "renamed" }), status(403));
    t.team.updateChannel(t.bob, eng.id, { topic: "Ship it" });
    assert.equal(t.team.getChannel(t.cara, eng.id).topic, "Ship it");
    t.team.archiveChannel(t.alice, eng.id, true);
    assert.throws(() => t.team.send(t.bob, eng.id, { text: "late" }), status(400));
    assert.throws(() => t.team.archiveChannel(t.alice, bar.channels[0]!.id, true), status(400));

    assert.throws(() => t.team.removeMember(t.bob, ws.id, "cara"), status(403));
    t.team.setRole(t.alice, ws.id, "bob", "admin");
    t.team.removeMember(t.bob, ws.id, "cara");
    assert.throws(() => t.team.sidebar(t.cara, ws.id), status(404));
    assert.throws(() => t.team.joinWorkspace(t.cara, ws.inviteCode), status(403));
    assert.throws(() => t.team.setRole(t.alice, ws.id, "alice", "member"), status(400));
  } finally {
    t.close();
  }
});

test("messages are sealed; threads, reactions, edits, deletes, pins and saved items work", () => {
  const t = setup();
  const phrase = `sealed-${randomBytes(6).toString("hex")}`;
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const sent = t.team.send(t.alice, general.id, { text: `${phrase} hello @bob` }).message!;
    assert.deepEqual(sent.mentions, [t.bob.sub]);
    let bobBar = t.team.sidebar(t.bob, ws.id).channels.find((c) => c.id === general.id)!;
    assert.equal(bobBar.unread, 1);
    assert.equal(bobBar.mentions, 1);
    t.team.markRead(t.bob, general.id);
    assert.equal(t.team.sidebar(t.bob, ws.id).channels.find((c) => c.id === general.id)!.unread, 0);
    t.team.markRead(t.bob, general.id, sent.id);
    assert.equal(t.team.sidebar(t.bob, ws.id).channels.find((c) => c.id === general.id)!.unread, 1);

    const reply = t.team.send(t.bob, general.id, { text: "a reply", parentId: sent.id }).message!;
    t.team.send(t.bob, general.id, { text: "also to channel", parentId: reply.id, alsoInChannel: true });
    const thread = t.team.thread(t.alice, sent.id);
    assert.equal(thread.replies.length, 2);
    assert.equal(thread.parent.replyCount, 2);
    assert.deepEqual(thread.parent.replyUsers, [t.bob.sub]);
    const top = t.team.list(t.alice, general.id).messages.filter((m) => m.kind === "user").map((m) => m.text);
    assert.deepEqual(top, [`${phrase} hello @bob`, "also to channel"]);
    assert.equal(t.team.threads(t.alice, ws.id)[0]?.parent.id, sent.id);
    assert.ok(t.team.activity(t.alice, ws.id).some((a) => a.kind === "reply" && a.message.id === reply.id));

    assert.equal(t.team.react(t.bob, sent.id, "👍")[0]?.count, 1);
    assert.equal(t.team.react(t.alice, sent.id, "👍")[0]?.count, 2);
    assert.equal(t.team.react(t.alice, sent.id, "👍")[0]?.count, 1);
    t.team.react(t.bob, sent.id, ":tada:");
    assert.throws(() => t.team.react(t.bob, sent.id, "<script>"), status(400));
    assert.ok(t.team.activity(t.alice, ws.id).some((a) => a.kind === "reaction" && a.emoji === "👍"));

    assert.throws(() => t.team.edit(t.bob, sent.id, "hijack"), status(403));
    const edited = t.team.edit(t.alice, sent.id, `${phrase} edited`);
    assert.ok(edited.editedAt);
    assert.deepEqual(edited.mentions, []);

    t.team.pin(t.bob, sent.id, true);
    assert.equal(t.team.pins(t.alice, general.id)[0]?.id, sent.id);
    t.team.save(t.bob, sent.id, {});
    assert.equal(t.team.saved(t.bob, ws.id)[0]?.messageId, sent.id);
    assert.equal(t.team.saved(t.alice, ws.id).length, 0);

    t.team.remove(t.bob, reply.id);
    assert.equal(t.team.thread(t.alice, sent.id).parent.replyCount, 1);
    assert.throws(() => t.team.remove(t.bob, sent.id), status(403));
    t.team.remove(t.alice, sent.id);
    const gone = t.team.list(t.alice, general.id).messages.find((m) => m.id === sent.id)!;
    assert.equal(gone.deleted, true, "a deleted parent with replies stays as a placeholder");
    assert.equal(gone.text, "");
    assert.equal(t.team.pins(t.alice, general.id).length, 0);

    t.store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = t.path + suffix;
      if (existsSync(file)) assert.equal(readFileSync(file).includes(phrase), false);
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("direct and group conversations, @channel, @here and user groups notify the right people", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    for (const p of [t.bob, t.cara, t.dan]) t.team.joinWorkspace(p, ws.inviteCode);
    const dm = t.team.openConversation(t.alice, ws.id, ["bob"]);
    assert.equal(dm.kind, "dm");
    assert.equal(t.team.openConversation(t.bob, ws.id, ["@alice"]).id, dm.id);
    assert.equal(dm.name, "Bob");
    const sent = t.team.send(t.alice, dm.id, { text: "no mention needed" }).message!;
    assert.deepEqual(sent.mentions, [t.bob.sub]);
    assert.throws(() => t.team.list(t.cara, dm.id), status(404));
    const group = t.team.openConversation(t.alice, ws.id, ["bob", "cara"]);
    assert.equal(group.kind, "group");
    const self = t.team.openConversation(t.alice, ws.id, []);
    assert.match(self.name, /\(you\)/);

    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    assert.equal(t.team.send(t.alice, general.id, { text: "@channel standup" }).message!.mentions.length, 3);
    t.team.seen(t.bob.sub);
    const here = t.team.send(t.alice, general.id, { text: "@here anyone?" }).message!;
    assert.deepEqual(here.mentions, [t.bob.sub]);

    t.team.saveGroup(t.alice, ws.id, { handle: "@design", name: "Design", members: ["cara", "dan"] });
    assert.deepEqual(t.team.send(t.alice, general.id, { text: "ping @design" }).message!.mentions.sort(), [t.cara.sub, t.dan.sub].sort());
    const eng = t.team.createChannel(t.alice, ws.id, { name: "eng" });
    assert.deepEqual(t.team.send(t.alice, eng.id, { text: "hey @dan" }).notInChannel, ["dan"]);
  } finally {
    t.close();
  }
});

test("slash commands, statuses, do not disturb, scheduled messages and reminders", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    assert.equal(t.team.send(t.alice, general.id, { text: "/shrug ok" }).message!.text, "ok ¯\\_(ツ)_/¯");
    assert.equal(t.team.send(t.alice, general.id, { text: "/me waves" }).message!.text, "_waves_");
    t.team.send(t.alice, general.id, { text: "/topic Launch week" });
    assert.equal(t.team.getChannel(t.alice, general.id).topic, "Launch week");
    assert.match(t.team.send(t.alice, general.id, { text: "/help" }).ephemeral!, /\/remind/);
    assert.throws(() => t.team.send(t.alice, general.id, { text: "/nope" }), status(400));
    const dm = t.team.send(t.alice, general.id, { text: "/dm @bob psst" });
    assert.equal(t.team.list(t.bob, dm.channelId!).messages[0]?.text, "psst");

    t.team.send(t.alice, general.id, { text: "/status 🌴 On holiday" });
    let me = t.team.sidebar(t.alice, ws.id).me;
    assert.equal(me.statusEmoji, "🌴");
    assert.equal(me.statusText, "On holiday");
    t.team.send(t.alice, general.id, { text: "/dnd 30m" });
    assert.equal(t.team.sidebar(t.alice, ws.id).me.dnd, true);
    t.advance(31 * 60_000);
    me = t.team.sidebar(t.alice, ws.id).me;
    assert.equal(me.dnd, false);

    const later = new Date(Date.parse("2026-11-12T10:31:00Z") + 60 * 60_000).toISOString();
    const s = t.team.schedule(t.alice, general.id, { text: "scheduled hello", sendAt: later });
    assert.equal(t.team.scheduledList(t.alice, ws.id)[0]?.text, "scheduled hello");
    assert.throws(() => t.team.schedule(t.alice, general.id, { text: "past", sendAt: "2020-01-01" }), status(400));
    assert.match(t.team.send(t.alice, general.id, { text: "/remind me to file taxes in 2 hours" }).ephemeral!, /file taxes/);
    assert.deepEqual(t.team.tick(), { sent: 0, reminded: 0 });
    t.advance(61 * 60_000);
    assert.deepEqual(t.team.tick(), { sent: 1, reminded: 0 });
    assert.equal(t.team.list(t.bob, general.id).messages.at(-1)?.id, s.id);
    assert.equal(t.team.scheduledList(t.alice, ws.id).length, 0);
    t.advance(60 * 60_000);
    assert.deepEqual(t.team.tick(), { sent: 0, reminded: 1 });
    const act = t.team.activity(t.alice, ws.id);
    assert.equal(act[0]?.kind, "reminder");
    assert.equal(act[0]?.message.text, "Reminder: file taxes");
    assert.equal(t.team.reminders(t.alice, ws.id)[0]?.fired, true);
  } finally {
    t.close();
  }
});

test("search, files, canvases and bookmarks respect channel access", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true });
    t.team.send(t.alice, general.id, { text: "Quarterly budget review at https://example.com" });
    t.team.send(t.alice, secret.id, { text: "budget secret numbers" });
    t.team.send(t.bob, general.id, { text: "budget looks fine" });
    assert.equal(t.team.search(t.alice, ws.id, "budget").messages.length, 3);
    assert.equal(t.team.search(t.bob, ws.id, "budget").messages.length, 2);
    assert.equal(t.team.search(t.bob, ws.id, "budget from:@bob").messages.length, 1);
    assert.equal(t.team.search(t.alice, ws.id, "budget in:#secret").messages.length, 1);
    assert.equal(t.team.search(t.alice, ws.id, "has:link").messages.length, 1);
    assert.equal(t.team.search(t.alice, ws.id, '"budget review"').messages.length, 1);
    assert.equal(t.team.search(t.alice, ws.id, "general").channels[0]?.name, "general");

    const file = t.team.upload(t.alice, secret.id, { name: "plan.txt", mime: "text/plain", data: Buffer.from("the plan").toString("base64") });
    assert.throws(() => t.team.download(t.bob, file.id), status(404));
    t.team.send(t.alice, secret.id, { text: "", fileIds: [file.id] });
    assert.equal(t.team.download(t.alice, file.id).data.toString(), "the plan");
    assert.throws(() => t.team.download(t.bob, file.id), status(404));
    assert.equal(t.team.files(t.bob, ws.id).length, 0);
    assert.equal(t.team.files(t.alice, ws.id).length, 1);

    t.team.setCanvas(t.alice, general.id, "# Plan\n- ship");
    assert.equal(t.team.canvas(t.bob, general.id).text, "# Plan\n- ship");
    assert.throws(() => t.team.canvas(t.bob, secret.id), status(404));
    t.team.addBookmark(t.bob, general.id, { url: "https://docs.example.com/x" });
    assert.throws(() => t.team.addBookmark(t.bob, general.id, { url: "javascript:alert(1)" }), status(400));
    assert.equal(t.team.getChannel(t.alice, general.id).bookmarks[0]?.title, "docs.example.com");
  } finally {
    t.close();
  }
});

test("reminder and search query parsing", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assert.deepEqual(parseReminder("me to call Sam in 10 minutes", now), { text: "call Sam", at: "2026-11-12T10:10:00.000Z" });
  assert.deepEqual(parseReminder("me stand-up at 9:30", now), { text: "stand-up", at: "2026-11-13T09:30:00.000Z" });
  assert.deepEqual(parseReminder("me lunch at 1pm", now, 60), { text: "lunch", at: "2026-11-12T12:00:00.000Z" });
  assert.deepEqual(parseReminder("me pay rent tomorrow", now), { text: "pay rent", at: "2026-11-13T09:00:00.000Z" });
  assert.equal(parseReminder("bob to x in 5m", now), null);
  const q = parseQuery('roadmap "next quarter" in:#eng from:@bob has:files during:2026-11-01');
  assert.deepEqual(q.terms, ["roadmap", "next quarter"]);
  assert.equal(q.inChannel, "eng");
  assert.equal(q.from, "bob");
  assert.ok(q.has.has("file"));
  assert.equal(q.after, "2026-11-01T00:00:00.000Z");
  assert.equal(q.before, "2026-11-02T00:00:00.000Z");
});
