import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CidService } from "@infinitum/cid";
import { createDeviceBroker } from "./device.ts";
import { parseBridges, parseCatalog, serverId, veilFail, type VeilServer } from "./model.ts";
import type { DeviceExitConfig, DeviceGrant } from "./wireguard.ts";

const CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const USER = /^[A-Za-z0-9_-]{16,128}$/;

export interface VeilControlOptions {
  cid: CidService;
  /** Explicit VEIL plan. Anything other than `true` is a denial, including throws. */
  entitled?: (cid: string) => boolean;
  servers?: readonly unknown[];
  bridges?: readonly unknown[];
  /** Operator WireGuard exit. Unset means device grants fail closed. */
  deviceExit?: DeviceExitConfig;
  clock?: () => Date;
  credentialTtlMs?: number;
}

interface Credential {
  username: string;
  passwordHash: Buffer;
  cid: string;
  sessionId: string;
  serverId: string;
  expiresAt: number;
}

export interface ProxyGrant {
  coverage: "browser";
  deviceWide: false;
  dns: "through-proxy";
  defaultMode: "veil";
  server: VeilServer;
  auth: { username: string; password: string; expiresAt: string };
}

/**
 * CID session is necessary and not sufficient for the VEIL exit proxy.
 * Tor routing does not call this service.
 */
export function createVeilControl(options: VeilControlOptions) {
  const cid = options.cid;
  // The VPN control plane checks sessions synchronously (device broker, proxy logins), against
  // this service's in-memory CID store. See CidService.syncView().
  let view: ReturnType<CidService["syncView"]> | undefined;
  const ids = () => (view ??= cid.syncView());
  const entitled = options.entitled ?? (() => false);
  const servers = parseCatalog([...(options.servers ?? [])]);
  const bridges = parseBridges([...(options.bridges ?? [])]);
  const clock = options.clock ?? (() => new Date());
  const ttl = options.credentialTtlMs ?? CREDENTIAL_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 60 * 60 * 1000) {
    veilFail("invalid_server", "Credential lifetime is invalid", 500);
  }
  const credentials = new Map<string, Credential>();
  const dummy = randomBytes(32);

  const hasPlan = (accountId: string): boolean => {
    try {
      return entitled(accountId) === true;
    } catch {
      return false;
    }
  };
  const devices = createDeviceBroker({
    exit: options.deviceExit,
    clock,
    ttl,
    hasPlan,
    sessionActive: (accountId, sessionId) => ids().isSessionActive(accountId, sessionId),
  });

  const hashPassword = (password: string) => createHash("sha256").update(password, "utf8").digest();

  const identify = (token: string) => {
    if (typeof token !== "string" || !token || token.length > 512) {
      veilFail("sign_in_required", "Cumulus ID sign-in required", 401);
    }
    const auth = ids().authenticate(token);
    if (!auth || !ids().isSessionActive(auth.account.cid, auth.session.id)) {
      veilFail("sign_in_required", "Cumulus ID session expired or revoked", 401);
    }
    return { cid: auth.account.cid, username: auth.account.username, sessionId: auth.session.id };
  };

  const revokeCid = (accountId: string) => {
    for (const [username, row] of credentials) {
      if (row.cid === accountId) credentials.delete(username);
    }
  };

  const publicServers = () => servers.map((server) => ({ ...server }));

  return {
    session(token: string) {
      const identity = identify(token);
      const allowed = hasPlan(identity.cid);
      return {
        cid: identity.cid,
        username: identity.username,
        entitled: allowed,
        browserOnly: true as const,
        deviceWide: false as const,
        defaultMode: "veil" as const,
        servers: allowed ? publicServers() : [],
      };
    },
    connect(token: string, requested: unknown): ProxyGrant {
      const identity = identify(token);
      if (!hasPlan(identity.cid)) veilFail("veil_plan_required", "This Cumulus ID has no VEIL entitlement", 403);
      const id = serverId(requested);
      const server = servers.find((row) => row.id === id);
      if (!server) veilFail("unknown_server", "Unknown server", 404);
      revokeCid(identity.cid);
      const username = `v_${randomBytes(18).toString("base64url")}`;
      const password = randomBytes(32).toString("base64url");
      const expiresAt = clock().getTime() + ttl;
      credentials.set(username, {
        username,
        passwordHash: hashPassword(password),
        cid: identity.cid,
        sessionId: identity.sessionId,
        serverId: server.id,
        expiresAt,
      });
      return {
        coverage: "browser",
        deviceWide: false,
        dns: "through-proxy",
        defaultMode: "veil",
        server: { ...server },
        auth: { username, password, expiresAt: new Date(expiresAt).toISOString() },
      };
    },
    disconnect(token: string) {
      const identity = identify(token);
      revokeCid(identity.cid);
      return { ok: true as const, deviceWide: false as const, browserOnly: true as const };
    },
    deviceSession(token: string) {
      const identity = identify(token);
      const allowed = hasPlan(identity.cid);
      return {
        cid: identity.cid,
        username: identity.username,
        entitled: allowed,
        coverage: "device" as const,
        deviceWide: true as const,
        browserOnly: false as const,
        configured: allowed && devices.configured(),
        defaultMode: "veil" as const,
        dns: "through-tunnel" as const,
        killSwitch: "fail-closed" as const,
        protection: "client-must-bring-up-tunnel" as const,
        servers: allowed ? publicServers() : [],
      };
    },
    connectDevice(token: string, requested: unknown): DeviceGrant {
      const identity = identify(token);
      if (!hasPlan(identity.cid)) veilFail("veil_plan_required", "This Cumulus ID has no VEIL entitlement", 403);
      const id = serverId(requested);
      const server = servers.find((row) => row.id === id);
      if (!server) veilFail("unknown_server", "Unknown server", 404);
      if (!devices.configured()) veilFail("device_exit_unconfigured", "VEIL device exit is not configured", 503);
      return devices.connect(identity, server);
    },
    disconnectDevice(token: string) {
      const identity = identify(token);
      devices.disconnect(identity.cid);
      return { ok: true as const, coverage: "device" as const, deviceWide: true as const, released: true as const };
    },
    devicePeers(exitToken: string) {
      return { peers: devices.peersForExit(exitToken) };
    },
    deviceAudit() {
      return devices.audit();
    },
    bridges(token: string) {
      const identity = identify(token);
      if (!hasPlan(identity.cid)) veilFail("veil_plan_required", "This Cumulus ID has no VEIL entitlement", 403);
      return {
        bridges: [...bridges],
        optional: true as const,
        routing: "local-tor" as const,
        deviceWide: false as const,
      };
    },
    authorizeProxy(username: unknown, password: unknown): boolean {
      const name = typeof username === "string" && USER.test(username) ? username : "";
      const secret = typeof password === "string" && password.length >= 16 && password.length <= 256 ? password : "";
      const row = name ? credentials.get(name) : undefined;
      const actual = secret ? hashPassword(secret) : dummy;
      const expected = row?.passwordHash ?? dummy;
      const match = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!row || !match) return false;
      if (row.expiresAt <= clock().getTime()) return false;
      if (!ids().isSessionActive(row.cid, row.sessionId)) return false;
      if (!hasPlan(row.cid)) return false;
      return true;
    },
  };
}

export type VeilControl = ReturnType<typeof createVeilControl>;
