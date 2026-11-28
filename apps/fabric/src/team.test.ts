import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FabricIdentity } from "./auth.ts";
import { FabricServiceError, touchUser } from "./service.ts";
import { FabricStore } from "./store.ts";
import { TeamService, dueDate, imageType, nextRun, parseIceServers, parseQuery, parseReminder, type TeamEvent } from "./team.ts";

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

test("polls: create, vote, move a single vote, multiple choice, anonymous, close", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    assert.throws(() => t.team.createPoll(t.alice, general.id, { question: "Lunch?", options: ["Pizza"] }), status(400));
    assert.throws(() => t.team.createPoll(t.alice, general.id, { question: "Lunch?", options: ["Pizza", "pizza"] }), status(400));
    const poll = t.team.createPoll(t.alice, general.id, { question: "Lunch?", options: ["Pizza", "Sushi", "Soup"] });
    assert.equal(poll.text, "Lunch?");
    assert.deepEqual(poll.poll!.options.map((o) => o.text), ["Pizza", "Sushi", "Soup"]);
    // The options are sealed, not stored as plain text.
    const raw = t.store.database.prepare("SELECT ciphertext FROM team_polls").get() as { ciphertext: string };
    assert.doesNotMatch(raw.ciphertext, /Sushi/);

    t.team.vote(t.bob, poll.id, 0);
    let view = t.team.vote(t.bob, poll.id, 1);
    assert.deepEqual(view.poll!.options.map((o) => o.count), [0, 1, 0], "a single-choice vote moves");
    assert.equal(view.poll!.options[1]!.mine, true);
    view = t.team.vote(t.cara, poll.id, 1);
    assert.deepEqual(view.poll!.options[1]!.voters, ["Bob", "Cara"]);
    assert.equal(view.poll!.voters, 2);
    view = t.team.vote(t.cara, poll.id, 1);
    assert.equal(view.poll!.options[1]!.count, 1, "voting again takes the vote back");
    assert.throws(() => t.team.vote(t.bob, poll.id, 7), status(400));
    assert.throws(() => t.team.closePoll(t.bob, poll.id), status(403));
    assert.equal(t.team.closePoll(t.alice, poll.id).poll!.closed, true);
    assert.throws(() => t.team.vote(t.cara, poll.id, 0), status(400));
    assert.ok(t.events.some((e) => e.event.type === "poll" && e.event.messageId === poll.id));

    const multi = t.team.send(t.alice, general.id, { text: '/poll "Which days?" "Mon" "Tue" "Wed" --multiple --anonymous' }).message!;
    t.team.vote(t.bob, multi.id, 0);
    view = t.team.vote(t.bob, multi.id, 2);
    assert.deepEqual(view.poll!.options.map((o) => o.count), [1, 0, 1]);
    assert.deepEqual(view.poll!.options[0]!.voters, [], "anonymous polls hide who voted");
    assert.equal(view.poll!.anonymous, true);
    assert.throws(() => t.team.send(t.alice, general.id, { text: "/poll just a question" }), status(400));
    t.team.remove(t.alice, multi.id);
    assert.throws(() => t.team.vote(t.bob, multi.id, 0), status(404));
  } finally {
    t.close();
  }
});

