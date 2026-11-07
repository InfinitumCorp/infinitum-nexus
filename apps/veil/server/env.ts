import { parseCatalog, type VeilServer } from "./model.ts";

export interface VeilHostConfig {
  entitled: (cid: string) => boolean;
  servers: VeilServer[];
}

/**
 * Operator configuration. Unset means nobody is entitled and there are no exits.
 * This list is account ids, not a proxy password.
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
  return {
    servers,
    entitled: (cid: string) => allowed.has(cid),
  };
}
