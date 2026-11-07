import { parseBridges } from "./model.ts";

export interface VeilHostConfig {
  entitled: (cid: string) => boolean;
  bridges: string[];
}

/**
 * Operator configuration for the optional bridge list.
 * Unset means nobody is entitled and no bridges are published.
 * Tor routing does not read this.
 */
export function veilFromEnv(env: NodeJS.ProcessEnv): VeilHostConfig {
  const raw = env.VEIL_ENTITLED_CIDS?.trim() ?? "";
  const allowed = new Set(raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : []);
  for (const cid of allowed) {
    if (!/^cid_[A-Za-z0-9-]{1,80}$/.test(cid)) throw new Error("VEIL_ENTITLED_CIDS contains an invalid Cumulus ID");
  }
  const bridges = env.VEIL_BRIDGES === undefined || env.VEIL_BRIDGES.trim() === ""
    ? []
    : parseBridges(JSON.parse(env.VEIL_BRIDGES));
  return {
    bridges,
    entitled: (cid: string) => allowed.has(cid),
  };
}
