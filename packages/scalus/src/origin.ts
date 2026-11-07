/**
 * Public origin of SCALVS.ai.
 *
 * scalvs.app is the purchased hostname and is hosted on Cloudflare.
 * This module records that origin. It does not change DNS or Cloudflare.
 */
export const SCALVS_ORIGIN = "https://scalvs.app";

/** Advertised origin. SCALVS_ORIGIN may point at another http(s) host. */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SCALVS_ORIGIN?.trim();
  if (!raw) return SCALVS_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SCALVS_ORIGIN must be an http(s) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("SCALVS_ORIGIN must be an http(s) origin");
  if (url.username || url.password) throw new Error("SCALVS_ORIGIN must not include credentials");
  return url.origin;
}
