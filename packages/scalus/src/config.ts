/**
 * SCALVS.ai runtime configuration.
 *
 * PORT             listen port. Default 3020. 0 lets the operating system choose.
 * SCALVS_ORIGIN    public origin. Default https://scalvs.app.
 * SCALVS_AUDIENCE  Cumulus ID token audience. Default scalvs.
 */
import { readAudience } from "./cumulus-auth.ts";

export const DEFAULT_ORIGIN = "https://scalvs.app";
export const DEFAULT_PORT = 3020;

export interface ScalvsConfig {
  port: number;
  origin: string;
  audience: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ScalvsConfig {
  return {
    port: readPort(env.PORT),
    origin: readOrigin(env.SCALVS_ORIGIN),
    audience: readAudience(env.SCALVS_AUDIENCE),
  };
}

export function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw.trim())) throw new Error("PORT must be an integer from 0 to 65535");
  const port = Number(raw.trim());
  if (port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
  return port;
}

/** Absolute http(s) origin with no credentials and no path. Blank means the public default. */
export function readOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("SCALVS_ORIGIN must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SCALVS_ORIGIN must be an absolute http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("SCALVS_ORIGIN must not include credentials");
  }
  return url.origin;
}