test("incoming webhooks post as an app, check the token, and stop when the owner leaves", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const ops = t.team.createChannel(t.alice, ws.id, { name: "ops", members: ["bob"] });
    assert.throws(() => t.team.createWebhook(t.cara, ops.id, { name: "CI" }), status(404));
    const hook = t.team.createWebhook(t.bob, ops.id, { name: "Deploys" });
    const [, , , , id, token] = hook.path.split("/");
    assert.match(hook.path, /^\/api\/team\/hooks\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{43}$/);
    const stored = t.store.database.prepare("SELECT token_hash FROM team_webhooks").get() as { token_hash: string };
    assert.notEqual(stored.token_hash, token, "only a hash of the token is stored");

    const posted = t.team.postWebhook(id!, token!, { text: "Deployed v2 to production" });
    const msg = t.team.getMessage(t.alice, posted.messageId);
    assert.deepEqual(msg.app, { id, name: "Deploys" });
    assert.equal(msg.sender.username, "bob");
    assert.equal(msg.text, "Deployed v2 to production");
    const reply = t.team.postWebhook(id!, token!, { text: "Rolled back", threadId: posted.messageId });
    assert.equal(t.team.getMessage(t.alice, reply.messageId).parentId, posted.messageId);

    // A different last character (one in sixteen tokens already ends in "A", so don't just set it to "A").
    const wrong = `${token!.slice(0, -1)}${token!.endsWith("A") ? "B" : "A"}`;
    assert.notEqual(wrong, token);
    assert.throws(() => t.team.postWebhook(id!, wrong, { text: "x" }), status(404));
    assert.throws(() => t.team.postWebhook(id!, token!, { text: "  " }), status(400));
    assert.equal(t.team.webhooks(t.alice, ws.id).length, 1, "admins see every webhook");
    assert.equal(t.team.webhooks(t.bob, ws.id)[0]!.lastUsedAt !== null, true);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    assert.equal(t.team.webhooks(t.cara, ws.id).length, 0);
    assert.throws(() => t.team.deleteWebhook(t.cara, id!), status(403));

    t.team.leaveChannel(t.bob, ops.id);
    assert.throws(() => t.team.postWebhook(id!, token!, { text: "still here?" }), status(410));
    t.team.deleteWebhook(t.alice, id!);
    assert.throws(() => t.team.postWebhook(id!, token!, { text: "gone" }), status(404));
  } finally {
    t.close();
  }
});

test("huddles: join, signal only to the right person, mute, one huddle at a time, end", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const bar = t.team.sidebar(t.alice, ws.id);
    const general = bar.channels.find((c) => c.name === "general")!;
    const random = bar.channels.find((c) => c.name === "random")!;
    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true, members: ["bob"] });

    assert.equal(t.team.huddle(t.alice, general.id), null);
    const started = t.team.joinHuddle(t.alice, general.id);
    assert.deepEqual(started.people.map((p) => p.username), ["alice"]);
    assert.deepEqual(started.iceServers, []);
    assert.match(t.team.list(t.bob, general.id).messages.at(-1)!.text, /started a huddle/);
    assert.equal(t.team.sidebar(t.bob, ws.id).channels.find((c) => c.id === general.id)!.huddle!.people, 1);
    assert.throws(() => t.team.joinHuddle(t.cara, secret.id), status(404), "only people who can see the channel can join");

    const joined = t.team.joinHuddle(t.bob, general.id);
    assert.deepEqual(joined.people.map((p) => p.username), ["alice", "bob"]);
    assert.ok(t.events.some((e) => e.event.type === "huddle" && e.event.action === "joined" && e.event.sub === t.bob.sub));

    t.events.length = 0;
    t.team.signalHuddle(t.bob, general.id, { to: t.alice.sub, data: { description: { type: "offer", sdp: "v=0 fake" } } });
    const signal = t.events.find((e) => e.event.type === "huddle-signal")!;
    assert.deepEqual(signal.subs, [t.alice.sub], "a signal goes only to the person it is for");
    assert.equal(signal.event.from, t.bob.sub);
    t.team.signalHuddle(t.alice, general.id, { to: t.bob.sub, data: { candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: "0" } } });
    assert.throws(() => t.team.signalHuddle(t.cara, general.id, { to: t.alice.sub, data: { candidate: null } }), status(404), "outsiders cannot signal");
    assert.throws(() => t.team.signalHuddle(t.bob, general.id, { to: t.cara.sub, data: { candidate: null } }), status(404));
    assert.throws(() => t.team.signalHuddle(t.bob, general.id, { to: t.alice.sub, data: { description: { type: "rollback", sdp: "" } } }), status(400));

    assert.equal(t.team.updateHuddle(t.bob, general.id, { muted: true, video: true }).people.find((p) => p.username === "bob")!.muted, true);
    assert.throws(() => t.team.updateHuddle(t.cara, general.id, { muted: true }), status(404));

    // Joining another huddle leaves the first one.
    t.team.joinHuddle(t.bob, random.id);
    assert.deepEqual(t.team.huddle(t.alice, general.id)!.people.map((p) => p.username), ["alice"]);
    t.advance(12 * 60_000);
    t.team.leaveHuddle(t.alice, general.id);
    assert.equal(t.team.huddle(t.alice, general.id), null);
    assert.match(t.team.list(t.alice, general.id).messages.at(-1)!.text, /ended the huddle after 12 minutes/);
    assert.equal(t.team.sidebar(t.alice, ws.id).channels.find((c) => c.id === general.id)!.huddle, null);
    t.team.leaveHuddle(t.bob, random.id);
  } finally {
    t.close();
  }
});

