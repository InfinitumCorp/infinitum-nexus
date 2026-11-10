/**
 * cumuluscloud.app is the Infinitum Corporation® domain for Cumulus://ID,
 * Cumulus://Cloud, and Cumulus://Mail. The name is registered at Cloudflare,
 * which also serves DNS and HTTPS. This module only records that fact.
 * It does not call Cloudflare.
 *
 * Email is name@cumuluscloud.app. The three products are sibling hosts so one
 * passkey (relying party cumuluscloud.app) and one cookie (.cumuluscloud.app)
 * cover ID, Cloud, and Mail.
 */

export const CUMULUS_DOMAIN = "cumuluscloud.app";
export const CUMULUS_ID_HOST = "id.cumuluscloud.app";
export const CUMULUS_CLOUD_HOST = "cloud.cumuluscloud.app";
export const CUMULUS_MAIL_HOST = "mail.cumuluscloud.app";

/** Mailbox domain. Addresses look like alex@cumuluscloud.app. */
export const MAIL_DOMAIN = CUMULUS_DOMAIN;

export const CUMULUS_ID_ORIGIN = `https://${CUMULUS_ID_HOST}`;
export const CUMULUS_CLOUD_ORIGIN = `https://${CUMULUS_CLOUD_HOST}`;
export const CUMULUS_MAIL_ORIGIN = `https://${CUMULUS_MAIL_HOST}`;

/** WebAuthn relying party. The parent domain so a passkey works on every product host. */
export const CUMULUS_RP_ID = CUMULUS_DOMAIN;

/** Cumulus://ID issuer. Customer SSO still uses each organization's own issuer. */
export const CUMULUS_ISSUER = CUMULUS_ID_ORIGIN;

/** Set on cookies only when the site is actually served under cumuluscloud.app. */
export const CUMULUS_COOKIE_DOMAIN = `.${CUMULUS_DOMAIN}`;

export const CUMULUS_ORIGINS = [CUMULUS_ID_ORIGIN, CUMULUS_CLOUD_ORIGIN, CUMULUS_MAIL_ORIGIN] as const;

export interface CumulusDomain {
  domain: string;
  mailDomain: string;
  idHost: string;
  cloudHost: string;
  mailHost: string;
  idOrigin: string;
  cloudOrigin: string;
  mailOrigin: string;
  rpId: string;
  issuer: string;
  cookieDomain: string;
  origins: string[];
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function host(value: string | undefined, fallback: string, name: string): string {
  const chosen = (value ?? "").trim().toLowerCase().replace(/\.$/, "") || fallback;
  if (!HOST.test(chosen)) throw new Error(`${name} must be a hostname`);
  return chosen;
}

function httpsOrigin(value: string | undefined, fallback: string, name: string): string {
  const raw = (value ?? "").trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an https origin`);
  }
  return url.origin;
}

/** Defaults are cumuluscloud.app. Environment variables override a single process. */
export function readCumulusDomain(env: NodeJS.ProcessEnv = process.env): CumulusDomain {
  const domain = host(env.CUMULUS_DOMAIN, CUMULUS_DOMAIN, "CUMULUS_DOMAIN");
  const idHost = host(env.CUMULUS_ID_HOST, `id.${domain}`, "CUMULUS_ID_HOST");
  const cloudHost = host(env.CUMULUS_CLOUD_HOST, `cloud.${domain}`, "CUMULUS_CLOUD_HOST");
  const mailHost = host(env.CUMULUS_MAIL_HOST, `mail.${domain}`, "CUMULUS_MAIL_HOST");
  const mailDomain = host(env.CUMULUS_MAIL_DOMAIN, domain, "CUMULUS_MAIL_DOMAIN");
  const cookieRaw = (env.CUMULUS_COOKIE_DOMAIN ?? "").trim().toLowerCase();
  const cookieDomain = cookieRaw ? (cookieRaw.startsWith(".") ? cookieRaw : `.${cookieRaw}`) : `.${domain}`;
  if (!HOST.test(cookieDomain.slice(1))) throw new Error("CUMULUS_COOKIE_DOMAIN must be a hostname");
  const idOrigin = httpsOrigin(env.CUMULUS_ID_ORIGIN, `https://${idHost}`, "CUMULUS_ID_ORIGIN");
  const cloudOrigin = httpsOrigin(env.CUMULUS_CLOUD_ORIGIN, `https://${cloudHost}`, "CUMULUS_CLOUD_ORIGIN");
  const mailOrigin = httpsOrigin(env.CUMULUS_MAIL_ORIGIN, `https://${mailHost}`, "CUMULUS_MAIL_ORIGIN");
  const issuer = httpsOrigin(env.CUMULUS_ISSUER, idOrigin, "CUMULUS_ISSUER");
  return {
    domain,
    mailDomain,
    idHost,
    cloudHost,
    mailHost,
    idOrigin,
    cloudOrigin,
    mailOrigin,
    rpId: domain,
    issuer,
    cookieDomain,
    origins: [idOrigin, cloudOrigin, mailOrigin],
  };
}

/**
 * Host-only cookies on localhost. On cumuluscloud.app, Domain=.cumuluscloud.app
 * so ID, Cloud, and Mail can share a sign-in cookie.
 */
export function cookieDomainForHost(hostname: string, cookieDomain = CUMULUS_COOKIE_DOMAIN): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const bare = cookieDomain.replace(/^\./, "");
  if (!bare || host === "localhost" || host.endsWith(".localhost")) return undefined;
  if (host !== bare && !host.endsWith(`.${bare}`)) return undefined;
  return cookieDomain.startsWith(".") ? cookieDomain : `.${cookieDomain}`;
}
