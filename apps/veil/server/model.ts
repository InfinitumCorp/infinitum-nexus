/** Exit catalog and optional bridge lines. Proxy passwords are never stored here. */

export const VEIL_SCHEMES = ["https", "socks5"] as const;
export type VeilScheme = (typeof VEIL_SCHEMES)[number];

export interface VeilServer {
  id: string;
  name: string;
  region: string;
  host: string;
  port: number;
  scheme: VeilScheme;
}

export class VeilError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DNS = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const BRIDGE = /^(?:bridge\s+)?(?:[a-z0-9]{1,20}\s+)?(?:\[[0-9a-f:.]+\]|[0-9a-z.-]+):\d{1,5}\b/i;

export function veilFail(code: string, message: string, status: number): never {
  throw new VeilError(code, message, status);
}

function label(value: unknown, max: number): string {
  if (typeof value !== "string") veilFail("invalid_server", "Server label must be text", 500);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    veilFail("invalid_server", "Server label is empty or too long", 500);
  }
  return text;
}

function ipv4Parts(host: string): number[] | null {
  if (!IPV4.test(host)) return null;
  return host.split(".").map((part) => Number(part));
}

export function isUnsafeProxyHost(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) return host === "metadata.google.internal";
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isProxyHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name.includes("%") || name.includes("@") || name.includes("/") || name.includes(":")) return false;
  if (!(DNS.test(name) || IPV4.test(name))) return false;
  return !isUnsafeProxyHost(name);
}

export function parseServer(input: unknown): VeilServer {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    veilFail("invalid_server", "Server entry must be an object", 500);
  }
  const row = input as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== "string" || !ID.test(id)) veilFail("invalid_server", "Server id is invalid", 500);
  if (typeof row.host !== "string" || !isProxyHost(row.host)) veilFail("invalid_server", "Server host is invalid", 500);
  if (typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) {
    veilFail("invalid_server", "Server port is invalid", 500);
  }
  if (row.scheme !== "https" && row.scheme !== "socks5") veilFail("invalid_server", "Server scheme must be https or socks5", 500);
  return {
    id,
    name: label(row.name, 60),
    region: label(row.region, 40),
    host: row.host.toLowerCase(),
    port: row.port,
    scheme: row.scheme,
  };
}

export function parseCatalog(input: unknown): VeilServer[] {
  if (!Array.isArray(input)) veilFail("invalid_server", "Server catalog must be a list", 500);
  if (input.length > 32) veilFail("invalid_server", "Server catalog is too large", 500);
  const servers = input.map((row) => parseServer(row));
  const ids = new Set(servers.map((server) => server.id));
  if (ids.size !== servers.length) veilFail("invalid_server", "Server ids must be unique", 500);
  return servers;
}

export function serverId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) veilFail("invalid_server", "Unknown server", 400);
  return value;
}

export function parseBridge(input: unknown): string {
  if (typeof input !== "string") veilFail("invalid_bridge", "Bridge line must be text", 500);
  const text = input.trim();
  if (!text || text.length > 400 || /[\r\n\u0000]/.test(text)) veilFail("invalid_bridge", "Bridge line is empty or too long", 500);
  if (/BEGIN |PRIVATE KEY/i.test(text)) veilFail("invalid_bridge", "Bridge line was refused", 500);
  if (!BRIDGE.test(text)) veilFail("invalid_bridge", "Bridge line is not a Tor bridge", 500);
  return text;
}

export function parseBridges(input: unknown): string[] {
  if (!Array.isArray(input)) veilFail("invalid_bridge", "Bridge list must be a list", 500);
  if (input.length > 32) veilFail("invalid_bridge", "Bridge list is too large", 500);
  return input.map((line) => parseBridge(line));
}
