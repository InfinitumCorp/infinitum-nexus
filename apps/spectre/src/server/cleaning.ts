/**
 * Endpoint helpers for Spectre self-cleaning.
 */
import type { SpectreCRM } from "../core/crm.ts";
import { findDuplicateCompanies, findDuplicateContacts, dataIssues, repointReferences } from "../core/cleaning.ts";

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
  const deals = crm.list("deals", workspace);
  const activities = crm.list("activities", workspace);
  repointReferences(keepId, mergeIds, deals, activities);

  if (kind === "company") {
    for (const id of mergeIds) crm.store.companies.delete(id);
  } else {
    for (const id of mergeIds) crm.store.contacts.delete(id);
  }
  await crm.recordMerge(actor, kind, keepId, mergeIds);
  return { kept: keepId, merged: mergeIds };
}
