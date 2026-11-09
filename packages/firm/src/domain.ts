/**
 * FIRM Wallet public root domain.
 *
 * `FIRM_ROOT_DOMAIN` overrides the default. The value must be a bare
 * hostname: no scheme, port, path, query, userinfo, or wildcard.
 * The public origin is the exact `https://` URL of that hostname.
 */
export const DEFAULT_FIRM_ROOT_DOMAIN = "firmwallet.app";

const LABEL = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export class FirmDomainError extends Error {
  constructor(message = "FIRM_ROOT_DOMAIN must be a bare hostname (no scheme, port, path, query, or wildcard)") {
    super(message);
    this.name = "FirmDomainError";
  }
}

/** Bare hostname from `FIRM_ROOT_DOMAIN`, or `firmwallet.app` when unset. */
export function firmRootDomain(env: { FIRM_ROOT_DOMAIN?: string | undefined } = process.env): string {
  const raw = env.FIRM_ROOT_DOMAIN;
  if (raw === undefined) return DEFAULT_FIRM_ROOT_DOMAIN;
  return bareHostname(raw);
}

function bareHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 253 || IPV4.test(value)) throw new FirmDomainError();
  const labels = value.split(".");
  if (labels.some((label) => !LABEL.test(label))) throw new FirmDomainError();
  return value;
}