test("FABRIC_ICE_SERVERS parsing", () => {
  assert.deepEqual(parseIceServers(undefined), []);
  assert.deepEqual(parseIceServers(" "), []);
  assert.deepEqual(parseIceServers('[{"urls":"stun:stun.example.org:3478"},{"urls":["turn:turn.example.org:3478?transport=tcp"],"username":"u","credential":"p"}]'), [
    { urls: "stun:stun.example.org:3478" },
    { urls: ["turn:turn.example.org:3478?transport=tcp"], username: "u", credential: "p" },
  ]);
  assert.throws(() => parseIceServers("{}"), /JSON list/);
  assert.throws(() => parseIceServers('[{"urls":"https://example.org"}]'), /stun:/);
});

test("sharing a message: live link, access-checked, never across workspaces", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true, members: ["bob"] });
    const original = t.team.send(t.alice, secret.id, { text: "launch is Friday" }).message!;

    // Cara can't see the private channel, so she can't share from it.
    assert.throws(() => t.team.share(t.cara, original.id, { channelId: general.id }), status(404));
    const shared = t.team.share(t.bob, original.id, { channelId: general.id, text: "FYI" });
    assert.equal(shared.channelId, general.id);
    assert.equal(shared.message!.text, "FYI");
    const forBob = t.team.getMessage(t.bob, shared.message!.id).shared;
    assert.ok(forBob && forBob.available);
    assert.equal(forBob.text, "launch is Friday");
    assert.equal(forBob.channelName, "secret");
    assert.equal(forBob.sender.username, "alice");
    // Cara sees the comment, not the private message.
    assert.deepEqual(t.team.getMessage(t.cara, shared.message!.id).shared, { available: false });

    // Edits show through; sharing a share shares the original.
    t.team.edit(t.alice, original.id, "launch is Monday");
    const again = t.team.share(t.alice, shared.message!.id, { channelId: general.id });
    const inner = t.team.getMessage(t.alice, again.message!.id).shared;
    assert.ok(inner && inner.available);
    assert.equal(inner.id, original.id);
    assert.equal(inner.text, "launch is Monday");

    // Deleting the original removes it from every share.
    t.team.remove(t.alice, original.id);
    assert.equal(t.team.getMessage(t.bob, shared.message!.id).shared, null);
    assert.throws(() => t.team.share(t.bob, original.id, { channelId: general.id }), status(400));

    // You must be able to post where you share, and it stays in the workspace.
    const other = t.team.createWorkspace(t.bob, "Other");
    const otherGeneral = t.team.sidebar(t.bob, other.id).channels.find((c) => c.name === "general")!;
    const hello = t.team.send(t.bob, general.id, { text: "hello" }).message!;
    assert.throws(() => t.team.share(t.bob, hello.id, { channelId: otherGeneral.id }), status(400));
    assert.throws(() => t.team.share(t.cara, hello.id, { channelId: secret.id }), status(404));
  } finally {
    t.close();
  }
});

