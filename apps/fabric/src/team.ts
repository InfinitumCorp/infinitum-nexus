/**
 * FABRIC++ team chat: workspaces, channels, direct and group messages, threads,
 * reactions, mentions, pins, saved items, bookmarks, files, canvases, user groups,
 * statuses, presence, do-not-disturb, scheduled messages, reminders, slash
 * commands, unread tracking, activity and search.
 *
 * Each channel has its own AES-256-GCM key, sealed by the server master key.
 * Message bodies, files, canvases and scheduled messages are sealed with the
 * channel key; reminders are sealed with the master key. Plaintext exists only
 * in this process, for a signed-in member who may read it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { open, randomKey, seal } from "@infinitum/fabric";
import type { FabricIdentity } from "./auth.ts";
import { FabricServiceError } from "./service.ts";
import type { FabricStore, UserRow } from "./store.ts";
import {
  TeamStore,
  type BookmarkRow,
  type ChannelKind,
  type ChannelMemberRow,
  type ChannelRow,
  type FileRow,
  type GroupRow,
  type MemberRow,
  type ReminderRow,
  type Role,
  type ScheduledRow,
  type TeamMessageRow,
  type WorkspaceRow,
} from "./team-store.ts";

export const TEAM_LIMITS = {
  text: 4000,
  canvas: 50_000,
  fileBytes: 1_000_000,
  groupDm: 8,
  page: 50,
  searchScan: 5000,
  activeWindowMs: 5 * 60_000,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,30}$/;
const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]{0,62})/gi;
const SPECIAL = new Set(["channel", "here", "everyone"]);

const fail = (status: number, message: string) => new FabricServiceError(status, message);

export interface TeamEvent {
  type: string;
  workspaceId: string;
  channelId?: string;
  messageId?: string;
  parentId?: string | null;
  sub?: string;
  mentioned?: string[];
  [key: string]: unknown;
}

export type Publish = (subs: string[], event: TeamEvent) => void;

export interface PersonView {
  sub: string;
  username: string;
  name: string | null;
  displayName: string;
  title: string | null;
  role: Role;
  statusEmoji: string | null;
  statusText: string | null;
  statusUntil: string | null;
  presence: "active" | "away";
  dnd: boolean;
  dndUntil: string | null;
  deactivated: boolean;
}

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  role: Role;
  createdAt: string;
  memberCount: number;
}

export interface ChannelView {
  id: string;
  workspaceId: string;
  kind: ChannelKind;
  name: string;
  topic: string;
  purpose: string;
  createdBy: string;
  createdAt: string;
  archived: boolean;
  isDefault: boolean;
  memberCount: number;
  member: boolean;
  muted: boolean;
  starred: boolean;
  unread: number;
  mentions: number;
  lastReadAt: string | null;
  lastMessageAt: string | null;
  people?: PersonView[];
}

export interface ReactionView { emoji: string; count: number; subs: string[]; mine: boolean }
export interface FileView { id: string; name: string; mime: string; size: number; createdAt: string; channelId: string; uploader: string }

export interface MessageView {
  id: string;
  channelId: string;
  workspaceId: string;
  parentId: string | null;
  sender: PersonView;
  text: string;
  kind: "user" | "system";
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  unreadable: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  replyUsers: string[];
  alsoInChannel: boolean;
  reactions: ReactionView[];
  pinned: boolean;
  saved: boolean;
  files: FileView[];
  mentions: string[];
}

export interface SendResult {
  message?: MessageView;
  ephemeral?: string;
  channelId?: string;
  notInChannel?: string[];
}

export interface SendInput {
  text: string;
  parentId?: string | null;
  alsoInChannel?: boolean;
  fileIds?: string[];
  /** Minutes east of UTC, for "/remind ... at 15:00". */
  tzOffset?: number;
}

export interface ActivityItem {
  kind: "mention" | "reply" | "reaction" | "reminder";
  at: string;
  actor: PersonView;
  emoji?: string;
  message: MessageView;
}

export class TeamService {
  private readonly users: FabricStore;
  readonly store: TeamStore;
  private readonly masterKey: Buffer;
  private readonly publish: Publish;
  private readonly clock: () => Date;
  private readonly keys = new Map<string, Buffer>();
  private readonly lastSeen = new Map<string, number>();
  private readonly connected = new Map<string, number>();
  private lastStamp = 0;

  constructor(users: FabricStore, masterKey: Buffer, options: { publish?: Publish; clock?: () => Date } = {}) {
    this.users = users;
    this.store = new TeamStore(users.database);
    this.masterKey = masterKey;
    this.publish = options.publish ?? (() => {});
    this.clock = options.clock ?? (() => new Date());
  }

  // ---------- presence ----------

  seen(sub: string): void {
    this.lastSeen.set(sub, this.clock().getTime());
  }

  setConnected(sub: string, delta: 1 | -1): void {
    const before = this.connected.get(sub) ?? 0;
    const n = Math.max(0, before + delta);
    if (n === 0) this.connected.delete(sub);
    else this.connected.set(sub, n);
    this.seen(sub);
    if ((before === 0) !== (n === 0)) {
      for (const workspaceId of this.workspaceIds(sub)) this.publish(this.workspaceSubs(workspaceId), { type: "presence", workspaceId, sub });
    }
  }

  // ---------- workspaces ----------

  createWorkspace(me: FabricIdentity, name: string): WorkspaceView {
    const clean = label(name, "workspace name", 60);
    const now = this.stamp();
    const id = randomUUID();
    this.store.tx(() => {
      this.store.insert("team_workspaces", { id, name: clean, slug: this.uniqueSlug(clean), inviteCode: inviteCode(), createdBy: me.sub, createdAt: now });
      this.store.insert("team_members", { workspaceId: id, sub: me.sub, role: "owner", joinedAt: now, away: 0 });
      for (const [channel, purpose] of [["general", "Announcements and work for the whole workspace."], ["random", "Everything else."]] as const) {
        const row = this.newChannel(id, "public", channel, me.sub, now, { purpose, isDefault: 1 });
        this.addChannelMember(row.id, me.sub, now);
      }
    });
    return this.workspaceView(me, this.workspace(id));
  }

  listWorkspaces(me: FabricIdentity): WorkspaceView[] {
    return this.store.all<WorkspaceRow>(
      `SELECT w.* FROM team_workspaces w JOIN team_members m ON m.workspace_id = w.id
       WHERE m.sub = ? AND m.deactivated_at IS NULL ORDER BY w.created_at`, me.sub,
    ).map((w) => this.workspaceView(me, w));
  }

  getWorkspace(me: FabricIdentity, workspaceId: string): WorkspaceView {
    this.member(me, workspaceId);
    return this.workspaceView(me, this.workspace(workspaceId));
  }

  joinWorkspace(me: FabricIdentity, code: string): WorkspaceView {
    const trimmed = String(code ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(trimmed)) throw fail(404, "invite not found");
    const ws = this.store.one<WorkspaceRow>("SELECT * FROM team_workspaces WHERE invite_code = ?", trimmed);
    if (!ws) throw fail(404, "invite not found");
    const existing = this.store.one<MemberRow>("SELECT * FROM team_members WHERE workspace_id = ? AND sub = ?", ws.id, me.sub);
    if (existing && !existing.deactivatedAt) return this.workspaceView(me, ws);
    if (existing?.deactivatedAt) throw fail(403, "your account was removed from this workspace");
    const now = this.stamp();
    this.store.tx(() => {
      this.store.insert("team_members", { workspaceId: ws.id, sub: me.sub, role: "member", joinedAt: now, away: 0 });
      for (const ch of this.store.all<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND is_default = 1 AND archived_at IS NULL", ws.id)) {
        this.addChannelMember(ch.id, me.sub, now);
        this.system(ch, me.sub, `joined #${ch.name}`);
      }
    });
    this.publish(this.workspaceSubs(ws.id), { type: "members", workspaceId: ws.id, sub: me.sub });
    return this.workspaceView(me, ws);
  }

  updateWorkspace(me: FabricIdentity, workspaceId: string, input: { name?: unknown; rotateInvite?: unknown }): WorkspaceView {
    this.admin(me, workspaceId);
    if (input.name !== undefined) this.store.run("UPDATE team_workspaces SET name = ? WHERE id = ?", label(input.name, "workspace name", 60), workspaceId);
    if (input.rotateInvite === true) this.store.run("UPDATE team_workspaces SET invite_code = ? WHERE id = ?", inviteCode(), workspaceId);
    this.publish(this.workspaceSubs(workspaceId), { type: "workspace", workspaceId });
    return this.workspaceView(me, this.workspace(workspaceId));
  }

