/**
 * Local persistence for FABRIC++.
 * Sessions and message bodies are stored as AES-256-GCM payloads, never as plaintext.
 */
import { DatabaseSync } from "node:sqlite";

export interface UserRow {
  sub: string;
  issuer: string;
  username: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface ConversationRow {
  id: string;
  participantA: string;
  participantB: string;
  sealedKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  sender: string;
  ciphertext: string;
  createdAt: string;
}

export interface LoginRow {
  tokenHash: string;
  sub: string;
  expiresAt: string;
}

export class FabricStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  ping(): void {
    this.db.prepare("SELECT 1 AS ok").get();
  }

  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  upsertUser(user: UserRow): void {
    this.db.prepare(
      `INSERT INTO users (sub, issuer, username, email, name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         username = excluded.username,
         email = excluded.email,
         name = excluded.name,
         last_seen_at = excluded.last_seen_at`,
    ).run(user.sub, user.issuer, user.username, user.email, user.name, user.createdAt, user.lastSeenAt);
  }

  findUserBySub(sub: string): UserRow | null {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE sub = ?").get(sub));
  }

  findUserByUsername(issuer: string, username: string): UserRow | null {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE issuer = ? AND username = ?").get(issuer, username));
  }

  insertConversation(row: ConversationRow): void {
    this.db.prepare(
      `INSERT INTO conversations (id, participant_a, participant_b, sealed_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.participantA, row.participantB, row.sealedKey, row.createdAt, row.updatedAt);
  }

  findConversationBetween(a: string, b: string): ConversationRow | null {
    const [left, right] = a < b ? [a, b] : [b, a];
    return mapConversation(this.db.prepare(
      "SELECT * FROM conversations WHERE participant_a = ? AND participant_b = ?",
    ).get(left, right));
  }

  getConversation(id: string): ConversationRow | null {
    return mapConversation(this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
  }

  listConversations(sub: string): ConversationRow[] {
    return this.db.prepare(
      `SELECT * FROM conversations
       WHERE participant_a = ? OR participant_b = ?
       ORDER BY updated_at DESC`,
    ).all(sub, sub).map((row) => mapConversation(row)!);
  }

  touchConversation(id: string, updatedAt: string): void {
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  insertMessage(row: MessageRow): void {
    this.db.prepare(
      `INSERT INTO messages (id, conversation_id, sender, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.id, row.conversationId, row.sender, row.ciphertext, row.createdAt);
  }

  /** Test helper: replace a stored payload so integrity failure can be asserted. */
  replaceCiphertext(id: string, ciphertext: string): void {
    this.db.prepare("UPDATE messages SET ciphertext = ? WHERE id = ?").run(ciphertext, id);
  }

  listMessages(conversationId: string, limit: number): MessageRow[] {
    return this.db.prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(conversationId, limit).map((row) => mapMessage(row)!);
  }

  latestMessage(conversationId: string): MessageRow | null {
    return mapMessage(this.db.prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(conversationId));
  }

  saveOauthState(state: string, verifier: string, nonce: string, expiresAt: string, now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
      this.db.prepare(
        "INSERT INTO oauth_states (state, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)",
      ).run(state, verifier, nonce, expiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  takeOauthState(state: string, now: string): { verifier: string; nonce: string } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT verifier, nonce, expires_at FROM oauth_states WHERE state = ?").get(state);
      this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      this.db.exec("COMMIT");
      if (!row || typeof row.expires_at !== "string" || row.expires_at <= now) return null;
      if (typeof row.verifier !== "string" || typeof row.nonce !== "string") return null;
      return { verifier: row.verifier, nonce: row.nonce };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createLogin(row: LoginRow): void {
    this.db.prepare(
      "INSERT INTO login_sessions (token_hash, sub, expires_at) VALUES (?, ?, ?)",
    ).run(row.tokenHash, row.sub, row.expiresAt);
  }

  getLogin(tokenHash: string): LoginRow | null {
    const row = this.db.prepare("SELECT * FROM login_sessions WHERE token_hash = ?").get(tokenHash);
    if (!row) return null;
    return { tokenHash: text(row, "token_hash"), sub: text(row, "sub"), expiresAt: text(row, "expires_at") };
  }

  deleteLogin(tokenHash: string): void {
    this.db.prepare("DELETE FROM login_sessions WHERE token_hash = ?").run(tokenHash);
  }

  counts(): { users: number; sessions: number; messages: number } {
    return {
      users: scalar(this.db, "SELECT COUNT(*) AS n FROM users"),
      sessions: scalar(this.db, "SELECT COUNT(*) AS n FROM conversations"),
      messages: scalar(this.db, "SELECT COUNT(*) AS n FROM messages"),
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        username TEXT NOT NULL,
        email TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (issuer, username)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL REFERENCES users(sub),
        participant_b TEXT NOT NULL REFERENCES users(sub),
        sealed_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (participant_a < participant_b),
        UNIQUE (participant_a, participant_b)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        sender TEXT NOT NULL REFERENCES users(sub),
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS login_sessions (
        token_hash TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES users(sub),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }
}

function mapUser(row: unknown): UserRow | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  return {
    sub: text(record, "sub"),
    issuer: text(record, "issuer"),
    username: text(record, "username"),
    email: nullable(record, "email"),
    name: nullable(record, "name"),
    createdAt: text(record, "created_at"),
    lastSeenAt: text(record, "last_seen_at"),
  };
}

function mapConversation(row: unknown): ConversationRow | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  return {
    id: text(record, "id"),
    participantA: text(record, "participant_a"),
    participantB: text(record, "participant_b"),
    sealedKey: text(record, "sealed_key"),
    createdAt: text(record, "created_at"),
    updatedAt: text(record, "updated_at"),
  };
}

function mapMessage(row: unknown): MessageRow | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  return {
    id: text(record, "id"),
    conversationId: text(record, "conversation_id"),
    sender: text(record, "sender"),
    ciphertext: text(record, "ciphertext"),
    createdAt: text(record, "created_at"),
  };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`FABRIC row is missing ${key}`);
  return value;
}

function nullable(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`FABRIC row is missing ${key}`);
  return value;
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get();
  const value = row && typeof row === "object" ? (row as Record<string, unknown>).n : 0;
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}
