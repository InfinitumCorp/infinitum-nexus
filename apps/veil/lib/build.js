/**
 * Production packages keep this false.
 * `VEIL_DEV=1 node scripts/package.js` writes true into the zip only.
 * A stored origin must not be able to flip it.
 */
export const VEIL_DEV = false;
