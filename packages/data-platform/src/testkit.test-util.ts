// © Infinitum Corporation®. All rights reserved.
// Shared fixtures for the tests. Secrets here are throwaway test values.
import { createPlatform, MemoryCredentials, MemoryObjectStore, MemoryTenancy, type Platform } from "./index.ts";
import { Collector, type Transport } from "./sdk.ts";

export const TEST_SECRET = "test-only-secret-0123456789abcdef0123";
export const PSEUDONYM_SECRET = "test-only-pseudonym-key-0123456789abcdef";
export const TENANT = "org_acme";
export const ALICE = "cid_alice";
export const BOB = "cid_bob";
export const MALLORY = "cid_mallory";

export interface Kit {
  platform: Platform;
  store: MemoryObjectStore;
  tenancy: MemoryTenancy;
  credentials: MemoryCredentials;
  collector: Collector;
  calls: number;
}

export function kit(): Kit {
  const store = new MemoryObjectStore();
  const tenancy = new MemoryTenancy().add(TENANT, ALICE).add(TENANT, BOB).add("org_other", MALLORY);
  const credentials = new MemoryCredentials().add({ key_id: "key_cloud", product: "cumulus-cloud", secret: TEST_SECRET });
  const platform = createPlatform({ store, tenancy, credentials, pseudonymSecret: PSEUDONYM_SECRET });
  platform.policy.put({
    id: "pol_acme_cloud",
    tenant_id: TENANT,
    product: "cumulus-cloud",
    purposes: ["service_operation", "security", "product_analytics", "billing"],
    exportAllowed: false,
    sourceRights: "first_party",
  });
  const k: Kit = { platform, store, tenancy, credentials, calls: 0, collector: undefined as unknown as Collector };
  const transport: Transport = async (_url, init) => {
    k.calls++;
    const r = await platform.gateway.ingest(init.headers, init.body);
    return { status: r.status, json: async () => r };
  };
  k.collector = new Collector({
    endpoint: "https://collect.cumuluscloud.app/v1/events",
    keyId: "key_cloud",
    secret: TEST_SECRET,
    product: "cumulus-cloud",
    transport,
    sleep: async () => {},
  });
  return k;
}