test("nextRun: daily, weekday and weekly times in the creator's time zone", () => {
  // Friday 2026-11-13 10:00 UTC = 13:00 in Moscow (UTC+3).
  const from = new Date("2026-11-13T10:00:00.000Z");
  assert.equal(nextRun("day", 9 * 60, null, 180, from), "2026-11-14T06:00:00.000Z", "09:00 Moscow tomorrow");
  assert.equal(nextRun("day", 14 * 60, null, 180, from), "2026-11-13T11:00:00.000Z", "14:00 Moscow later today");
  assert.equal(nextRun("weekday", 9 * 60, null, 180, from), "2026-11-16T06:00:00.000Z", "skips the weekend");
  assert.equal(nextRun("week", 10 * 60, 3, 0, from), "2026-11-18T10:00:00.000Z", "next Wednesday");
  assert.equal(nextRun("day", 30, null, -300, new Date("2026-11-14T05:00:00.000Z")), "2026-11-14T05:30:00.000Z", "00:30 in New York");
});

test("workflows: welcome new members, post on a schedule, pause and permissions", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const welcome = t.team.createWorkflow(t.alice, general.id, { kind: "welcome", name: "Hello", text: "Welcome, {name}! Read the pins first." });
    assert.equal(welcome.kind, "welcome");
    const raw = t.store.database.prepare("SELECT ciphertext FROM team_workflows").get() as { ciphertext: string };
    assert.doesNotMatch(raw.ciphertext, /pins/, "workflow text is sealed");

    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const self = t.team.openConversation(t.bob, ws.id, []);
    const got = t.team.list(t.bob, self.id).messages.at(-1)!;
    assert.equal(got.text, "Welcome, Bob! Read the pins first.");
    assert.equal(got.app!.name, "Hello · #general");
    assert.ok(t.team.activity(t.bob, ws.id).some((a) => a.message.id === got.id), "the welcome shows in Activity");

    assert.throws(() => t.team.createWorkflow(t.bob, general.id, { kind: "recurring", text: "x", every: "day", at: "25:00" }), status(400));
    assert.throws(() => t.team.createWorkflow(t.bob, general.id, { kind: "recurring", text: "x", every: "week", at: "09:00" }), status(400));
    const standup = t.team.createWorkflow(t.bob, general.id, { kind: "recurring", name: "Standup", text: "What are you working on today?", every: "day", at: "10:30", tzOffset: 0 });
    assert.equal(standup.nextRunAt, "2026-11-12T10:30:00.000Z");
    assert.equal(standup.at, "10:30");

    t.advance(31 * 60_000);
    assert.equal(t.team.tick().sent, 1);
    const posted = t.team.list(t.alice, general.id).messages.at(-1)!;
    assert.equal(posted.text, "What are you working on today?");
    assert.deepEqual(posted.app, { id: standup.id, name: "Standup" });
    assert.equal(posted.sender.username, "bob");
    assert.equal(t.team.tick().sent, 0, "runs once per day");
    assert.equal(t.team.workflows(t.alice, general.id).find((w) => w.id === standup.id)!.nextRunAt, "2026-11-13T10:30:00.000Z");

    t.team.joinWorkspace(t.cara, ws.inviteCode);
    assert.throws(() => t.team.updateWorkflow(t.cara, standup.id, { paused: true }), status(403));
    assert.equal(t.team.updateWorkflow(t.alice, standup.id, { paused: true }).paused, true, "admins can pause anyone's workflow");
    t.advance(24 * 3600_000);
    assert.equal(t.team.tick().sent, 0, "paused workflows do not run");
    assert.equal(t.team.updateWorkflow(t.bob, standup.id, { paused: false }).nextRunAt, "2026-11-14T10:30:00.000Z");
    t.team.deleteWorkflow(t.bob, standup.id);
    assert.equal(t.team.workflows(t.alice, general.id).length, 1);
  } finally {
    t.close();
  }
});

