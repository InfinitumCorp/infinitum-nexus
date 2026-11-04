/**
 * VEIL privacy helpers.
 * Strips tracking parameters and common identifiers from URLs.
 */
const TRACKERS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "msclkid"];

export function stripTrackers(url: string): string {
  try {
    const u = new URL(url);
    for (const t of TRACKERS) u.searchParams.delete(t);
    return u.toString();
  } catch {
    return url;
  }
}

export function isPrivateMode(): boolean {
  return true; // VEIL is Tor-first by design
}
