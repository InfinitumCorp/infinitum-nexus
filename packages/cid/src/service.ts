import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Ledger, Signer, Entry } from "@infinitum/firmament";
import {
  verifyRegistration,
  verifyAssertion,
  type RegistrationResponse,
  type AssertionResponse,
} from "./webauthn.ts";
import { generateTotpSecret, verifyTotp, otpauthUri } from "./totp.ts";
import { noSecretBox, secretBox, type SecretBox } from "./secret-box.ts";
import { verifyIdToken, type SsoConfig } from "./oidc.ts";
import {
  assertExactOrigin,
  cumulusCorsHeaders,
  cumulusDomains,
  exactCorsOrigin,
  MAIL_DOMAIN,
  type CidIssuerMetadata,
} from "./domains.ts";
import {
  PROVIDERS,
  SocialClient,
  pkcePair,
  type PendingAuth,
  type SocialCredentials,
  type SocialProfile,
  type SocialProviderId,
} from "./social.ts";
import { MapCidRepository, type CidRepository } from "./repository.ts";

export { MAIL_DOMAIN };

/* ------------------------------------------------------------------ *
 * Product registry: every app a CID can sign in to and grant access to.
 * ------------------------------------------------------------------ */

export const INFINITUM_APPS = [
  "veil", "fabric", "throne", "eon", "scalvs", "architect", "spectre", "metatron",
  "cumulus", "cumulus-mail", "cumulus-cloud", "firm-wallet", "aether", "argus", "hrvst", "eidetic",
  "orbis", "pollen", "flower", "nemesis", "LBRNTH", "firm", "daemon", "slug", "seraphim", "tokens",
  "odin", "firmament", "cumulus-exchange", "cherubim", "azrail", "cloud", "conjure", "node",
] as const;
export type AppId = (typeof INFINITUM_APPS)[number];

/** Earlier ids for the same app, still accepted for one release. */
const LEGACY_APP_IDS: Record<string, AppId> = { architct: "architect", cndctr: "architect", scalus: "scalvs" };

/**
 * Canonical web origins of apps on their own domains (METATRON¹⁰⁰: https://mttrn.app).
 * Each one is in the CID CORS allowlist (domains.ts) and registers `cidRedirectUri(app, provider)`
 * with every social sign-in provider.
 */
export const APP_ORIGINS: Readonly<Partial<Record<AppId, string>>> = Object.freeze({
  metatron: cumulusDomains().productOrigins.metatron,
});

/** Social sign-in callback for an app: the same path +SPCTR and Cumulus://Mail serve. */
export function cidRedirectUri(app: AppId, provider: SocialProviderId): string {
  const origin = APP_ORIGINS[app];
  if (!origin) throw new Error(`${app} has no registered web origin`);
  return `${origin}/api/auth/oauth/${provider}/callback`;
}

/**
 * What every new CID comes with, per the Cumulus://ID page. Like a Google account and Gmail,
 * every CID gets a Cumulus://Mail address, a Cumulus://Cloud drive and a FIRM Wallet on the free tier.
 */
export const FREE_ENTITLEMENTS = {
  storageGb: 15, // shared by Cumulus://Cloud (Drive) and Cumulus://Mail
  mail: true,
  cloud: true,
  firmWallet: true,
  scalvs: "free",
  architect: "free",
  metatronDashboard: true,
} as const;

/* ------------------------------------------------------------------ *
 * Data model
 * ------------------------------------------------------------------ */

export interface Account {
  cid: string;
  username: string;
  /** e.g. alex@cumuluscloud.app */
  mailAddress: string;
  /** Ecosystem handle, e.g. @alex.veil */
  handle: string;
  orgId?: string;
  /** Link to the organization identity provider, for SSO members. */
  federated?: { issuer: string; subject: string };
  /** Set on a product's local mirror of an account issued by Cumulus://ID (see adoptUpstreamAccount). */
  upstream?: { issuer: string; adoptedAt: string };
  /** Google, GitHub, Microsoft, Apple, ChatGPT or Amazon Cognito accounts linked for sign-in. */
  identities?: LinkedIdentity[];
  createdAt: string;
  entitlements: typeof FREE_ENTITLEMENTS;
  totp?: { secret: string; confirmed: boolean; lastStep: number };
}

export interface LinkedIdentity {
  provider: SocialProviderId;
  subject: string;
  /** Shown in the account's settings so people can tell linked accounts apart. */
  email?: string;
  linkedAt: string;
}

export type SessionMethod =
  | "passkey" | "security-key" | "sso" | "passkey+totp"
  | `social:${SocialProviderId}` | `social:${SocialProviderId}+totp`
  | "device-handoff"
  /** Signed in at the Cumulus://ID issuer; this product holds a local mirror of the account. */
  | "cumulus-id"
  /** Signed in at the standalone Cumulus://ID issuer; this host is its OpenID Connect client. */
  | "oidc";

export interface Authenticator {
  id: string;
  cid: string;
  kind: "passkey" | "security-key";
  label: string;
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  backedUp: boolean;
  addedAt: string;
  lastUsedAt?: string;
}

export interface Session {
  id: string;
  cid: string;
  tokenHash: string;
  device: string;
  method: SessionMethod;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** "oidc" sessions: the issuer's ID token, sent back as id_token_hint at sign-out. */
  idTokenHint?: string;
}

export interface Grant {
  cid: string;
  app: AppId;
  scopes: string[];
  grantedAt: string;
  /** Firmament entry hash proving when this grant was made. */
  ledgerHash: string;
}

export interface Organization {
  id: string;
  name: string;
  admins: string[];
  sso?: SsoConfig & { emailDomain?: string };
  /**
   * "issuer": the standalone Cumulus://ID issuer reports this organization (org_id in its ID
   * tokens), so membership and admins follow the issuer. Unset: the organization exists only here.
   */
  source?: "issuer";
}

interface Challenge {
  value: string;
  cid?: string;
  purpose: "register" | "login";
  expiresAt: number;
}

interface PendingMfa {
  cid: string;
  method: SessionMethod;
  device: string;
  expiresAt: number;
}

/**
 * A one-time code that moves a sign-in from the browser to a native app on the same computer
 * (RFC 8252 style). The app keeps a secret verifier and sends only its SHA-256 (the challenge);
 * the code is useless without the verifier, so a code caught on its way to the app can't be used.
 */
interface DeviceHandoff {
  cid: string;
  challenge: string;
  app: string;
  expiresAt: number;
  /** How the browser session was created: google, cognito, passkey, or another provider id. */
  idp?: string;
  /** OpenID Connect nonce, returned on the ID token when the product sent one. */
  nonce?: string;
  /** Checked when the token request repeats it (the OpenID Connect token endpoint does). */
  redirectUri?: string;
}

/**
 * A sign-in this host started at the standalone Cumulus://ID issuer (OpenID Connect client mode).
 * Kept server side, keyed by the SHA-256 of `state`, and taken once by the callback.
 */
