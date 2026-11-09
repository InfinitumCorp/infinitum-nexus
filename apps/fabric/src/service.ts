/**
 * Messaging operations. Plaintext exists only in this process, for an authenticated participant.
 * The database stores session keys sealed by the server master key and message bodies sealed by the session key.
 */
import { randomUUID } from "node:crypto";
import { open, randomKey, seal } from "@infinitum/fabric";
import type { FabricIdentity } from "./auth.ts";
import { FabricStore, type ConversationRow, type MessageRow, type UserRow } from "./store.ts";

const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const TEXT_LIMIT = 4000;

export class FabricServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FabricServiceError";
    this.status = status;
  }
}

export interface SessionView {
  id: string;
  peer: { sub: string; username: string; name: string | null };
  createdAt: string;
  updatedAt: string;
  preview: string | null;
}

export interface MessageView {
  id: string;
  sessionId: string;
  sender: string;
  username: string;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export class FabricService {
  private readonly store: FabricStore;
  private readonly masterKey: Buffer;

  constructor(store: FabricStore, masterKey: Buffer) {
    this.store = store;
    this.masterKey = masterKey;
  }

  openSession(owner: FabricIdentity, peerUsername: string): SessionView {
    const username = peerUsername.trim().toLowerCase();
    if (!USERNAME.test(username)) throw new FabricServiceError(400, "username is invalid");
    const peer = this.store.findUserByUsername(owner.issuer, username);
    if (!peer) throw new FabricServiceError(404, "no such account");
    if (peer.sub === owner.sub) throw new FabricServiceError(400, "choose someone else");
    const existing = this.store.findConversationBetween(owner.sub, peer.sub);
    if (existing) return this.present(owner, existing);
    const now = new Date().toISOString();
    const id = randomUUID();
    const sessionKey = randomKey();
    const row: ConversationRow = {
      id,
      participantA: owner.sub < peer.sub ? owner.sub : peer.sub,
      participantB: owner.sub < peer.sub ? peer.sub : owner.sub,
      sealedKey: seal(sessionKey.toString("base64"), this.masterKey, keyAad(id)),
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.insertConversation(row);
    } catch (error) {
      const again = this.store.findConversationBetween(owner.sub, peer.sub);
      if (again) return this.present(owner, again);
      throw error;
    }
    return this.present(owner, row);
  }

  listSessions(owner: FabricIdentity): SessionView[] {
    return this.store.listConversations(owner.sub).map((row) => this.present(owner, row));
  }

  getSession(owner: FabricIdentity, sessionId: string): SessionView {
    return this.present(owner, this.owned(owner, sessionId));
  }

  send(owner: FabricIdentity, sessionId: string, text: string): MessageView {
    if (typeof text !== "string" || text.trim() === "") throw new FabricServiceError(400, "text is required");
    if (text.length > TEXT_LIMIT) throw new FabricServiceError(400, "text is too long");
    const conversation = this.owned(owner, sessionId);
    const now = new Date().toISOString();
    const row: MessageRow = {
      id: randomUUID(),
      conversationId: conversation.id,
      sender: owner.sub,
      ciphertext: seal(text, this.sessionKey(conversation), messageAad(conversation.id, owner.sub)),
      createdAt: now,
    };
    this.store.insertMessage(row);
    this.store.touchConversation(conversation.id, now);
    return this.presentMessage(row, owner.username, text);
  }

  receive(owner: FabricIdentity, sessionId: string): MessageView[] {
    const conversation = this.owned(owner, sessionId);
    const key = this.sessionKey(conversation);
    return this.store.listMessages(conversation.id, 200).map((row) => {
      const sender = this.store.findUserBySub(row.sender);
      try {
        const text = open(row.ciphertext, key, messageAad(conversation.id, row.sender));
        return this.presentMessage({ ...row, ciphertext: "" }, sender?.username ?? "unknown", text);
      } catch {
        return { id: row.id, sessionId: row.conversationId, sender: row.sender, username: sender?.username ?? "unknown", text: "", createdAt: row.createdAt, unreadable: true };
      }
    });
  }

  private owned(owner: FabricIdentity, sessionId: string): ConversationRow {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new FabricServiceError(404, "not found");
    const row = this.store.getConversation(sessionId);
    if (!row || (row.participantA !== owner.sub && row.participantB !== owner.sub)) throw new FabricServiceError(404, "not found");
    return row;
  }

  private sessionKey(row: ConversationRow): Buffer {
    return Buffer.from(open(row.sealedKey, this.masterKey, keyAad(row.id)), "base64");
  }

  private present(owner: FabricIdentity, row: ConversationRow): SessionView {
    const peerSub = row.participantA === owner.sub ? row.participantB : row.participantA;
    const peer = this.store.findUserBySub(peerSub);
    const latest = this.store.latestMessage(row.id);
    return {
      id: row.id,
      peer: { sub: peerSub, username: peer?.username ?? "unknown", name: peer?.name ?? null },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: latest ? preview(latest, this.sessionKey(row)) : null,
    };
  }

  private presentMessage(row: MessageRow, username: string, text: string): MessageView {
    return {
      id: row.id,
      sessionId: row.conversationId,
      sender: row.sender,
      username,
      text,
      createdAt: row.createdAt,
      unreadable: false,
    };
  }
}

function preview(row: MessageRow, key: Buffer): string | null {
  try {
    const text = open(row.ciphertext, key, messageAad(row.conversationId, row.sender));
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    return null;
  }
}

function keyAad(sessionId: string): string {
  return `fabric-session-key:${sessionId}`;
}

function messageAad(sessionId: string, sender: string): string {
  return `fabric-message:${sessionId}:${sender}`;
}

export function touchUser(store: FabricStore, identity: FabricIdentity, now = new Date()): UserRow {
  const existing = store.findUserBySub(identity.sub);
  const row: UserRow = {
    sub: identity.sub,
    issuer: identity.issuer,
    username: identity.username,
    email: identity.email,
    name: identity.name,
    createdAt: existing?.createdAt ?? now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  store.upsertUser(row);
  return row;
}
