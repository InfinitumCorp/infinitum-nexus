/**
 * Pinned toolchains for reproducible VEIL archives.
 * .github/workflows/veil.yml must use these exact versions.
 * apps/veil/test/reproducible.test.js fails when they drift.
 */

export const NODE_VERSION = "22.23.4";
export const PNPM_VERSION = "10.28.0";
export const GO_VERSION = "1.26.0";
