/**
 * Links a Cumulus://ID to the billing org that pays for it, and turns that org's paid
 * entitlements into the CID's effective entitlements, on top of the free tier every CID gets.
 */
import { RevenueClient, type Entitlements, type ProductEntitlement } from "./client.ts";

/** CID product ids to revenue product ids. ARCHITECT is "cndctr" in the revenue catalog. */
export const REVENUE_PRODUCT: Record<string, string> = {
  scalvs: "scalvs",
  architect: "cndctr",
  cloud: "cumulus",
  mail: "cumulus",
  firmWallet: "firm_wallet",
};

export interface BillingLink {
  cid: string; orgId: string; apiKey: string; linkedAt: string;
  /** Set once the revenue API's own Cumulus ID mapping knows about this org (or already had another). */
  handedOver?: "linked" | "superseded";
}

/** Plain Map so it persists with the same snapshot helpers as the CID store. Server-side only: it holds org API keys. */
export class BillingLinkStore {
  links = new Map<string, BillingLink>();
}

export interface CidLike { cid: string; username: string; mailAddress: string }

const pending = new WeakMap<BillingLinkStore, Map<string, Promise<BillingLink>>>();

/** The CID's billing link, creating an individual billing org on first use (once, even under concurrent calls). */
export async function ensureBillingOrg(client: RevenueClient, store: BillingLinkStore, account: CidLike): Promise<BillingLink> {
  const existing = store.links.get(account.cid);
  if (existing) return existing;
  let inFlight = pending.get(store);
  if (!inFlight) pending.set(store, (inFlight = new Map()));
  const running = inFlight.get(account.cid);
  if (running) return running;
  const p = client.signup({ name: account.username, email: account.mailAddress, kind: "individual" })
    .then(({ orgId, apiKey }) => {
      const link: BillingLink = { cid: account.cid, orgId, apiKey, linkedAt: new Date().toISOString() };
      store.links.set(account.cid, link);
      return link;
    })
    .finally(() => inFlight!.delete(account.cid));
  inFlight.set(account.cid, p);
  return p;
}

/**
 * A client bound to the CID's billing org.
 *
 * With a partner key, the revenue API's own Cumulus ID mapping is the one source of truth (the same
 * org product apps reach with the person's Cumulus ID token). An org this hub created earlier is
 * handed over once; if the person already had another org there, that one wins and the old org is
 * marked superseded (Infinitum support reconciles any subscription left on it).
 * Without a partner key, the hub keeps its own links, as before.
 */
export async function billingFor(client: RevenueClient, store: BillingLinkStore, account: CidLike) {
  if (!client.cidPartnerKey) return client.withApiKey((await ensureBillingOrg(client, store, account)).apiKey);
  const legacy = store.links.get(account.cid);
  if (legacy && !legacy.handedOver) {
    try {
      await client.withApiKey(legacy.apiKey).linkCid(account.cid);
      legacy.handedOver = "linked";
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "cid_already_linked" || code === "org_already_linked") legacy.handedOver = "superseded";
      else return client.withApiKey(legacy.apiKey); // revenue unreachable: keep working on the old org
    }
  }
  return client.asCid(account.cid);
}

/** True when this hub can read the CID's billing without creating anything new. */
export function hasBilling(client: RevenueClient, store: BillingLinkStore, cid: string) {
  return Boolean(client.cidPartnerKey) || store.links.has(cid);
}

const PAID = new Set(["trialing", "active", "past_due", "bundled"]);

export interface EffectiveEntitlements {
  storageGb: number;
  /** Plan id per CID product, e.g. { scalvs: "scalvs_pro", architect: "cndctr_free" }. */
  plans: Record<string, string>;
  features: string[];
  creditsCents: number;
}

/**
 * The free tier from @infinitum/cid plus whatever the billing org pays for. Storage is the larger of
 * the free allowance and the Cumulus plan's included GB: a paid plan never reduces what the free tier gives.
 */
export function effectiveEntitlements(
  free: { storageGb: number; scalvs?: string; architect?: string },
  ent?: Entitlements,
): EffectiveEntitlements {
  const plans: Record<string, string> = {};
  if (free.scalvs) plans.scalvs = `scalvs_${free.scalvs}`;
  if (free.architect) plans.architect = `cndctr_${free.architect}`;
  const features = new Set<string>();
  const byProduct = new Map<string, ProductEntitlement>((ent?.products ?? []).map((p) => [p.product, p]));
  for (const [cidProduct, revenueProduct] of Object.entries(REVENUE_PRODUCT)) {
    const p = byProduct.get(revenueProduct);
    if (!p) continue;
    const paid = PAID.has(p.status);
    if (paid || !plans[cidProduct]) plans[cidProduct] = p.plan;
    if (paid) for (const f of p.features) features.add(f);
  }
  const driveGb = byProduct.get("cumulus")?.meters.cumulus_storage_gb_month?.included ?? 0;
  return {
    storageGb: Math.max(free.storageGb, driveGb),
    plans,
    features: [...features].sort(),
    creditsCents: ent?.credits_cents ?? 0,
  };
}

/** Extra GB above the free tier, for `StorageQuota.store.extraGb` in @infinitum/cloud. */
export const extraStorageGb = (freeGb: number, eff: EffectiveEntitlements) => Math.max(0, eff.storageGb - freeGb);
