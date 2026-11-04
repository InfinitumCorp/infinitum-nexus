/**
 * Endpoint helpers for Spectre self-cleaning.
 */
import type { SpectreCRM } from "../core/crm.ts";
import { findCompanyDuplicates, findContactDuplicates, mergeCompanies, mergeContacts } from "../core/cleaning.ts";

export function listDuplicates(crm: SpectreCRM, workspace: string) {
  return {
    companies: findCompanyDuplicates(crm, workspace),
    contacts: findContactDuplicates(crm, workspace),
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
  if (kind === "company") return mergeCompanies(crm, workspace, actor, keepId, mergeIds);
  return mergeContacts(crm, workspace, actor, keepId, mergeIds);
}