export interface IssuerLogin {
  nonce: string;
  /** PKCE code_verifier. */
  verifier: string;
  redirectUri: string;
  /** Same-origin path to return to after sign-in. */
  next?: string;
  expiresAt: number;
}

/** Claims of a verified ID token from the standalone Cumulus://ID issuer. */
export interface IssuerClaims {
  sub: string;
  preferred_username?: unknown;
  username?: unknown;
  handle?: unknown;
  email?: unknown;
  /** With the profile scope: the person's organization at the issuer (org_<uuid>), its name and their role. */
  org_id?: unknown;
  org_name?: unknown;
  org_role?: unknown;
  [k: string]: unknown;
}

/** Short-lived, single-use items, by kind (see CidRepository's one-time methods). */
export interface CidOneTime {
  challenge: Challenge;
  mfa: PendingMfa;
  oauth: PendingAuth;
  handoff: DeviceHandoff;
  /** A sign-in this host started at the standalone issuer (OpenID Connect client mode). */
  issuer: IssuerLogin;
}

/** How long a browser-to-app sign-in code stays valid. */
export const DEVICE_HANDOFF_TTL_MS = 2 * 60_000;

/** Storage boundary. In-memory here; a Postgres implementation on Cumulus Database slots in behind it. */
export class CidStore {
  accounts = new Map<string, Account>();
  byUsername = new Map<string, string>();
  byFederation = new Map<string, string>();
  authenticators = new Map<string, Authenticator>();
  byCredentialId = new Map<string, string>();
  sessions = new Map<string, Session>();
  byTokenHash = new Map<string, string>();
  grants = new Map<string, Grant>(); // key: `${cid}|${app}`
  orgs = new Map<string, Organization>();
  challenges = new Map<string, Challenge>();
  pendingMfa = new Map<string, PendingMfa>();
  byIdentity = new Map<string, string>(); // `${provider}|${subject}` -> cid
  oauthPending = new Map<string, PendingAuth>();
  deviceHandoffs = new Map<string, DeviceHandoff>(); // key: SHA-256 of the code
  issuerLogins = new Map<string, IssuerLogin>(); // key: SHA-256 of the state
}

/* ------------------------------------------------------------------ */

export interface CidConfig {
  ledger: Ledger;
  signer: Signer;
  /** WebAuthn relying party ID, e.g. "id.cumuluscloud.app". */
  rpId: string;
  /** Exact origins allowed to run passkey ceremonies. Wildcards are rejected. */
  origins: string[];
  store?: CidStore;
  /**
   * Where accounts, sessions, keys and grants live. Defaults to MapCidRepository over `store`
   * (in memory). A database-backed repository replaces it without changing sign-in logic.
   */
  repository?: CidRepository;
  /**
   * 32-byte key that seals authenticator-app seeds at rest (AES-256-GCM, bound to the account).
   * Without it they are stored as they are, as before. See secret-box.ts.
   */
  secretKey?: Buffer;
  clock?: () => Date;
  sessionDays?: number;
  /** Social sign-in providers with their client credentials. Only configured ones are offered. */
  social?: { providers: Partial<Record<SocialProviderId, SocialCredentials>>; fetchImpl?: typeof fetch };
  /**
   * Account events for the rest of the suite: Cumulus://Mail provisions a mailbox on
   * "account.created" and sends security notices for sign-ins, keys and MFA changes.
   * A failing listener never blocks sign-in.
   */
  onEvent?: (event: CidEvent) => void | Promise<void>;
  /**
   * Upstream mode. When set to the Cumulus://ID issuer origin (https://id.cumuluscloud.app), this
   * service never creates an account of its own: createAccount, new social sign-ins and new SSO
   * members are refused, and accounts arrive only through adoptUpstreamAccount with the issuer's cid.
   * Accounts that already exist locally keep signing in.
   */
  upstreamIssuer?: string;
}

export type CidEventName =
  | "account.created"
  | "authenticator.added"
  | "authenticator.removed"
  | "session.created"
  | "session.revoked_all"
  | "mfa.enabled"
  | "mfa.disabled"
  | "identity.linked"
  | "identity.unlinked";

export interface CidEvent {
  event: CidEventName;
  cid: string;
  at: string;
  /** Event details safe to show the account owner (device, method, key kind, provider). */
  detail: Record<string, string | number>;
}