test("workspace export: admins get public channels, owners can add private ones, never direct messages", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const root = t.team.send(t.bob, general.id, { text: "Ship it on Friday" }).message!;
    t.team.send(t.alice, general.id, { text: "Agreed", parentId: root.id });
    t.team.react(t.cara, root.id, "🚀");
    t.team.pin(t.alice, root.id, true);
    t.team.createPoll(t.alice, general.id, { question: "Lunch?", options: ["Pizza", "Soup"] });
    const gone = t.team.send(t.bob, general.id, { text: "oops" }).message!;
    t.team.remove(t.bob, gone.id);
    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true, members: ["bob"] });
    t.team.send(t.alice, secret.id, { text: "private plans" });
    const dm = t.team.openConversation(t.alice, ws.id, ["bob"]);
    t.team.send(t.alice, dm.id, { text: "just between us" });

    assert.throws(() => t.team.exportWorkspace(t.bob, ws.id), status(403));
    t.team.setRole(t.alice, ws.id, "bob", "admin");
    assert.throws(() => t.team.exportWorkspace(t.bob, ws.id, { includePrivate: true }), status(403));

    const pub = t.team.exportWorkspace(t.bob, ws.id);
    assert.equal(pub.format, "fabric-teams-export/1");
    assert.deepEqual(pub.channels.map((c) => c.name).sort(), ["general", "random"]);
    const g = pub.channels.find((c) => c.name === "general")!;
    const exported = g.messages.find((m) => m.id === root.id)!;
    assert.equal(exported.text, "Ship it on Friday");
    assert.equal(exported.user, "bob");
    assert.equal(exported.replyCount, 1);
    assert.equal(exported.pinned, true);
    assert.deepEqual(exported.reactions, [{ emoji: "🚀", users: ["cara"] }]);
    assert.equal(g.messages.find((m) => m.threadParent === root.id)!.text, "Agreed");
    assert.deepEqual(g.messages.find((m) => m.poll)!.poll!.options.map((o) => o.text), ["Pizza", "Soup"]);
    assert.ok(!g.messages.some((m) => m.id === gone.id), "deleted messages are left out");
    assert.deepEqual(pub.people.map((p) => p.username), ["alice", "bob", "cara"]);
    const all = JSON.stringify(pub);
    assert.doesNotMatch(all, /private plans|just between us/);
    assert.equal(pub.includes.directMessages, false);
    assert.match(t.team.list(t.alice, general.id).messages.at(-1)!.text, /exported the workspace's public channel history/);

    const full = t.team.exportWorkspace(t.alice, ws.id, { includePrivate: true });
    assert.deepEqual(full.channels.map((c) => c.name).sort(), ["general", "random", "secret"]);
    assert.doesNotMatch(JSON.stringify(full), /just between us/);
  } finally {
    t.close();
  }
});

