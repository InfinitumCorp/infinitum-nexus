import { createHash } from "node:crypto";
import type { AuditEntry, Commit } from "./model.ts";
import { LabyrinthError } from "./model.ts";
export const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function commitHash(c: Omit<Commit, "id">): string {
  return hashBytes(JSON.stringify([c.parent, Object.entries(c.tree).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), c.author, c.message, c.at]));
}
export function auditHash(e: Omit<AuditEntry, "hash">): string {
  return hashBytes(JSON.stringify([e.sequence, e.actor, e.action, e.repoId ?? null, e.at, e.previous]));
}
export function verifyAudit(entries: AuditEntry[]): boolean {
  return entries.every((e, i) => e.sequence === i + 1 && e.previous === (entries[i - 1]?.hash ?? null) && e.hash === auditHash(e));
}
export function validName(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value) || value.split("/").some(p => !p || p === "." || p === ".." || ["__proto__", "constructor", "prototype"].includes(p))) {
    throw new LabyrinthError("invalid", "Invalid name or path");
  }
}
export function validPath(path: string): void { validName(path); }