export class CidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
// Includes the Cumulus://Mail product senders, so no person can register an address that
// looks like a security notice or a wallet receipt.
const RESERVED = new Set([
  "admin", "root", "support", "security", "odin", "infinitum", "postmaster", "abuse",
  "welcome", "cloud", "wallet", "ledger", "noreply", "no-reply", "mail", "cumulus", "firm",
]);
const CHALLENGE_TTL_MS = 5 * 60_000;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class CidService {
  readonly store: CidStore;
  /** Keycloak issuer for Cumulus://ID, https://id.cumuluscloud.app/realms/cumulus by default. */
  readonly issuer: string;
  /** JWKS URI for `issuer`. */
  readonly jwksUri: string;
  /** Email domain, cumuluscloud.app by default. */
  readonly mailDomain: string;
  /** Exact CORS origins for ID, Cloud and Mail. Never a wildcard. */
  readonly corsOrigins: readonly string[];
  private readonly cfg: Required<Omit<CidConfig, "store" | "repository" | "secretKey" | "social" | "onEvent" | "upstreamIssuer">>;
  /** Every read and write of CID data goes through here. */
  readonly repo: CidRepository;
  readonly #secrets: SecretBox;
  /** Issuer origin when this service only mirrors accounts from Cumulus://ID; undefined when it issues its own. */
  readonly upstreamIssuer?: string;
  private readonly socialProviders: Partial<Record<SocialProviderId, SocialCredentials>>;
  private readonly socialClient: SocialClient;
  private readonly onEvent?: CidConfig["onEvent"];

  constructor(config: CidConfig) {
    this.onEvent = config.onEvent;
    this.upstreamIssuer = config.upstreamIssuer ? config.upstreamIssuer.replace(/\/$/, "") : undefined;
    this.store = config.store ?? new CidStore();
    this.repo = config.repository ?? new MapCidRepository(this.store);
    this.#secrets = config.secretKey ? secretBox(config.secretKey) : noSecretBox;
    const domains = cumulusDomains();
    this.issuer = domains.issuer;
    this.jwksUri = domains.jwksUri;
    this.mailDomain = domains.mailDomain;
    this.corsOrigins = domains.corsOrigins;
    this.cfg = {
      ledger: config.ledger,
      signer: config.signer,
      rpId: config.rpId,
      origins: config.origins.map((origin) => {
        try {
          return assertExactOrigin(origin);
        } catch (err) {
          throw new CidError("invalid_origin", err instanceof Error ? err.message : "Origin must be exact");
        }
      }),
      clock: config.clock ?? (() => new Date()),
      sessionDays: config.sessionDays ?? 30,
    };
    this.socialProviders = config.social?.providers ?? {};
    this.socialClient = new SocialClient(config.social?.fetchImpl);
  }

  private now() {
    return this.cfg.clock();
  }

  /**
   * A synchronous view of the in-memory store, for subsystems that authorize synchronously inside
   * one call (Labyrinth's CidLabyrinth). Valid only while this service runs on the in-memory
   * CidStore; a database-backed deployment resolves the caller first (LabyrinthHost) and hands
   * Labyrinth a per-request view instead. Everything else uses the async methods.
   */
  syncView() {
    if (!(this.repo instanceof MapCidRepository) || this.repo.store !== this.store) {
      throw new CidError("sync_unavailable", "A synchronous CID view needs the in-memory store; resolve the caller first instead");
    }
    return {
      authenticate: (token: string) => this.authenticateNow(token),
      isSessionActive: (cid: string, sessionId: string) => this.isSessionActiveNow(cid, sessionId),
      organizationMembership: (cid: string) => this.organizationMembershipNow(cid),
      can: (cid: string, app: string, scope: string) => this.canNow(cid, app, scope),
      permissions: (cid: string) => this.permissionsNow(cid),
      createOrganization: (name: string, adminCid: string) => this.createOrganization(name, adminCid),
      grant: (cid: string, app: string, scopes: string[]) => this.grant(cid, app, scopes),
    };
  }

  /** Issuer and JWKS for Cumulus://ID. The issuer string has no trailing slash. */
  issuerMetadata(): CidIssuerMetadata {
    return { issuer: this.issuer, jwks_uri: this.jwksUri, id_host: new URL(this.issuer).host };
  }

  /** Allowlisted origin for this request, or null. Never "*". */
  corsAllowOrigin(requestOrigin: string | undefined): string | null {
    return exactCorsOrigin(requestOrigin, this.corsOrigins);
  }

  /** CORS headers for a browser call. Allow-Origin is set only for an exact match. */
  corsHeaders(requestOrigin: string | undefined): Record<string, string> {
    return cumulusCorsHeaders(requestOrigin, this.corsOrigins);
  }

  private record(type: Entry["type"], actor: string, subject: string, payload: Record<string, unknown>) {
    return this.cfg.ledger.append({ type, product: "cid", actor, subject, payload }, this.cfg.signer);
  }

  private async emit(event: CidEventName, cid: string, detail: CidEvent["detail"] = {}) {
    if (!this.onEvent) return;
    try {
      await this.onEvent({ event, cid, at: this.now().toISOString(), detail });
    } catch (err) {
      console.error(`CID event listener failed for ${event}:`, err);
    }
  }

  private async account(cid: string): Promise<Account> {
    const a = await this.repo.account(cid);
    if (!a) throw new CidError("not_found", "No such CID");
    return a;
  }

  /** In-memory only, for syncView(). */
  private accountNow(cid: string): Account {
    const a = this.store.accounts.get(cid);
    if (!a) throw new CidError("not_found", "No such CID");
    return a;
  }

  /* ---------------- Accounts ---------------- */

  async createAccount(input: { username: string; orgId?: string; accountType?: string }): Promise<Account> {
    if (this.upstreamIssuer) {
      throw new CidError("signup_at_issuer", `New Cumulus://IDs are created at ${this.upstreamIssuer}. Sign in there and you'll come straight back.`);
    }
    if (input.accountType === "odin" || input.accountType === "military") {
      throw new CidError("odin_separate", "ODIN° accounts are issued separately, outside consumer accounts");
    }
    const username = input.username.trim().toLowerCase();
    if (!USERNAME.test(username)) {
      throw new CidError("invalid_username", "Usernames are 3-30 characters: letters, numbers, dot, dash, underscore");
    }
    if (RESERVED.has(username)) throw new CidError("reserved", "That username is reserved");
    if (await this.repo.cidForUsername(username)) throw new CidError("taken", "That username is taken");

    const account: Account = {
      cid: `cid_${randomUUID()}`,
      username,
      mailAddress: `${username}@${this.mailDomain}`,
      handle: `@${username}.veil`,
      orgId: input.orgId,
      createdAt: this.now().toISOString(),
      entitlements: FREE_ENTITLEMENTS,
    };
    return this.insertAccount(account, { event: "account.created", org: input.orgId ?? null });
  }

  private async insertAccount(account: Account, ledgerPayload: Record<string, unknown>): Promise<Account> {
    await this.repo.putAccount(account);
    // Only the event is recorded; the CID is never sold and personal details stay off the ledger.
    await this.record("identity", account.cid, account.cid, ledgerPayload);
    await this.emit("account.created", account.cid);
    return account;
  }

  /**
   * Upstream mode: sign in a person whose account was issued by Cumulus://ID. The profile must come
   * from the issuer's token endpoint over a direct call (UpstreamIdClient.finish), never from the
   * browser. The local account keeps the issuer's cid, so Mail, Cloud and Wallet line up with every
   * other product. A local account that already uses the same username under a different cid (a
   * Mail-only account from before the cutover) is never merged automatically.
   */
  async adoptUpstreamAccount(
    profile: { cid: string; username: string; email: string; handle: string },
    device: string,
  ): Promise<{ token: string; session: Session; created: boolean }> {
    const issuer = this.upstreamIssuer;
    if (!issuer) throw new CidError("upstream_off", "This product issues its own Cumulus://IDs");
    const username = profile.username.toLowerCase();
    if (!/^cid_[0-9a-f-]{36}$/.test(profile.cid) || !USERNAME.test(username) || profile.email !== `${username}@${this.mailDomain}`) {
      throw new CidError("bad_profile", "Cumulus://ID returned an account this product can't use.");
    }
    let created = false;
    const existing = await this.repo.account(profile.cid);
    if (existing) {
      if (existing.username !== username) {
        throw new CidError("username_conflict", "This Cumulus://ID doesn't match the account stored here. Contact support.");
      }
      if (!existing.upstream) {
        existing.upstream = { issuer, adoptedAt: this.now().toISOString() };
        await this.repo.putAccount(existing);
      }
    } else {
      const holder = await this.repo.cidForUsername(username);
      if (holder && holder !== profile.cid) {
        throw new CidError(
          "username_conflict",
          `${username}@${this.mailDomain} belongs to an older account on this service. Sign in with your passkey here, or contact support to move it to your Cumulus://ID.`,
        );
      }
      const now = this.now().toISOString();
      await this.insertAccount(
        {
          cid: profile.cid,
          username,
          mailAddress: `${username}@${this.mailDomain}`,
          handle: /^@[a-z0-9._-]{3,40}$/.test(profile.handle) ? profile.handle : `@${username}.veil`,
          createdAt: now,
          entitlements: FREE_ENTITLEMENTS,
          upstream: { issuer, adoptedAt: now },
        },
        { event: "account.adopted", issuer },
      );
      created = true;
    }
    const issued = await this.issueSession(profile.cid, device, "cumulus-id");
    return { ...issued, created };
  }

  async getAccount(cid: string): Promise<Account> {
    return this.account(cid);
  }

  /** The account, or undefined when there is no such CID (getAccount throws instead). */
  async findAccount(cid: string): Promise<Account | undefined> {
    return this.repo.account(cid);
  }

  /** The CID holding `username`, if any. */
  async cidForUsername(username: string): Promise<string | undefined> {
    return this.repo.cidForUsername(username.toLowerCase());
  }

  /** Every account, oldest first. For backfills and admin jobs, not per-request paths. */
  async allAccounts(): Promise<Account[]> {
    return this.repo.allAccounts();
  }

  /* ---------------- Passkeys & security keys ---------------- */

  private async issueChallenge(purpose: Challenge["purpose"], cid?: string): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    // Anyone can start a sign-in, so unfinished challenges are cleared as new ones are made.
    await this.repo.sweepOneTime("challenge", this.now().getTime());
    await this.repo.putOneTime("challenge", value, { value, cid, purpose, expiresAt: this.now().getTime() + CHALLENGE_TTL_MS });
    return value;
  }

  private async takeChallenge(clientDataJSON: string, purpose: Challenge["purpose"]): Promise<Challenge> {
    let challenge: string;
    try {
      challenge = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")).challenge;
    } catch {
      throw new CidError("bad_request", "Malformed client data");
    }
    const c = await this.repo.takeOneTime("challenge", challenge); // single use
    if (!c || c.purpose !== purpose || c.expiresAt < this.now().getTime()) {
      throw new CidError("challenge_expired", "Sign-in request expired. Please try again.");
    }
    return c;
  }

  /** Options for navigator.credentials.create() in the browser. */
  async startAuthenticatorRegistration(cid: string, kind: Authenticator["kind"] = "passkey") {
    const account = await this.account(cid);
    const existing = await this.repo.authenticatorsOf(cid);
    return {
      challenge: await this.issueChallenge("register", cid),
      rp: { id: this.cfg.rpId, name: "Infinitum" },
      user: { id: Buffer.from(cid).toString("base64url"), name: account.mailAddress, displayName: account.username },
      pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        residentKey: kind === "passkey" ? "required" : "discouraged",
        userVerification: kind === "passkey" ? "required" : "preferred",
      },
      excludeCredentials: existing.map((a) => ({ type: "public-key", id: a.credentialId })),
      attestation: "none",
      timeout: CHALLENGE_TTL_MS,
    };
  }

  async finishAuthenticatorRegistration(
    cid: string,
    response: RegistrationResponse,
    meta: { kind?: Authenticator["kind"]; label?: string } = {},
  ): Promise<Authenticator> {
    const challenge = await this.takeChallenge(response.clientDataJSON, "register");
    if (challenge.cid !== cid) throw new CidError("challenge_expired", "Registration request does not match this account");
    const kind = meta.kind ?? "passkey";
    let verified;
    try {
      verified = verifyRegistration(response, {
        challenge: challenge.value,
        origins: this.cfg.origins,
        rpId: this.cfg.rpId,
        requireUserVerification: kind === "passkey",
      });
    } catch (err) {
      throw new CidError("webauthn_failed", (err as Error).message);
    }
    if (await this.repo.authenticatorByCredential(verified.credentialId)) {
      throw new CidError("duplicate", "This key is already registered");
    }
    const auth: Authenticator = {
      id: `auth_${randomUUID()}`,
      cid,
      kind,
      label: meta.label ?? (kind === "passkey" ? "Passkey" : "Security key"),
      credentialId: verified.credentialId,
      publicKeyCose: verified.publicKeyCose,
      signCount: verified.signCount,
      backedUp: verified.backedUp,
      addedAt: this.now().toISOString(),
    };
    await this.repo.putAuthenticator(auth);
    await this.record("audit", cid, cid, { event: "authenticator.added", kind, authenticator: auth.id });
    await this.emit("authenticator.added", cid, { kind, label: auth.label });
    return auth;
  }

  async listAuthenticators(cid: string): Promise<Omit<Authenticator, "publicKeyCose">[]> {
    return (await this.repo.authenticatorsOf(cid)).map(({ publicKeyCose: _k, ...rest }) => rest);
  }

  async removeAuthenticator(cid: string, authenticatorId: string) {
    const auth = await this.repo.authenticator(authenticatorId);
    if (!auth || auth.cid !== cid) throw new CidError("not_found", "No such key on this account");
    const acct = await this.account(cid);
    if ((await this.listAuthenticators(cid)).length === 1 && !acct.federated && !acct.identities?.length) {
      throw new CidError("last_key", "Add another passkey or security key before removing your last one");
    }
    await this.repo.deleteAuthenticator(auth);
    await this.record("audit", cid, cid, { event: "authenticator.removed", authenticator: authenticatorId });
    await this.emit("authenticator.removed", cid, { kind: auth.kind, label: auth.label });
  }

  /** Options for navigator.credentials.get(). Omit the username for discoverable passkey sign-in. */
  async startSignIn(username?: string) {
    let allowCredentials: { type: string; id: string }[] = [];
    if (username) {
      const cid = await this.repo.cidForUsername(username.toLowerCase());
      // Unknown usernames get the same response shape so accounts can't be enumerated.
      if (cid) {
        allowCredentials = (await this.repo.authenticatorsOf(cid)).map((a) => ({ type: "public-key", id: a.credentialId }));
      }
    }
    return {
      challenge: await this.issueChallenge("login"),
      rpId: this.cfg.rpId,
      allowCredentials,
      userVerification: "preferred",
      timeout: CHALLENGE_TTL_MS,
    };
  }

  async finishSignIn(
    response: AssertionResponse,
    device: string,
  ): Promise<{ status: "ok"; token: string; session: Session } | { status: "mfa_required"; mfaToken: string }> {
    const challenge = await this.takeChallenge(response.clientDataJSON, "login");
    const auth = await this.repo.authenticatorByCredential(response.credentialId);
    if (!auth) throw new CidError("unknown_key", "This key isn't registered to a CID");

    let result;
    try {
      result = verifyAssertion(response, auth, { challenge: challenge.value, origins: this.cfg.origins, rpId: this.cfg.rpId });
    } catch (err) {
      await this.record("audit", auth.cid, auth.cid, { event: "signin.failed", authenticator: auth.id, reason: (err as Error).message });
      throw new CidError("webauthn_failed", (err as Error).message);
    }
    auth.signCount = result.signCount;
    auth.lastUsedAt = this.now().toISOString();
    await this.repo.putAuthenticator(auth);

    const account = await this.account(auth.cid);
    // A user-verified passkey (biometric or PIN on the device) is already two factors.
    // A security key tap without verification needs the authenticator-app code too.
    if (account.totp?.confirmed && !result.userVerified) {
      const mfaToken = randomBytes(24).toString("base64url");
      await this.repo.sweepOneTime("mfa", this.now().getTime());
      await this.repo.putOneTime("mfa", mfaToken, { cid: account.cid, method: "passkey+totp", device, expiresAt: this.now().getTime() + CHALLENGE_TTL_MS });
      return { status: "mfa_required", mfaToken };
    }
    const issued = await this.issueSession(account.cid, device, auth.kind);
    return { status: "ok", ...issued };
  }

  async completeMfa(mfaToken: string, code: string) {
    const pending = await this.repo.peekOneTime("mfa", mfaToken);
    if (!pending || pending.expiresAt < this.now().getTime()) {
      await this.repo.deleteOneTime("mfa", mfaToken);
      throw new CidError("challenge_expired", "Sign-in request expired. Please try again.");
    }
    const account = await this.account(pending.cid);
    const step = account.totp ? verifyTotp(this.totpSecret(account), code, this.now(), account.totp.lastStep) : null;
    if (step === null) {
      await this.record("audit", account.cid, account.cid, { event: "mfa.failed" });
      throw new CidError("mfa_failed", "That code didn't match");
    }
    account.totp = { ...account.totp!, secret: this.#sealed(account), lastStep: step };
    await this.repo.putAccount(account);
    await this.repo.deleteOneTime("mfa", mfaToken);
    return this.issueSession(account.cid, pending.device, pending.method);
  }

  /* ---------------- Multifactor (authenticator app) ---------------- */

  /** The account's authenticator-app seed in the clear (for verifying codes and the account export). */
  totpSecret(account: Account): string {
    if (!account.totp) throw new CidError("not_enrolled", "Multifactor is not on");
    return this.#secrets.open(account.totp.secret, account.cid);
  }

  /** The stored seed, sealed if it wasn't yet (values written before a key was configured). */
  #sealed(account: Account): string {
    const stored = account.totp!.secret;
    return this.#secrets.isPlain(stored) ? this.#secrets.seal(stored, account.cid) : stored;
  }

  async enrollTotp(cid: string) {
    const account = await this.account(cid);
    if (account.totp?.confirmed) throw new CidError("already_enabled", "Multifactor is already on");
    const secret = generateTotpSecret();
    account.totp = { secret: this.#secrets.seal(secret, account.cid), confirmed: false, lastStep: -1 };
    await this.repo.putAccount(account);
    return { secret, uri: otpauthUri(secret, account.mailAddress) };
  }

  async confirmTotp(cid: string, code: string) {
    const account = await this.account(cid);
    if (!account.totp) throw new CidError("not_enrolled", "Start multifactor setup first");
    const step = verifyTotp(this.totpSecret(account), code, this.now(), account.totp.lastStep);
    if (step === null) throw new CidError("mfa_failed", "That code didn't match");
    account.totp = { ...account.totp, secret: this.#sealed(account), confirmed: true, lastStep: step };
    await this.repo.putAccount(account);
    await this.record("audit", cid, cid, { event: "mfa.enabled", method: "totp" });
    await this.emit("mfa.enabled", cid, { method: "authenticator app" });
  }

  async disableTotp(cid: string, code: string) {
    const account = await this.account(cid);
    if (!account.totp?.confirmed) throw new CidError("not_enrolled", "Multifactor is not on");
    if (verifyTotp(this.totpSecret(account), code, this.now(), account.totp.lastStep) === null) {
      throw new CidError("mfa_failed", "That code didn't match");
    }
    account.totp = undefined;
    await this.repo.putAccount(account);
    await this.record("audit", cid, cid, { event: "mfa.disabled", method: "totp" });
    await this.emit("mfa.disabled", cid, { method: "authenticator app" });
  }

  /* ---------------- Sessions ---------------- */

  private async issueSession(cid: string, device: string, method: SessionMethod) {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const session: Session = {
      id: `ses_${randomUUID()}`,
      cid,
      tokenHash: hashToken(token), // raw tokens are never stored
      device,
      method,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.cfg.sessionDays * 86_400_000).toISOString(),
    };
    await this.repo.putSession(session);
    await this.record("audit", cid, cid, { event: "session.created", session: session.id, method });
    await this.emit("session.created", cid, { device, method, session: session.id });
    return { token, session };
  }

  /**
   * Browser side of signing in a native app: someone already signed in approves the app, and gets a
   * one-time code to hand it. `challenge` is base64url(SHA-256(verifier)) from the app.
   */
  async grantDeviceHandoff(cid: string, challenge: string, app: string, meta?: { idp?: string; nonce?: string; redirectUri?: string }) {
    await this.account(cid);
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new CidError("invalid_request", "The app's sign-in request isn't valid. Start again from the app.");
    const now = this.now().getTime();
    await this.repo.sweepOneTime("handoff", now);
    const code = randomBytes(32).toString("base64url");
    const idp = meta?.idp && /^[a-z0-9_-]{1,32}$/.test(meta.idp) ? meta.idp : undefined;
    await this.repo.putOneTime("handoff", hashToken(code), {
      cid, challenge, app, expiresAt: now + DEVICE_HANDOFF_TTL_MS, idp, nonce: meta?.nonce, redirectUri: meta?.redirectUri,
    });
    await this.record("audit", cid, cid, { event: "device_handoff.granted", app });
    return { code };
  }

  /** App side: trade the code plus the verifier for a session of its own. Each code works once. */
  async redeemDeviceHandoff(code: string, verifier: string, device: string) {
    const key = hashToken(code);
    const handoff = await this.repo.takeOneTime("handoff", key); // single use, even when the verifier is wrong
    const expected = handoff ? Buffer.from(handoff.challenge) : Buffer.alloc(0);
    const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
    if (!handoff || handoff.expiresAt < this.now().getTime() || verifier.length < 43 || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new CidError("challenge_expired", "That sign-in link expired. Start again from the app.");
    }
    const issued = await this.issueSession(handoff.cid, device, "device-handoff");
    return { ...issued, app: handoff.app, idp: handoff.idp ?? "passkey", nonce: handoff.nonce, redirectUri: handoff.redirectUri };
  }

  /** Called by every Infinitum product on each request. Returns null for unknown, expired or revoked tokens. */
  async authenticate(token: string): Promise<{ account: Account; session: Session } | null> {
    const session = await this.repo.sessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || new Date(session.expiresAt) <= this.now()) return null;
    const account = await this.repo.account(session.cid);
    return account ? { account, session } : null;
  }

  private authenticateNow(token: string): { account: Account; session: Session } | null {
    const id = this.store.byTokenHash.get(hashToken(token));
    const session = id ? this.store.sessions.get(id) : undefined;
    if (!session || session.revokedAt || new Date(session.expiresAt) <= this.now()) return null;
    return { account: this.accountNow(session.cid), session };
  }

  async listSessions(cid: string): Promise<Omit<Session, "tokenHash" | "idTokenHint">[]> {
    return (await this.repo.sessionsOf(cid))
      .filter((s) => !s.revokedAt && new Date(s.expiresAt) > this.now())
      .map(({ tokenHash: _t, idTokenHint: _i, ...rest }) => rest);
  }

  /* ---------------- OpenID Connect client mode (standalone Cumulus://ID issuer) ---------------- */

  /** Keeps a started issuer sign-in until its callback (a single-use "issuer" item). Expired ones are swept. */
  async rememberIssuerLogin(state: string, login: Omit<IssuerLogin, "expiresAt">, ttlMs = 10 * 60_000) {
    const now = this.now().getTime();
    await this.repo.sweepOneTime("issuer", now);
    await this.repo.putOneTime("issuer", hashToken(state), { ...login, expiresAt: now + ttlMs });
  }

  /** The sign-in started with `state`, once: a second call, or an expired one, returns null. */
  async takeIssuerLogin(state: string): Promise<IssuerLogin | null> {
    const login = await this.repo.takeOneTime("issuer", hashToken(state));
    return login && login.expiresAt >= this.now().getTime() ? login : null;
  }

  /**
   * Session for someone the issuer signed in. The caller has already verified the ID token
   * (signature, iss, aud, exp, nonce). The local account is keyed by `sub`, which is the same
   * cid this store uses; it is created from the claims on first sign-in, so grants, workspaces
   * and CRM data keyed by cid keep working.
   */
  async signInFromIssuer(claims: IssuerClaims, device: string, idToken?: string): Promise<{ token: string; session: Session; created: boolean }> {
    const cid = claims.sub;
    if (typeof cid !== "string" || !/^cid_[0-9a-f-]{36}$/.test(cid)) throw new CidError("invalid_subject", "The ID token's subject is not a Cumulus://ID");
    let created = false;
    if (!(await this.repo.account(cid))) {
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const wanted = str(claims.preferred_username || claims.username).trim().toLowerCase();
      const username = USERNAME.test(wanted) && !RESERVED.has(wanted) && !(await this.repo.cidForUsername(wanted))
        ? wanted
        : await this.freeUsername(wanted || "member");
      const email = str(claims.email).toLowerCase();
      const handle = str(claims.handle);
      await this.insertAccount({
        cid,
        username,
        mailAddress: email.endsWith(`@${this.mailDomain}`) ? email : `${username}@${this.mailDomain}`,
        handle: /^@[a-z0-9._-]{1,64}$/.test(handle) ? handle : `@${username}.veil`,
        createdAt: this.now().toISOString(),
        entitlements: FREE_ENTITLEMENTS,
      }, { event: "account.created", org: null, via: "issuer" });
      created = true;
    }
    await this.syncIssuerOrg(cid, claims);
    const issued = await this.issueSession(cid, device, "oidc");
    if (idToken) {
      issued.session.idTokenHint = idToken;
      await this.repo.putSession(issued.session);
    }
    return { ...issued, created };
  }

  /**
   * Organization membership from the issuer's org_id / org_name / org_role claims. The local
   * organization is created if missing, the account joins it, and the local admin list follows
   * org_role. Without org_id, a membership is cleared only when it came from the issuer: an
   * organization that exists only here is left alone. Every change is written back through the
   * repository (in-memory store or Postgres).
   */
  private async syncIssuerOrg(cid: string, claims: IssuerClaims) {
    const account = await this.account(cid);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const orgId = str(claims.org_id);
    const leave = async (org: Organization | undefined) => {
      if (org && org.admins.includes(cid)) {
        org.admins = org.admins.filter((a) => a !== cid);
        await this.repo.putOrg(org);
      }
    };
    if (!/^org_[0-9a-f-]{36}$/.test(orgId)) {
      const current = account.orgId ? await this.repo.org(account.orgId) : undefined;
      if (current?.source === "issuer") {
        await leave(current);
        account.orgId = undefined;
        await this.repo.putAccount(account);
        await this.record("audit", cid, current.id, { event: "org.member_left", via: "issuer" });
      }
      return;
    }
    const name = str(claims.org_name).slice(0, 120);
    let org = await this.repo.org(orgId);
    if (!org) {
      org = { id: orgId, name: name || orgId, admins: [], source: "issuer" };
      await this.repo.putOrg(org);
      await this.record("identity", cid, orgId, { event: "org.created", via: "issuer" });
    } else {
      // The issuer now reports it, so it follows the issuer from here on.
      org.source = "issuer";
      if (name) org.name = name;
      await this.repo.putOrg(org);
    }
    if (account.orgId && account.orgId !== orgId) await leave(await this.repo.org(account.orgId));
    if (account.orgId !== orgId) {
      account.orgId = orgId;
      await this.repo.putAccount(account);
    }
    const admin = str(claims.org_role) === "admin";
    const wasAdmin = org.admins.includes(cid);
    if (admin && !wasAdmin) org.admins = [...org.admins, cid];
    if (!admin && wasAdmin) org.admins = org.admins.filter((a) => a !== cid);
    if (admin !== wasAdmin) {
      await this.repo.putOrg(org);
      await this.record("audit", cid, orgId, { event: admin ? "org.admin_added" : "org.admin_removed", via: "issuer" });
    }
  }

  async revokeSession(cid: string, sessionId: string, actor = cid) {
    const s = await this.repo.session(sessionId);
    if (!s || s.cid !== cid) throw new CidError("not_found", "No such session");
    if (!s.revokedAt) {
      s.revokedAt = this.now().toISOString();
      await this.repo.putSession(s);
      await this.record("audit", actor, cid, { event: "session.revoked", session: sessionId });
    }
  }

  /** "Sign out everywhere", optionally keeping the current device signed in. */
  async revokeAllSessions(cid: string, keepSessionId?: string, actor = cid) {
    let count = 0;
    for (const s of await this.repo.sessionsOf(cid)) {
      if (!s.revokedAt && s.id !== keepSessionId) {
        s.revokedAt = this.now().toISOString();
        await this.repo.putSession(s);
        count++;
      }
    }
    await this.record("audit", actor, cid, { event: "session.revoked_all", count });
    await this.emit("session.revoked_all", cid, { count, by: actor === cid ? "you" : "your organization admin" });
    return count;
  }

  /* ---------------- Social sign-in ---------------- */

  /** Providers with credentials configured, in display order. */
  socialProvidersEnabled(): { id: SocialProviderId; label: string }[] {
    const order: SocialProviderId[] = ["google", "apple", "microsoft", "github", "chatgpt", "cognito"];
    return order.filter((id) => this.socialProviders[id]).map((id) => ({ id, label: PROVIDERS[id].label }));
  }

  private providerCreds(provider: string): { spec: (typeof PROVIDERS)[SocialProviderId]; creds: SocialCredentials } {
    const spec = PROVIDERS[provider as SocialProviderId];
    const creds = spec ? this.socialProviders[spec.id] : undefined;
    if (!spec || !creds) throw new CidError("provider_unavailable", "That sign-in option isn't available");
    return { spec, creds };
  }

  /**
   * Begin "Continue with Google/GitHub/…". Returns the provider URL to send the browser to and
   * the state, which the caller must also bind to the browser (a short-lived cookie) and check on return.
   * Pass `linkToCid` when a signed-in person is adding a provider to their account.
   */
  async startSocialSignIn(provider: string, redirectUri: string, linkToCid?: string) {
    const { spec, creds } = this.providerCreds(provider);
    if (linkToCid) await this.account(linkToCid);
    const { verifier, challenge } = pkcePair();
    const pending: PendingAuth = {
      state: randomBytes(24).toString("base64url"),
      provider: spec.id,
      nonce: randomBytes(16).toString("base64url"),
      codeVerifier: verifier,
      redirectUri,
      expiresAt: this.now().getTime() + 10 * 60_000,
      linkToCid,
    };
    await this.repo.sweepOneTime("oauth", this.now().getTime());
    await this.repo.putOneTime("oauth", pending.state, pending);
    const url = await this.socialClient.authorizeUrl(spec, creds, pending, challenge);
    return { url, state: pending.state };
  }

  async finishSocialSignIn(
    provider: string,
    params: { state: string; code: string; browserState?: string },
    device: string,
  ): Promise<
    | { status: "ok"; token: string; session: Session; created: boolean }
    | { status: "mfa_required"; mfaToken: string }
    | { status: "linked"; cid: string }
  > {
    const { spec, creds } = this.providerCreds(provider);
    const pending = await this.repo.takeOneTime("oauth", params.state); // single use
    // The state must be one we issued, for this provider, unexpired, and started in this same browser.
    if (!pending || pending.provider !== spec.id || pending.expiresAt < this.now().getTime() || params.browserState !== params.state) {
      throw new CidError("challenge_expired", "Sign-in request expired. Please try again.");
    }
    let profile: SocialProfile;
    try {
      profile = await this.socialClient.complete(spec, creds, pending, params.code, this.now());
    } catch (err) {
      throw new CidError("social_failed", (err as Error).message);
    }
    const key = `${profile.provider}|${profile.subject}`;
    const existing = await this.repo.cidForIdentity(key);

    if (pending.linkToCid) {
      if (existing && existing !== pending.linkToCid) {
        throw new CidError("identity_in_use", `That ${spec.label} account is already linked to a different CID`);
      }
      if (!existing) await this.attachIdentity(pending.linkToCid, profile);
      return { status: "linked", cid: pending.linkToCid };
    }

    let cid = existing;
    let created = false;
    if (!cid) {
      // A new provider account always gets a new CID. Accounts are never joined by matching email,
      // which would let anyone who controls an email at one provider take over another person's CID.
      const account = await this.createAccount({ username: await this.freeUsername(profile.usernameHint ?? `${spec.id}-user`) });
      await this.attachIdentity(account.cid, profile);
      cid = account.cid;
      created = true;
    }
    const account = await this.account(cid);
    const method = `social:${spec.id}` as const;
    if (account.totp?.confirmed) {
      const mfaToken = randomBytes(24).toString("base64url");
      await this.repo.sweepOneTime("mfa", this.now().getTime());
      await this.repo.putOneTime("mfa", mfaToken, { cid, method: `${method}+totp`, device, expiresAt: this.now().getTime() + CHALLENGE_TTL_MS });
      return { status: "mfa_required", mfaToken };
    }
    const issued = await this.issueSession(cid, device, method);
    return { status: "ok", ...issued, created };
  }

  private async freeUsername(hint: string): Promise<string> {
    let base = hint.toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+/, "").slice(0, 24);
    if (base.length < 3) base = `${base}user`.slice(0, 24);
    let name = base;
    for (let i = 2; (await this.repo.cidForUsername(name)) || RESERVED.has(name); i++) name = `${base}${i}`;
    return name;
  }

  private async attachIdentity(cid: string, profile: SocialProfile) {
    const account = await this.account(cid);
    const identity: LinkedIdentity = {
      provider: profile.provider,
      subject: profile.subject,
      email: profile.emailVerified ? profile.email : undefined,
      linkedAt: this.now().toISOString(),
    };
    account.identities = [...(account.identities ?? []).filter((i) => i.provider !== profile.provider), identity];
    await this.repo.putAccount(account);
    await this.repo.setIdentity(`${profile.provider}|${profile.subject}`, cid);
    // The provider's account ID and email stay off the ledger; only the event is recorded.
    await this.record("audit", cid, cid, { event: "identity.linked", provider: profile.provider });
    await this.emit("identity.linked", cid, { provider: PROVIDERS[profile.provider]?.label ?? profile.provider });
  }

  async linkedIdentities(cid: string): Promise<LinkedIdentity[]> {
    return [...((await this.account(cid)).identities ?? [])];
  }

  async unlinkIdentity(cid: string, provider: string) {
    const account = await this.account(cid);
    const identity = account.identities?.find((i) => i.provider === provider);
    if (!identity) throw new CidError("not_found", "That account isn't linked");
    const otherWays = (await this.listAuthenticators(cid)).length + (account.identities!.length - 1) + (account.federated ? 1 : 0);
    if (otherWays === 0) throw new CidError("last_key", "Add a passkey or another sign-in option before removing your last one");
    account.identities = account.identities!.filter((i) => i.provider !== provider);
    await this.repo.putAccount(account);
    await this.repo.deleteIdentity(`${identity.provider}|${identity.subject}`);
    await this.record("audit", cid, cid, { event: "identity.unlinked", provider });
    await this.emit("identity.unlinked", cid, { provider: PROVIDERS[provider as SocialProviderId]?.label ?? provider });
  }

  /* ---------------- Permissions dashboard ---------------- */

  private appId(app: string): AppId {
    const id = LEGACY_APP_IDS[app] ?? app;
    if (!(INFINITUM_APPS as readonly string[]).includes(id)) throw new CidError("unknown_app", `Unknown Infinitum app: ${app}`);
    return id as AppId;
  }

  /** Grant an app access, app by app. Every grant is recorded on Firmament Network. */
  async grant(cid: string, appName: string, scopes: string[]): Promise<Grant> {
    await this.account(cid);
    const app = this.appId(appName);
    if (scopes.length === 0 || scopes.some((s) => !/^[a-z0-9-]+:[a-z0-9-]+$/.test(s))) {
      throw new CidError("invalid_scope", "Scopes look like 'contacts:read'");
    }
    const merged = [...new Set([...((await this.repo.grant(cid, app))?.scopes ?? []), ...scopes])].sort();
    const entry = await this.record("grant", cid, cid, { app, scopes: merged });
    const grant: Grant = { cid, app, scopes: merged, grantedAt: entry.timestamp, ledgerHash: entry.hash };
    await this.repo.putGrant(grant);
    return grant;
  }

  /** Revoke some scopes, or all access when scopes are omitted. Recorded on Firmament. */
  async revoke(cid: string, appName: string, scopes?: string[]) {
    const app = this.appId(appName);
    const current = await this.repo.grant(cid, app);
    if (!current) return;
    const remaining = scopes ? current.scopes.filter((s) => !scopes.includes(s)) : [];
    const entry = await this.record("revoke", cid, cid, { app, revoked: scopes ?? current.scopes, remaining });
    if (remaining.length === 0) await this.repo.deleteGrant(cid, app);
    else await this.repo.putGrant({ ...current, scopes: remaining, grantedAt: entry.timestamp, ledgerHash: entry.hash });
  }

  async can(cid: string, app: string, scope: string): Promise<boolean> {
    const id = LEGACY_APP_IDS[app] ?? app;
    return (await this.repo.grant(cid, id))?.scopes.includes(scope) ?? false;
  }

  private canNow(cid: string, app: string, scope: string): boolean {
    const id = LEGACY_APP_IDS[app] ?? app;
    return this.store.grants.get(`${cid}|${id}`)?.scopes.includes(scope) ?? false;
  }

  /** One permissions dashboard: which product can use what. */
  async permissions(cid: string): Promise<Grant[]> {
    return (await this.repo.grantsOf(cid)).sort((a, b) => a.app.localeCompare(b.app));
  }

  private permissionsNow(cid: string): Grant[] {
    return [...this.store.grants.values()].filter((g) => g.cid === cid).sort((a, b) => a.app.localeCompare(b.app));
  }

  /** Full Firmament history of this CID's grants and revocations. */
  async permissionHistory(cid: string) {
    const entries = await this.cfg.ledger.query({ product: "cid", subject: cid });
    return entries.filter((e) => e.type === "grant" || e.type === "revoke");
  }

  /* ---------------- Teams, organizations and SSO ---------------- */

  async createOrganization(name: string, adminCid: string): Promise<Organization> {
    const admin = await this.account(adminCid);
    const org: Organization = { id: `org_${randomUUID()}`, name, admins: [adminCid] };
    await this.repo.putOrg(org);
    admin.orgId = org.id;
    await this.repo.putAccount(admin);
    await this.record("identity", adminCid, org.id, { event: "org.created" });
    return org;
  }

  private async org(orgId: string, adminCid?: string): Promise<Organization> {
    const org = await this.repo.org(orgId);
    if (!org) throw new CidError("not_found", "No such organization");
    if (adminCid && !org.admins.includes(adminCid)) throw new CidError("forbidden", "Organization admins only");
    return org;
  }

  async configureSso(orgId: string, adminCid: string, sso: NonNullable<Organization["sso"]>) {
    const org = await this.org(orgId, adminCid);
    org.sso = sso;
    await this.repo.putOrg(org);
    await this.record("audit", adminCid, orgId, { event: "org.sso_configured", issuer: sso.issuer });
  }

  /** Sign in with the organization's identity provider; creates the member's CID on first sign-in. */
  async signInWithSso(orgId: string, idToken: string, device: string, nonce?: string) {
    const org = await this.org(orgId);
    if (!org.sso) throw new CidError("sso_not_configured", "This organization hasn't set up single sign-on");
    let claims;
    try {
      claims = verifyIdToken(idToken, org.sso, { now: this.now(), nonce });
    } catch (err) {
      throw new CidError("sso_failed", (err as Error).message);
    }
    if (org.sso.emailDomain) {
      const domain = claims.email?.split("@")[1]?.toLowerCase();
      if (!claims.email_verified || domain !== org.sso.emailDomain.toLowerCase()) {
        throw new CidError("sso_failed", "Account is not part of this organization's domain");
      }
    }
    const fedKey = `${claims.iss}|${claims.sub}`;
    let cid = await this.repo.cidForFederation(fedKey);
    if (!cid) {
      const base = (claims.email?.split("@")[0] ?? claims.sub).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "member";
      let username = base.length >= 3 ? base : `${base}-user`;
      for (let i = 2; (await this.repo.cidForUsername(username)) || RESERVED.has(username); i++) username = `${base}${i}`;
      const account = await this.createAccount({ username, orgId });
      account.federated = { issuer: claims.iss, subject: claims.sub };
      await this.repo.putAccount(account);
      await this.repo.setFederation(fedKey, account.cid);
      cid = account.cid;
    }
    return this.issueSession(cid, device, "sso");
  }

  async orgMembers(orgId: string, adminCid: string): Promise<Account[]> {
    await this.org(orgId, adminCid);
    return this.repo.accountsInOrg(orgId);
  }

  /** Server-side linked-credential checks; a session id by itself is never a login token. */
  async isSessionActive(cid: string, sessionId: string): Promise<boolean> {
    const session = await this.repo.session(sessionId);
    const expiresAt = session ? Date.parse(session.expiresAt) : NaN;
    return !!session && session.cid === cid && !session.revokedAt && Number.isFinite(expiresAt) && expiresAt > this.now().getTime() && !!(await this.repo.account(cid));
  }

  private isSessionActiveNow(cid: string, sessionId: string): boolean {
    const session = this.store.sessions.get(sessionId);
    const expiresAt = session ? Date.parse(session.expiresAt) : NaN;
    return !!session && session.cid === cid && !session.revokedAt && Number.isFinite(expiresAt) && expiresAt > this.now().getTime() && this.store.accounts.has(cid);
  }

  /** Trusted current directory membership; never infer organizations by email. */
  async organizationMembership(cid: string): Promise<{ id: string; name: string; admin: boolean } | null> {
    const account = await this.account(cid);
    const org = account.orgId ? await this.repo.org(account.orgId) : undefined;
    return org ? { id: org.id, name: org.name, admin: org.admins.includes(cid) } : null;
  }

  private organizationMembershipNow(cid: string): { id: string; name: string; admin: boolean } | null {
    const account = this.accountNow(cid);
    const org = account.orgId ? this.store.orgs.get(account.orgId) : undefined;
    return org ? { id: org.id, name: org.name, admin: org.admins.includes(cid) } : null;
  }

  /** Admin control: sign a member out of every device (e.g. a lost laptop or offboarding). */
  async adminRevokeMemberSessions(orgId: string, adminCid: string, memberCid: string) {
    await this.org(orgId, adminCid);
    if ((await this.account(memberCid)).orgId !== orgId) throw new CidError("forbidden", "Not a member of this organization");
    return this.revokeAllSessions(memberCid, undefined, adminCid);
  }
}