test("custom emoji: add, list, react, serve, remove; only raster images", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(imageType(png), "image/png");
    assert.equal(imageType(Buffer.from("GIF89a......")), "image/gif");
    assert.equal(imageType(svg), null);

    const added = t.team.addEmoji(t.bob, ws.id, { name: ":Party-Parrot:", data: png.toString("base64") });
    assert.equal(added.name, "party-parrot");
    assert.throws(() => t.team.addEmoji(t.alice, ws.id, { name: "party-parrot", data: png.toString("base64") }), status(409));
    assert.throws(() => t.team.addEmoji(t.alice, ws.id, { name: "evil", data: svg.toString("base64") }), status(400));
    assert.throws(() => t.team.addEmoji(t.alice, ws.id, { name: "bad name", data: png.toString("base64") }), status(400));
    assert.throws(() => t.team.addEmoji(t.alice, ws.id, { name: "huge", data: Buffer.concat([png, Buffer.alloc(130_000)]).toString("base64") }), status(413));
    assert.throws(() => t.team.addEmoji(t.cara, ws.id, { name: "outsider", data: png.toString("base64") }), status(404));
    assert.ok(t.events.some((e) => e.event.type === "emoji" && e.event.name === "party-parrot"));

    assert.deepEqual(t.team.sidebar(t.alice, ws.id).emoji, ["party-parrot"]);
    assert.equal(t.team.emojis(t.alice, ws.id)[0]!.createdBy.username, "bob");
    const image = t.team.emojiImage(t.alice, ws.id, "party-parrot");
    assert.equal(image.mime, "image/png");
    assert.ok(image.data.equals(png));
    assert.throws(() => t.team.emojiImage(t.cara, ws.id, "party-parrot"), status(404));
    const stored = t.store.database.prepare("SELECT ciphertext FROM team_emoji").get() as { ciphertext: string };
    assert.ok(!stored.ciphertext.includes(png.toString("base64").slice(0, 20)), "emoji images are sealed at rest");

    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const msg = t.team.send(t.alice, general.id, { text: "ship it :party-parrot:" }).message!;
    assert.equal(t.team.react(t.bob, msg.id, ":party-parrot:")[0]!.emoji, ":party-parrot:");

    t.team.joinWorkspace(t.cara, ws.inviteCode);
    assert.throws(() => t.team.removeEmoji(t.cara, ws.id, "party-parrot"), status(403));
    t.team.removeEmoji(t.alice, ws.id, "party-parrot");
    assert.deepEqual(t.team.sidebar(t.alice, ws.id).emoji, []);
    assert.throws(() => t.team.emojiImage(t.alice, ws.id, "party-parrot"), status(404));
  } finally {
    t.close();
  }
});

test("sidebar sections are personal: create, move channels, reorder, collapse, delete", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const dm = t.team.openConversation(t.alice, ws.id, ["bob"]);
    const projects = t.team.createSection(t.alice, ws.id, { name: "Projects" });
    const people = t.team.createSection(t.alice, ws.id, { name: "People" });
    assert.deepEqual(t.team.sections(t.alice, ws.id).map((s) => s.name), ["Projects", "People"]);
    assert.deepEqual(t.team.sections(t.bob, ws.id), [], "sections are personal");

    t.team.setChannelPrefs(t.alice, general.id, { sectionId: projects.id });
    t.team.setChannelPrefs(t.alice, dm.id, { sectionId: people.id });
    let bar = t.team.sidebar(t.alice, ws.id);
    assert.equal(bar.channels.find((c) => c.id === general.id)!.sectionId, projects.id);
    assert.equal(bar.direct.find((c) => c.id === dm.id)!.sectionId, people.id);
    assert.equal(t.team.sidebar(t.bob, ws.id).channels.find((c) => c.id === general.id)!.sectionId, null);
    // Bob can't use Alice's section.
    assert.throws(() => t.team.setChannelPrefs(t.bob, general.id, { sectionId: projects.id }), status(404));
    assert.throws(() => t.team.updateSection(t.bob, projects.id, { name: "Mine" }), status(404));

    const moved = t.team.updateSection(t.alice, people.id, { position: 0, name: "Teammates", collapsed: true });
    assert.deepEqual(moved.map((s) => [s.name, s.collapsed]), [["Teammates", true], ["Projects", false]]);
    assert.throws(() => t.team.createSection(t.alice, ws.id, { name: "" }), status(400));

    t.team.deleteSection(t.alice, projects.id);
    bar = t.team.sidebar(t.alice, ws.id);
    assert.equal(bar.channels.find((c) => c.id === general.id)!.sectionId, null, "channels go back to their default place");
    assert.deepEqual(bar.sections.map((s) => s.name), ["Teammates"]);
    t.team.setChannelPrefs(t.alice, dm.id, { sectionId: null });
    assert.equal(t.team.sidebar(t.alice, ws.id).direct[0]!.sectionId, null);
    assert.ok(t.events.some((e) => e.event.type === "sections" && e.subs.length === 1 && e.subs[0] === t.alice.sub));
  } finally {
    t.close();
  }
});

