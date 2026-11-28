// © Infinitum Corporation®. All rights reserved.
/**
 * Tenancy from Cumulus ID. A Cumulus ID belongs to at most one organization
 * (`CidService.organizationMembership`); that organization's id is the tenant. People
 * without an organization use their personal tenant, whose id the host derives (it must not
 * be the raw Cumulus ID, because tenant ids are stored in the lakehouse).
 *
 * Answers are cached briefly; a revoked membership stops collection within `ttlMs`.
 */
import type { TenancyDirectory } from "./policy.ts";

export interface CidTenancyOptions {
  /** e.g. (cid) => cidService.organizationMembership(cid) */
  membership: (cid: string) => Promise<{ id: string } | null>;
  /** Personal tenant id for a Cumulus ID, e.g. a pseudonym. Omit to allow organization tenants only. */
  personalTenantOf?: (cid: string) => string;
  ttlMs?: number;
  now?: () => number;
}

export class CidTenancy implements TenancyDirectory {
  private readonly o: Required<Omit<CidTenancyOptions, "personalTenantOf">> & Pick<CidTenancyOptions, "personalTenantOf">;
  private cache = new Map<string, { org: string | null; at: number }>();

  constructor(options: CidTenancyOptions) {
    this.o = { ttlMs: 60_000, now: Date.now, ...options };
  }

  async isMember(tenantId: string, cid: string): Promise<boolean> {
    if (this.o.personalTenantOf && this.o.personalTenantOf(cid) === tenantId) return true;
    const now = this.o.now();
    let hit = this.cache.get(cid);
    if (!hit || now - hit.at > this.o.ttlMs) {
      const m = await this.o.membership(cid);
      hit = { org: m?.id ?? null, at: now };
      this.cache.set(cid, hit);
      if (this.cache.size > 50_000) this.cache.delete(this.cache.keys().next().value!);
    }
    return hit.org !== null && hit.org === tenantId;
  }
}
