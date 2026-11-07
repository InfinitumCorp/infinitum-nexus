import { VeilError } from "./model.ts";
import type { VeilControl } from "./control.ts";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const COOKIE = "spctr_session";

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

function tokenFrom(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]{1,512})$/.exec(authorization);
    return match?.[1] ?? null;
  }
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * CID-host routes for the optional bridge list.
 * Cookie name `spctr_session` is the existing Cumulus ID session.
 * A malformed Authorization header does not fall back to the cookie.
 */
export function veilHttp(control: VeilControl) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.search) return json(404, { error: "not_found" });
      if (url.pathname !== "/api/veil/session" && url.pathname !== "/api/veil/bridges") {
        return json(404, { error: "not_found" });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(405, { error: "method_not_allowed" }, { allow: "GET" });
      }
      if (request.headers.get("x-veil") !== "1") return json(403, { error: "missing_header" });
      const token = tokenFrom(request);
      if (!token) return json(401, { error: "sign_in_required" });
      if (url.pathname === "/api/veil/bridges") return json(200, control.bridges(token));
      return json(200, control.session(token));
    } catch (err) {
      if (err instanceof VeilError) return json(err.status, { error: err.code, deviceWide: false });
      return json(500, { error: "unavailable" });
    }
  };
}
