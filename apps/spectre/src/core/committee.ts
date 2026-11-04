/**
 * Buying-committee gap detection for Spectre.
 * Ideal commercial committee: decision-maker, champion, and at least one influencer/user.
 */
import type { Contact, Deal } from "./model.ts";

export type Influence = NonNullable<Contact["influence"]>;

export const IDEAL_ROLES: Influence[] = ["decision-maker", "champion", "influencer"];

export interface CommitteeGap {
  dealId: string;
  dealName: string;
  present: Influence[];
  missing: Influence[];
  message: string;
}

export function analyzeCommittee(deal: Deal, contacts: Contact[]): CommitteeGap | null {
  const involved = contacts.filter((c) => deal.contactIds.includes(c.id) && !c.optedOut);
  const present = new Set<Influence>();
  for (const c of involved) if (c.influence) present.add(c.influence);

  const missing = IDEAL_ROLES.filter((r) => !present.has(r));
  if (missing.length === 0) return null;

  const msg =
    missing.length === IDEAL_ROLES.length
      ? "No buying committee mapped"
      : `Missing: ${missing.join(", ")}`;

  return {
    dealId: deal.id,
    dealName: deal.name,
    present: [...present],
    missing,
    message: msg,
  };
}

export function findCommitteeGaps(deals: Deal[], contacts: Contact[]): CommitteeGap[] {
  return deals
    .filter((d) => d.stage !== "won" && d.stage !== "lost")
    .map((d) => analyzeCommittee(d, contacts))
    .filter((g): g is CommitteeGap => g !== null);
}
