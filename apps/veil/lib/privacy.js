/**
 * VEIL tracker stripping.
 *
 * content.js keeps its own copy of TRACKERS (content scripts cannot import
 * modules without exposing web-accessible resources, which would make VEIL
 * fingerprintable). privacy.test.js checks the two lists stay identical.
 *
 * "ref" is deliberately absent: sites such as GitHub use it for real state.
 */
export const TRACKERS = Object.freeze([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid",
  "igshid", "li_fat_id", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "oly_enc_id",
  "oly_anon_id", "vero_id", "wickedid", "s_cid", "_ga", "_gl",
]);

/**
 * @returns {string | null} the cleaned URL, or null when nothing was removed
 *   (or the input is not a URL).
 */
export function stripTrackers(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  for (const t of TRACKERS) {
    if (u.searchParams.has(t)) {
      u.searchParams.delete(t);
      changed = true;
    }
  }
  return changed ? u.toString() : null;
}