test("task lists: add, assign, due dates, tick off, reorder, my tasks, access", () => {
  const t = setup();
  try {
    const ws = t.team.createWorkspace(t.alice, "Acme");
    t.team.joinWorkspace(t.bob, ws.inviteCode);
    t.team.joinWorkspace(t.cara, ws.inviteCode);
    const general = t.team.sidebar(t.alice, ws.id).channels.find((c) => c.name === "general")!;
    const secret = t.team.createChannel(t.alice, ws.id, { name: "secret", private: true, members: ["bob"] });

    const a = t.team.createTask(t.alice, secret.id, { title: "Draft launch post", assignee: "bob", due: "2026-12-01", notes: "Keep it short" });
    const b = t.team.createTask(t.bob, secret.id, { title: "Book the venue" });
    assert.equal(a.assignee!.username, "bob");
    assert.equal(a.due, "2026-12-01");
    assert.equal(a.notes, "Keep it short");
    const stored = t.store.database.prepare("SELECT ciphertext FROM team_tasks WHERE id = ?").get(a.id) as { ciphertext: string };
    assert.ok(!stored.ciphertext.includes("launch"), "task titles are sealed at rest");

    // Cara can't see the private channel's list, be assigned in it, or change it.
    assert.throws(() => t.team.tasks(t.cara, secret.id), status(404));
    assert.throws(() => t.team.createTask(t.alice, secret.id, { title: "x", assignee: "cara" }), status(400));
    assert.throws(() => t.team.updateTask(t.cara, a.id, { done: true }), status(404));
    assert.throws(() => t.team.createTask(t.alice, secret.id, { title: "x", due: "2026-02-30" }), status(400));
    assert.throws(() => t.team.createTask(t.alice, secret.id, { title: " " }), status(400));
    // In a public channel, anyone in the workspace can be assigned.
    const c = t.team.createTask(t.alice, general.id, { title: "Say hi", assignee: "@cara" });
    assert.equal(c.assignee!.username, "cara");

    assert.deepEqual(t.team.myTasks(t.bob, ws.id).map((x) => x.title), ["Draft launch post"]);
    assert.equal(t.team.sidebar(t.bob, ws.id).tasks, 1);
    assert.equal(t.team.sidebar(t.cara, ws.id).tasks, 1);

    // Reorder, then tick off: done tasks move to the end.
    t.team.updateTask(t.bob, b.id, { position: 0 });
    assert.deepEqual(t.team.tasks(t.alice, secret.id).map((x) => x.title), ["Book the venue", "Draft launch post"]);
    const done = t.team.updateTask(t.bob, b.id, { done: true });
    assert.equal(done.done, true);
    assert.equal(done.doneBy!.username, "bob");
    assert.deepEqual(t.team.tasks(t.alice, secret.id).map((x) => [x.title, x.done]), [["Draft launch post", false], ["Book the venue", true]]);
    assert.equal(t.team.getChannel(t.alice, secret.id).openTasks, 1);
    assert.equal(t.team.updateTask(t.alice, b.id, { done: false }).doneAt, null);

    // Edit and reassign; the new assignee gets the event even outside the channel's members.
    const edited = t.team.updateTask(t.alice, c.id, { title: "Say hello", assignee: "bob", due: null });
    assert.equal(edited.title, "Say hello");
    assert.equal(edited.due, null);
    assert.ok(t.events.some((e) => e.event.type === "task" && e.event.taskId === c.id && e.event.action === "assigned"));
    assert.equal(t.team.myTasks(t.cara, ws.id).length, 0);

    // Leaving a private channel hides its tasks from "my tasks".
    t.team.leaveChannel(t.bob, secret.id);
    assert.deepEqual(t.team.myTasks(t.bob, ws.id).map((x) => x.title), ["Say hello"]);

    t.team.deleteTask(t.alice, a.id);
    assert.deepEqual(t.team.tasks(t.alice, secret.id).map((x) => x.title), ["Book the venue"]);
    assert.equal(dueDate("2028-02-29"), "2028-02-29");
  } finally {
    t.close();
  }
});
