import { hkdfSync } from "node:crypto";
import { PostgresStorage } from "./postgres.ts";
import type { SqlDatabase } from "./postgres.ts";

/** Per-organization key, derived exactly as LabyrinthHost derives it. */
export function hostKeyForOrg(masterKey: Uint8Array): (orgId: string) => Uint8Array {
  const master = Buffer.from(masterKey);
  if (master.length !== 32) throw new Error("Labyrinth master key must be 32 bytes");
  return org => new Uint8Array(hkdfSync("sha256", master, "Infinitum/LBRNTH/v1", org, 32));
}

export interface MoveOptions {
  /** Where the organizations are now (e.g. labyrinth-russia's Postgres). Only read, never written. */
  source: SqlDatabase;
  sourceMasterKey: Uint8Array;
  /** Where they go (e.g. Supabase, schema lbrnth, for lbrnth-host-us). */
  target: SqlDatabase;
  targetMasterKey: Uint8Array;
  /** Organization ids to copy, or "all". */
  orgIds: readonly string[] | "all";
  /** true (the default): report what would happen and write nothing. */
  dryRun?: boolean;
}

export interface MoveReport {
  copied: string[];
  /** Already in the target; never overwritten (the target may have newer work). */
  skippedExisting: string[];
  /** Asked for but not in the source. */
  missing: string[];
  /** Entitlement rows copied alongside (paid-plan access). */
  entitlements: string[];
  dryRun: boolean;
}

/**
 * Copies Labyrinth organizations from one hosted Labyrinth to another, re-encrypting each
 * envelope under the target's key. Uses PostgresStorage on both sides, so envelopes are opened
 * and sealed exactly as the hosts do (AES-256-GCM, AAD bound to org id and revision).
 *
 * Safety: the source is only read. An org that already exists in the target is skipped, never
 * overwritten. Target writes are one transaction (envelopes and entitlements together): all
 * or nothing. Delegations (15-minute bearers) are not copied; people simply sign in again.
 * After a move, point that org's users at the target before anyone writes to the source again,
 * or later source changes will not be in the target.
 */
export async function moveOrganizations(opts: MoveOptions): Promise<MoveReport> {
  const dryRun = opts.dryRun !== false;
  const from = new PostgresStorage(opts.source, hostKeyForOrg(opts.sourceMasterKey));
  const to = new PostgresStorage(opts.target, hostKeyForOrg(opts.targetMasterKey));
  await from.refresh();
  await to.refresh();
  const sourceOrgs = from.load();
  const targetOrgs = to.load();
  const inTarget = new Set(targetOrgs.map(o => o.id));
  const wanted = opts.orgIds === "all" ? sourceOrgs.map(o => o.id) : [...new Set(opts.orgIds)];
  const byId = new Map(sourceOrgs.map(o => [o.id, o]));

  const report: MoveReport = { copied: [], skippedExisting: [], missing: [], entitlements: [], dryRun };
  const moving = [];
  for (const id of wanted) {
    const org = byId.get(id);
    if (!org) report.missing.push(id);
    else if (inTarget.has(id)) report.skippedExisting.push(id);
    else { moving.push(org); report.copied.push(id); }
  }

  type Ent = { org_id: string; plan: string; active: boolean; source: string; note: string | null };
  const ents = report.copied.length
    ? (await opts.source.query<Ent>("select org_id, plan, active, source, note from lbrnth.entitlements where org_id = any($1::text[])", [report.copied])).rows
    : [];
  report.entitlements = ents.map(e => e.org_id);
  if (dryRun || !moving.length) return report;

  to.save([...targetOrgs, ...moving]);
  await to.flush(async tx => {
    for (const e of ents) {
      await tx.query(
        "insert into lbrnth.entitlements (org_id, plan, active, source, note) values ($1, $2, $3, $4, $5) on conflict (org_id) do nothing",
        [e.org_id, e.plan, e.active, e.source, e.note],
      );
    }
  });
  return report;
}
