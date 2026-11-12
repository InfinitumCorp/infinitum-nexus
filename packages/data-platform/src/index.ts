// © Infinitum Corporation®. All rights reserved.
export * from "./envelope.ts";
export * from "./schemas.ts";
export * from "./policy.ts";
export * from "./storage.ts";
export * from "./table.ts";
export * from "./lakehouse.ts";
export * from "./pii.ts";
export * from "./quality.ts";
export * from "./catalog.ts";
export * from "./ontology.ts";
export * from "./signing.ts";
export * from "./gateway.ts";
export * from "./pipeline.ts";
export * from "./privacy.ts";
export * from "./http.ts";
export * from "./adapters/cloud.ts";

import { defaultCatalog, type Catalog } from "./catalog.ts";
import { Gateway, type CredentialStore } from "./gateway.ts";
import { Lakehouse } from "./lakehouse.ts";
import { Ontology } from "./ontology.ts";
import { Pipeline } from "./pipeline.ts";
import { PolicyService, Pseudonymizer, type TenancyDirectory } from "./policy.ts";
import type { ObjectStore } from "./storage.ts";

export interface PlatformOptions {
  store: ObjectStore;
  tenancy: TenancyDirectory;
  credentials: CredentialStore;
  /** HMAC key for subject pseudonyms. From a secret manager, never from source. */
  pseudonymSecret: string | Buffer;
  now?: () => number;
}

export interface Platform {
  lakehouse: Lakehouse;
  ontology: Ontology;
  catalog: Catalog;
  policy: PolicyService;
  pseudonymizer: Pseudonymizer;
  pipeline: Pipeline;
  gateway: Gateway;
}

/** Wires gateway → raw zone → pipeline → ontology in one process. */
export function createPlatform(o: PlatformOptions): Platform {
  const lakehouse = new Lakehouse(o.store);
  const ontology = new Ontology();
  const catalog = defaultCatalog();
  const policy = new PolicyService(o.tenancy);
  const pseudonymizer = new Pseudonymizer(o.pseudonymSecret);
  const pipeline = new Pipeline(lakehouse, ontology, catalog);
  const gateway = new Gateway({
    credentials: o.credentials,
    policy,
    pseudonymizer,
    lakehouse,
    onAccepted: async (envs) => {
      await pipeline.process(envs);
    },
    ...(o.now ? { now: o.now } : {}),
  });
  return { lakehouse, ontology, catalog, policy, pseudonymizer, pipeline, gateway };
}