  people(me: FabricIdentity, workspaceId: string, query = ""): PersonView[] {
    this.member(me, workspaceId);
    const q = query.trim().toLowerCase();
    return this.store.all<MemberRow>("SELECT * FROM team_members WHERE workspace_id = ? ORDER BY joined_at", workspaceId)
      .map((m) => this.personFromMember(m))
      .filter((p) => !q || p.username.includes(q) || p.displayName.toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q))
      .sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || a.displayName.localeCompare(b.displayName));
  }

  updateProfile(me: FabricIdentity, workspaceId: string, input: { displayName?: unknown; title?: unknown }): PersonView {
    this.member(me, workspaceId);
    if (input.displayName !== undefined) this.store.run("UPDATE team_members SET display_name = ? WHERE workspace_id = ? AND sub = ?", optional(input.displayName, "display name", 80), workspaceId, me.sub);
    if (input.title !== undefined) this.store.run("UPDATE team_members SET title = ? WHERE workspace_id = ? AND sub = ?", optional(input.title, "title", 100), workspaceId, me.sub);
    this.publish(this.workspaceSubs(workspaceId), { type: "members", workspaceId, sub: me.sub });
    return this.person(workspaceId, me.sub);
  }

  setStatus(me: FabricIdentity, workspaceId: string, input: { emoji?: unknown; text?: unknown; until?: unknown }): PersonView {
    this.member(me, workspaceId);
    const emoji = input.emoji === null || input.emoji === "" || input.emoji === undefined ? null : emojiOf(input.emoji);
    const text = optional(input.text ?? null, "status", 100);
    const until = input.until === null || input.until === undefined || input.until === "" ? null : this.future(input.until, "until");
    this.store.run("UPDATE team_members SET status_emoji = ?, status_text = ?, status_until = ? WHERE workspace_id = ? AND sub = ?", emoji, text, emoji || text ? until : null, workspaceId, me.sub);
    this.publish(this.workspaceSubs(workspaceId), { type: "members", workspaceId, sub: me.sub });
    return this.person(workspaceId, me.sub);
  }

  setPresence(me: FabricIdentity, workspaceId: string, input: { away?: unknown; dndUntil?: unknown }): PersonView {
    this.member(me, workspaceId);
    if (input.away !== undefined) this.store.run("UPDATE team_members SET away = ? WHERE workspace_id = ? AND sub = ?", input.away === true ? 1 : 0, workspaceId, me.sub);
    if (input.dndUntil !== undefined) {
      const until = input.dndUntil === null || input.dndUntil === "" ? null : this.future(input.dndUntil, "dndUntil");
      this.store.run("UPDATE team_members SET dnd_until = ? WHERE workspace_id = ? AND sub = ?", until, workspaceId, me.sub);
    }
    this.publish(this.workspaceSubs(workspaceId), { type: "members", workspaceId, sub: me.sub });
    return this.person(workspaceId, me.sub);
  }

  setRole(me: FabricIdentity, workspaceId: string, username: string, role: unknown): PersonView {
    const mine = this.member(me, workspaceId);
    if (mine.role !== "owner") throw fail(403, "only an owner can change roles");
    if (role !== "admin" && role !== "member" && role !== "guest" && role !== "owner") throw fail(400, "role is invalid");
    const target = this.memberByUsername(workspaceId, username);
    if (target.sub === me.sub && role !== "owner" && this.store.count("SELECT COUNT(*) FROM team_members WHERE workspace_id = ? AND role = 'owner' AND deactivated_at IS NULL", workspaceId) < 2) {
      throw fail(400, "a workspace needs at least one owner");
    }
    this.store.run("UPDATE team_members SET role = ? WHERE workspace_id = ? AND sub = ?", role, workspaceId, target.sub);
    this.publish(this.workspaceSubs(workspaceId), { type: "members", workspaceId, sub: target.sub });
    return this.person(workspaceId, target.sub);
  }

  removeMember(me: FabricIdentity, workspaceId: string, username: string): void {
    this.admin(me, workspaceId);
    const target = this.memberByUsername(workspaceId, username);
    if (target.role === "owner") throw fail(403, "an owner cannot be removed");
    const now = this.stamp();
    this.store.tx(() => {
      this.store.run("UPDATE team_members SET deactivated_at = ? WHERE workspace_id = ? AND sub = ?", now, workspaceId, target.sub);
      this.store.run(
        `DELETE FROM team_channel_members WHERE sub = ? AND channel_id IN
         (SELECT id FROM team_channels WHERE workspace_id = ? AND kind IN ('public','private'))`, target.sub, workspaceId,
      );
    });
    this.publish(this.workspaceSubs(workspaceId), { type: "members", workspaceId, sub: target.sub });
  }

  // ---------- channels ----------

  /** Channels and conversations the caller belongs to, with unread and mention counts. */
  sidebar(me: FabricIdentity, workspaceId: string): { workspace: WorkspaceView; me: PersonView; channels: ChannelView[]; direct: ChannelView[]; scheduled: number; reminders: number; saved: number } {
    this.member(me, workspaceId);
    this.seen(me.sub);
    const rows = this.store.all<ChannelRow>(
      `SELECT c.* FROM team_channels c JOIN team_channel_members cm ON cm.channel_id = c.id
       WHERE c.workspace_id = ? AND cm.sub = ? ORDER BY c.name, c.created_at`, workspaceId, me.sub,
    );
    const views = rows.map((c) => this.channelView(me, c));
    return {
      workspace: this.workspaceView(me, this.workspace(workspaceId)),
      me: this.person(workspaceId, me.sub),
      channels: views.filter((c) => (c.kind === "public" || c.kind === "private") && !c.archived),
      direct: views.filter((c) => c.kind === "dm" || c.kind === "group").sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)),
      scheduled: this.store.count("SELECT COUNT(*) FROM team_scheduled s JOIN team_channels c ON c.id = s.channel_id WHERE s.sender = ? AND c.workspace_id = ?", me.sub, workspaceId),
      reminders: this.store.count("SELECT COUNT(*) FROM team_reminders WHERE sub = ? AND workspace_id = ? AND done = 0", me.sub, workspaceId),
      saved: this.store.count("SELECT COUNT(*) FROM team_saved s JOIN team_messages m ON m.id = s.message_id JOIN team_channels c ON c.id = m.channel_id WHERE s.sub = ? AND s.done = 0 AND c.workspace_id = ?", me.sub, workspaceId),
    };
  }

  browseChannels(me: FabricIdentity, workspaceId: string, query = "", archived = false): ChannelView[] {
    const mine = this.member(me, workspaceId);
    const q = query.trim().toLowerCase();
    return this.store.all<ChannelRow>(
      `SELECT * FROM team_channels WHERE workspace_id = ? AND kind IN ('public','private') ORDER BY name`, workspaceId,
    )
      .filter((c) => (archived ? c.archivedAt : !c.archivedAt))
      .filter((c) => (c.kind === "public" && mine.role !== "guest") || this.channelMember(c.id, me.sub))
      .filter((c) => !q || (c.name ?? "").includes(q) || c.topic.toLowerCase().includes(q) || c.purpose.toLowerCase().includes(q))
      .map((c) => this.channelView(me, c));
  }

  createChannel(me: FabricIdentity, workspaceId: string, input: { name?: unknown; private?: unknown; topic?: unknown; purpose?: unknown; members?: unknown }): ChannelView {
    const mine = this.member(me, workspaceId);
    if (mine.role === "guest") throw fail(403, "guests cannot create channels");
    const name = channelName(input.name);
    if (this.store.one("SELECT id FROM team_channels WHERE workspace_id = ? AND name = ?", workspaceId, name)) throw fail(409, "that channel name is taken");
    const invitees = this.membersByUsernames(workspaceId, usernames(input.members));
    const now = this.stamp();
    const row = this.store.tx(() => {
      const ch = this.newChannel(workspaceId, input.private === true ? "private" : "public", name, me.sub, now, {
        topic: optional(input.topic ?? "", "topic", 250) ?? "",
        purpose: optional(input.purpose ?? "", "purpose", 250) ?? "",
      });
      this.addChannelMember(ch.id, me.sub, now);
      for (const m of invitees) this.addChannelMember(ch.id, m.sub, now);
      return ch;
    });
    this.system(row, me.sub, `created #${name}`);
    this.publish(this.channelSubs(row.id), { type: "channel", workspaceId, channelId: row.id });
    return this.channelView(me, row, true);
  }

  getChannel(me: FabricIdentity, channelId: string): ChannelView & { bookmarks: BookmarkRow[]; pins: number; canvas: boolean; myRole: Role } {
    const { channel, ws } = this.readable(me, channelId);
    return {
      ...this.channelView(me, channel, true),
      bookmarks: this.store.all<BookmarkRow>("SELECT * FROM team_bookmarks WHERE channel_id = ? ORDER BY created_at", channelId),
      pins: this.store.count("SELECT COUNT(*) FROM team_pins WHERE channel_id = ?", channelId),
      canvas: !!this.store.one("SELECT channel_id FROM team_canvases WHERE channel_id = ?", channelId),
      myRole: ws.role,
    };
  }

  updateChannel(me: FabricIdentity, channelId: string, input: { name?: unknown; topic?: unknown; purpose?: unknown }): ChannelView {
    const { channel, ws } = this.writable(me, channelId);
    if (input.name !== undefined) {
      if (channel.kind === "dm" || channel.kind === "group") throw fail(400, "conversations do not have names");
      if (!isAdmin(ws.role) && channel.createdBy !== me.sub) throw fail(403, "only the channel creator or an admin can rename it");
      const name = channelName(input.name);
      if (name !== channel.name) {
        if (this.store.one("SELECT id FROM team_channels WHERE workspace_id = ? AND name = ?", channel.workspaceId, name)) throw fail(409, "that channel name is taken");
        this.store.run("UPDATE team_channels SET name = ? WHERE id = ?", name, channelId);
        this.system(channel, me.sub, `renamed the channel from #${channel.name} to #${name}`);
      }
    }
    for (const key of ["topic", "purpose"] as const) {
      if (input[key] === undefined) continue;
      const value = optional(input[key], key, 250) ?? "";
      if (value === channel[key]) continue;
      this.store.run(`UPDATE team_channels SET ${key} = ? WHERE id = ?`, value, channelId);
      this.system(channel, me.sub, value ? `set the channel ${key}: ${value}` : `cleared the channel ${key}`);
    }
    this.publish(this.channelSubs(channelId), { type: "channel", workspaceId: channel.workspaceId, channelId });
    return this.channelView(me, this.channel(channelId), true);
  }

  archiveChannel(me: FabricIdentity, channelId: string, archived: boolean): ChannelView {
    const { channel, ws } = this.readable(me, channelId);
    if (channel.kind === "dm" || channel.kind === "group") throw fail(400, "conversations cannot be archived");
    if (!isAdmin(ws.role) && channel.createdBy !== me.sub) throw fail(403, "only the channel creator or an admin can archive it");
    if (channel.isDefault && archived) throw fail(400, "a default channel cannot be archived");
    if (!archived && channel.archivedAt) this.store.run("UPDATE team_channels SET archived_at = NULL WHERE id = ?", channelId);
    if (archived && !channel.archivedAt) {
      this.system(channel, me.sub, "archived this channel");
      this.store.run("UPDATE team_channels SET archived_at = ? WHERE id = ?", this.stamp(), channelId);
    }
    if (!archived && channel.archivedAt) this.system(this.channel(channelId), me.sub, "unarchived this channel");
    this.publish(this.channelSubs(channelId), { type: "channel", workspaceId: channel.workspaceId, channelId });
    return this.channelView(me, this.channel(channelId));
  }

  joinChannel(me: FabricIdentity, channelId: string): ChannelView {
    const { channel, ws } = this.readable(me, channelId);
    if (channel.archivedAt) throw fail(400, "this channel is archived");
    if (!this.channelMember(channelId, me.sub)) {
      if (channel.kind !== "public" || ws.role === "guest") throw fail(403, "ask a member to invite you");
      this.addChannelMember(channelId, me.sub, this.stamp());
      this.system(channel, me.sub, `joined #${channel.name}`);
      this.publish(this.channelSubs(channelId), { type: "channel", workspaceId: channel.workspaceId, channelId });
    }
    return this.channelView(me, channel, true);
  }

  leaveChannel(me: FabricIdentity, channelId: string): void {
    const { channel } = this.readable(me, channelId);
    if (channel.kind === "dm") throw fail(400, "you cannot leave a direct message");
    if (channel.isDefault) throw fail(400, "everyone stays in a default channel");
    if (!this.channelMember(channelId, me.sub)) return;
    this.system(channel, me.sub, channel.kind === "group" ? "left the conversation" : `left #${channel.name}`);
    this.store.run("DELETE FROM team_channel_members WHERE channel_id = ? AND sub = ?", channelId, me.sub);
    this.publish([...this.channelSubs(channelId), me.sub], { type: "channel", workspaceId: channel.workspaceId, channelId });
  }

  invite(me: FabricIdentity, channelId: string, names: unknown): ChannelView {
    const { channel } = this.writable(me, channelId);
    if (channel.kind === "dm") throw fail(400, "start a group conversation to add people");
    const people = this.membersByUsernames(channel.workspaceId, usernames(names));
    if (people.length === 0) throw fail(400, "name at least one person");
    if (channel.kind === "group" && this.store.count("SELECT COUNT(*) FROM team_channel_members WHERE channel_id = ?", channelId) + people.length > TEAM_LIMITS.groupDm + 1) {
      throw fail(400, `a group conversation holds up to ${TEAM_LIMITS.groupDm + 1} people; make a private channel instead`);
    }
    const now = this.stamp();
    const added = people.filter((p) => !this.channelMember(channelId, p.sub));
    for (const p of added) this.addChannelMember(channelId, p.sub, now);
    if (added.length) this.system(channel, me.sub, `added ${added.map((p) => `@${this.username(p.sub)}`).join(", ")}`);
    this.publish(this.channelSubs(channelId), { type: "channel", workspaceId: channel.workspaceId, channelId });
    return this.channelView(me, channel, true);
  }

  kick(me: FabricIdentity, channelId: string, username: string): void {
    const { channel, ws } = this.writable(me, channelId);
    if (channel.kind === "dm" || channel.kind === "group") throw fail(400, "people leave conversations themselves");
    if (channel.isDefault) throw fail(400, "everyone stays in a default channel");
    if (!isAdmin(ws.role) && channel.createdBy !== me.sub) throw fail(403, "only the channel creator or an admin can remove people");
    const target = this.memberByUsername(channel.workspaceId, username);
    if (!this.channelMember(channelId, target.sub)) return;
    this.store.run("DELETE FROM team_channel_members WHERE channel_id = ? AND sub = ?", channelId, target.sub);
    this.system(channel, me.sub, `removed @${this.username(target.sub)}`);
    this.publish([...this.channelSubs(channelId), target.sub], { type: "channel", workspaceId: channel.workspaceId, channelId });
  }

  setChannelPrefs(me: FabricIdentity, channelId: string, input: { muted?: unknown; starred?: unknown }): ChannelView {
    const { channel } = this.readable(me, channelId);
    if (!this.channelMember(channelId, me.sub)) throw fail(403, "join the channel first");
    if (input.muted !== undefined) this.store.run("UPDATE team_channel_members SET muted = ? WHERE channel_id = ? AND sub = ?", input.muted === true ? 1 : 0, channelId, me.sub);
    if (input.starred !== undefined) this.store.run("UPDATE team_channel_members SET starred = ? WHERE channel_id = ? AND sub = ?", input.starred === true ? 1 : 0, channelId, me.sub);
    return this.channelView(me, channel);
  }

  /** Mark read up to now, or mark unread from a message onward. */
  markRead(me: FabricIdentity, channelId: string, unreadFrom?: string): ChannelView {
    const { channel } = this.readable(me, channelId);
    if (!this.channelMember(channelId, me.sub)) return this.channelView(me, channel);
    let at = this.stamp();
    if (unreadFrom) {
      const msg = this.message(unreadFrom);
      if (msg.channelId !== channelId) throw fail(404, "not found");
      at = new Date(Date.parse(msg.createdAt) - 1).toISOString();
    }
    this.store.run("UPDATE team_channel_members SET last_read_at = ? WHERE channel_id = ? AND sub = ?", at, channelId, me.sub);
    this.publish([me.sub], { type: "read", workspaceId: channel.workspaceId, channelId });
    return this.channelView(me, channel);
  }

  channelPeople(me: FabricIdentity, channelId: string): PersonView[] {
    const { channel } = this.readable(me, channelId);
    return this.channelSubs(channelId).map((sub) => this.person(channel.workspaceId, sub)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Open (or find) a direct message: nobody else = notes to self, one person = DM, 2–8 = group. */
  openConversation(me: FabricIdentity, workspaceId: string, names: unknown): ChannelView {
    this.member(me, workspaceId);
    const others = this.membersByUsernames(workspaceId, usernames(names)).filter((m) => m.sub !== me.sub);
    if (others.length > TEAM_LIMITS.groupDm) throw fail(400, `a group conversation holds up to ${TEAM_LIMITS.groupDm + 1} people; make a private channel instead`);
    const subs = [me.sub, ...others.map((o) => o.sub)].sort();
    const dmKey = subs.join(",");
    const existing = this.store.one<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND dm_key = ?", workspaceId, dmKey);
    if (existing) return this.channelView(me, existing, true);
    const now = this.stamp();
    const row = this.store.tx(() => {
      const ch = this.newChannel(workspaceId, others.length > 1 ? "group" : "dm", null, me.sub, now, { dmKey });
      for (const sub of subs) this.addChannelMember(ch.id, sub, now);
      return ch;
    });
    this.publish(subs, { type: "channel", workspaceId, channelId: row.id });
    return this.channelView(me, row, true);
  }

  // ---------- messages ----------

  send(me: FabricIdentity, channelId: string, input: SendInput): SendResult {
    const text = typeof input.text === "string" ? input.text : "";
    const fileIds = Array.isArray(input.fileIds) ? input.fileIds.filter((f): f is string => typeof f === "string") : [];
    if (text.trim().startsWith("/") && !input.parentId && fileIds.length === 0) return this.command(me, channelId, text.trim(), input.tzOffset ?? 0);
    if (text.trim() === "" && fileIds.length === 0) throw fail(400, "text is required");
    if (text.length > TEAM_LIMITS.text) throw fail(400, "text is too long");
    const { channel } = this.writable(me, channelId);
    let parent: TeamMessageRow | null = null;
    if (input.parentId) {
      parent = this.message(input.parentId);
      if (parent.channelId !== channelId) throw fail(404, "not found");
      if (parent.parentId) parent = this.message(parent.parentId);
      if (parent.deletedAt && parent.replyCount === 0) throw fail(404, "not found");
    }
    const id = randomUUID();
    const files = fileIds.map((f) => {
      const row = this.store.one<FileRow>("SELECT * FROM team_files WHERE id = ?", f);
      if (!row || row.channelId !== channelId || row.uploader !== me.sub || row.messageId) throw fail(400, "file is not available");
      return row;
    });
    const result = this.insertMessage(channel, me.sub, text, { id, parent, alsoInChannel: !!(parent && input.alsoInChannel), fileIds: files.map((f) => f.id) });
    return { message: this.view(me, result.row), notInChannel: result.notInChannel };
  }

  list(me: FabricIdentity, channelId: string, opts: { before?: string; after?: string; around?: string; limit?: number } = {}): { messages: MessageView[]; hasMore: boolean; hasNewer: boolean } {
    this.readable(me, channelId);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? TEAM_LIMITS.page), 1), 200);
    const visible = "channel_id = ? AND (parent_id IS NULL OR also_in_channel = 1) AND (deleted_at IS NULL OR reply_count > 0)";
    let rows: TeamMessageRow[];
    let hasMore = false;
    let hasNewer = false;
    if (opts.around) {
      const pivot = this.message(opts.around);
      const anchor = pivot.parentId ? this.message(pivot.parentId) : pivot;
      if (anchor.channelId !== channelId) throw fail(404, "not found");
      const half = Math.floor(limit / 2);
      const older = this.store.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${visible} AND created_at < ? ORDER BY created_at DESC LIMIT ?`, channelId, anchor.createdAt, half + 1);
      const newer = this.store.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${visible} AND created_at >= ? ORDER BY created_at ASC LIMIT ?`, channelId, anchor.createdAt, half + 1);
      hasMore = older.length > half;
      hasNewer = newer.length > half;
      rows = [...older.slice(0, half).reverse(), ...newer.slice(0, half)];
    } else if (opts.after) {
      const after = isoOf(opts.after, "after");
      rows = this.store.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${visible} AND created_at > ? ORDER BY created_at ASC LIMIT ?`, channelId, after, limit + 1);
      hasNewer = rows.length > limit;
      rows = rows.slice(0, limit);
    } else {
      const before = opts.before ? isoOf(opts.before, "before") : "9999";
      rows = this.store.all<TeamMessageRow>(`SELECT * FROM team_messages WHERE ${visible} AND created_at < ? ORDER BY created_at DESC LIMIT ?`, channelId, before, limit + 1);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    return { messages: rows.map((r) => this.view(me, r)), hasMore, hasNewer };
  }

  thread(me: FabricIdentity, messageId: string): { parent: MessageView; replies: MessageView[]; channel: ChannelView } {
    let parent = this.message(messageId);
    if (parent.parentId) parent = this.message(parent.parentId);
    const { channel } = this.readable(me, parent.channelId);
    const replies = this.store.all<TeamMessageRow>("SELECT * FROM team_messages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at", parent.id);
    return { parent: this.view(me, parent), replies: replies.map((r) => this.view(me, r)), channel: this.channelView(me, channel) };
  }

  getMessage(me: FabricIdentity, messageId: string): MessageView {
    const row = this.message(messageId);
    this.readable(me, row.channelId);
    return this.view(me, row);
  }

  edit(me: FabricIdentity, messageId: string, text: unknown): MessageView {
    const row = this.message(messageId);
    const { channel } = this.writable(me, row.channelId);
    if (row.sender !== me.sub || row.kind !== "user") throw fail(403, "you can only edit your own messages");
    if (row.deletedAt) throw fail(404, "not found");
    if (typeof text !== "string" || text.trim() === "") throw fail(400, "text is required");
    if (text.length > TEAM_LIMITS.text) throw fail(400, "text is too long");
    const now = this.stamp();
    this.store.tx(() => {
      this.store.run("UPDATE team_messages SET ciphertext = ?, edited_at = ? WHERE id = ?", seal(text, this.key(channel), messageAad(channel.id, row.id)), now, row.id);
      this.store.run("DELETE FROM team_mentions WHERE message_id = ?", row.id);
      this.recordMentions(channel, me.sub, row.id, text, row.createdAt);
    });
    this.publish(this.channelSubs(channel.id), { type: "message_changed", workspaceId: channel.workspaceId, channelId: channel.id, messageId: row.id, parentId: row.parentId });
    return this.view(me, this.message(row.id));
  }

  remove(me: FabricIdentity, messageId: string): void {
    const row = this.message(messageId);
    const { channel, ws } = this.readable(me, row.channelId);
    if (row.sender !== me.sub && !isAdmin(ws.role)) throw fail(403, "you can only delete your own messages");
    if (row.deletedAt) return;
    const now = this.stamp();
    this.store.tx(() => {
      this.store.run("UPDATE team_messages SET ciphertext = ?, deleted_at = ? WHERE id = ?", seal("", this.key(channel), messageAad(channel.id, row.id)), now, row.id);
      for (const table of ["team_mentions", "team_reactions", "team_pins", "team_saved"]) this.store.run(`DELETE FROM ${table} WHERE message_id = ?`, row.id);
      this.store.run("DELETE FROM team_files WHERE message_id = ?", row.id);
      if (row.parentId) {
        this.store.run(
          `UPDATE team_messages SET reply_count = (SELECT COUNT(*) FROM team_messages WHERE parent_id = ? AND deleted_at IS NULL),
           last_reply_at = (SELECT MAX(created_at) FROM team_messages WHERE parent_id = ? AND deleted_at IS NULL) WHERE id = ?`,
          row.parentId, row.parentId, row.parentId,
        );
      }
    });
    this.publish(this.channelSubs(channel.id), { type: "message_deleted", workspaceId: channel.workspaceId, channelId: channel.id, messageId: row.id, parentId: row.parentId });
  }

  react(me: FabricIdentity, messageId: string, emoji: unknown, on?: boolean): ReactionView[] {
    const row = this.message(messageId);
    const { channel } = this.writable(me, row.channelId);
    if (row.deletedAt) throw fail(404, "not found");
    const e = emojiOf(emoji);
    const has = !!this.store.one("SELECT emoji FROM team_reactions WHERE message_id = ? AND sub = ? AND emoji = ?", row.id, me.sub, e);
    const want = on ?? !has;
    if (want && !has) {
      if (this.store.count("SELECT COUNT(DISTINCT emoji) FROM team_reactions WHERE message_id = ?", row.id) >= 50) throw fail(400, "too many different reactions");
      this.store.insert("team_reactions", { messageId: row.id, sub: me.sub, emoji: e, createdAt: this.stamp() });
    }
    if (!want && has) this.store.run("DELETE FROM team_reactions WHERE message_id = ? AND sub = ? AND emoji = ?", row.id, me.sub, e);
    this.publish(this.channelSubs(channel.id), { type: "reaction", workspaceId: channel.workspaceId, channelId: channel.id, messageId: row.id, parentId: row.parentId, sub: me.sub, emoji: e });
    return this.reactions(me, row.id);
  }

  pin(me: FabricIdentity, messageId: string, pinned: boolean): MessageView {
    const row = this.message(messageId);
    const { channel } = this.writable(me, row.channelId);
    if (row.deletedAt) throw fail(404, "not found");
    if (pinned) {
      if (this.store.count("SELECT COUNT(*) FROM team_pins WHERE channel_id = ?", channel.id) >= 100) throw fail(400, "a channel can pin up to 100 messages");
      if (!this.store.one("SELECT message_id FROM team_pins WHERE channel_id = ? AND message_id = ?", channel.id, row.id)) {
        this.store.insert("team_pins", { channelId: channel.id, messageId: row.id, pinnedBy: me.sub, pinnedAt: this.stamp() });
        this.system(channel, me.sub, "pinned a message to this channel");
      }
    } else {
      this.store.run("DELETE FROM team_pins WHERE channel_id = ? AND message_id = ?", channel.id, row.id);
    }
    this.publish(this.channelSubs(channel.id), { type: "message_changed", workspaceId: channel.workspaceId, channelId: channel.id, messageId: row.id, parentId: row.parentId });
    return this.view(me, row);
  }

  pins(me: FabricIdentity, channelId: string): MessageView[] {
    this.readable(me, channelId);
    return this.store.all<TeamMessageRow>(
      "SELECT m.* FROM team_pins p JOIN team_messages m ON m.id = p.message_id WHERE p.channel_id = ? ORDER BY p.pinned_at DESC", channelId,
    ).map((r) => this.view(me, r));
  }

  /** Save for later, optionally with a reminder time. */
  save(me: FabricIdentity, messageId: string, input: { saved?: unknown; remindAt?: unknown; done?: unknown }): MessageView {
    const row = this.message(messageId);
    this.readable(me, row.channelId);
    if (input.saved === false) {
      this.store.run("DELETE FROM team_saved WHERE sub = ? AND message_id = ?", me.sub, row.id);
      return this.view(me, row);
    }
    if (row.deletedAt) throw fail(404, "not found");
    const remindAt = input.remindAt === undefined || input.remindAt === null || input.remindAt === "" ? null : this.future(input.remindAt, "remindAt");
    if (!this.store.one("SELECT message_id FROM team_saved WHERE sub = ? AND message_id = ?", me.sub, row.id)) {
      this.store.insert("team_saved", { sub: me.sub, messageId: row.id, savedAt: this.stamp(), remindAt, done: 0 });
    } else {
      if (input.remindAt !== undefined) this.store.run("UPDATE team_saved SET remind_at = ? WHERE sub = ? AND message_id = ?", remindAt, me.sub, row.id);
      if (input.done !== undefined) this.store.run("UPDATE team_saved SET done = ? WHERE sub = ? AND message_id = ?", input.done === true ? 1 : 0, me.sub, row.id);
    }
    return this.view(me, row);
  }

  saved(me: FabricIdentity, workspaceId: string, done = false): { messageId: string; savedAt: string; remindAt: string | null; done: boolean; message: MessageView }[] {
    this.member(me, workspaceId);
    return this.store.all<{ messageId: string; savedAt: string; remindAt: string | null; done: number }>(
      `SELECT s.* FROM team_saved s JOIN team_messages m ON m.id = s.message_id JOIN team_channels c ON c.id = m.channel_id
       WHERE s.sub = ? AND c.workspace_id = ? AND s.done = ? ORDER BY s.saved_at DESC LIMIT 200`, me.sub, workspaceId, done ? 1 : 0,
    ).filter((s) => this.canRead(me, this.message(s.messageId).channelId))
      .map((s) => ({ messageId: s.messageId, savedAt: s.savedAt, remindAt: s.remindAt, done: !!s.done, message: this.view(me, this.message(s.messageId)) }));
  }

  addBookmark(me: FabricIdentity, channelId: string, input: { title?: unknown; url?: unknown }): BookmarkRow {
    const { channel } = this.writable(me, channelId);
    const url = httpUrl(input.url);
    const title = optional(input.title, "title", 120) || new URL(url).hostname;
    if (this.store.count("SELECT COUNT(*) FROM team_bookmarks WHERE channel_id = ?", channelId) >= 50) throw fail(400, "a channel can hold up to 50 bookmarks");
    const row: BookmarkRow = { id: randomUUID(), channelId, title, url, createdBy: me.sub, createdAt: this.stamp() };
    this.store.insert("team_bookmarks", row);
    this.publish(this.channelSubs(channelId), { type: "channel", workspaceId: channel.workspaceId, channelId });
    return row;
  }

  removeBookmark(me: FabricIdentity, bookmarkId: string): void {
    const row = this.store.one<BookmarkRow>("SELECT * FROM team_bookmarks WHERE id = ?", uuid(bookmarkId));
    if (!row) throw fail(404, "not found");
    const { channel } = this.writable(me, row.channelId);
    this.store.run("DELETE FROM team_bookmarks WHERE id = ?", row.id);
    this.publish(this.channelSubs(row.channelId), { type: "channel", workspaceId: channel.workspaceId, channelId: row.channelId });
  }

  // ---------- files ----------

  upload(me: FabricIdentity, channelId: string, input: { name?: unknown; mime?: unknown; data?: unknown }): FileView {
    const { channel } = this.writable(me, channelId);
    const name = fileName(input.name);
    const mime = typeof input.mime === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.mime) && input.mime.length <= 100 ? input.mime.toLowerCase() : "application/octet-stream";
    if (typeof input.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw fail(400, "data must be base64");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length === 0) throw fail(400, "the file is empty");
    if (bytes.length > TEAM_LIMITS.fileBytes) throw fail(413, "files can be up to 1 MB");
    const id = randomUUID();
    const row: FileRow = {
      id, channelId, messageId: null, uploader: me.sub, name, mime, size: bytes.length,
      ciphertext: seal(bytes.toString("base64"), this.key(channel), fileAad(channelId, id)), createdAt: this.stamp(),
    };
    this.store.insert("team_files", row);
    return fileView(row);
  }

  download(me: FabricIdentity, fileId: string): { name: string; mime: string; data: Buffer } {
    const row = this.store.one<FileRow>("SELECT * FROM team_files WHERE id = ?", uuid(fileId));
    if (!row) throw fail(404, "not found");
    const { channel } = this.readable(me, row.channelId);
    if (!row.messageId && row.uploader !== me.sub) throw fail(404, "not found");
    return { name: row.name, mime: row.mime, data: Buffer.from(open(row.ciphertext, this.key(channel), fileAad(row.channelId, row.id)), "base64") };
  }

  files(me: FabricIdentity, workspaceId: string, channelId?: string): FileView[] {
    this.member(me, workspaceId);
    return this.store.all<FileRow>(
      `SELECT f.* FROM team_files f JOIN team_channels c ON c.id = f.channel_id
       WHERE c.workspace_id = ? AND f.message_id IS NOT NULL ${channelId ? "AND f.channel_id = ?" : ""} ORDER BY f.created_at DESC LIMIT 200`,
      ...(channelId ? [workspaceId, uuid(channelId)] : [workspaceId]),
    ).filter((f) => this.canRead(me, f.channelId)).map(fileView);
  }

  // ---------- canvases ----------

  canvas(me: FabricIdentity, channelId: string): { text: string; updatedBy: PersonView | null; updatedAt: string | null } {
    const { channel } = this.readable(me, channelId);
    const row = this.store.one<{ ciphertext: string; updatedBy: string; updatedAt: string }>("SELECT * FROM team_canvases WHERE channel_id = ?", channelId);
    if (!row) return { text: "", updatedBy: null, updatedAt: null };
    return { text: open(row.ciphertext, this.key(channel), canvasAad(channelId)), updatedBy: this.person(channel.workspaceId, row.updatedBy), updatedAt: row.updatedAt };
  }

  setCanvas(me: FabricIdentity, channelId: string, text: unknown): { text: string; updatedBy: PersonView | null; updatedAt: string | null } {
    const { channel } = this.writable(me, channelId);
    if (typeof text !== "string") throw fail(400, "text is required");
    if (text.length > TEAM_LIMITS.canvas) throw fail(400, "a canvas can be up to 50,000 characters");
    const now = this.stamp();
    this.store.run(
      `INSERT INTO team_canvases (channel_id, ciphertext, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      channelId, seal(text, this.key(channel), canvasAad(channelId)), me.sub, now,
    );
    this.publish(this.channelSubs(channelId), { type: "canvas", workspaceId: channel.workspaceId, channelId, sub: me.sub });
    return this.canvas(me, channelId);
  }

  // ---------- user groups ----------

  groups(me: FabricIdentity, workspaceId: string): (GroupRow & { members: string[] })[] {
    this.member(me, workspaceId);
    return this.store.all<GroupRow>("SELECT * FROM team_groups WHERE workspace_id = ? ORDER BY handle", workspaceId)
      .map((g) => ({ ...g, members: this.store.all<{ sub: string }>("SELECT sub FROM team_group_members WHERE group_id = ?", g.id).map((m) => this.username(m.sub)) }));
  }

  saveGroup(me: FabricIdentity, workspaceId: string, input: { handle?: unknown; name?: unknown; members?: unknown }): GroupRow & { members: string[] } {
    const mine = this.member(me, workspaceId);
    if (mine.role === "guest") throw fail(403, "guests cannot manage user groups");
    const handle = String(input.handle ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!HANDLE.test(handle) || SPECIAL.has(handle)) throw fail(400, "handle is invalid");
    if (this.store.one("SELECT m.sub FROM team_members m JOIN users u ON u.sub = m.sub WHERE m.workspace_id = ? AND u.username = ?", workspaceId, handle)) throw fail(409, "a person already uses that handle");
    const name = label(input.name ?? handle, "name", 80);
    const people = this.membersByUsernames(workspaceId, usernames(input.members));
    const existing = this.store.one<GroupRow>("SELECT * FROM team_groups WHERE workspace_id = ? AND handle = ?", workspaceId, handle);
    const id = existing?.id ?? randomUUID();
    this.store.tx(() => {
      if (existing) this.store.run("UPDATE team_groups SET name = ? WHERE id = ?", name, id);
      else this.store.insert("team_groups", { id, workspaceId, handle, name, createdBy: me.sub, createdAt: this.stamp() });
      this.store.run("DELETE FROM team_group_members WHERE group_id = ?", id);
      for (const p of people) this.store.insert("team_group_members", { groupId: id, sub: p.sub });
    });
    return this.groups(me, workspaceId).find((g) => g.id === id)!;
  }

  deleteGroup(me: FabricIdentity, workspaceId: string, handle: string): void {
    const mine = this.member(me, workspaceId);
    const group = this.store.one<GroupRow>("SELECT * FROM team_groups WHERE workspace_id = ? AND handle = ?", workspaceId, handle.toLowerCase());
    if (!group) throw fail(404, "not found");
    if (!isAdmin(mine.role) && group.createdBy !== me.sub) throw fail(403, "only the creator or an admin can delete a group");
    this.store.tx(() => {
      this.store.run("DELETE FROM team_group_members WHERE group_id = ?", group.id);
      this.store.run("DELETE FROM team_groups WHERE id = ?", group.id);
    });
  }

  // ---------- scheduled messages and reminders ----------

  schedule(me: FabricIdentity, channelId: string, input: { text?: unknown; sendAt?: unknown; parentId?: unknown }): ScheduledView {
    const { channel } = this.writable(me, channelId);
    const text = input.text;
    if (typeof text !== "string" || text.trim() === "") throw fail(400, "text is required");
    if (text.length > TEAM_LIMITS.text) throw fail(400, "text is too long");
    const sendAt = this.future(input.sendAt, "sendAt");
    let parentId: string | null = null;
    if (typeof input.parentId === "string" && input.parentId) {
      const parent = this.message(input.parentId);
      if (parent.channelId !== channelId) throw fail(404, "not found");
      parentId = parent.parentId ?? parent.id;
    }
    if (this.store.count("SELECT COUNT(*) FROM team_scheduled WHERE sender = ?", me.sub) >= 100) throw fail(400, "you can schedule up to 100 messages");
    const id = randomUUID();
    const row: ScheduledRow = { id, channelId, sender: me.sub, ciphertext: seal(text, this.key(channel), messageAad(channelId, id)), parentId, sendAt, createdAt: this.stamp() };
    this.store.insert("team_scheduled", row);
    return this.scheduledView(me, row);
  }

  scheduledList(me: FabricIdentity, workspaceId: string): ScheduledView[] {
    this.member(me, workspaceId);
    return this.store.all<ScheduledRow>(
      "SELECT s.* FROM team_scheduled s JOIN team_channels c ON c.id = s.channel_id WHERE s.sender = ? AND c.workspace_id = ? ORDER BY s.send_at", me.sub, workspaceId,
    ).map((r) => this.scheduledView(me, r));
  }

  cancelScheduled(me: FabricIdentity, id: string): void {
    if (this.store.run("DELETE FROM team_scheduled WHERE id = ? AND sender = ?", uuid(id), me.sub) === 0) throw fail(404, "not found");
  }

  remind(me: FabricIdentity, workspaceId: string, text: unknown, at: unknown): ReminderView {
    this.member(me, workspaceId);
    if (typeof text !== "string" || text.trim() === "") throw fail(400, "text is required");
    if (text.length > 1000) throw fail(400, "a reminder can be up to 1,000 characters");
    const remindAt = this.future(at, "at");
    if (this.store.count("SELECT COUNT(*) FROM team_reminders WHERE sub = ? AND done = 0", me.sub) >= 200) throw fail(400, "you have too many open reminders");
    const id = randomUUID();
    const row: ReminderRow = { id, workspaceId, sub: me.sub, sealedText: seal(text.trim(), this.masterKey, reminderAad(id)), remindAt, done: 0, firedAt: null, messageId: null, createdAt: this.stamp() };
    this.store.insert("team_reminders", row);
    return this.reminderView(row);
  }

  reminders(me: FabricIdentity, workspaceId: string): ReminderView[] {
    this.member(me, workspaceId);
    return this.store.all<ReminderRow>("SELECT * FROM team_reminders WHERE sub = ? AND workspace_id = ? ORDER BY done, remind_at", me.sub, workspaceId).map((r) => this.reminderView(r));
  }

  updateReminder(me: FabricIdentity, id: string, input: { done?: unknown; at?: unknown }): ReminderView {
    const row = this.store.one<ReminderRow>("SELECT * FROM team_reminders WHERE id = ? AND sub = ?", uuid(id), me.sub);
    if (!row) throw fail(404, "not found");
    if (input.done !== undefined) this.store.run("UPDATE team_reminders SET done = ? WHERE id = ?", input.done === true ? 1 : 0, row.id);
    if (input.at !== undefined) this.store.run("UPDATE team_reminders SET remind_at = ?, fired_at = NULL, done = 0 WHERE id = ?", this.future(input.at, "at"), row.id);
    return this.reminderView(this.store.one<ReminderRow>("SELECT * FROM team_reminders WHERE id = ?", row.id)!);
  }

  deleteReminder(me: FabricIdentity, id: string): void {
    if (this.store.run("DELETE FROM team_reminders WHERE id = ? AND sub = ?", uuid(id), me.sub) === 0) throw fail(404, "not found");
  }

  /** Send due scheduled messages and fire due reminders. Call every few seconds. */
  tick(): { sent: number; reminded: number } {
    const now = this.clock().toISOString();
    let sent = 0;
    let reminded = 0;
    for (const s of this.store.all<ScheduledRow>("SELECT * FROM team_scheduled WHERE send_at <= ? ORDER BY send_at LIMIT 100", now)) {
      this.store.run("DELETE FROM team_scheduled WHERE id = ?", s.id);
      try {
        const channel = this.channel(s.channelId);
        const author = this.users.findUserBySub(s.sender);
        if (!author || channel.archivedAt || !this.channelMember(channel.id, s.sender)) continue;
        const text = open(s.ciphertext, this.key(channel), messageAad(channel.id, s.id));
        const parent = s.parentId ? this.store.one<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ?", s.parentId) : null;
        this.insertMessage(channel, s.sender, text, { id: s.id, parent: parent && !(parent.deletedAt && parent.replyCount === 0) ? parent : null, alsoInChannel: false, fileIds: [] });
        sent += 1;
      } catch (error) {
        console.warn(`scheduled message not sent: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    for (const r of this.store.all<ReminderRow>("SELECT * FROM team_reminders WHERE fired_at IS NULL AND done = 0 AND remind_at <= ? LIMIT 100", now)) {
      try {
        const text = open(r.sealedText, this.masterKey, reminderAad(r.id));
        const messageId = this.deliverReminder(r.workspaceId, r.sub, `Reminder: ${text}`);
        this.store.run("UPDATE team_reminders SET fired_at = ?, message_id = ? WHERE id = ?", now, messageId, r.id);
        reminded += 1;
      } catch (error) {
        this.store.run("UPDATE team_reminders SET fired_at = ? WHERE id = ?", now, r.id);
        console.warn(`reminder not delivered: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    for (const s of this.store.all<{ sub: string; messageId: string }>("SELECT sub, message_id FROM team_saved WHERE remind_at IS NOT NULL AND remind_at <= ? AND done = 0 LIMIT 100", now)) {
      this.store.run("UPDATE team_saved SET remind_at = NULL WHERE sub = ? AND message_id = ?", s.sub, s.messageId);
      const msg = this.store.one<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ?", s.messageId);
      if (!msg) continue;
      const channel = this.channel(msg.channelId);
      try {
        this.deliverReminder(channel.workspaceId, s.sub, `Reminder about a saved message in ${channelLabel(channel)}: fabric:message/${msg.id}`);
        reminded += 1;
      } catch {
        // The member left the workspace.
      }
    }
    return { sent, reminded };
  }

  // ---------- activity, threads, unreads, search ----------

  activity(me: FabricIdentity, workspaceId: string): ActivityItem[] {
    this.member(me, workspaceId);
    const items: ActivityItem[] = [];
    const visible = "(c.kind = 'public' OR EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.sub = ?))";
    for (const m of this.store.all<{ messageId: string; createdAt: string }>(
      `SELECT x.message_id, x.created_at FROM team_mentions x JOIN team_channels c ON c.id = x.channel_id
       WHERE x.sub = ? AND c.workspace_id = ? AND ${visible} ORDER BY x.created_at DESC LIMIT 50`, me.sub, workspaceId, me.sub,
    )) {
      const msg = this.message(m.messageId);
      if (msg.deletedAt) continue;
      const self = msg.sender === me.sub;
      items.push({ kind: self && msg.kind === "system" ? "reminder" : "mention", at: msg.createdAt, actor: this.person(workspaceId, msg.sender), message: this.view(me, msg) });
    }
    for (const r of this.store.all<TeamMessageRow>(
      `SELECT r.* FROM team_messages r JOIN team_channels c ON c.id = r.channel_id
       WHERE c.workspace_id = ? AND ${visible} AND r.parent_id IS NOT NULL AND r.sender <> ? AND r.deleted_at IS NULL
         AND r.parent_id IN (SELECT id FROM team_messages WHERE sender = ? UNION SELECT parent_id FROM team_messages WHERE sender = ? AND parent_id IS NOT NULL)
       ORDER BY r.created_at DESC LIMIT 50`, workspaceId, me.sub, me.sub, me.sub, me.sub,
    )) {
      if (items.some((i) => i.message.id === r.id)) continue;
      items.push({ kind: "reply", at: r.createdAt, actor: this.person(workspaceId, r.sender), message: this.view(me, r) });
    }
    for (const x of this.store.all<{ messageId: string; sub: string; emoji: string; createdAt: string }>(
      `SELECT x.* FROM team_reactions x JOIN team_messages m ON m.id = x.message_id JOIN team_channels c ON c.id = m.channel_id
       WHERE m.sender = ? AND x.sub <> ? AND c.workspace_id = ? AND ${visible} ORDER BY x.created_at DESC LIMIT 50`, me.sub, me.sub, workspaceId, me.sub,
    )) {
      items.push({ kind: "reaction", at: x.createdAt, actor: this.person(workspaceId, x.sub), emoji: x.emoji, message: this.view(me, this.message(x.messageId)) });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  }

  threads(me: FabricIdentity, workspaceId: string): { parent: MessageView; latest: MessageView[]; channel: ChannelView }[] {
    this.member(me, workspaceId);
    return this.store.all<TeamMessageRow>(
      `SELECT p.* FROM team_messages p JOIN team_channels c ON c.id = p.channel_id
       WHERE c.workspace_id = ? AND p.parent_id IS NULL AND p.reply_count > 0
         AND (p.sender = ? OR EXISTS (SELECT 1 FROM team_messages r WHERE r.parent_id = p.id AND r.sender = ?)
              OR EXISTS (SELECT 1 FROM team_mentions x JOIN team_messages r ON r.id = x.message_id WHERE x.sub = ? AND (r.id = p.id OR r.parent_id = p.id)))
       ORDER BY p.last_reply_at DESC LIMIT 30`, workspaceId, me.sub, me.sub, me.sub,
    ).filter((p) => this.canRead(me, p.channelId)).map((p) => ({
      parent: this.view(me, p),
      latest: this.store.all<TeamMessageRow>("SELECT * FROM team_messages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3", p.id).reverse().map((r) => this.view(me, r)),
      channel: this.channelView(me, this.channel(p.channelId)),
    }));
  }

  unreads(me: FabricIdentity, workspaceId: string): { channel: ChannelView; messages: MessageView[] }[] {
    const bar = this.sidebar(me, workspaceId);
    return [...bar.channels, ...bar.direct].filter((c) => c.unread > 0 && !c.muted).map((c) => ({
      channel: c,
      messages: this.store.all<TeamMessageRow>(
        `SELECT * FROM team_messages WHERE channel_id = ? AND (parent_id IS NULL OR also_in_channel = 1) AND deleted_at IS NULL
         AND sender <> ? AND created_at > ? ORDER BY created_at DESC LIMIT 20`, c.id, me.sub, c.lastReadAt ?? "",
      ).reverse().map((r) => this.view(me, r)),
    }));
  }

  /**
   * Search messages, channels, people and files.
   * Message filters: in:#channel, in:@person, from:@person, has:link, has:file, has:reaction, has:pin,
   * is:thread, is:saved, before:YYYY-MM-DD, after:YYYY-MM-DD, during:YYYY-MM-DD, "exact phrase".
   */
  search(me: FabricIdentity, workspaceId: string, query: string): { messages: MessageView[]; channels: ChannelView[]; people: PersonView[]; files: FileView[]; scanned: number } {
    this.member(me, workspaceId);
    const q = parseQuery(query);
    const where: string[] = ["c.workspace_id = ?", "m.deleted_at IS NULL", "m.kind = 'user'"];
    const params: (string | number)[] = [workspaceId];
    where.push("(c.kind = 'public' OR EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.sub = ?))");
    params.push(me.sub);
    if (q.inChannel) {
      where.push("c.name = ?");
      params.push(q.inChannel);
    }
    if (q.inPerson) {
      const other = this.users.findUserByUsername(me.issuer, q.inPerson);
      where.push("c.kind = 'dm' AND c.dm_key = ?");
      params.push([me.sub, other?.sub ?? "-"].sort().join(","));
    }
    if (q.from) {
      const who = this.users.findUserByUsername(me.issuer, q.from === "me" ? me.username : q.from);
      where.push("m.sender = ?");
      params.push(who?.sub ?? "-");
    }
    if (q.before) { where.push("m.created_at < ?"); params.push(q.before); }
    if (q.after) { where.push("m.created_at >= ?"); params.push(q.after); }
    if (q.has.has("file")) where.push("EXISTS (SELECT 1 FROM team_files f WHERE f.message_id = m.id)");
    if (q.has.has("reaction")) where.push("EXISTS (SELECT 1 FROM team_reactions x WHERE x.message_id = m.id)");
    if (q.has.has("pin")) where.push("EXISTS (SELECT 1 FROM team_pins p WHERE p.message_id = m.id)");
    if (q.is.has("thread")) where.push("(m.parent_id IS NOT NULL OR m.reply_count > 0)");
    if (q.is.has("saved")) { where.push("EXISTS (SELECT 1 FROM team_saved s WHERE s.message_id = m.id AND s.sub = ?)"); params.push(me.sub); }
    const rows = this.store.all<TeamMessageRow>(
      `SELECT m.* FROM team_messages m JOIN team_channels c ON c.id = m.channel_id WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ?`,
      ...params, TEAM_LIMITS.searchScan,
    );
    const messages: MessageView[] = [];
    for (const row of rows) {
      if (messages.length >= 50) break;
      const channel = this.channel(row.channelId);
      let text: string;
      try {
        text = open(row.ciphertext, this.key(channel), messageAad(channel.id, row.id));
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      if (q.terms.some((t) => !lower.includes(t))) continue;
      if (q.has.has("link") && !/https?:\/\//i.test(text)) continue;
      messages.push(this.view(me, row, text));
    }
    const plain = q.terms.join(" ");
    const filtered = q.inChannel || q.inPerson || q.from || q.has.size || q.is.size || q.before || q.after;
    return {
      messages,
      channels: !plain || filtered ? [] : this.browseChannels(me, workspaceId, plain).slice(0, 10),
      people: !plain || filtered ? [] : this.people(me, workspaceId, plain).slice(0, 10),
      files: !plain || filtered ? [] : this.files(me, workspaceId).filter((f) => f.name.toLowerCase().includes(plain)).slice(0, 10),
      scanned: rows.length,
    };
  }

  typing(me: FabricIdentity, channelId: string, parentId: string | null): void {
    const { channel } = this.writable(me, channelId);
    this.publish(this.channelSubs(channelId).filter((s) => s !== me.sub), { type: "typing", workspaceId: channel.workspaceId, channelId, parentId, sub: me.sub, username: me.username });
  }

  /** Workspaces the person belongs to, for routing live events. */
  workspaceIds(sub: string): string[] {
    return this.store.all<{ workspaceId: string }>("SELECT workspace_id FROM team_members WHERE sub = ? AND deactivated_at IS NULL", sub).map((r) => r.workspaceId);
  }

  // ---------- slash commands ----------

  private command(me: FabricIdentity, channelId: string, text: string, tzOffset: number): SendResult {
    const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) throw fail(400, "unknown command");
    const name = match[1]!.toLowerCase();
    const rest = (match[2] ?? "").trim();
    const { channel } = this.readable(me, channelId);
    const ws = channel.workspaceId;
    const plain = (body: string) => this.send(me, channelId, { text: body });
    switch (name) {
      case "me":
        if (!rest) throw fail(400, "usage: /me text");
        return plain(`_${rest}_`);
      case "shrug":
        return plain(`${rest ? `${rest} ` : ""}¯\\_(ツ)_/¯`);
      case "topic":
      case "purpose":
        this.updateChannel(me, channelId, { [name]: rest });
        return { ephemeral: rest ? `The ${name} is now: ${rest}` : `The ${name} was cleared.` };
      case "rename":
        this.updateChannel(me, channelId, { name: rest });
        return { ephemeral: `Renamed to #${channelName(rest)}.` };
      case "invite":
      case "add":
        this.invite(me, channelId, rest.split(/[\s,]+/).filter(Boolean));
        return { ephemeral: "Added." };
      case "kick":
      case "remove": {
        const target = rest.replace(/^@/, "");
        this.kick(me, channelId, target);
        return { ephemeral: `Removed @${target}.` };
      }
      case "leave":
      case "part":
        this.leaveChannel(me, channelId);
        return { ephemeral: "You left." };
      case "join": {
        const target = channelName(rest.replace(/^#/, ""));
        const row = this.store.one<ChannelRow>("SELECT * FROM team_channels WHERE workspace_id = ? AND name = ?", ws, target);
        if (!row) throw fail(404, `no channel named #${target}`);
        this.joinChannel(me, row.id);
        return { ephemeral: `Joined #${target}.`, channelId: row.id };
      }
      case "archive":
        this.archiveChannel(me, channelId, true);
        return { ephemeral: "Archived." };
      case "msg":
      case "dm": {
        const m = /^@?([a-z0-9._-]+)\s+([\s\S]+)$/i.exec(rest);
        if (!m) throw fail(400, "usage: /dm @person message");
        const dm = this.openConversation(me, ws, [m[1]!]);
        const result = this.send(me, dm.id, { text: m[2]! });
        return { ...result, channelId: dm.id };
      }
      case "remind": {
        const parsed = parseReminder(rest, this.clock(), tzOffset);
        if (!parsed) throw fail(400, "usage: /remind me to [what] in 10 minutes | at 15:00 | tomorrow");
        const r = this.remind(me, ws, parsed.text, parsed.at);
        return { ephemeral: `I will remind you “${parsed.text}” at ${r.remindAt}.` };
      }
      case "status": {
        if (!rest || rest === "clear") {
          this.setStatus(me, ws, { emoji: null, text: null });
          return { ephemeral: "Status cleared." };
        }
        const [first = "", ...words] = rest.split(/\s+/);
        const emoji = /^:[a-z0-9_+-]+:$/i.test(first) || !/[a-z0-9]/i.test(first) ? first : null;
        this.setStatus(me, ws, { emoji, text: emoji ? words.join(" ") : rest });
        return { ephemeral: "Status set." };
      }
      case "away":
        this.setPresence(me, ws, { away: !this.member(me, ws).away });
        return { ephemeral: this.member(me, ws).away ? "You are set to away." : "You are active." };
      case "active":
        this.setPresence(me, ws, { away: false });
        return { ephemeral: "You are active." };
      case "dnd": {
        if (rest === "off" || rest === "end") {
          this.setPresence(me, ws, { dndUntil: null });
          return { ephemeral: "Notifications are back on." };
        }
        const ms = duration(rest || "1h");
        if (!ms) throw fail(400, "usage: /dnd 30m | 2h | off");
        const until = new Date(this.clock().getTime() + ms).toISOString();
        this.setPresence(me, ws, { dndUntil: until });
        return { ephemeral: `Notifications paused until ${until}.` };
      }
      case "mute":
      case "unmute":
        this.setChannelPrefs(me, channelId, { muted: name === "mute" });
        return { ephemeral: name === "mute" ? "Channel muted." : "Channel unmuted." };
      case "who":
        return { ephemeral: `In ${channelLabel(channel)}: ${this.channelPeople(me, channelId).map((p) => `@${p.username}`).join(", ")}` };
      case "help":
        return { ephemeral: HELP };
      default:
        throw fail(400, `unknown command /${name}. Try /help`);
    }
  }

  // ---------- internals ----------

  private insertMessage(channel: ChannelRow, sender: string, text: string, opts: { id: string; parent: TeamMessageRow | null; alsoInChannel: boolean; fileIds: string[] }): { row: TeamMessageRow; notInChannel: string[] } {
    const now = this.stamp();
    const row: TeamMessageRow = {
      id: opts.id, channelId: channel.id, sender, ciphertext: seal(text, this.key(channel), messageAad(channel.id, opts.id)),
      parentId: opts.parent?.id ?? null, createdAt: now, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null,
      alsoInChannel: opts.alsoInChannel ? 1 : 0, kind: "user",
    };
    const notInChannel = this.store.tx(() => {
      this.store.insert("team_messages", row);
      for (const f of opts.fileIds) this.store.run("UPDATE team_files SET message_id = ? WHERE id = ?", row.id, f);
      if (opts.parent) this.store.run("UPDATE team_messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?", now, opts.parent.id);
      if (!opts.parent || opts.alsoInChannel) this.store.run("UPDATE team_channels SET last_message_at = ? WHERE id = ?", now, channel.id);
      this.store.run("UPDATE team_channel_members SET last_read_at = ? WHERE channel_id = ? AND sub = ? AND last_read_at < ?", now, channel.id, sender, now);
      return this.recordMentions(channel, sender, row.id, text, now);
    });
    const mentioned = this.store.all<{ sub: string }>("SELECT sub FROM team_mentions WHERE message_id = ?", row.id).map((m) => m.sub);
    this.publish(this.channelSubs(channel.id), {
      type: "message", workspaceId: channel.workspaceId, channelId: channel.id, messageId: row.id, parentId: row.parentId,
      sub: sender, mentioned, kind: channel.kind, alsoInChannel: opts.alsoInChannel,
    });
    return { row, notInChannel };
  }

  /** Record who a message notifies. Returns usernames mentioned who are not in the channel. */
  private recordMentions(channel: ChannelRow, sender: string, messageId: string, text: string, at: string): string[] {
    const members = new Set(this.channelSubs(channel.id));
    const targets = new Set<string>();
    const outside = new Set<string>();
    if (channel.kind === "dm" || channel.kind === "group") for (const m of members) if (m !== sender) targets.add(m);
    for (const match of text.matchAll(MENTION)) {
      const handle = match[2]!.toLowerCase().replace(/[._-]+$/, "");
      if (handle === "channel" || handle === "everyone") {
        for (const m of members) if (m !== sender) targets.add(m);
        continue;
      }
      if (handle === "here") {
        for (const m of members) if (m !== sender && this.presence(this.store.one<MemberRow>("SELECT * FROM team_members WHERE workspace_id = ? AND sub = ?", channel.workspaceId, m)) === "active") targets.add(m);
        continue;
      }
      const user = this.store.one<{ sub: string }>(
        "SELECT u.sub FROM users u JOIN team_members m ON m.sub = u.sub WHERE m.workspace_id = ? AND u.username = ? AND m.deactivated_at IS NULL", channel.workspaceId, handle,
      );
      if (user) {
        if (members.has(user.sub)) targets.add(user.sub);
        else if (user.sub !== sender) outside.add(handle);
        continue;
      }
      const group = this.store.one<GroupRow>("SELECT * FROM team_groups WHERE workspace_id = ? AND handle = ?", channel.workspaceId, handle);
      if (group) for (const g of this.store.all<{ sub: string }>("SELECT sub FROM team_group_members WHERE group_id = ?", group.id)) if (members.has(g.sub)) targets.add(g.sub);
    }
    targets.delete(sender);
    for (const sub of targets) this.store.insert("team_mentions", { messageId, sub, channelId: channel.id, createdAt: at });
    return [...outside];
  }

  private system(channel: ChannelRow, actor: string, text: string): void {
    const id = randomUUID();
    const now = this.stamp();
    this.store.insert("team_messages", {
      id, channelId: channel.id, sender: actor, ciphertext: seal(text, this.key(channel), messageAad(channel.id, id)),
      parentId: null, createdAt: now, replyCount: 0, alsoInChannel: 0, kind: "system",
    });
    this.publish(this.channelSubs(channel.id), { type: "message", workspaceId: channel.workspaceId, channelId: channel.id, messageId: id, parentId: null, sub: actor, mentioned: [], kind: channel.kind });
  }

  private deliverReminder(workspaceId: string, sub: string, text: string): string {
    const user = this.users.findUserBySub(sub);
    if (!user) throw new Error("no such user");
    const identity: FabricIdentity = { sub, issuer: user.issuer, username: user.username, email: user.email, name: user.name, expiresAt: 0 };
    const self = this.openConversation(identity, workspaceId, []);
    const channel = this.channel(self.id);
    const id = randomUUID();
    const now = this.stamp();
    this.store.tx(() => {
      this.store.insert("team_messages", {
        id, channelId: channel.id, sender: sub, ciphertext: seal(text, this.key(channel), messageAad(channel.id, id)),
        parentId: null, createdAt: now, replyCount: 0, alsoInChannel: 0, kind: "system",
      });
      this.store.run("UPDATE team_channels SET last_message_at = ? WHERE id = ?", now, channel.id);
      this.store.insert("team_mentions", { messageId: id, sub, channelId: channel.id, createdAt: now });
    });
    this.publish([sub], { type: "message", workspaceId, channelId: channel.id, messageId: id, parentId: null, sub, mentioned: [sub], kind: "dm", reminder: true });
    return id;
  }

  private newChannel(workspaceId: string, kind: ChannelKind, name: string | null, by: string, now: string, extra: { topic?: string; purpose?: string; dmKey?: string; isDefault?: number } = {}): ChannelRow {
    const id = randomUUID();
    const row: ChannelRow = {
      id, workspaceId, kind, name, topic: extra.topic ?? "", purpose: extra.purpose ?? "",
      sealedKey: seal(randomKey().toString("base64"), this.masterKey, channelKeyAad(id)), createdBy: by, createdAt: now,
      archivedAt: null, dmKey: extra.dmKey ?? null, isDefault: extra.isDefault ?? 0, lastMessageAt: null,
    };
    this.store.insert("team_channels", row);
    return row;
  }

  private addChannelMember(channelId: string, sub: string, now: string): void {
    this.store.run(
      "INSERT INTO team_channel_members (channel_id, sub, last_read_at, muted, starred, joined_at) VALUES (?, ?, ?, 0, 0, ?) ON CONFLICT DO NOTHING",
      channelId, sub, now, now,
    );
  }

  private key(channel: ChannelRow): Buffer {
    let key = this.keys.get(channel.id);
    if (!key) {
      key = Buffer.from(open(channel.sealedKey, this.masterKey, channelKeyAad(channel.id)), "base64");
      this.keys.set(channel.id, key);
    }
    return key;
  }

  private stamp(): string {
    let t = this.clock().getTime();
    if (t <= this.lastStamp) t = this.lastStamp + 1;
    this.lastStamp = t;
    return new Date(t).toISOString();
  }

  private future(value: unknown, name: string): string {
    const iso = isoOf(value, name);
    if (Date.parse(iso) <= this.clock().getTime()) throw fail(400, `${name} must be in the future`);
    if (Date.parse(iso) > this.clock().getTime() + 366 * 86_400_000) throw fail(400, `${name} must be within a year`);
    return iso;
  }

  private workspace(id: string): WorkspaceRow {
    const row = this.store.one<WorkspaceRow>("SELECT * FROM team_workspaces WHERE id = ?", uuid(id));
    if (!row) throw fail(404, "not found");
    return row;
  }

  private member(me: FabricIdentity, workspaceId: string): MemberRow {
    const row = this.store.one<MemberRow>("SELECT * FROM team_members WHERE workspace_id = ? AND sub = ?", uuid(workspaceId), me.sub);
    if (!row || row.deactivatedAt) throw fail(404, "not found");
    return row;
  }

  private admin(me: FabricIdentity, workspaceId: string): MemberRow {
    const row = this.member(me, workspaceId);
    if (!isAdmin(row.role)) throw fail(403, "only an owner or admin can do that");
    return row;
  }

  private memberByUsername(workspaceId: string, username: string): MemberRow {
    const handle = String(username ?? "").trim().replace(/^@/, "").toLowerCase();
    const row = this.store.one<MemberRow>(
      "SELECT m.* FROM team_members m JOIN users u ON u.sub = m.sub WHERE m.workspace_id = ? AND u.username = ? AND m.deactivated_at IS NULL", workspaceId, handle,
    );
    if (!row) throw fail(404, `@${handle} is not in this workspace`);
    return row;
  }

  private membersByUsernames(workspaceId: string, names: string[]): MemberRow[] {
    const seen = new Map<string, MemberRow>();
    for (const n of names) {
      const m = this.memberByUsername(workspaceId, n);
      seen.set(m.sub, m);
    }
    return [...seen.values()];
  }

  private channel(id: string): ChannelRow {
    const row = this.store.one<ChannelRow>("SELECT * FROM team_channels WHERE id = ?", uuid(id));
    if (!row) throw fail(404, "not found");
    return row;
  }

  private channelMember(channelId: string, sub: string): ChannelMemberRow | null {
    return this.store.one<ChannelMemberRow>("SELECT * FROM team_channel_members WHERE channel_id = ? AND sub = ?", channelId, sub);
  }

  private canRead(me: FabricIdentity, channelId: string): boolean {
    try {
      this.readable(me, channelId);
      return true;
    } catch {
      return false;
    }
  }

  /** Workspace members can read public channels (guests only their own); everything else needs membership. */
  private readable(me: FabricIdentity, channelId: string): { channel: ChannelRow; ws: MemberRow } {
    const channel = this.channel(channelId);
    const ws = this.member(me, channel.workspaceId);
    if ((channel.kind !== "public" || ws.role === "guest") && !this.channelMember(channel.id, me.sub)) throw fail(404, "not found");
    return { channel, ws };
  }

  private writable(me: FabricIdentity, channelId: string): { channel: ChannelRow; ws: MemberRow } {
    const r = this.readable(me, channelId);
    if (r.channel.archivedAt) throw fail(400, "this channel is archived");
    if (!this.channelMember(channelId, me.sub)) throw fail(403, "join the channel first");
    return r;
  }

  private message(id: string): TeamMessageRow {
    const row = this.store.one<TeamMessageRow>("SELECT * FROM team_messages WHERE id = ?", uuid(id));
    if (!row) throw fail(404, "not found");
    return row;
  }

  private channelSubs(channelId: string): string[] {
    return this.store.all<{ sub: string }>("SELECT sub FROM team_channel_members WHERE channel_id = ?", channelId).map((r) => r.sub);
  }

  private workspaceSubs(workspaceId: string): string[] {
    return this.store.all<{ sub: string }>("SELECT sub FROM team_members WHERE workspace_id = ? AND deactivated_at IS NULL", workspaceId).map((r) => r.sub);
  }

  private uniqueSlug(name: string): string {
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
    let slug = base;
    for (let i = 2; this.store.one("SELECT id FROM team_workspaces WHERE slug = ?", slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  private username(sub: string): string {
    return this.users.findUserBySub(sub)?.username ?? "unknown";
  }

  private presence(m: MemberRow | null): "active" | "away" {
    if (!m || m.away) return "away";
    if ((this.connected.get(m.sub) ?? 0) > 0) return "active";
    const last = this.lastSeen.get(m.sub);
    return last !== undefined && this.clock().getTime() - last < TEAM_LIMITS.activeWindowMs ? "active" : "away";
  }

  private person(workspaceId: string, sub: string): PersonView {
    const m = this.store.one<MemberRow>("SELECT * FROM team_members WHERE workspace_id = ? AND sub = ?", workspaceId, sub);
    if (m) return this.personFromMember(m);
    const user = this.users.findUserBySub(sub);
    return {
      sub, username: user?.username ?? "unknown", name: user?.name ?? null, displayName: user?.name || user?.username || "unknown", title: null, role: "guest",
      statusEmoji: null, statusText: null, statusUntil: null, presence: "away", dnd: false, dndUntil: null, deactivated: true,
    };
  }

  private personFromMember(m: MemberRow): PersonView {
    const user: UserRow | null = this.users.findUserBySub(m.sub);
    const now = this.clock().toISOString();
    const statusLive = !m.statusUntil || m.statusUntil > now;
    const dnd = !!m.dndUntil && m.dndUntil > now;
    return {
      sub: m.sub,
      username: user?.username ?? "unknown",
      name: user?.name ?? null,
      displayName: m.displayName || user?.name || user?.username || "unknown",
      title: m.title,
      role: m.role,
      statusEmoji: statusLive ? m.statusEmoji : null,
      statusText: statusLive ? m.statusText : null,
      statusUntil: statusLive ? m.statusUntil : null,
      presence: this.presence(m),
      dnd,
      dndUntil: dnd ? m.dndUntil : null,
      deactivated: !!m.deactivatedAt,
    };
  }

  private workspaceView(me: FabricIdentity, w: WorkspaceRow): WorkspaceView {
    const role = this.store.one<{ role: Role }>("SELECT role FROM team_members WHERE workspace_id = ? AND sub = ?", w.id, me.sub)?.role ?? "member";
    return {
      id: w.id, name: w.name, slug: w.slug, inviteCode: role === "guest" ? "" : w.inviteCode, role, createdAt: w.createdAt,
      memberCount: this.store.count("SELECT COUNT(*) FROM team_members WHERE workspace_id = ? AND deactivated_at IS NULL", w.id),
    };
  }

  private channelView(me: FabricIdentity, c: ChannelRow, withPeople = false): ChannelView {
    const mine = this.channelMember(c.id, me.sub);
    const subs = this.channelSubs(c.id);
    const lastRead = mine?.lastReadAt ?? null;
    const unread = mine ? this.store.count(
      `SELECT COUNT(*) FROM team_messages WHERE channel_id = ? AND (parent_id IS NULL OR also_in_channel = 1)
       AND deleted_at IS NULL AND sender <> ? AND created_at > ?`, c.id, me.sub, mine.lastReadAt,
    ) : 0;
    const mentions = mine ? this.store.count("SELECT COUNT(*) FROM team_mentions WHERE channel_id = ? AND sub = ? AND created_at > ?", c.id, me.sub, mine.lastReadAt) : 0;
    const others = subs.filter((s) => s !== me.sub);
    const name = c.kind === "dm" || c.kind === "group"
      ? (others.length ? others.map((s) => this.person(c.workspaceId, s).displayName).join(", ") : `${this.person(c.workspaceId, me.sub).displayName} (you)`)
      : c.name ?? "";
    return {
      id: c.id, workspaceId: c.workspaceId, kind: c.kind, name, topic: c.topic, purpose: c.purpose, createdBy: c.createdBy, createdAt: c.createdAt,
      archived: !!c.archivedAt, isDefault: !!c.isDefault, memberCount: subs.length, member: !!mine, muted: !!mine?.muted, starred: !!mine?.starred,
      unread, mentions, lastReadAt: lastRead, lastMessageAt: c.lastMessageAt,
      ...(withPeople || c.kind === "dm" || c.kind === "group" ? { people: (c.kind === "dm" || c.kind === "group" ? others : subs).slice(0, 50).map((s) => this.person(c.workspaceId, s)) } : {}),
    };
  }

  private reactions(me: FabricIdentity, messageId: string): ReactionView[] {
    const grouped = new Map<string, string[]>();
    for (const r of this.store.all<{ emoji: string; sub: string }>("SELECT emoji, sub FROM team_reactions WHERE message_id = ? ORDER BY created_at", messageId)) {
      const list = grouped.get(r.emoji) ?? [];
      list.push(r.sub);
      grouped.set(r.emoji, list);
    }
    return [...grouped].map(([emoji, subs]) => ({ emoji, count: subs.length, subs, mine: subs.includes(me.sub) }));
  }

  private view(me: FabricIdentity, row: TeamMessageRow, plaintext?: string): MessageView {
    const channel = this.channel(row.channelId);
    let text = plaintext ?? "";
    let unreadable = false;
    if (plaintext === undefined && !row.deletedAt) {
      try {
        text = open(row.ciphertext, this.key(channel), messageAad(channel.id, row.id));
      } catch {
        unreadable = true;
      }
    }
    return {
      id: row.id,
      channelId: row.channelId,
      workspaceId: channel.workspaceId,
      parentId: row.parentId,
      sender: this.person(channel.workspaceId, row.sender),
      text: row.deletedAt ? "" : text,
      kind: row.kind,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deleted: !!row.deletedAt,
      unreadable,
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
      replyUsers: row.replyCount ? this.store.all<{ sender: string }>("SELECT sender FROM team_messages WHERE parent_id = ? AND deleted_at IS NULL GROUP BY sender ORDER BY MIN(created_at) LIMIT 5", row.id).map((r) => r.sender) : [],
      alsoInChannel: !!row.alsoInChannel,
      reactions: this.reactions(me, row.id),
      pinned: !!this.store.one("SELECT message_id FROM team_pins WHERE message_id = ?", row.id),
      saved: !!this.store.one("SELECT message_id FROM team_saved WHERE message_id = ? AND sub = ?", row.id, me.sub),
      files: this.store.all<FileRow>("SELECT * FROM team_files WHERE message_id = ? ORDER BY created_at", row.id).map(fileView),
      mentions: this.store.all<{ sub: string }>("SELECT sub FROM team_mentions WHERE message_id = ?", row.id).map((m) => m.sub),
    };
  }

  private scheduledView(me: FabricIdentity, row: ScheduledRow): ScheduledView {
    const channel = this.channel(row.channelId);
    return { id: row.id, channel: this.channelView(me, channel), parentId: row.parentId, sendAt: row.sendAt, createdAt: row.createdAt, text: open(row.ciphertext, this.key(channel), messageAad(channel.id, row.id)) };
  }

  private reminderView(row: ReminderRow): ReminderView {
    return { id: row.id, text: open(row.sealedText, this.masterKey, reminderAad(row.id)), remindAt: row.remindAt, done: !!row.done, fired: !!row.firedAt, messageId: row.messageId, createdAt: row.createdAt };
  }
}

export interface ScheduledView { id: string; channel: ChannelView; parentId: string | null; sendAt: string; createdAt: string; text: string }
export interface ReminderView { id: string; text: string; remindAt: string; done: boolean; fired: boolean; messageId: string | null; createdAt: string }

const HELP = [
  "/me text · /shrug [text] · /topic text · /purpose text · /rename name",
  "/invite @a @b · /kick @a · /join #channel · /leave · /archive · /who",
  "/dm @person message · /remind me to [what] in 10m | at 15:00 | tomorrow",
  "/status :emoji: text | clear · /away · /active · /dnd 30m | off · /mute · /unmute",
].join("\n");

function isAdmin(role: Role): boolean {
  return role === "owner" || role === "admin";
}

function uuid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw fail(404, "not found");
  return value.toLowerCase();
}

function label(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw fail(400, `${name} is required`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean) throw fail(400, `${name} is required`);
  if (clean.length > max) throw fail(400, `${name} can be up to ${max} characters`);
  return clean;
}

function optional(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw fail(400, `${name} must be text`);
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  if (clean.length > max) throw fail(400, `${name} can be up to ${max} characters`);
  return clean || null;
}

export function channelName(value: unknown): string {
  if (typeof value !== "string") throw fail(400, "channel name is required");
  const name = value.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
  if (!CHANNEL_NAME.test(name)) throw fail(400, "channel names use lowercase letters, numbers, hyphens and underscores (up to 80)");
  return name;
}

function usernames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : null;
  if (!list) throw fail(400, "members must be a list of usernames");
  if (list.length > 100) throw fail(400, "too many people at once");
  return list.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().replace(/^@/, "").toLowerCase());
}

/** A reaction or status emoji: an emoji character sequence or a :short_code:. */
export function emojiOf(value: unknown): string {
  if (typeof value !== "string") throw fail(400, "emoji is required");
  const e = value.trim();
  if (/^:[a-z0-9_+-]{1,40}:$/i.test(e)) return e.toLowerCase();
  if (e.length === 0 || e.length > 16 || /[\s<>"'`&a-z0-9]/i.test(e)) throw fail(400, "emoji is invalid");
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|[©®‼-㊙]/u.test(e)) throw fail(400, "emoji is invalid");
  return e;
}

function fileName(value: unknown): string {
  const name = label(value, "file name", 200).replace(/[\\/]/g, "_");
  return name;
}

function httpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) throw fail(400, "url is invalid");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw fail(400, "url is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw fail(400, "url must be http or https");
  return url.href;
}

function isoOf(value: unknown, name: string): string {
  const t = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw fail(400, `${name} must be a date`);
  return new Date(t).toISOString();
}

function fileView(f: FileRow): FileView {
  return { id: f.id, name: f.name, mime: f.mime, size: f.size, createdAt: f.createdAt, channelId: f.channelId, uploader: f.uploader };
}

function channelLabel(c: ChannelRow): string {
  return c.kind === "public" || c.kind === "private" ? `#${c.name}` : "a conversation";
}

function inviteCode(): string {
  return randomBytes(16).toString("base64url");
}

function channelKeyAad(id: string): string { return `fabric-team-channel-key:${id}`; }
function messageAad(channelId: string, id: string): string { return `fabric-team-message:${channelId}:${id}`; }
function fileAad(channelId: string, id: string): string { return `fabric-team-file:${channelId}:${id}`; }
function canvasAad(channelId: string): string { return `fabric-team-canvas:${channelId}`; }
function reminderAad(id: string): string { return `fabric-team-reminder:${id}`; }

/** "10m", "2 hours", "1d" → milliseconds. */
export function duration(text: string): number | null {
  const m = /^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase()[0];
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n > 0 ? n * ms : null;
}

/**
 * "/remind me to call Sam in 10 minutes", "/remind me stand-up at 9:30", "/remind me pay rent tomorrow".
 * `tzOffset` is minutes east of UTC, so "at 15:00" means the person's local 15:00.
 */
export function parseReminder(input: string, now: Date, tzOffset = 0): { text: string; at: string } | null {
  let rest = input.trim();
  if (!/^me\b/i.test(rest)) return null;
  rest = rest.replace(/^me\s+/i, "");
  let at: Date | null = null;
  let m = /\s+in\s+(\d{1,4}\s*[a-z]+)$/i.exec(rest);
  if (m) {
    const ms = duration(m[1]!);
    if (ms) at = new Date(now.getTime() + ms);
  }
  if (!at && (m = /\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(rest))) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const ampm = m[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const local = new Date(now.getTime() + tzOffset * 60_000);
    local.setUTCHours(hour, minute, 0, 0);
    let t = local.getTime() - tzOffset * 60_000;
    if (t <= now.getTime()) t += 86_400_000;
    at = new Date(t);
  }
  if (!at && (m = /\s+tomorrow$/i.exec(rest))) {
    const local = new Date(now.getTime() + tzOffset * 60_000 + 86_400_000);
    local.setUTCHours(9, 0, 0, 0);
    at = new Date(local.getTime() - tzOffset * 60_000);
  }
  if (!at || !m) return null;
  const text = rest.slice(0, m.index).replace(/^to\s+/i, "").trim();
  if (!text) return null;
  return { text, at: at.toISOString() };
}

interface Query {
  terms: string[];
  inChannel?: string;
  inPerson?: string;
  from?: string;
  before?: string;
  after?: string;
  has: Set<string>;
  is: Set<string>;
}

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], has: new Set(), is: new Set() };
  const tokens = String(input ?? "").slice(0, 500).match(/"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    const m = /^(in|from|has|is|before|after|during|on):(.+)$/.exec(token);
    if (!m) {
      const term = token.replace(/^"|"$/g, "").trim();
      if (term) q.terms.push(term);
      continue;
    }
    const [, key, value] = m as unknown as [string, string, string];
    if (key === "in") {
      if (value.startsWith("@")) q.inPerson = value.slice(1);
      else q.inChannel = value.replace(/^#/, "");
    } else if (key === "from") q.from = value.replace(/^@/, "");
    else if (key === "has") q.has.add(value.replace(/s$/, ""));
    else if (key === "is") q.is.add(value);
    else {
      const t = Date.parse(value);
      if (!Number.isFinite(t)) continue;
      const day = new Date(t).toISOString();
      const next = new Date(t + 86_400_000).toISOString();
      if (key === "before") q.before = day;
      if (key === "after") q.after = next;
      if (key === "during" || key === "on") {
        q.after = day;
        q.before = next;
      }
    }
  }
  return q;
}
