import { generateKeyPairSync, createHash, timingSafeEqual } from "node:crypto";
import { isProxyHost, veilFail } from "./model.ts";

/** Tunnel addresses are inside this prefix. Public resolvers are not accepted. */
export const DEVICE_POOL = "10.64.0.0/16";
export const DEVICE_DNS = ["10.64.0.1"] as const;
export const DEVICE_MTU = 1280;
export const DEVICE_ALLOWED_IPS = ["0.0.0.0/0", "::/0"] as const;
export const DEVICE_KEEPALIVE = 25;

export interface DeviceExitConfig {
  publicKey: string;
  host: string;
  port: number;
  /** Present only when the operator configured an exit peer list. */
  exitToken?: string;
}

export interface DevicePeerView {
  publicKey: string;
  address: string;
  expiresAt: string;
}

export interface DeviceGrant {
  coverage: "device";
  deviceWide: true;
  browserOnly: false;
  defaultMode: "veil";
  dns: "through-tunnel";
  killSwitch: "fail-closed";
  /** The HTTP response does not move packets. The desktop client must bring the tunnel up. */
  protection: "client-must-bring-up-tunnel";
  expiresAt: string;
  server: { id: string; name: string; region: string };
  interface: {
    privateKey: string;
    publicKey: string;
    address: string;
    dns: string[];
    mtu: number;
  };
  peer: {
    publicKey: string;
    endpoint: string;
    allowedIps: string[];
    persistentKeepalive: number;
  };
}

export function wireGuardKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  if (!pub.x || !priv.d) veilFail("invalid_device_exit", "WireGuard key generation failed", 500);
  return { publicKey: standardKey(pub.x), privateKey: standardKey(priv.d) };
}

function standardKey(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32) veilFail("invalid_device_exit", "WireGuard key generation failed", 500);
  return bytes.toString("base64");
}

/** Accept the standard base64 form WireGuard prints. Reject short, unpadded, or zero keys. */
export function parseWireGuardKey(value: unknown): string {
  if (typeof value !== "string") veilFail("invalid_device_exit", "WireGuard key is invalid", 500);
  const text = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) veilFail("invalid_device_exit", "WireGuard key is invalid", 500);
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== text) veilFail("invalid_device_exit", "WireGuard key is invalid", 500);
  if (bytes.every((byte) => byte === 0)) veilFail("invalid_device_exit", "WireGuard key is invalid", 500);
  return text;
}

export function parseDeviceEndpoint(value: string): { host: string; port: number } {
  const text = value.trim();
  const split = text.lastIndexOf(":");
  if (split <= 0 || split === text.length - 1) {
    throw new Error("VEIL_WG_ENDPOINT must be host:port");
  }
  const host = text.slice(0, split).toLowerCase();
  const port = Number(text.slice(split + 1));
  if (!isProxyHost(host)) throw new Error("VEIL_WG_ENDPOINT host is invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VEIL_WG_ENDPOINT port is invalid");
  return { host, port };
}

export function exitTokensMatch(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
