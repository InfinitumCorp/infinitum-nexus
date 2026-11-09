/**
 * Canonical public names for Cumulus://ID, Cumulus://Cloud and Cumulus://Mail.
 *
 * Defaults (override with the environment; never a wildcard):
 *   CUMULUS_ROOT_DOMAIN=cumuluscloud.app
 *   CUMULUS_ID_HOST=id.cumuluscloud.app
 *   CUMULUS_KEYCLOAK_REALM=cumulus
 *   CUMULUS_CLOUD_HOST=cloud.cumuluscloud.app
 *   CUMULUS_MAIL_HOST=mail.cumuluscloud.app
 *
 * The CID issuer is the Keycloak realm on the ID host:
 *   https://id.cumuluscloud.app/realms/cumulus
 *   JWKS: https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs
 *
 * Mail addresses are name@CUMULUS_ROOT_DOMAIN. The three hosts are the HTTPS
 * origins of the products.
 *
 * Products on their own domains that sign in with Cumulus://ID from the browser:
 *   METATRON_HOST=mttrn.app   (METATRON¹⁰⁰)
 *
 * CORS allowlists those exact origins and nothing else.
 */

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const REALM = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export const CUMULUS_DOMAIN_DEFAULTS = Object.freeze({
  rootDomain: "cumuluscloud.app",
  idHost: "id.cumuluscloud.app",
  realm: "cumulus",
  cloudHost: "cloud.cumuluscloud.app",
  mailHost: "mail.cumuluscloud.app",
});

/** Canonical hosts of products outside the Cumulus root domain that use Cumulus://ID. */
export const PRODUCT_HOST_DEFAULTS = Object.freeze({
  metatron: "mttrn.app",
});

export interface CumulusDomains {
  rootDomain: string;
  idHost: string;
  cloudHost: string;
  mailHost: string;
  /** Email domain. Addresses look like alex@cumuluscloud.app. */
  mailDomain: string;
  /** Keycloak realm. Default cumulus. */
  realm: string;
  /** Keycloak issuer: https://<id-host>/realms/<realm>. No trailing slash. */
  issuer: string;
  /** Keycloak JWKS: <issuer>/protocol/openid-connect/certs. */
  jwksUri: string;
  origins: { id: string; cloud: string; mail: string };
  /** Origins of products on their own domains, e.g. METATRON¹⁰⁰ at https://mttrn.app. */
  productOrigins: { metatron: string };
  /** Exact browser origins: the Cumulus hosts plus `productOrigins`. Never includes "*". */
  corsOrigins: readonly string[];
}

export interface CidIssuerMetadata {
  issuer: string;
  jwks_uri: string;
  id_host: string;
}

function hostname(value: string | undefined, fallback: string, name: string): string {
  const host = (value ?? fallback).trim().toLowerCase();
  if (!host || host.includes("*") || host.includes("://") || host.includes("/") || host.includes(":") || !HOSTNAME.test(host)) {
    throw new Error(`${name} must be an exact hostname, not a URL, port or wildcard`);
  }
  return host;
}

