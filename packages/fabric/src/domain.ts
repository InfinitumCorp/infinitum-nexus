/**
 * FABRIC++ public root domain.
 *
 * `FABRIC_ROOT_DOMAIN` overrides the default. The value must be a bare
 * hostname: no scheme, port, path, query, userinfo, or wildcard.
 * The exact public origin is `https://<FABRIC_ROOT_DOMAIN>`.
 */
export const DEFAULT_FABRIC_ROOT_DOMAIN = "infinitumfabric.app";

const LABEL = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export class FabricDomainError extends Error {
  constructor(message = "FABRIC_ROOT_DOMAIN must be a bare hostname (no scheme, port, path, query, or wildcard)") {
    super(message);
    this.name = "FabricDomainError";
  }
}

/** Bare hostname from `FABRIC_ROOT_DOMAIN`, or `infinitumfabric.app` when unset. */
export function fabricRootDomain(env: { FABRIC_ROOT_DOMAIN?: string | undefined } = process.env): string {
  const raw = env.FABRIC_ROOT_DOMAIN;
  if (raw === undefined) return DEFAULT_FABRIC_ROOT_DOMAIN;
  return bareHostname(raw);
}

function bareHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 253 || IPV4.test(value)) throw new FabricDomainError();
  const labels = value.split(".");
  if (labels.some((label) => !LABEL.test(label))) throw new FabricDomainError();
  return value;
}
