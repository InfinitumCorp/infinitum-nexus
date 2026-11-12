/**
 * Buying Infinitum products with a Cumulus://ID.
 *
 * Product sites link a "Subscribe" button to
 *   GET /api/billing/subscribe?plan=<plan id>&return=<page on an Infinitum product site>
 * Not signed in yet: the Cumulus://ID sign-in page opens first, then the request continues.
 * Signed in: the CID's billing org (created on first purchase, see @infinitum/billing) asks the
 * revenue API (infinitum-revenue) for a Stripe Checkout session, and the browser goes there.
 * Prices only ever appear on Stripe Checkout. Stripe keys live only in the revenue API.
 *
 * Business plans (BUSINESS_PLANS) switch the buyer's billing org to a business org first and take
 * `&seats=<n>` for per-seat plans.
 *
 *   GET /api/billing/manage?return=<url>   Stripe customer portal: cards, invoices, change or cancel.
 *   GET /api/billing/me                    What this CID pays for, for apps to unlock features.
 *                                          Cookie session here, or "Authorization: Bearer <CID token>"
 *                                          from a product site (CORS for Infinitum product origins).
 *
 * Only the self-serve plans in SELLABLE can be bought this way. Military products are never sold
 * here, whatever the revenue catalog says; sales-assisted plans go through sales.
 */
import { ID_CLIENTS, type Account, type CidService } from "@infinitum/cid";
import { BillingLinkStore, RevenueClient, RevenueError, billingFor, effectiveEntitlements, hasBilling } from "@infinitum/billing";

/** Plan id -> product name shown on the sign-in page. Self-serve, paid plans only. */
export const SELLABLE: Record<string, string> = {
  scalvs_pro: "SCALVS.ai",
  cndctr_pro: ":\\ARCHITECT\\",
  metatron_personal: "METATRON¹⁰⁰",
  metatron_family: "METATRON¹⁰⁰",
  metatron_annual: "METATRON¹⁰⁰",
  cumulus_drive_200: "Cumulus://Cloud",
  cumulus_drive_2tb: "Cumulus://Cloud",
  hrvst_pro: "[HRVST]",
  throne_care: "#THRONE",
  throne_book_lease: "#THRONE",
  academy_membership: "Infinitum Academy",
  veil_premium: "VEIL",
  // Business plans (self-serve): the buyer's billing org becomes a business org first.
  scalvs_team: "SCALVS.ai",
  cndctr_business: ":\\ARCHITECT\\",
  spectre_starter: "+SPCTR",
  spectre_growth: "+SPCTR",
  fabric_business: "FABRIC",
  metatron_business: "METATRON¹⁰⁰",
};

/** Plans only a business org may hold. Per-seat ones take `seats` (1..10000). */
export const BUSINESS_PLANS: Record<string, { perSeat: boolean }> = {
  scalvs_team: { perSeat: true },
  cndctr_business: { perSeat: true },
  spectre_starter: { perSeat: true },
  spectre_growth: { perSeat: true },
  fabric_business: { perSeat: true },
  metatron_business: { perSeat: false },
};

export function seatsFor(plan: string, raw: string | null): number | undefined {
  if (!BUSINESS_PLANS[plan]?.perSeat) return undefined;
  const n = Math.floor(Number(raw ?? 1));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 10000) : 1;
}

/** Military-only products: never sold through public checkout. */
export const MILITARY_PRODUCTS = new Set(["eidetic", "eon", "orbis", "pollen", "slug", "odin", "daemon", "argus", "aether"]);

/** Every Infinitum product origin (the same list "Sign in with Cumulus://ID" accepts). */
const PRODUCT_ORIGINS = new Set(Object.values(ID_CLIENTS).flatMap((c) => c.origins));

export function returnUrlFor(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  let url: URL;
  try { url = new URL(raw); } catch { return fallback; }
  if (url.username || url.password || !PRODUCT_ORIGINS.has(url.origin)) return fallback;
  url.hash = "";
  return url.toString();
}

const STRIPE_HOSTS = new Set(["checkout.stripe.com", "billing.stripe.com"]);
const isStripeUrl = (u: string) => {
  try { const x = new URL(u); return x.protocol === "https:" && STRIPE_HOSTS.has(x.hostname); } catch { return false; }
};

