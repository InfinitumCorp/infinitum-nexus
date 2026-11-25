/**
 * Team-chat tables for FABRIC++: workspaces, channels, threads, reactions and the rest.
 *
 * Every message body, file, canvas, scheduled message and reminder is stored
 * as AES-256-GCM ciphertext. Names that people browse and search by
 * (workspace, channel, topic, user group) are stored as plain text.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type Role = "owner" | "admin" | "member" | "guest";
export type ChannelKind = "public" | "private" | "dm" | "group";

export interface WorkspaceRow { id: string; name: string; slug: string; inviteCode: string; createdBy: string; createdAt: string }
export interface MemberRow {
  workspaceId: string; sub: string; role: Role; displayName: string | null; title: string | null;
  statusEmoji: string | null; statusText: string | null; statusUntil: string | null;
  dndUntil: string | null; away: number; joinedAt: string; deactivatedAt: string | null;
}
export interface ChannelRow {
  id: string; workspaceId: string; kind: ChannelKind; name: string | null; topic: string; purpose: string;
  sealedKey: string; createdBy: string; createdAt: string; archivedAt: string | null; dmKey: string | null;
  isDefault: number; lastMessageAt: string | null;
}
export interface ChannelMemberRow { channelId: string; sub: string; lastReadAt: string; muted: number; starred: number; joinedAt: string }
export interface TeamMessageRow {
  id: string; channelId: string; sender: string; ciphertext: string; parentId: string | null; createdAt: string;
  editedAt: string | null; deletedAt: string | null; replyCount: number; lastReplyAt: string | null;
  alsoInChannel: number; kind: "user" | "system";
  /** Set when an app (webhook or workflow) posted the message on the creator's behalf. */
  appId?: string | null; appName?: string | null;
}
export interface ReactionRow { messageId: string; sub: string; emoji: string; createdAt: string }
export interface PinRow { channelId: string; messageId: string; pinnedBy: string; pinnedAt: string }
export interface SavedRow { sub: string; messageId: string; savedAt: string; remindAt: string | null; done: number }
export interface BookmarkRow { id: string; channelId: string; title: string; url: string; createdBy: string; createdAt: string }
export interface ScheduledRow { id: string; channelId: string; sender: string; ciphertext: string; parentId: string | null; sendAt: string; createdAt: string }
export interface ReminderRow { id: string; workspaceId: string; sub: string; sealedText: string; remindAt: string; done: number; firedAt: string | null; messageId: string | null; createdAt: string }
export interface GroupRow { id: string; workspaceId: string; handle: string; name: string; createdBy: string; createdAt: string }
export interface FileRow { id: string; channelId: string; messageId: string | null; uploader: string; name: string; mime: string; size: number; ciphertext: string; createdAt: string }
export interface CanvasRow { channelId: string; ciphertext: string; updatedBy: string; updatedAt: string }
export interface PollRow { messageId: string; channelId: string; ciphertext: string; anonymous: number; multiple: number; closedAt: string | null; createdAt: string }
export interface WebhookRow { id: string; workspaceId: string; channelId: string; name: string; tokenHash: string; createdBy: string; createdAt: string; lastUsedAt: string | null }
export type WorkflowKind = "welcome" | "recurring";
export type WorkflowEvery = "day" | "weekday" | "week";
export interface WorkflowRow {
  id: string; workspaceId: string; channelId: string; kind: WorkflowKind; name: string; ciphertext: string;
  every: WorkflowEvery | null; atMinute: number | null; weekday: number | null; tzOffset: number; nextRunAt: string | null;
  paused: number; createdBy: string; createdAt: string; lastRunAt: string | null;
}
export interface MentionRow { messageId: string; sub: string; channelId: string; createdAt: string }

type Row = Record<string, unknown>;

