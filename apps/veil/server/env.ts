import { parseBridges, parseCatalog, type VeilServer } from "./model.ts";
import { parseDeviceEndpoint, parseWireGuardKey, type DeviceExitConfig } from "./wireguard.ts";

export interface VeilHostConfig {
  entitled: (cid: string) => boolean;
  servers: VeilServer[];
  bridges: string[];
  deviceExit?: DeviceExitConfig;
}

/**
 * Operator configuration. Unset means nobody is entitled and there are no exits.
 * VEIL_SERVERS is the default browser proxy. VEIL_BRIDGES is optional Tor config.
 * Neither is required for the optional local Tor mode in the extension.
 * VEIL_WG_SERVER_PUBLIC_KEY and VEIL_WG_ENDPOINT configure the device exit.
 * The exit private key is not read here.
 */
export function veilFromEnv(env: NodeJS.ProcessEnv): VeilHostConfig {
  const raw = env.VEIL_ENTITLED_CIDS?.trim() ?? "";
  const allowed = new Set(raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : []);
  for (const cid of allowed) {
    if (!/^cid_[A-Za-z0-9-]{1,80}$/.test(cid)) throw new Error("VEIL_ENTITLED_CIDS contains an invalid Cumulus ID");
  }
  const servers = env.VEIL_SERVERS === undefined || env.VEIL_SERVERS.trim() === ""
    ? []
    : parseCatalog(JSON.parse(env.VEIL_SERVERS));
  const bridges = env.VEIL_BRIDGES === undefined || env.VEIL_BRIDGES.trim() === ""
    ? []
    : parseBridges(JSON.parse(env.VEIL_BRIDGES));
  return {
    servers,
    bridges,
    deviceExit: deviceExitFromEnv(env),
    entitled: (cid: string) => allowed.has(cid),
  };
}

function deviceExitFromEnv(env: NodeJS.ProcessEnv): DeviceExitConfig | undefined {
  const pub = env.VEIL_WG_SERVER_PUBLIC_KEY?.trim() ?? "";
  const endpoint = env.VEIL_WG_ENDPOINT?.trim() ?? "";
  const token = env.VEIL_EXIT_TOKEN?.trim() ?? "";
  if (!pub && !endpoint && !token) return undefined;
  if (!pub || !endpoint) {
    throw new Error("VEIL device exit requires VEIL_WG_SERVER_PUBLIC_KEY and VEIL_WG_ENDPOINT");
  }
  let publicKey: string;
  try {
    publicKey = parseWireGuardKey(pub);
  } catch {
    throw new Error("VEIL_WG_SERVER_PUBLIC_KEY is invalid");
  }
  const parsed = parseDeviceEndpoint(endpoint);
  if (token && !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("VEIL_EXIT_TOKEN is invalid");
  return { publicKey, host: parsed.host, port: parsed.port, exitToken: token || undefined };
}
