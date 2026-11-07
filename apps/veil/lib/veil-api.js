/**
 * Calls the VEIL control plane with the Cumulus ID session cookie the
 * extension already established against the CID host (`credentials: include`
 * to `/api/me`). The control response is not trusted until it matches the
 * browser-only contract.
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
    const plan = body?.error === "veil_plan_required";
    throw new VeilApiError(plan ? "This Cumulus ID has no VEIL entitlement" : "VEIL control refused the request", 403);
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

export function parseSession(body) {
  if (!body || typeof body !== "object" || typeof body.cid !== "string" || !body.cid) {
    throw new VeilApiError("VEIL control sent an account without a CID", 0);
  }
  if (body.browserOnly !== true || body.deviceWide !== false) {
    throw new VeilApiError("VEIL control did not confirm browser-only coverage", 0);
  }
  const entitled = body.entitled === true;
  const servers = entitled ? parseServerList(body.servers) : [];
  return {
    cid: body.cid.slice(0, 120),
    username: typeof body.username === "string" ? body.username.slice(0, 80) : null,
    entitled,
    servers,
    browserOnly: true,
    deviceWide: false,
  };
}

export function parseServerList(value) {
  if (!Array.isArray(value)) throw new VeilApiError("VEIL control sent no server list", 0);
  return value.map((server) => normalizeServer(server));
}

export function parseConnectGrant(body, now) {
  if (!body || body.coverage !== "browser" || body.deviceWide !== false || body.dns !== "through-proxy") {
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
  };
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
