/**
 * Typed client for the Infinitum revenue API (infinitum-revenue on Cloudflare Workers).
 * Stripe is only ever touched by that API: apps never hold Stripe keys. They hold an org API key
 * and send people to the Checkout / portal URLs it returns.
 */

export const REVENUE_API_URL = "https://infinitum-revenue.infinitumcorp.workers.dev";

export type OrgKind = "individual" | "business" | "government";

export interface MeterUse { included: number; used: number }

export interface ProductEntitlement {
  product: string;
  plan: string;
  /** "free" | "bundled" | "trialing" | "active" | "past_due" | ... */
  status: string;
  grantedBy?: string | null;
  seats: number;
  features: string[];
  overage: boolean;
  period: { start: string; end: string };
  meters: Record<string, MeterUse>;
}

export interface Entitlements { orgId: string; credits_cents: number; products: ProductEntitlement[] }

export interface PublicPlan {
  id: string; product: string; name: string; channel: string; priceCents: number; interval: string;
  perSeat?: boolean; included?: Record<string, number>; overage?: boolean; features?: string[]; trialDays?: number;
}

export interface Catalog {
  plans: PublicPlan[];
  meters: { id: string; product: string; unit: string; unitPriceCents: number }[];
  creditPacks: { id: string; priceCents: number; creditCents: number }[];
  [k: string]: unknown;
}

export interface CheckoutSession { id: string; url: string }

export class RevenueError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RevenueError";
    this.status = status;
    this.code = code;
  }
  /** 402: the free allowance is used up and there are no credits. Show an upgrade prompt. */
  get needsUpgrade() { return this.status === 402; }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RevenueClientOptions {
  /** Org API key from signup. Omit for public calls (catalog, signup). */
  apiKey?: string;
  baseUrl?: string;
  fetch?: Fetch;
}

export class RevenueClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: Fetch;

  constructor(opts: RevenueClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? REVENUE_API_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  }

  /** The same client acting for another org. */
  withApiKey(apiKey: string) { return new RevenueClient({ apiKey, baseUrl: this.baseUrl, fetch: this.fetchFn }); }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new RevenueError(res.status, e.code ?? "http_error", e.message ?? `Revenue API ${method} ${path} failed with ${res.status}`);
    }
    return json as T;
  }

  catalog() { return this.req<Catalog>("GET", "/v1/catalog"); }

  /** Creates a billing org and returns its API key. Server-side only: the key is a secret. */
  signup(input: { name: string; email?: string; kind?: OrgKind; referralCode?: string }) {
    return this.req<{ orgId: string; apiKey: string }>("POST", "/v1/signup", input);
  }

  entitlements() { return this.req<Entitlements>("GET", "/v1/me/entitlements"); }

  /** Stripe Checkout for a subscription. `returnUrl` must be on an Infinitum product domain. */
  subscriptionCheckout(input: { planId: string; quantity?: number; returnUrl?: string }) {
    return this.req<CheckoutSession>("POST", "/v1/subscriptions/checkout", input);
  }

  /** Stripe Checkout for a prepaid credit pack. */
  creditsCheckout(input: { packId: string; returnUrl?: string }) {
    return this.req<CheckoutSession>("POST", "/v1/credits/checkout", input);
  }

  /** Stripe customer portal: change plan, cards, invoices, cancel. */
  portal(input: { returnUrl?: string } = {}) {
    return this.req<{ url: string }>("POST", "/v1/billing/portal", input);
  }

  /** Meter usage. Throws a RevenueError with `needsUpgrade` when the allowance and credits are spent. */
  recordUsage(input: { meter: string; quantity: number; idempotencyKey: string }) {
    return this.req<{ billed_as?: string; cost_cents?: number; replay?: boolean }>("POST", "/v1/usage", input);
  }
}
