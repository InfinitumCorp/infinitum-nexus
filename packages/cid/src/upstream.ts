/**
 * Relying-party side of "Sign in with Cumulus://ID".
 *
 * id.cumuluscloud.app is the only place a cid is created. A product that keeps its own CID store
 * (Cumulus://Mail, Cumulus://Cloud) runs in upstream mode: it sends people to the issuer, trades the
 * code for the issuer's profile over a direct HTTPS call, and keeps a local mirror of that account
 * under the SAME cid. It never mints a cid of its own.
 *
 *   1. start()   -> redirect to <issuer>/api/id/authorize (code + PKCE S256). The caller keeps
 *                   `cookie` in an HttpOnly cookie, which binds the request to this browser.
 *   2. finish()  -> checks state against that cookie, POSTs <issuer>/api/id/token, validates the
 *                   profile, then revokes the issuer token (the product issues its own session).
 *   3. CidService.adoptUpstreamAccount(profile) creates or reuses the mirror and signs it in.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertExactOrigin } from "./domains.ts";

/** What the issuer's /api/id/token returns as `profile` (see profileOf in product-idp.ts). */
export interface UpstreamProfile {
  cid: string;
  username: string;
  email: string;
  handle: string;
}

export interface UpstreamIdConfig {
  /** Issuer origin, e.g. https://id.cumuluscloud.app. Must be an exact https origin (http only for localhost). */
  issuer: string;
  /** This product's client id in ID_CLIENTS, e.g. "cumulus-mail". */
  clientId: string;
  /** Where the issuer sends the code back. Must be on one of the client's registered origins. */
  redirectUri: string;
  /** Mail domain the issuer's addresses must use, e.g. cumuluscloud.app. */
  mailDomain: string;
  fetchImpl?: typeof fetch;
}

export class UpstreamIdError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const CID = /^cid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const STATE = /^[A-Za-z0-9_-]{32}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

const b64url = (bytes: Buffer) => bytes.toString("base64url");

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Reads the issuer origin from CUMULUS_ID_ISSUER. Returns undefined when upstream mode is off. */
export function upstreamIssuerFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.CUMULUS_ID_ISSUER?.trim();
  if (!raw) return undefined;
  return normalizeIssuer(raw);
}

function normalizeIssuer(raw: string): string {
  const origin = assertExactOrigin(raw.replace(/\/$/, ""));
  const url = new URL(origin);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new UpstreamIdError("invalid_issuer", "CUMULUS_ID_ISSUER must be an https origin");
  return origin;
}

/** Strict check of the issuer's profile. Anything unexpected is refused rather than repaired. */
export function parseUpstreamProfile(value: unknown, mailDomain: string): UpstreamProfile {
  const p = value as Record<string, unknown> | null;
  const cid = typeof p?.cid === "string" ? p.cid : "";
  const username = typeof p?.username === "string" ? p.username : "";
  const email = typeof p?.email === "string" ? p.email : "";
  const handle = typeof p?.handle === "string" ? p.handle : `@${username}.veil`;
  if (!CID.test(cid) || !USERNAME.test(username) || email !== `${username}@${mailDomain}`) {
    throw new UpstreamIdError("bad_profile", "Cumulus://ID returned an account this product can't use.");
  }
  return { cid, username, email, handle };
}

export class UpstreamIdClient {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  private readonly mailDomain: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: UpstreamIdConfig) {
    this.issuer = normalizeIssuer(config.issuer);
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.mailDomain = config.mailDomain;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Begin a sign-in. Store `cookie` HttpOnly for ~10 minutes and redirect to `url`. */
  start(opts: { create?: boolean } = {}): { url: string; cookie: string } {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${this.issuer}/api/id/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (opts.create) url.searchParams.set("prompt", "create");
    return { url: url.toString(), cookie: `${state}.${verifier}` };
  }

  /** Finish a sign-in from the callback's `code` and `state` plus the cookie set by start(). */
  async finish(params: { code?: string | null; state?: string | null; cookie?: string }): Promise<UpstreamProfile> {
    const [cookieState = "", verifier = ""] = (params.cookie ?? "").split(".");
    const state = params.state ?? "";
    if (!STATE.test(cookieState) || !VERIFIER.test(verifier) || !sameString(state, cookieState)) {
      throw new UpstreamIdError("challenge_expired", "Sign-in request expired. Please try again.");
    }
    const code = params.code ?? "";
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) throw new UpstreamIdError("challenge_expired", "Sign-in request expired. Please try again.");

    const res = await this.call("/api/id/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, client_id: this.clientId, redirect_uri: this.redirectUri }),
    });
    if (!res.ok) throw new UpstreamIdError("upstream_refused", "Cumulus://ID didn't accept that sign-in. Please try again.");
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; profile?: unknown } | null;
    const profile = parseUpstreamProfile(body?.profile, this.mailDomain);

    // This product issues its own session; the issuer's token is not kept anywhere.
    if (typeof body?.access_token === "string" && body.access_token.length <= 8000) {
      await this.call("/api/id/signout", { method: "POST", headers: { authorization: `Bearer ${body.access_token}` } }).catch(() => undefined);
    }
    return profile;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      // "manual": a redirect from the token endpoint is treated as a failure, never followed.
      return await this.fetchImpl(`${this.issuer}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new UpstreamIdError("upstream_unreachable", "Cumulus://ID couldn't be reached. Please try again.");
    }
  }
}