export class TeamStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  /** Run `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  one<T>(sql: string, ...params: SQLInputValue[]): T | null {
    const row = this.db.prepare(sql).get(...params);
    return row ? camel(row as Row) as T : null;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params).map((row) => camel(row as Row) as T);
  }

  count(sql: string, ...params: SQLInputValue[]): number {
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    const value = row ? Object.values(row)[0] : 0;
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
  }

  /** Insert a row given camelCase fields. */
  insert(table: string, row: object): void {
    const entries = Object.entries(row).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => snake(k));
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    this.db.prepare(sql).run(...entries.map(([, v]) => v as SQLInputValue));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        invite_code TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_members (
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        role TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
        display_name TEXT,
        title TEXT,
        status_emoji TEXT,
        status_text TEXT,
        status_until TEXT,
        dnd_until TEXT,
        away INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        deactivated_at TEXT,
        PRIMARY KEY (workspace_id, sub)
      );
      CREATE TABLE IF NOT EXISTS team_channels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        kind TEXT NOT NULL CHECK (kind IN ('public','private','dm','group')),
        name TEXT,
        topic TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        sealed_key TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL,
        archived_at TEXT,
        dm_key TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        UNIQUE (workspace_id, name),
        UNIQUE (workspace_id, dm_key)
      );
      CREATE TABLE IF NOT EXISTS team_channel_members (
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        last_read_at TEXT NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, sub)
      );
      CREATE INDEX IF NOT EXISTS team_channel_members_sub ON team_channel_members(sub);
      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        sender TEXT NOT NULL REFERENCES users(sub),
        ciphertext TEXT NOT NULL,
        parent_id TEXT REFERENCES team_messages(id),
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        reply_count INTEGER NOT NULL DEFAULT 0,
        last_reply_at TEXT,
        also_in_channel INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system'))
      );
      CREATE INDEX IF NOT EXISTS team_messages_channel ON team_messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS team_messages_parent ON team_messages(parent_id, created_at);
      CREATE TABLE IF NOT EXISTS team_mentions (
        message_id TEXT NOT NULL REFERENCES team_messages(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, sub)
      );
      CREATE INDEX IF NOT EXISTS team_mentions_sub ON team_mentions(sub, created_at);
      CREATE TABLE IF NOT EXISTS team_reactions (
        message_id TEXT NOT NULL REFERENCES team_messages(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, sub, emoji)
      );
      CREATE TABLE IF NOT EXISTS team_pins (
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        message_id TEXT NOT NULL REFERENCES team_messages(id),
        pinned_by TEXT NOT NULL REFERENCES users(sub),
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS team_saved (
        sub TEXT NOT NULL REFERENCES users(sub),
        message_id TEXT NOT NULL REFERENCES team_messages(id),
        saved_at TEXT NOT NULL,
        remind_at TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (sub, message_id)
      );
      CREATE TABLE IF NOT EXISTS team_bookmarks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_scheduled (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        sender TEXT NOT NULL REFERENCES users(sub),
        ciphertext TEXT NOT NULL,
        parent_id TEXT,
        send_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_scheduled_due ON team_scheduled(send_at);
      CREATE TABLE IF NOT EXISTS team_reminders (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        sealed_text TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        fired_at TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_reminders_due ON team_reminders(fired_at, remind_at);
      CREATE TABLE IF NOT EXISTS team_groups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        handle TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, handle)
      );
      CREATE TABLE IF NOT EXISTS team_group_members (
        group_id TEXT NOT NULL REFERENCES team_groups(id),
        sub TEXT NOT NULL REFERENCES users(sub),
        PRIMARY KEY (group_id, sub)
      );
      CREATE TABLE IF NOT EXISTS team_files (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        message_id TEXT,
        uploader TEXT NOT NULL REFERENCES users(sub),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_files_message ON team_files(message_id);
      CREATE TABLE IF NOT EXISTS team_canvases (
        channel_id TEXT PRIMARY KEY REFERENCES team_channels(id),
        ciphertext TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(sub),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_polls (
        message_id TEXT PRIMARY KEY REFERENCES team_messages(id),
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        ciphertext TEXT NOT NULL,
        anonymous INTEGER NOT NULL DEFAULT 0,
        multiple INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_poll_votes (
        message_id TEXT NOT NULL REFERENCES team_polls(message_id),
        sub TEXT NOT NULL REFERENCES users(sub),
        choice INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, sub, choice)
      );
      CREATE TABLE IF NOT EXISTS team_webhooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS team_workflows (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
        channel_id TEXT NOT NULL REFERENCES team_channels(id),
        kind TEXT NOT NULL CHECK (kind IN ('welcome','recurring')),
        name TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        every TEXT CHECK (every IN ('day','weekday','week')),
        at_minute INTEGER,
        weekday INTEGER,
        tz_offset INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(sub),
        created_at TEXT NOT NULL,
        last_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS team_workflows_due ON team_workflows(kind, paused, next_run_at);
    `);
    // Columns added after the first release.
    const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(team_messages)").map((c) => c.name));
    if (!columns.has("app_id")) this.db.exec("ALTER TABLE team_messages ADD COLUMN app_id TEXT");
    if (!columns.has("app_name")) this.db.exec("ALTER TABLE team_messages ADD COLUMN app_name TEXT");
  }
}

function camel(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = typeof value === "bigint" ? Number(value) : value;
  return out;
}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
