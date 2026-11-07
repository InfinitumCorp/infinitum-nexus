/**
 * Architect production configuration.
 *
 * CNDCTR is the earlier name of this service. cndctr.app is the purchased
 * public hostname and is hosted on Cloudflare. This file records that origin.
 * It does not change DNS or Cloudflare.
 */
export const CNDCTR_ORIGIN = "https://cndctr.app";

/** Advertised origin. CNDCTR_ORIGIN may point at another http(s) host, such as a local process. */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CNDCTR_ORIGIN?.trim();
  if (!raw) return CNDCTR_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CNDCTR_ORIGIN must be an http(s) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("CNDCTR_ORIGIN must be an http(s) origin");
  if (url.username || url.password) throw new Error("CNDCTR_ORIGIN must not include credentials");
  return url.origin;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** Public host of CNDCTR. The process still listens on `port`. */
  publicOrigin: publicOrigin(),
  spectreUrl: process.env.SPECTRE_URL ?? "http://localhost:3000",
};

export function log(level: string, msg: string, extra?: Record<string, unknown>) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const current = levels[config.logLevel as keyof typeof levels] ?? 1;
  const requested = levels[level as keyof typeof levels] ?? 1;
  if (requested >= current) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
    console.log(line);
  }
}
