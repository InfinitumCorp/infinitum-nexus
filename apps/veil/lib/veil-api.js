/**
 * Optional Cumulus ID calls. Tor routing does not use these.
 * The session cookie is the same one the sidebar already sends to /api/me.
 */
import { safeOrigin } from "./nexus.js";

export class VeilApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function controlUrl(origin, path) {
  const safe = safeOrigin(origin);
  if (!safe) throw new VeilApiError("Invalid VEIL control origin", 0);
  const url = new URL(safe);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new VeilApiError("VEIL control over http is only allowed on localhost", 0);
  }
  if (typeof path !== "string" || !path.startsWith("/api/veil/")) throw new VeilApiError("Invalid VEIL path", 0);
  return `${url.origin}${path}`;
}

async function readVeil(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 401) throw new VeilApiError("Cumulus ID sign-in required", 401);
  if (response.status === 403) {
    throw new VeilApiError(
      body?.error === "veil_plan_required" ? "This Cumulus ID has no VEIL entitlement" : "VEIL control refused the request",
      403,
    );
  }
  if (!response.ok) throw new VeilApiError(`VEIL control answered ${response.status}`, response.status || 0);
  return body;
}

function request(origin, path, fetcher) {
  return fetcher(controlUrl(origin, path), {
    method: "GET",
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "x-veil": "1" },
  });
}

export function parseSession(body) {
  if (!body || typeof body !== "object" || typeof body.cid !== "string" || !body.cid) {
    throw new VeilApiError("VEIL control sent an account without a CID", 0);
  }
  if (body.browserOnly !== true || body.deviceWide !== false || body.routing !== "local-tor") {
    throw new VeilApiError("VEIL control did not confirm local Tor routing", 0);
  }
  return {
    cid: body.cid.slice(0, 120),
    username: typeof body.username === "string" ? body.username.slice(0, 80) : null,
    entitled: body.entitled === true,
    browserOnly: true,
    deviceWide: false,
    routing: "local-tor",
  };
}

export function parseBridges(body) {
  if (!body || body.routing !== "local-tor" || body.optional !== true || !Array.isArray(body.bridges)) {
    throw new VeilApiError("VEIL control sent an unusable bridge list", 0);
  }
  return body.bridges.map((line) => {
    if (typeof line !== "string" || !line || line.length > 400 || /[\r\n]/.test(line)) {
      throw new VeilApiError("VEIL control sent a bridge line that was refused", 0);
    }
    return line;
  });
}

export async function fetchSession(origin, fetcher = fetch) {
  return parseSession(await readVeil(await request(origin, "/api/veil/session", fetcher)));
}

export async function fetchBridges(origin, fetcher = fetch) {
  return parseBridges(await readVeil(await request(origin, "/api/veil/bridges", fetcher)));
}
