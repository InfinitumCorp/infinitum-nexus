/**
 * Minimal Plaid client over fetch (no SDK): Link tokens, token exchange, balances,
 * transactions sync, investment holdings, item removal and webhook verification.
 *
 * Plaid covers banks, cards, loans and brokerages (read-only) in the US, Canada, the UK
 * and much of the EU. It does not cover every country; set PLAID_COUNTRY_CODES to the
 * markets you serve.
 */
import { createHash, createPublicKey, verify as verifySig, type JsonWebKey } from "node:crypto";

export type PlaidEnv = "sandbox" | "production";
const HOSTS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnv;
  /** ISO country codes Link offers, e.g. ["US","GB","NL"]. */
  countryCodes?: string[];
  /** Where Plaid sends webhooks for new transactions. */
  webhook?: string;
  /** OAuth redirect URI registered with Plaid (needed for many EU/UK banks). */
  redirectUri?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class PlaidError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { available: number | null; current: number | null; limit: number | null; iso_currency_code: string | null };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
}

export class PlaidClient {
  private readonly cfg: PlaidConfig;
  private readonly fetch: typeof fetch;
  private readonly keyCache = new Map<string, { jwk: JsonWebKey; expired: boolean }>();

  constructor(cfg: PlaidConfig) {
    if (!cfg.clientId || !cfg.secret) throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are required");
    if (!HOSTS[cfg.env]) throw new Error("PLAID_ENV must be sandbox or production");
    this.cfg = cfg;
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  get env() {
    return this.cfg.env;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(HOSTS[this.cfg.env] + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidError(String(json.error_code ?? "PLAID_ERROR"), String(json.display_message ?? json.error_message ?? `Plaid request failed (${res.status})`), res.status);
    }
    return json as T;
  }

  /** Starts Link for a user. Pass accessToken to re-authenticate an existing connection (update mode). */
  async createLinkToken(userId: string, opts: { accessToken?: string; investments?: boolean } = {}) {
    const body: Record<string, unknown> = {
      user: { client_user_id: userId },
      client_name: "METATRON",
      language: "en",
      country_codes: this.cfg.countryCodes ?? ["US"],
    };
    if (opts.accessToken) body.access_token = opts.accessToken;
    else {
      body.products = ["transactions"];
      if (opts.investments) body.optional_products = ["investments"];
    }
    if (this.cfg.webhook) body.webhook = this.cfg.webhook;
    if (this.cfg.redirectUri) body.redirect_uri = this.cfg.redirectUri;
    return this.post<{ link_token: string; expiration: string }>("/link/token/create", body);
  }

  exchangePublicToken(publicToken: string) {
    return this.post<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
  }

  async getBalances(accessToken: string): Promise<PlaidAccount[]> {
    const r = await this.post<{ accounts: PlaidAccount[] }>("/accounts/balance/get", { access_token: accessToken });
    return r.accounts;
  }

  /** Pulls every change since `cursor`, following has_more. Store next_cursor for the next call. */
  async syncTransactions(accessToken: string, cursor?: string) {
    const added: PlaidTransaction[] = [], modified: PlaidTransaction[] = [], removed: { transaction_id: string }[] = [];
    let next = cursor;
    for (let page = 0; page < 50; page++) {
      const r = await this.post<{ added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string }[]; next_cursor: string; has_more: boolean }>(
        "/transactions/sync",
        { access_token: accessToken, cursor: next, count: 500 },
      );
      added.push(...r.added);
      modified.push(...r.modified);
      removed.push(...r.removed);
      next = r.next_cursor;
      if (!r.has_more) break;
    }
    return { added, modified, removed, nextCursor: next ?? "" };
  }

  getHoldings(accessToken: string) {
    return this.post<{ accounts: PlaidAccount[]; holdings: Record<string, unknown>[]; securities: Record<string, unknown>[] }>(
      "/investments/holdings/get",
      { access_token: accessToken },
    );
  }

  removeItem(accessToken: string) {
    return this.post<{ request_id: string }>("/item/remove", { access_token: accessToken });
  }

  /**
   * Verifies the Plaid-Verification header on a webhook: an ES256 JWT whose
   * request_body_sha256 claim must match the raw body, issued within the last 5 minutes.
   */
  async verifyWebhook(rawBody: string, jwt: string | undefined): Promise<boolean> {
    if (!jwt) return false;
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    let header: { alg?: string; kid?: string }, claims: { iat?: number; request_body_sha256?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    } catch {
      return false;
    }
    if (header.alg !== "ES256" || !header.kid) return false;
    let cached = this.keyCache.get(header.kid);
    if (!cached) {
      try {
        const r = await this.post<{ key: JsonWebKey & { expired_at?: number | null } }>("/webhook_verification_key/get", { key_id: header.kid });
        cached = { jwk: r.key, expired: !!r.key.expired_at };
        this.keyCache.set(header.kid, cached);
      } catch {
        return false;
      }
    }
    if (cached.expired) return false;
    const key = createPublicKey({ key: cached.jwk, format: "jwk" });
    const ok = verifySig("sha256", Buffer.from(parts[0] + "." + parts[1]), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
    if (!ok) return false;
    const now = Math.floor((this.cfg.clock?.() ?? new Date()).getTime() / 1000);
    if (!claims.iat || now - claims.iat > 300) return false;
    return claims.request_body_sha256 === createHash("sha256").update(rawBody).digest("hex");
  }
}
