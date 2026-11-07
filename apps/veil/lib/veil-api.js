/**
 * CID-host calls for the default VEIL exit proxy and optional bridge lines.
 * Local Tor mode does not use this module.
 */
import { safeOrigin } from "./nexus.js";
import { normalizeServer } from "./proxy.js";

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

function request(origin, path, method, body, fetcher) {
  return fetcher(controlUrl(origin, path), {
    method,
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      accept: "application/json",
      "x-veil": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function parseServerList(value) {
  if (!Array.isArray(value)) throw new VeilApiError("VEIL control sent no server list", 0);
  return value.map((server) => normalizeServer(server));
}

export function parseSession(body) {
  if (!body || typeof body !== "object" || typeof body.cid !== "string" || !body.cid) {
    throw new VeilApiError("VEIL control sent an account without a CID", 0);
  }
  if (body.browserOnly !== true || body.deviceWide !== false || body.defaultMode !== "veil") {
    throw new VeilApiError("VEIL control did not confirm the browser proxy", 0);
  }
  const entitled = body.entitled === true;
  return {
    cid: body.cid.slice(0, 120),
    username: typeof body.username === "string" ? body.username.slice(0, 80) : null,
    entitled,
    servers: entitled ? parseServerList(body.servers) : [],
    browserOnly: true,
    deviceWide: false,
    defaultMode: "veil",
  };
}

export function parseConnectGrant(body, now) {
  if (!body || body.coverage !== "browser" || body.deviceWide !== false || body.dns !== "through-proxy" || body.defaultMode !== "veil") {
    throw new VeilApiError("VEIL control did not confirm browser-only coverage", 0);
  }
  const server = normalizeServer(body.server);
  const auth = body.auth;
  if (!auth || typeof auth.username !== "string" || typeof auth.password !== "string") {
    throw new VeilApiError("VEIL control did not issue proxy credentials", 0);
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(auth.username)) throw new VeilApiError("Refused proxy username", 0);
  if (auth.password.length < 16 || auth.password.length > 256) throw new VeilApiError("Refused proxy password", 0);
  if (/[\r\n]/.test(auth.password) || /[\r\n]/.test(auth.username)) throw new VeilApiError("Refused proxy credentials", 0);
  const expiresAt = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new VeilApiError("Proxy credentials are already expired", 0);
  return {
    server,
    auth: { username: auth.username, password: auth.password, expiresAt: new Date(expiresAt).toISOString() },
    coverage: "browser",
    deviceWide: false,
    dns: "through-proxy",
    defaultMode: "veil",
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
  return parseSession(await readVeil(await request(origin, "/api/veil/session", "GET", undefined, fetcher)));
}

export async function postConnect(origin, serverId, fetcher = fetch, now = Date.now()) {
  if (typeof serverId !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(serverId)) {
    throw new VeilApiError("Select a VEIL server", 0);
  }
  const body = await readVeil(await request(origin, "/api/veil/connect", "POST", { serverId }, fetcher));
  return parseConnectGrant(body, now);
}

export async function postDisconnect(origin, fetcher = fetch) {
  await readVeil(await request(origin, "/api/veil/disconnect", "POST", {}, fetcher));
  return { ok: true };
}

export async function fetchBridges(origin, fetcher = fetch) {
  return parseBridges(await readVeil(await request(origin, "/api/veil/bridges", "GET", undefined, fetcher)));
}
