/**
 * Spectre production configuration.
 */
import { CNDCTR_ORIGIN } from "@infinitum/architect";
import { SCALVS_ORIGIN } from "@infinitum/scalus";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  workspace: process.env.SPECTRE_WORKSPACE ?? "demo",
  actor: process.env.SPECTRE_ACTOR ?? "cid:demo-user",
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** CNDCTR public host (https://cndctr.app on Cloudflare). ARCHITECT_URL overrides it. */
  architectUrl: process.env.ARCHITECT_URL ?? CNDCTR_ORIGIN,
  /** SCALVS.ai public host (https://scalvs.app on Cloudflare). SCALVS_URL overrides it. */
  scalvsUrl: process.env.SCALVS_URL ?? SCALVS_ORIGIN,
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
