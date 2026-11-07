import {
  DEVICE_ALLOWED_IPS,
  DEVICE_DNS,
  DEVICE_KEEPALIVE,
  DEVICE_MTU,
  exitTokensMatch,
  wireGuardKeyPair,
  type DeviceExitConfig,
  type DeviceGrant,
  type DevicePeerView,
} from "./wireguard.ts";
import { veilFail, type VeilServer } from "./model.ts";

interface Identity {
  cid: string;
  sessionId: string;
}

interface StoredPeer {
  publicKey: string;
  cid: string;
  sessionId: string;
  serverId: string;
  address: string;
  expiresAt: number;
}

export interface DeviceBrokerOptions {
  exit?: DeviceExitConfig;
  clock: () => Date;
  ttl: number;
  hasPlan: (cid: string) => boolean;
  sessionActive: (cid: string, sessionId: string) => boolean;
}

/**
 * Mints a short-lived WireGuard peer for an entitled Cumulus ID.
 * The client private key is returned once and is not stored.
 */
export function createDeviceBroker(options: DeviceBrokerOptions) {
  const peers = new Map<string, StoredPeer>();

  const expire = () => {
    const now = options.clock().getTime();
    for (const [key, row] of peers) {
      if (row.expiresAt <= now) peers.delete(key);
    }
  };

  const allocate = (): string => {
    expire();
    const used = new Set([...peers.values()].map((row) => row.address));
    for (let n = 2; n <= 0xfffe; n++) {
      const address = `10.64.${Math.floor(n / 256)}.${n % 256}`;
      if (address === "10.64.0.1" || used.has(address)) continue;
      return address;
    }
    veilFail("pool_exhausted", "VEIL device address pool is exhausted", 503);
  };

  const dropCid = (accountId: string) => {
    for (const [key, row] of peers) {
      if (row.cid === accountId) peers.delete(key);
    }
  };

  return {
    configured(): boolean {
      return options.exit !== undefined;
    },
    connect(identity: Identity, server: VeilServer): DeviceGrant {
      const exit = options.exit;
      if (!exit) veilFail("device_exit_unconfigured", "VEIL device exit is not configured", 503);
      if (!options.hasPlan(identity.cid)) veilFail("veil_plan_required", "This Cumulus ID has no VEIL entitlement", 403);
      dropCid(identity.cid);
      const keys = wireGuardKeyPair();
      const address = allocate();
      const expiresAt = options.clock().getTime() + options.ttl;
      peers.set(keys.publicKey, {
        publicKey: keys.publicKey,
        cid: identity.cid,
        sessionId: identity.sessionId,
        serverId: server.id,
        address,
        expiresAt,
      });
      return {
        coverage: "device",
        deviceWide: true,
        browserOnly: false,
        defaultMode: "veil",
        dns: "through-tunnel",
        killSwitch: "fail-closed",
        protection: "client-must-bring-up-tunnel",
        expiresAt: new Date(expiresAt).toISOString(),
        server: { id: server.id, name: server.name, region: server.region },
        interface: {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          address: `${address}/32`,
          dns: [...DEVICE_DNS],
          mtu: DEVICE_MTU,
        },
        peer: {
          publicKey: exit.publicKey,
          endpoint: `${exit.host}:${exit.port}`,
          allowedIps: [...DEVICE_ALLOWED_IPS],
          persistentKeepalive: DEVICE_KEEPALIVE,
        },
      };
    },
    disconnect(accountId: string) {
      dropCid(accountId);
    },
    peersForExit(presented: string): DevicePeerView[] {
      const expected = options.exit?.exitToken;
      if (!expected) veilFail("not_found", "Not found", 404);
      if (!presented || !exitTokensMatch(presented, expected)) {
        veilFail("exit_unauthorized", "Exit token refused", 401);
      }
      expire();
      const out: DevicePeerView[] = [];
      for (const [key, row] of peers) {
        if (!options.sessionActive(row.cid, row.sessionId) || !options.hasPlan(row.cid)) {
          peers.delete(key);
          continue;
        }
        out.push({
          publicKey: row.publicKey,
          address: `${row.address}/32`,
          expiresAt: new Date(row.expiresAt).toISOString(),
        });
      }
      return out;
    },
    /** Public peer metadata for tests. Private keys are not retained to put here. */
    audit(): Array<{ publicKey: string; address: string; serverId: string; expiresAt: number }> {
      expire();
      return [...peers.values()].map((row) => ({
        publicKey: row.publicKey,
        address: row.address,
        serverId: row.serverId,
        expiresAt: row.expiresAt,
      }));
    },
  };
}

export type DeviceBroker = ReturnType<typeof createDeviceBroker>;
