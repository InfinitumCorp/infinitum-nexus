import { readFileSync } from "node:fs";
import { moveOrganizations } from "../../../packages/lbrnth/src/move.ts";
import { postgresDatabase } from "./pg.ts";

/**
 * Copy Labyrinth organizations from this host's database to another hosted Labyrinth
 * (Russia server -> US host on Supabase), re-encrypted under the target's master key.
 * Runs ON the source server: its master key never leaves it.
 *
 *   SOURCE_ENV_FILE        default /etc/lbrnth/env (LBRNTH_MASTER_KEY, DATABASE_URL of this host)
 *   TARGET_MASTER_KEY_FILE file holding the target's base64 master key (pipe it in; mode 600)
 *   TARGET_DATABASE_URL_FILE file holding a postgres:// URL for the target with insert rights on
 *                          lbrnth.org_snapshots and lbrnth.entitlements (an operator role, not lbrnth_host)
 *
 *   node --experimental-strip-types src/move-cli.ts --org org_123 [--org ...] | --all  [--apply]
 *
 * Without --apply it is a dry run. It prints org ids and counts only, never keys or content.
 */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function masterKey(encoded: string, what: string): Uint8Array {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded.trim()) throw new Error(`${what} must be a canonical base64 32-byte key`);
  return new Uint8Array(key);
}

export function parseArgs(argv: string[]): { orgIds: string[] | "all"; apply: boolean } {
  const orgIds: string[] = [];
  let all = false, apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
    else if (a === "--apply") apply = true;
    else if (a === "--org" && argv[i + 1]) orgIds.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (all === (orgIds.length > 0)) throw new Error("Give --all or one or more --org <id>, not both");
  return { orgIds: all ? "all" : orgIds, apply };
}

async function main() {
  const { orgIds, apply } = parseArgs(process.argv.slice(2));
  const source = readEnvFile(process.env.SOURCE_ENV_FILE ?? "/etc/lbrnth/env");
  if (!source.LBRNTH_MASTER_KEY || !source.DATABASE_URL) throw new Error("Source env file lacks LBRNTH_MASTER_KEY or DATABASE_URL");
  const targetKeyFile = process.env.TARGET_MASTER_KEY_FILE, targetUrlFile = process.env.TARGET_DATABASE_URL_FILE;
  if (!targetKeyFile || !targetUrlFile) throw new Error("Set TARGET_MASTER_KEY_FILE and TARGET_DATABASE_URL_FILE");

  const src = postgresDatabase(source.DATABASE_URL);
  const targetUrl = readFileSync(targetUrlFile, "utf8").trim();
  // Same CA rule as the host (config.ts): Supabase hosts use the bundled Supabase Root 2021 CA.
  const supabase = new URL(targetUrl).hostname.endsWith(".supabase.com");
  const dst = postgresDatabase(targetUrl, process.env.TARGET_DATABASE_CA_PEM || (supabase ? readFileSync(new URL("../certs/supabase-root-2021.crt", import.meta.url), "utf8") : undefined));
  try {
    const report = await moveOrganizations({
      source: src.db, sourceMasterKey: masterKey(source.LBRNTH_MASTER_KEY, "Source LBRNTH_MASTER_KEY"),
      target: dst.db, targetMasterKey: masterKey(readFileSync(targetKeyFile, "utf8"), "Target master key"),
      orgIds, dryRun: !apply,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!apply) console.log("Dry run: nothing written. Add --apply to copy.");
  } finally {
    await src.close();
    await dst.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
