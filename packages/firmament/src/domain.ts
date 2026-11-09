/**
 * Firmament Network public root domain.
 *
 * `FIRMAMENT_ROOT_DOMAIN` overrides the default. The value must be a bare
 * hostname: no scheme, port, path, query, userinfo, or wildcard.
 * The public origin is the exact `https://` URL of that hostname.
 */
export const DEFAULT_FIRMAMENT_ROOT_DOMAIN = "firmnetwork.app";

const LABEL = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export class FirmamentDomainError extends Error {
  constructor(message = "FIRMAMENT_ROOT_DOMAIN must be a bare hostname (no scheme, port, path, query, or wildcard)") {
    super(message);
    this.name = "FirmamentDomainError";
  }
}

/** Bare hostname from `FIRMAMENT_ROOT_DOMAIN`, or `firmnetwork.app` when unset. */
export function firmamentRootDomain(env: { FIRMAMENT_ROOT_DOMAIN?: string | undefined } = process.env): string {
  const raw = env.FIRMAMENT_ROOT_DOMAIN;
  if (raw === undefined) return DEFAULT_FIRMAMENT_ROOT_DOMAIN;
  return bareHostname(raw);
}

function bareHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 253 || IPV4.test(value)) throw new FirmamentDomainError();
  const labels = value.split(".");
  if (labels.some((label) => !LABEL.test(label))) throw new FirmamentDomainError();
  return value;
}
