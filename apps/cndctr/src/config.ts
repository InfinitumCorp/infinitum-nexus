/**
 * Process configuration for the CNDCTR server.
 * The JWT issuer defaults to the Cumulus ID Keycloak realm.
 */
import { isIP } from "node:net";

export const DEFAULT_CNDCTR_JWT_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const DEFAULT_CNDCTR_AUDIENCE = "cndctr";

const HOST = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const REALM = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CndctrConfig {
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  audience: string;
  clientSecret: string | null;
  bind: string;
  port: number;
  /** Set when `CNDCTR_PUBLIC_ORIGIN` is present. Otherwise the listener fills in the loopback origin. */
  publicOrigin: string | null;
  clockSkewSeconds: number;
}

export class CndctrConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CndctrConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CndctrConfig {
  const issuer = issuerFromEnv(env);
  const issuerUrl = parseIssuer(issuer);
  const jwksUri = endpoint(env.CNDCTR_JWKS_URI, issuerUrl, "/protocol/openid-connect/certs");
  const tokenEndpoint = endpoint(undefined, issuerUrl, "/protocol/openid-connect/token");
  const authorizationEndpoint = endpoint(undefined, issuerUrl, "/protocol/openid-connect/auth");
  const audience = clientId(env.CNDCTR_OIDC_CLIENT_ID);
  const clientSecret = optionalSecret(env.CNDCTR_OIDC_CLIENT_SECRET);
  const port = portNumber(env.PORT);
  const bind = bindAddress(env.CNDCTR_BIND);
  const publicOrigin = env.CNDCTR_PUBLIC_ORIGIN === undefined || env.CNDCTR_PUBLIC_ORIGIN.trim() === ""
    ? null
    : exactOrigin(env.CNDCTR_PUBLIC_ORIGIN);
  return {
    issuer: issuerUrl.origin + trimSlash(issuerUrl.pathname),
    jwksUri,
    tokenEndpoint,
    authorizationEndpoint,
    audience,
    clientSecret,
    bind,
    port,
    publicOrigin,
    clockSkewSeconds: 60,
  };
}

function issuerFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.CNDCTR_JWT_ISSUER;
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  if (env.CUMULUS_ID_HOST !== undefined || env.CUMULUS_KEYCLOAK_REALM !== undefined) {
    const host = hostname(env.CUMULUS_ID_HOST ?? "id.cumuluscloud.app", "CUMULUS_ID_HOST");
    const realm = realmName(env.CUMULUS_KEYCLOAK_REALM ?? "cumulus");
    return `https://${host}/realms/${realm}`;
  }
  return DEFAULT_CNDCTR_JWT_ISSUER;
}

function parseIssuer(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CndctrConfigError("CNDCTR_JWT_ISSUER must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash || raw.includes("*")) {
    throw new CndctrConfigError("CNDCTR_JWT_ISSUER must be an exact URL with no userinfo, query, fragment, or wildcard");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) {
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = trimSlash(url.pathname);
    return url;
  }
  throw new CndctrConfigError("CNDCTR_JWT_ISSUER must be https, or http on localhost");
}

function endpoint(override: string | undefined, issuer: URL, suffix: string): string {
  const value = override?.trim() || `${issuer.origin}${trimSlash(issuer.pathname)}${suffix}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CndctrConfigError("CNDCTR JWT endpoint must be an absolute URL");
  }
  if (url.origin !== issuer.origin || url.username || url.password || url.search || url.hash || value.includes("*")) {
    throw new CndctrConfigError("CNDCTR JWT endpoint must stay on the issuer origin");
  }
  return url.href;
}

function clientId(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_CNDCTR_AUDIENCE).trim();
  if (!CLIENT_ID.test(value)) throw new CndctrConfigError("CNDCTR_OIDC_CLIENT_ID must be a single token");
  return value;
}

function optionalSecret(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!value) throw new CndctrConfigError("A configured secret must not be empty");
  return value;
}

function portNumber(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === "" ? 3011 : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new CndctrConfigError("PORT must be an integer from 0 to 65535");
  return value;
}

function bindAddress(raw: string | undefined): string {
  const value = (raw ?? "127.0.0.1").trim();
  if (value === "localhost" || isIP(value) !== 0) return value;
  throw new CndctrConfigError("CNDCTR_BIND must be an IP address or localhost");
}

export function exactOrigin(raw: string): string {
  if (!raw || raw.includes("*") || /[\r\n]/.test(raw)) throw new CndctrConfigError("Origin must be exact");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CndctrConfigError("Origin must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CndctrConfigError("Origin must be https, or http on localhost");
  }
  if (url.username || url.password || url.search || url.hash) throw new CndctrConfigError("Origin must not include credentials, a query, or a fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new CndctrConfigError("Origin must not include a path");
  return url.origin;
}

function hostname(raw: string, name: string): string {
  const host = raw.trim().toLowerCase();
  if (!host || host.includes("*") || host.includes("://") || host.includes("/") || host.includes(":") || host.split(".").some((label) => !HOST.test(label))) {
    throw new CndctrConfigError(`${name} must be an exact hostname`);
  }
  return host;
}

function realmName(raw: string): string {
  const realm = raw.trim().toLowerCase();
  if (!REALM.test(realm)) throw new CndctrConfigError("CUMULUS_KEYCLOAK_REALM must be an exact realm name");
  return realm;
}

function trimSlash(path: string): string {
  return path === "/" ? "" : path.replace(/\/+$/, "");
}
