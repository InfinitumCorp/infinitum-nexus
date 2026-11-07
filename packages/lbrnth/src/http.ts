import { CidLabyrinth } from "./auth.ts";
import type { Scope } from "./model.ts";
import { LabyrinthError } from "./model.ts";
const invalid = (): never => { throw new LabyrinthError("invalid", "Invalid Labyrinth command"); };
const text = (v: unknown): string => typeof v === "string" && v.length > 0 && v.length <= 4000 ? v : invalid();
const head = (v: unknown): string | null => v === null ? null : text(v);
export function labyrinthToken(header: string | null): string | undefined {
  return header?.match(/^Bearer ([^\s]{1,512})$/)?.[1];
}
/** No cid/org/role claims accepted. Server derives all authority from the live CID session. */
export function labyrinthCommand(auth: CidLabyrinth, token: string, value: unknown): unknown {
  auth.forSession(token); // authenticate before interpreting the request body
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  if (["cid", "org", "orgId", "role", "entitled"].some(k => Object.hasOwn(p, k))) return invalid();
  const client = auth.forProduct(token, text(p.product));
  switch (p.action) {
    case "provision": return auth.provision(token);
    case "token": return auth.issueToken(token);
    case "consent": return auth.consent(token, p.scopes as Scope[]);
    case "list": return client.repositories();
    case "create": return client.createRepository(text(p.name));
    case "save": {
      if (typeof p.content !== "string") return invalid();
      return client.save(text(p.repo), text(p.path), p.content, head(p.expectedHead), p.message === undefined ? undefined : text(p.message), p.branch === undefined ? undefined : text(p.branch));
    }
    case "load": return { content: new TextDecoder("utf-8", { fatal: true }).decode(client.load(text(p.repo), text(p.commit), text(p.path))) };
    case "history": return client.history(text(p.repo), p.branch === undefined ? undefined : text(p.branch), p.limit === undefined ? undefined : typeof p.limit === "number" ? p.limit : invalid());
    case "diff": return client.diff(text(p.repo), head(p.from), text(p.to));
    default: return invalid();
  }
}
export const LABYRINTH_HTTP_LIMIT = 2 * 1024 * 1024;
export function labyrinthErrorStatus(error: unknown): number {
  return error instanceof LabyrinthError ? ({ forbidden: 403, not_found: 404, invalid: 400, conflict: 409, integrity: 500, capacity: 429 })[error.code] : error instanceof SyntaxError ? 400 : 500;
}
