/**
 * Endpoint helper for buying-committee gaps.
 */
import type { SpectreCRM } from "../core/crm.ts";
import { findCommitteeGaps } from "../core/committee.ts";

export function listCommitteeGaps(crm: SpectreCRM, workspace: string) {
  const deals = crm.list("deals", workspace);
  const contacts = crm.list("contacts", workspace);
  return findCommitteeGaps(deals, contacts);
}
