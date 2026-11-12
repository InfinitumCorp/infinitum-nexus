// © Infinitum Corporation®. All rights reserved.
/**
 * Policy service. Every decision here comes from authoritative records held by the
 * platform (tenancy from Cumulus ID, policy records, opt-ins), never from claims inside
 * an event.
 */
import { createHmac } from "node:crypto";
import type { Classification, Purpose } from "./envelope.ts";
import { EXCLUDED_PRODUCTS, contractFor, CONTRACTS } from "./schemas.ts";

/** Cumulus ID's view of who belongs to which tenant (organization or personal space). */
export interface TenancyDirectory {
  isMember(tenantId: string, cid: string): boolean | Promise<boolean>;
}

export class MemoryTenancy implements TenancyDirectory {
  private members = new Map<string, Set<string>>();
  add(tenantId: string, cid: string): this {
    let s = this.members.get(tenantId);
    if (!s) this.members.set(tenantId, (s = new Set()));
    s.add(cid);
    return this;
  }
  remove(tenantId: string, cid: string): void {
    this.members.get(tenantId)?.delete(cid);
  }
  isMember(tenantId: string, cid: string): boolean {
    return this.members.get(tenantId)?.has(cid) ?? false;
  }
}

export interface PolicyRecord {
  id: string;
  tenant_id: string;
  product: string;
  /** Purposes this tenant allows this product to collect for. */
  purposes: Purpose[];
  /** Overrides the contract's raw retention, never longer than it. */
  retentionDays?: number;
  /** Whether curated datasets built from this source may be offered on Cumulus Exchange. */
  exportAllowed: boolean;
  /** Source rights, e.g. "first_party", "licensed:<license_id>". */
  sourceRights: string;
}

export type Decision =
  | { ok: true; policy: PolicyRecord; classification: Classification; retentionDays: number }
  | { ok: false; status: 403 | 422; reason: string };

export interface PolicyCheck {
  product: string;
  eventType: string;
  tenantId: string;
  purpose: Purpose;
  subjectCid?: string;
}

export class PolicyService {
  private records = new Map<string, PolicyRecord>();
  private optIns = new Set<string>();
  readonly tenancy: TenancyDirectory;

  constructor(tenancy: TenancyDirectory) {
    this.tenancy = tenancy;
  }

  private key(tenantId: string, product: string): string {
    return `${tenantId}\u0000${product}`;
  }

  put(record: PolicyRecord): void {
    if (EXCLUDED_PRODUCTS.has(record.product)) throw new Error(`${record.product} is excluded from the data platform`);
    if (!CONTRACTS[record.product]) throw new Error(`no collection contract for ${record.product}`);
    this.records.set(this.key(record.tenant_id, record.product), { ...record, purposes: [...record.purposes] });
  }

  get(tenantId: string, product: string): PolicyRecord | undefined {
    return this.records.get(this.key(tenantId, product));
  }

  byId(id: string): PolicyRecord | undefined {
    for (const r of this.records.values()) if (r.id === id) return r;
    return undefined;
  }

  /** Opt-in for products whose collection is opt-in only (VEIL). */
  optIn(product: string, cid: string): void {
    this.optIns.add(`${product}\u0000${cid}`);
  }

  optOut(product: string, cid: string): void {
    this.optIns.delete(`${product}\u0000${cid}`);
  }

  hasOptIn(product: string, cid: string): boolean {
    return this.optIns.has(`${product}\u0000${cid}`);
  }

  async decide(c: PolicyCheck): Promise<Decision> {
    if (EXCLUDED_PRODUCTS.has(c.product)) return { ok: false, status: 403, reason: "military and defense products are excluded" };
    const contract = contractFor(c.product, c.eventType);
    if (!contract) return { ok: false, status: 422, reason: `no contract for ${c.product} ${c.eventType}` };
    if (!contract.purposes.includes(c.purpose)) {
      return { ok: false, status: 403, reason: `${c.eventType} may not be collected for ${c.purpose}` };
    }
    const policy = this.get(c.tenantId, c.product);
    if (!policy) return { ok: false, status: 403, reason: "no policy record for this tenant and product" };
    if (!policy.purposes.includes(c.purpose)) return { ok: false, status: 403, reason: `tenant does not allow ${c.purpose}` };
    if (contract.requiresSubject && !c.subjectCid) return { ok: false, status: 422, reason: "subject_cid is required" };
    if (c.subjectCid && !(await this.tenancy.isMember(c.tenantId, c.subjectCid))) {
      return { ok: false, status: 403, reason: "subject is not a member of this tenant" };
    }
    if (CONTRACTS[c.product]?.optInOnly) {
      if (!c.subjectCid || !this.hasOptIn(c.product, c.subjectCid)) {
        return { ok: false, status: 403, reason: "this product only collects after the person opts in" };
      }
    }
    const retentionDays = Math.min(policy.retentionDays ?? contract.retentionDays, contract.retentionDays);
    return { ok: true, policy, classification: contract.classification, retentionDays };
  }
}

/**
 * Tenant-scoped pseudonyms. The same Cumulus ID gets the same pseudonym inside one tenant
 * across products, and unrelated pseudonyms in different tenants, so cross-tenant linking
 * needs an explicit authorized relationship instead of happening by accident.
 */
export class Pseudonymizer {
  private secret: Buffer;
  constructor(secret: string | Buffer) {
    const s = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
    if (s.length < 32) throw new Error("pseudonym secret must be at least 32 bytes");
    this.secret = s;
  }
  subject(tenantId: string, cid: string): string {
    const mac = createHmac("sha256", this.secret).update(`subject\u0000${tenantId}\u0000${cid}`).digest("hex");
    return `sub_${mac.slice(0, 32)}`;
  }
}
