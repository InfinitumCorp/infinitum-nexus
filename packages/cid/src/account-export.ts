import { coseToKey } from "./webauthn.ts";
import type { Authenticator, CidService, Grant } from "./service.ts";

/**
 * Account export for moving Cumulus://ID to its own Worker (InfinitumCorp/cumulus-id).
 *
 * POST /api/id/export answers with this document when the Worker secret
 * CID_EXPORT_KEY_SHA256 is set and the caller sends the matching key in x-cid-export-key.
 * It is a migration tool, not an API: it is off by default and the secret is removed after
 * the cut-over (see docs/cumulus-id.md).
 *
 * What is left out on purpose: sessions and their token hashes, pending WebAuthn challenges,
 * pending MFA steps, social sign-in (OAuth) state, browser-to-app handoff codes and
 * unconfirmed TOTP enrolments. People sign in again on the new issuer; their cid, passkeys,
 * linked Google/Cognito accounts and confirmed authenticator app carry over.
 */

export const CID_EXPORT_FORMAT = "cumulus-id.export";
export const CID_EXPORT_VERSION = 1;

export interface CidExportAuthenticator {
  id: string;
  kind: "passkey" | "security-key";
  label: string;
  /** base64url, as the browser reports it. */
  credentialId: string;
  /** base64url COSE_Key. */
  publicKeyCose: string;
  /** COSE algorithm read from publicKeyCose (-7 ES256, -8 EdDSA, -257 RS256); null if unreadable. */
  alg: number | null;
  signCount: number;
  backedUp: boolean;
  addedAt: string;
  lastUsedAt: string | null;
}

export interface CidExportIdentity {
  provider: string;
  subject: string;
  email: string | null;
  linkedAt: string;
}

export interface CidExportGrant {
  /** Nexus app id (e.g. "spectre", "cumulus-mail"); matches the client's `app` in id-clients.ts. */
  app: string;
  scopes: string[];
  grantedAt: string;
  ledgerHash: string;
}

export interface CidExportAccount {
  cid: string;
  username: string;
  mailAddress: string;
  handle: string;
  createdAt: string;
  orgId: string | null;
  /** Organization SSO link, when the account signs in through its organization. */
  federated: { issuer: string; subject: string } | null;
  /** Only a confirmed authenticator app. `secret` is base32. */
  totp: { secret: string; lastStep: number } | null;
  authenticators: CidExportAuthenticator[];
  identities: CidExportIdentity[];
  grants: CidExportGrant[];
}

export interface CidExport {
  format: typeof CID_EXPORT_FORMAT;
  version: typeof CID_EXPORT_VERSION;
  issuer: string;
  exportedAt: string;
  counts: { accounts: number; authenticators: number; identities: number; grants: number };
  accounts: CidExportAccount[];
}

function algOf(publicKeyCose: string): number | null {
  try {
    return coseToKey(new Uint8Array(Buffer.from(publicKeyCose, "base64url"))).alg;
  } catch {
    return null;
  }
}

/**
 * Snapshot of every account, in the shape InfinitumCorp/cumulus-id imports. Reads through the
 * service's repository, so it works on the in-memory store and on Postgres alike.
 */
export async function exportCidAccounts(cid: CidService, now: Date = new Date()): Promise<CidExport> {
  const exportKey = (a: Authenticator): CidExportAuthenticator => ({
    id: a.id,
    kind: a.kind,
    label: a.label,
    credentialId: a.credentialId,
    publicKeyCose: a.publicKeyCose,
    alg: algOf(a.publicKeyCose),
    signCount: a.signCount,
    backedUp: a.backedUp,
    addedAt: a.addedAt,
    lastUsedAt: a.lastUsedAt ?? null,
  });
  const exportGrant = (g: Grant): CidExportGrant => ({ app: g.app, scopes: [...g.scopes], grantedAt: g.grantedAt, ledgerHash: g.ledgerHash });

  const counts = { accounts: 0, authenticators: 0, identities: 0, grants: 0 };
  const accounts: CidExportAccount[] = [];
  for (const a of (await cid.allAccounts()).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.cid.localeCompare(y.cid))) {
    const account: CidExportAccount = {
      cid: a.cid,
      username: a.username,
      mailAddress: a.mailAddress,
      handle: a.handle,
      createdAt: a.createdAt,
      orgId: a.orgId ?? null,
      federated: a.federated ? { issuer: a.federated.issuer, subject: a.federated.subject } : null,
      totp: a.totp?.confirmed ? { secret: cid.totpSecret(a), lastStep: a.totp.lastStep } : null,
      authenticators: (await cid.repo.authenticatorsOf(a.cid)).map(exportKey),
      identities: (a.identities ?? []).map((i) => ({ provider: i.provider, subject: i.subject, email: i.email ?? null, linkedAt: i.linkedAt })),
      grants: (await cid.repo.grantsOf(a.cid)).map(exportGrant),
    };
    counts.accounts += 1;
    counts.authenticators += account.authenticators.length;
    counts.identities += account.identities.length;
    counts.grants += account.grants.length;
    accounts.push(account);
  }
  return { format: CID_EXPORT_FORMAT, version: CID_EXPORT_VERSION, issuer: cid.issuer, exportedAt: now.toISOString(), counts, accounts };
}
