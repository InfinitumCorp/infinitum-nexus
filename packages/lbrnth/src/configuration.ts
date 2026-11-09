import { hkdfSync } from "node:crypto";
import { EncryptedFileStorage } from "./storage.ts";
import type { CidLabyrinthOptions } from "./auth.ts";
/** Operator configuration only. No key generation, free entitlement, or insecure fallback. */
export function labyrinthFromEnvironment(env: Record<string, string | undefined>, path: string): Pick<CidLabyrinthOptions, "storage" | "entitled"> | undefined {
  if (!env.LBRNTH_MASTER_KEY) return undefined;
  const encoded = env.LBRNTH_MASTER_KEY;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("LBRNTH_MASTER_KEY must be a canonical base64 32-byte secret");
  return {
    storage: new EncryptedFileStorage(path, org => new Uint8Array(hkdfSync("sha256", key, "Infinitum/LBRNTH/v1", org, 32))),
    // An operator-managed initial entitlement adapter; replace with trusted billing in hosted deployments.
    entitled: org => (env.LBRNTH_ENTITLED_ORGS ?? "").split(",").map(x => x.trim()).filter(Boolean).includes(org),
  };
}