function underRoot(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function realmName(value: string | undefined, fallback: string): string {
  const realm = (value ?? fallback).trim().toLowerCase();
  if (!realm || realm.includes("*") || realm.includes("/") || realm.includes(".") || !REALM.test(realm)) {
    throw new Error("CUMULUS_KEYCLOAK_REALM must be an exact realm name, not a path or wildcard");
  }
  return realm;
}

/** Read the Cumulus domain from `env`. Pass `{}` to force the defaults. */
export function cumulusDomains(env: Record<string, string | undefined> = process.env): CumulusDomains {
  const rootDomain = hostname(env.CUMULUS_ROOT_DOMAIN, CUMULUS_DOMAIN_DEFAULTS.rootDomain, "CUMULUS_ROOT_DOMAIN");
  const idHost = hostname(env.CUMULUS_ID_HOST, `id.${rootDomain}`, "CUMULUS_ID_HOST");
  const cloudHost = hostname(env.CUMULUS_CLOUD_HOST, `cloud.${rootDomain}`, "CUMULUS_CLOUD_HOST");
  const mailHost = hostname(env.CUMULUS_MAIL_HOST, `mail.${rootDomain}`, "CUMULUS_MAIL_HOST");
  const realm = realmName(env.CUMULUS_KEYCLOAK_REALM, CUMULUS_DOMAIN_DEFAULTS.realm);
  for (const [name, host] of [
    ["CUMULUS_ID_HOST", idHost],
    ["CUMULUS_CLOUD_HOST", cloudHost],
    ["CUMULUS_MAIL_HOST", mailHost],
  ] as const) {
    if (!underRoot(host, rootDomain)) throw new Error(`${name} must be ${rootDomain} or one of its subdomains`);
  }
  const origins = {
    id: `https://${idHost}`,
    cloud: `https://${cloudHost}`,
    mail: `https://${mailHost}`,
  };
  const productOrigins = {
    metatron: `https://${hostname(env.METATRON_HOST, PRODUCT_HOST_DEFAULTS.metatron, "METATRON_HOST")}`,
  };
  const corsOrigins = [
    ...new Set([...Object.values(origins), ...Object.values(productOrigins)].map((origin) => assertExactOrigin(origin))),
  ];
  if (corsOrigins.some((origin) => origin === "*" || origin.includes("*"))) {
    throw new Error("CORS origins must be exact");
  }
  const issuer = `https://${idHost}/realms/${realm}`;
  return {
    rootDomain,
    idHost,
    cloudHost,
    mailHost,
    mailDomain: rootDomain,
    realm,
    issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    origins,
    productOrigins,
    corsOrigins,
  };
}

/** Address domain for Cumulus://ID mail, from the environment at process start. */
export const MAIL_DOMAIN = cumulusDomains().mailDomain;

export function cidIssuerMetadata(domains: CumulusDomains = cumulusDomains()): CidIssuerMetadata {
  return { issuer: domains.issuer, jwks_uri: domains.jwksUri, id_host: domains.idHost };
}

/**
 * Accept only an origin: scheme, host and optional port. Rejects wildcards,
 * credentials, paths, queries and fragments. A trailing slash is normalized away.
 */
export function assertExactOrigin(value: string): string {
  if (typeof value !== "string" || !value || value.includes("*")) {
    throw new Error("Origin must be exact, not a wildcard");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Origin must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Origin must be http or https");
  if (url.username || url.password) throw new Error("Origin must not include credentials");
  if (url.search || url.hash) throw new Error("Origin must not include a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Origin must not include a path");
  if (url.origin === "null" || url.origin.includes("*")) throw new Error("Origin must be exact, not a wildcard");
  return url.origin;
}

/**
 * Return the allowlist entry that matches `requestOrigin`, or null.
 * The returned value is the configured origin, never the raw header and never "*".
 */
export function exactCorsOrigin(requestOrigin: string | undefined, allowed: readonly string[]): string | null {
  if (!requestOrigin || requestOrigin === "*" || requestOrigin.includes("*") || requestOrigin.includes("\n") || requestOrigin.includes("\r")) {
    return null;
  }
  let origin: string;
  try {
    origin = assertExactOrigin(requestOrigin);
  } catch {
    return null;
  }
  const match = allowed.find((entry) => {
    try {
      return assertExactOrigin(entry) === origin;
    } catch {
      return false;
    }
  });
  return match && match !== "*" ? origin : null;
}

/** CORS headers for one request. Omits Allow-Origin unless the origin is an exact match. */
export function cumulusCorsHeaders(
  requestOrigin: string | undefined,
  allowed: readonly string[] = cumulusDomains().corsOrigins,
): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  const allow = exactCorsOrigin(requestOrigin, allowed);
  if (!allow) return headers;
  headers["Access-Control-Allow-Origin"] = allow;
  headers["Access-Control-Allow-Credentials"] = "true";
  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, x-cumulus, x-spectre";
  headers["Access-Control-Max-Age"] = "600";
  return headers;
}
