/**
 * Endpoint helpers for Spectre self-cleaning.
 */
import type { SpectreCRM } from "../core/crm.ts";
import { findDuplicateCompanies, findDuplicateContacts, dataIssues, mergeCompanies, repointReferences } from "../core/cleaning.ts";

export function listDuplicates(crm: SpectreCRM, workspace: string) {
  const companies = crm.list("companies", workspace);
  const contacts = crm.list("contacts", workspace);
  const activities = crm.list("activities", workspace);
  const now = crm.now();
  return {
    companies: findDuplicateCompanies(companies),
    contacts: findDuplicateContacts(contacts),
    issues: dataIssues(contacts, companies, activities, now),
  };
}

export async function runMerge(
  crm: SpectreCRM,
  workspace: string,
  actor: string,
  kind: "company" | "contact",
  keepId: string,
  mergeIds: string[],
) {
  const ids = mergeIds.filter((id) => id !== keepId);
  if (kind === "company") {
    return mergeCompanies(crm, workspace, actor, keepId, ids);
  }
  const deals = crm.list("deals", workspace);
  const activities = crm.list("activities", workspace);
  repointReferences(keepId, ids, deals, activities);
  for (const id of ids) crm.store.contacts.delete(id);
  await crm.recordMerge(actor, kind, keepId, ids);
  return { kept: keepId, merged: ids };
}
