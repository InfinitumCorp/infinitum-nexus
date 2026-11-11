import { labyrinthProduct } from "@infinitum/lbrnth-client";
import { CidLabyrinth } from "./auth.ts";
import type { CommitInput, Role, Scope } from "./model.ts";
import { LabyrinthError } from "./model.ts";
const invalid = (): never => { throw new LabyrinthError("invalid", "Invalid Labyrinth command"); };
const text = (v: unknown): string => typeof v === "string" && v.length > 0 && v.length <= 4000 ? v : invalid();
const content = (value: unknown, encoding: unknown): string | Uint8Array => {
  if (typeof value !== "string") return invalid();
  if (encoding === undefined || encoding === "utf-8") return value;
  if (encoding !== "base64") return invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return invalid();
  return bytes;
};
const head = (v: unknown): string | null => v === null ? null : text(v);
export function labyrinthToken(header: string | null): string | undefined {
  return header?.match(/^Bearer ([^\s]{1,512})$/)?.[1];
}
/** No cid/org/role claims accepted. Server derives all authority from the live CID session. */
export function labyrinthCommand(auth: CidLabyrinth, token: string, value: unknown): unknown {
  auth.session(token); // authenticate before interpreting the request body
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  if (["cid", "org", "orgId", "role", "entitled"].some(k => Object.hasOwn(p, k))) return invalid();
  try { labyrinthProduct(text(p.product)); } catch { return invalid(); }
  if (p.action === "session") return auth.session(token);
  if (p.action === "organization") return auth.createOrganization(token, text(p.name));
  const client = auth.forProduct(token, text(p.product));
  const session = auth.forSession(token);
  switch (p.action) {
    case "branch": return session.createBranch(text(p.repo), text(p.name), head(p.from));
    case "tag": return session.createTag(text(p.repo), text(p.name), text(p.commit));
    case "members": return session.members();
    case "set-member": {
      if (p.memberRole !== null && !["reader", "writer", "admin", "owner"].includes(p.memberRole as string)) return invalid();
      return session.setMember(text(p.member), p.memberRole as Role | null);
    }
    case "audit": return session.audit(p.after === undefined ? undefined : typeof p.after === "number" ? p.after : invalid(), p.limit === undefined ? undefined : typeof p.limit === "number" ? p.limit : invalid());
    case "remove": return client.remove(text(p.repo), text(p.path), text(p.expectedHead), p.message === undefined ? undefined : text(p.message), p.branch === undefined ? undefined : text(p.branch));
    case "provision": return auth.provision(token);
    case "token": return auth.issueToken(token);
    case "consent": return auth.consent(token, p.scopes as Scope[]);
    case "list": return client.repositories();
    case "create": return client.createRepository(text(p.name));
    case "save": {
      return client.save(text(p.repo), text(p.path), content(p.content, p.encoding), head(p.expectedHead), p.message === undefined ? undefined : text(p.message), p.branch === undefined ? undefined : text(p.branch));
    }
    case "load": {
      if (p.encoding !== undefined && p.encoding !== "utf-8" && p.encoding !== "base64") return invalid();
      const bytes = client.load(text(p.repo), text(p.commit), text(p.path));
      if (p.encoding === "base64") return { content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
      try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
      catch { throw new LabyrinthError("invalid", "Binary artifacts require base64 encoding"); }
    }
    case "commit": {
      if (!p.changes || typeof p.changes !== "object" || Array.isArray(p.changes)) return invalid();
      const changes: CommitInput["changes"] = Object.create(null);
      const entries = Object.entries(p.changes);
      if (!entries.length || entries.length > 1000) return invalid();
      for (const [path, value] of entries) {
        if (value === null) changes[path] = null;
        else if (typeof value === "string") changes[path] = value;
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          const artifact = value as Record<string, unknown>;
          changes[path] = content(artifact.content, artifact.encoding);
        } else return invalid();
      }
      return client.commit(text(p.repo), { branch: p.branch === undefined ? "main" : text(p.branch), expectedHead: head(p.expectedHead), message: text(p.message), changes });
    }
    case "history": return client.history(text(p.repo), p.branch === undefined ? undefined : text(p.branch), p.limit === undefined ? undefined : typeof p.limit === "number" ? p.limit : invalid(), p.before === undefined ? undefined : text(p.before));
    case "diff": return client.diff(text(p.repo), head(p.from), text(p.to));
    default: return invalid();
  }
}
export const LABYRINTH_HTTP_LIMIT = 2 * 1024 * 1024;
export function labyrinthErrorStatus(error: unknown): number {
  return error instanceof LabyrinthError ? ({ forbidden: 403, not_found: 404, invalid: 400, conflict: 409, integrity: 500, capacity: 429 })[error.code] : error instanceof SyntaxError ? 400 : 500;
}
