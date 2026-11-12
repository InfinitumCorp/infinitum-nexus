/**
 * Cumulus://ID storage boundary (relational-storage plan, phase 1b).
 *
 * CidService reads and writes only through this interface, one entity at a time, so a database
 * implementation (one row per account, session, authenticator, grant ...) can replace the in-memory
 * one without touching sign-in logic. Every change is an explicit put/delete: nothing relies on
 * mutating an object that came out of the store.
 *
 * MapCidRepository keeps today's in-memory CidStore and its snapshot format exactly as they are.
 */
import type { Account, Authenticator, Grant, Organization, Session } from "./service.ts";
import type { CidStore, CidOneTime } from "./service.ts";

/** Short-lived, single-use items. Each kind has its own key space. */
export type OneTimeKind = keyof CidOneTime;

export interface CidRepository {
  account(cid: string): Promise<Account | undefined>;
  cidForUsername(username: string): Promise<string | undefined>;
  /** Insert or update. Keeps the username index in step. */
  putAccount(account: Account): Promise<void>;
  accountsInOrg(orgId: string): Promise<Account[]>;

  /** `${provider}|${subject}` -> cid, for social sign-in. */
  cidForIdentity(key: string): Promise<string | undefined>;
  setIdentity(key: string, cid: string): Promise<void>;
  deleteIdentity(key: string): Promise<void>;
  /** `${issuer}|${subject}` -> cid, for organization SSO. */
  cidForFederation(key: string): Promise<string | undefined>;
  setFederation(key: string, cid: string): Promise<void>;

  authenticator(id: string): Promise<Authenticator | undefined>;
  authenticatorByCredential(credentialId: string): Promise<Authenticator | undefined>;
  authenticatorsOf(cid: string): Promise<Authenticator[]>;
  putAuthenticator(auth: Authenticator): Promise<void>;
  deleteAuthenticator(auth: Authenticator): Promise<void>;

  session(id: string): Promise<Session | undefined>;
  sessionByTokenHash(tokenHash: string): Promise<Session | undefined>;
  sessionsOf(cid: string): Promise<Session[]>;
  putSession(session: Session): Promise<void>;

  grant(cid: string, app: string): Promise<Grant | undefined>;
  grantsOf(cid: string): Promise<Grant[]>;
  putGrant(grant: Grant): Promise<void>;
  deleteGrant(cid: string, app: string): Promise<void>;

  org(id: string): Promise<Organization | undefined>;
  putOrg(org: Organization): Promise<void>;

  putOneTime<K extends OneTimeKind>(kind: K, key: string, value: CidOneTime[K]): Promise<void>;
  peekOneTime<K extends OneTimeKind>(kind: K, key: string): Promise<CidOneTime[K] | undefined>;
  /** Read and delete in one step: a single-use item can be taken once. */
  takeOneTime<K extends OneTimeKind>(kind: K, key: string): Promise<CidOneTime[K] | undefined>;
  deleteOneTime(kind: OneTimeKind, key: string): Promise<void>;
  /** Drop items of `kind` whose expiresAt is before `now` (ms). */
  sweepOneTime(kind: OneTimeKind, now: number): Promise<void>;
}

/** The in-memory repository over CidStore's Maps. Same objects, same snapshot format as before. */
export class MapCidRepository implements CidRepository {
  readonly store: CidStore;
  constructor(store: CidStore) {
    this.store = store;
  }

  private oneTime(kind: OneTimeKind): Map<string, { expiresAt: number }> {
    const s = this.store;
    return (kind === "challenge" ? s.challenges : kind === "mfa" ? s.pendingMfa : kind === "oauth" ? s.oauthPending : s.deviceHandoffs) as Map<string, { expiresAt: number }>;
  }

  async account(cid: string) {
    return this.store.accounts.get(cid);
  }
  async cidForUsername(username: string) {
    return this.store.byUsername.get(username);
  }
  async putAccount(account: Account) {
    const before = this.store.accounts.get(account.cid);
    if (before && before.username !== account.username && this.store.byUsername.get(before.username) === account.cid) {
      this.store.byUsername.delete(before.username);
    }
    this.store.accounts.set(account.cid, account);
    this.store.byUsername.set(account.username, account.cid);
  }
  async accountsInOrg(orgId: string) {
    return [...this.store.accounts.values()].filter((a) => a.orgId === orgId);
  }

  async cidForIdentity(key: string) {
    return this.store.byIdentity.get(key);
  }
  async setIdentity(key: string, cid: string) {
    this.store.byIdentity.set(key, cid);
  }
  async deleteIdentity(key: string) {
    this.store.byIdentity.delete(key);
  }
  async cidForFederation(key: string) {
    return this.store.byFederation.get(key);
  }
  async setFederation(key: string, cid: string) {
    this.store.byFederation.set(key, cid);
  }

  async authenticator(id: string) {
    return this.store.authenticators.get(id);
  }
  async authenticatorByCredential(credentialId: string) {
    const id = this.store.byCredentialId.get(credentialId);
    return id ? this.store.authenticators.get(id) : undefined;
  }
  async authenticatorsOf(cid: string) {
    return [...this.store.authenticators.values()].filter((a) => a.cid === cid);
  }
  async putAuthenticator(auth: Authenticator) {
    this.store.authenticators.set(auth.id, auth);
    this.store.byCredentialId.set(auth.credentialId, auth.id);
  }
  async deleteAuthenticator(auth: Authenticator) {
    this.store.authenticators.delete(auth.id);
    this.store.byCredentialId.delete(auth.credentialId);
  }

  async session(id: string) {
    return this.store.sessions.get(id);
  }
  async sessionByTokenHash(tokenHash: string) {
    const id = this.store.byTokenHash.get(tokenHash);
    return id ? this.store.sessions.get(id) : undefined;
  }
  async sessionsOf(cid: string) {
    return [...this.store.sessions.values()].filter((s) => s.cid === cid);
  }
  async putSession(session: Session) {
    this.store.sessions.set(session.id, session);
    this.store.byTokenHash.set(session.tokenHash, session.id);
  }

  async grant(cid: string, app: string) {
    return this.store.grants.get(`${cid}|${app}`);
  }
  async grantsOf(cid: string) {
    return [...this.store.grants.values()].filter((g) => g.cid === cid);
  }
  async putGrant(grant: Grant) {
    this.store.grants.set(`${grant.cid}|${grant.app}`, grant);
  }
  async deleteGrant(cid: string, app: string) {
    this.store.grants.delete(`${cid}|${app}`);
  }

  async org(id: string) {
    return this.store.orgs.get(id);
  }
  async putOrg(org: Organization) {
    this.store.orgs.set(org.id, org);
  }

  async putOneTime<K extends OneTimeKind>(kind: K, key: string, value: CidOneTime[K]) {
    this.oneTime(kind).set(key, value as { expiresAt: number });
  }
  async peekOneTime<K extends OneTimeKind>(kind: K, key: string) {
    return this.oneTime(kind).get(key) as CidOneTime[K] | undefined;
  }
  async takeOneTime<K extends OneTimeKind>(kind: K, key: string) {
    const map = this.oneTime(kind);
    const value = map.get(key) as CidOneTime[K] | undefined;
    map.delete(key);
    return value;
  }
  async deleteOneTime(kind: OneTimeKind, key: string) {
    this.oneTime(kind).delete(key);
  }
  async sweepOneTime(kind: OneTimeKind, now: number) {
    const map = this.oneTime(kind);
    for (const [k, v] of map) if (v.expiresAt < now) map.delete(k);
  }
}
