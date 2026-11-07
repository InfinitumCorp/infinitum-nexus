import { VeilError, serverId } from "./model.ts";
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

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) {
    throw new VeilError("too_large", "Request is too large", 413);
  }
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" || request.headers.has("content-encoding")) {
    throw new VeilError("unsupported_media", "JSON body required", 415);
  }
  const text = await request.text();
  if (text.length > 4096) throw new VeilError("too_large", "Request is too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VeilError("invalid_json", "JSON body required", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VeilError("invalid_json", "JSON object required", 400);
  }
  return parsed as Record<string, unknown>;
}

function exact(body: Record<string, unknown>, keys: string[]) {
  const present = Object.keys(body).sort();
  const wanted = [...keys].sort();
  if (present.length !== wanted.length || present.some((key, index) => key !== wanted[index])) {
    throw new VeilError("invalid_json", "Unexpected fields", 400);
  }
}

/**
 * VEIL control HTTP. Cookie name `spctr_session` is the Cumulus ID host session
 * the extension already uses. A bearer is accepted for the same token.
 * A malformed Authorization header does not fall back to the cookie.
 */
export function veilHttp(control: VeilControl) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.search) return json(404, { error: "not_found" });
      const path = url.pathname;
      if (path !== "/api/veil/session" && path !== "/api/veil/servers" && path !== "/api/veil/connect" && path !== "/api/veil/disconnect") {
        return json(404, { error: "not_found" });
      }
      if (request.headers.get("x-veil") !== "1") return json(403, { error: "missing_header" });
      const token = tokenFrom(request);
      if (!token) return json(401, { error: "sign_in_required" });
      if (path === "/api/veil/session" || path === "/api/veil/servers") {
        if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" }, { allow: "GET" });
        const session = control.session(token);
        if (path === "/api/veil/servers") {
          if (!session.entitled) return json(403, { error: "veil_plan_required", entitled: false, deviceWide: false });
          return json(200, { servers: session.servers, browserOnly: true, deviceWide: false, dns: "through-proxy" });
        }
        return json(200, session);
      }
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
      const body = await readBody(request);
      if (path === "/api/veil/disconnect") {
        exact(body, []);
        return json(200, control.disconnect(token));
      }
      exact(body, ["serverId"]);
      return json(200, control.connect(token, serverId(body.serverId)));
    } catch (err) {
      if (err instanceof VeilError) return json(err.status, { error: err.code, deviceWide: false });
      return json(500, { error: "unavailable" });
    }
  };
}
