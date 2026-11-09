/**
 * Data exchange (opt-in, in development). People choose, product by product, whether de-identified
 * usage data may be pooled (with at least 1,000 others) and sold, keeping 85% of eligible net
 * revenue, paid in product tokens. Nothing is shared until the exchange opens; until then these
 * choices stay on this device. Global Privacy Control always means "no".
 */
export const DATA_SHARE_POOL_MIN = 1000;
export const DATA_SHARE_PERSON_PCT = 85;

export const NEVER_SOLD = [
  "Messages", "Documents", "Prompts", "Precise location", "Biometrics", "Anything from ODIN°™ or a military edition",
];

/** Military editions stay outside the token economy, and the network and corporate site aren't products: never offered. */
const EXCLUDED = new Set(["odin", "aether-mil", "firmament", "infinitum"]);

export function gpcEnabled(nav: { globalPrivacyControl?: boolean } = globalThis.navigator as never): boolean {
  return nav?.globalPrivacyControl === true;
}

/** Whether a product's de-identified data may be shared: an explicit yes, no GPC, not military. */
export function sharingAllowed(choices: Record<string, boolean>, productId: string, gpc: boolean): boolean {
  return !gpc && !EXCLUDED.has(productId) && choices[productId] === true;
}

export function offeredProducts<T extends { id: string }>(products: T[]): T[] {
  return products.filter((p) => !EXCLUDED.has(p.id));
}