export interface BillingHelpers {
  route: (method: string, path: string, handler: (ctx: any) => unknown, auth?: boolean, opts?: { csrf?: boolean; optionalAuth?: boolean }) => void;
  cid: CidService;
  origin: string;
  str: (v: unknown, max?: number) => string;
  Redirect: new (location: string) => unknown;
  HttpError: new (status: number, message: string) => Error;
  store: BillingLinkStore;
  revenue: RevenueClient;
}

export function registerBilling(h: BillingHelpers) {
  const { route, cid, str, Redirect, HttpError, store, revenue } = h;
  const home = "https://infinitumcorporation.ai/";

  const account = async (ctx: any): Promise<Account | null> => {
    if (ctx.user?.account) return ctx.user.account as Account;
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(ctx.req.headers.authorization ?? ""));
    const hit = m ? await cid.authenticate(m[1]!) : null;
    return hit ? hit.account : null;
  };
  const signInFirst = (ctx: any, path: string, forName: string) => {
    const back = `${path}?${(ctx.query as URLSearchParams).toString()}`;
    return new Redirect(`/?next=${encodeURIComponent(back)}&for=${encodeURIComponent(forName)}`);
  };
  const failed = (e: unknown, what: string) => {
    if (e instanceof RevenueError && e.status >= 400 && e.status < 500) return new HttpError(400, `${what}: ${e.message}`);
    return new HttpError(503, `${what} isn't available right now. Please try again in a few minutes.`);
  };

  route("GET", "/api/billing/subscribe", async (ctx: any) => {
    const q = ctx.query as URLSearchParams;
    const plan = str(q.get("plan"), 60);
    const product = Object.prototype.hasOwnProperty.call(SELLABLE, plan) ? SELLABLE[plan]! : null;
    if (!product || MILITARY_PRODUCTS.has(plan.split("_")[0]!)) throw new HttpError(400, "That plan can't be bought online. Contact us at info@infinitumcorporation.ai.");
    const returnUrl = returnUrlFor(q.get("return"), home);
    const who = await account(ctx);
    if (!who) return signInFirst(ctx, "/api/billing/subscribe", product);
    let session;
    try {
      const org = await billingFor(revenue, store, who);
      if (BUSINESS_PLANS[plan]) await org.updateOrg({ kind: "business" });
      const quantity = seatsFor(plan, q.get("seats"));
      session = await org.subscriptionCheckout({ planId: plan, ...(quantity ? { quantity } : {}), returnUrl });
    } catch (e) { throw failed(e, "Checkout"); }
    if (!isStripeUrl(session.url)) throw new HttpError(502, "Checkout returned an unexpected address. Please contact us.");
    return new Redirect(session.url);
  }, false, { optionalAuth: true });

  route("GET", "/api/billing/manage", async (ctx: any) => {
    const q = ctx.query as URLSearchParams;
    const returnUrl = returnUrlFor(q.get("return"), home);
    const who = await account(ctx);
    if (!who) return signInFirst(ctx, "/api/billing/manage", "your Infinitum subscriptions");
    let portal;
    try { portal = await (await billingFor(revenue, store, who)).portal({ returnUrl }); } catch (e) { throw failed(e, "Billing"); }
    if (!isStripeUrl(portal.url)) throw new HttpError(502, "Billing returned an unexpected address. Please contact us.");
    return new Redirect(portal.url);
  }, false, { optionalAuth: true });

  route("GET", "/api/billing/me", async (ctx: any) => {
    const o = ctx.req.headers.origin;
    if (typeof o === "string" && PRODUCT_ORIGINS.has(o)) {
      ctx.res.setHeader("Access-Control-Allow-Origin", o);
      ctx.res.setHeader("Vary", "Origin");
    }
    const who = await account(ctx);
    if (!who) throw new HttpError(401, "Not signed in");
    // No billing org yet means nothing bought yet: don't create one just to look.
    if (!hasBilling(revenue, store, who.cid)) return { cid: who.cid, plans: {}, features: [], creditsCents: 0, products: [] };
    let ent;
    try { ent = await (await billingFor(revenue, store, who)).entitlements(); } catch (e) { throw failed(e, "Billing"); }
    const eff = effectiveEntitlements({ storageGb: 0 }, ent);
    return {
      cid: who.cid,
      plans: eff.plans,
      features: eff.features,
      creditsCents: eff.creditsCents,
      products: ent.products.map((p) => ({ product: p.product, plan: p.plan, status: p.status, renews: p.period.end })),
    };
  }, false, { optionalAuth: true, csrf: false });
}
