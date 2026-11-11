/**
 * Labyrinth host configuration, read from the environment (Cloud Run secrets and variables).
 * Nothing here has a default secret, and a missing value keeps /api/labyrinth at 503.
 *
 *   LBRNTH_MASTER_KEY     canonical base64, exactly 32 bytes (Secret Manager)
 *   DATABASE_URL          Supabase Postgres connection string (Secret Manager)
 *   DATABASE_CA_PEM       optional PEM of the database CA; when unset, system CAs are used
 *   CID_DIRECTORY_KEY     service key for id.cumuluscloud.app's labyrinth directory (Secret Manager)
 *   CID_DIRECTORY_URL     default https://id.cumuluscloud.app/api/id/labyrinth-directory
 *   LBRNTH_ENTITLED_ORGS  optional comma-separated operator allowlist of CID org ids
 *   PORT                  set by Cloud Run (default 8080)
 */
export interface HostConfig {
  masterKey: Uint8Array;
  databaseUrl: string;
  databaseCa?: string;
  directoryUrl: string;
  directoryKey: string;
  entitledOrgs: () => string[];
}

export function hostConfigFromEnv(env: Record<string, string | undefined>): { config?: HostConfig; missing: string[] } {
  const missing = ["LBRNTH_MASTER_KEY", "DATABASE_URL", "CID_DIRECTORY_KEY"].filter(name => !env[name]);
  if (missing.length) return { missing };
  const encoded = env.LBRNTH_MASTER_KEY!;
  const masterKey = Buffer.from(encoded, "base64");
  if (masterKey.length !== 32 || masterKey.toString("base64") !== encoded) throw new Error("LBRNTH_MASTER_KEY must be a canonical base64 32-byte secret");
  const databaseUrl = env.DATABASE_URL!;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error("DATABASE_URL must be a postgres:// URL");
  const directoryKey = env.CID_DIRECTORY_KEY!;
  if (directoryKey.length < 32 || directoryKey.length > 512) throw new Error("CID_DIRECTORY_KEY must be 32-512 characters");
  return {
    missing: [],
    config: {
      masterKey: new Uint8Array(masterKey),
      databaseUrl,
      databaseCa: env.DATABASE_CA_PEM || undefined,
      directoryUrl: env.CID_DIRECTORY_URL || "https://id.cumuluscloud.app/api/id/labyrinth-directory",
      directoryKey,
      // Read on every request so an operator change takes effect on the next revision.
      entitledOrgs: () => (env.LBRNTH_ENTITLED_ORGS ?? "").split(",").map(x => x.trim()).filter(Boolean),
    },
  };
}
