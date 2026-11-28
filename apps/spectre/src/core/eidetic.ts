/**
 * Spectre integration point for ei·det·ic.
 * Authorized, lawful use only. No identity source is wired in this build, so callers
 * get an explicit "not configured" result instead of an empty match or a fake consent receipt.
 */

export const EIDETIC_NOT_CONFIGURED = "ei·det·ic is not configured";

export async function matchIdentity(query: string) {
  return { configured: false as const, error: EIDETIC_NOT_CONFIGURED, query, matches: [] as [] };
}

export async function recordConsent(subject: string, purpose: string) {
  return { configured: false as const, recorded: false as const, error: EIDETIC_NOT_CONFIGURED, subject, purpose };
}
