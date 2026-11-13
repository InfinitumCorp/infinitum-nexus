# Data exchange: explicit consent and FABRIC 70% share — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/data-exchange` refuses to package a dataset without an existing active consent, delists on revoke, and gives FABRIC datasets a 70% contributor share.

**Architecture:** `ConsentManager` gains product-level grants and `findActive`. `DataExchange.packageDataset` looks up consent instead of creating it, and a new `DataExchange.revokeConsent` revokes and delists. `DatasetCatalog.create` takes its default share from a per-product table in `revshare.ts`. Collectors return `skippedReason: "consent_required"` instead of listing.

**Tech Stack:** TypeScript (strip-types), Node test runner, pnpm workspace `infinitum-nexus`.

## Global Constraints

- FABRIC contributor share is 70% (`infinitum-revenue` `src/catalog.ts`, `contributorShareBps: 7000`, commit c8c4cb9). Other products keep 85% (unchanged in this plan).
- Consent purpose string for data licensing is `"data_licensing"` (matches `infinitum-revenue` `src/services/marketplace.ts` `PURPOSE`).
- No dataset is created or listed without an active consent. Revoke delists immediately.
- No live payouts, tokens or charges are added.

Repo: `InfinitumCorp/infinitum-nexus`, base `main` at `5328038`. Work on a new branch `feat/data-exchange-explicit-consent`.

---

### Task 1: Product-level consent and lookup

**Files:**
- Modify: `packages/data-exchange/src/types.ts` (`ConsentRecord.datasetId` becomes optional)
- Modify: `packages/data-exchange/src/consent.ts` (`grant` accepts no `datasetId`; add `findActive`)
- Test: `packages/data-exchange/src/consent.test.ts` (new)

**Interfaces:**
- Produces: `ConsentManager.grant(params: { cid: string; product: ProductId; datasetId?: string; scopes: string[]; purpose: string }): Promise<ConsentRecord>`
- Produces: `ConsentManager.findActive(cid: string, product: ProductId, purpose: string): ConsentRecord | undefined`

- [ ] **Step 1: Write the failing test**

`packages/data-exchange/src/consent.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsentManager } from "./consent.ts";

test("a product-level grant is found until it is revoked", async () => {
  const cm = new ConsentManager();
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing"), undefined);

  const c = await cm.grant({ cid: "cid_a", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing")?.id, c.id);
  assert.equal(cm.findActive("cid_a", "fabric", "other_purpose"), undefined);
  assert.equal(cm.findActive("cid_b", "fabric", "data_licensing"), undefined);

  assert.equal(await cm.revoke(c.id), true);
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/data-exchange && node --test --experimental-strip-types src/consent.test.ts`
Expected: FAIL, `cm.findActive is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `types.ts`, change the `ConsentRecord` field:

```ts
  datasetId?: string;
```

In `consent.ts`, change the `grant` parameter type and the ledger subject, and add `findActive` after `grant`:

```ts
  async grant(params: {
    cid: string;
    product: ProductId;
    datasetId?: string;
    scopes: string[];
    purpose: string;
  }): Promise<ConsentRecord> {
```

```ts
          subject: params.datasetId ?? params.product,
```

```ts
  /** The newest active consent for this person, product and purpose. */
  findActive(cid: string, product: ProductId, purpose: string): ConsentRecord | undefined {
    let found: ConsentRecord | undefined;
    for (const c of this.consents.values()) {
      if (c.cid === cid && c.product === product && c.purpose === purpose && c.granted) found = c;
    }
    return found;
  }
```

In `revoke`, change the ledger subject the same way:

```ts
          subject: c.datasetId ?? c.product,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/data-exchange && node --test --experimental-strip-types src/consent.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add packages/data-exchange/src/types.ts packages/data-exchange/src/consent.ts packages/data-exchange/src/consent.test.ts
git commit -m "data-exchange: product-level consent grants and findActive"
```

### Task 2: packageDataset requires consent; revoke delists

**Files:**
- Modify: `packages/data-exchange/src/index.ts` (`packageDataset`, new `revokeConsent`, new `ConsentRequiredError`)
- Modify: `packages/data-exchange/src/index.test.ts`, `packages/data-exchange/src/persist.test.ts` (grant before packaging)
- Modify: `apps/data-exchange/src/server.ts` (403 on missing consent)
- Test: `packages/data-exchange/src/explicit-consent.test.ts` (new)

**Interfaces:**
- Consumes: `ConsentManager.findActive` (Task 1)
- Produces: `class ConsentRequiredError extends Error { code: "consent_required" }`
- Produces: `DataExchange.packageDataset(params)` — same parameters as today; throws `ConsentRequiredError` when no active `"data_licensing"` consent exists; returns `{ dataset, consent }` with `dataset.consentId === consent.id`.
- Produces: `DataExchange.revokeConsent(consentId: string): Promise<{ revoked: boolean; delisted: number }>`

- [ ] **Step 1: Write the failing test**

`packages/data-exchange/src/explicit-consent.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange, ConsentRequiredError } from "./index.ts";

const params = {
  cid: "cid_user", product: "fabric" as const, title: "t", description: "d", schema: "x",
  sizeEstimate: 1, privacyLevel: "aggregated" as const, licenseTerms: "CDAT-test-1y", priceUsd: 10,
  scopes: ["usage_metrics"],
};

test("packaging without consent is refused and creates nothing", async () => {
  const dx = new DataExchange();
  await assert.rejects(dx.packageDataset(params), ConsentRequiredError);
  assert.equal(dx.catalog.list().length, 0);
  assert.equal(dx.consent.findActive("cid_user", "fabric", "data_licensing"), undefined);
});

test("packaging uses the existing consent and revoking it delists", async () => {
  const dx = new DataExchange();
  const c = await dx.consent.grant({ cid: "cid_user", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset, consent } = await dx.packageDataset(params);
  assert.equal(consent.id, c.id);
  assert.equal(dataset.consentId, c.id);
  dx.catalog.updateStatus(dataset.id, "listed");
  assert.equal(dx.listForSale().length, 1);

  assert.deepEqual(await dx.revokeConsent(c.id), { revoked: true, delisted: 1 });
  assert.equal(dx.listForSale().length, 0);
  await assert.rejects(dx.packageDataset(params), ConsentRequiredError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/data-exchange && node --test --experimental-strip-types src/explicit-consent.test.ts`
Expected: FAIL, `ConsentRequiredError` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `index.ts`, add above `export class DataExchange`:

```ts
export const DATA_LICENSING = "data_licensing";

export class ConsentRequiredError extends Error {
  code = "consent_required" as const;
  constructor() {
    super("Grant data-licensing consent for this product before packaging data");
  }
}
```

Replace the body of `packageDataset` from `const ds = this.catalog.create({` to the end of the method with:

```ts
    const consent = this.consent.findActive(params.cid, params.product, DATA_LICENSING);
    if (!consent) throw new ConsentRequiredError();

    const ds = this.catalog.create({
      ownerCid: params.cid,
      product: params.product,
      title: params.title,
      description: params.description,
      schema: params.schema,
      sizeEstimate: params.sizeEstimate,
      privacyLevel: params.privacyLevel,
      licenseTerms: params.licenseTerms,
      priceUsd: params.priceUsd,
      consentId: consent.id,
    });

    await this.flush();
    return { dataset: ds, consent };
  }

  /** Revoke a consent and delist every dataset that relied on it. */
  async revokeConsent(consentId: string): Promise<{ revoked: boolean; delisted: number }> {
    const revoked = await this.consent.revoke(consentId);
    let delisted = 0;
    if (revoked) {
      for (const ds of this.catalog.list()) {
        if (ds.consentId === consentId && ds.status === "listed") {
          this.catalog.updateStatus(ds.id, "revoked");
          delisted++;
        }
      }
    }
    await this.flush();
    return { revoked, delisted };
  }
```

Update the doc comment above `packageDataset` to: `Package a dataset from a product. Requires an existing active data-licensing consent; never creates one.`

In `index.test.ts`, insert before each of the four `dx.packageDataset({` calls a grant with the same `cid` and `product` as that call:

```ts
  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
```

(For the test at line 64 use `cid: "cid_firmament", product: "cumulus"`.) In that same test, the grant subject is now the product, so change:

```ts
  assert.equal(entries[0].subject, dataset.id);
```

to:

```ts
  assert.equal(entries[0].subject, "cumulus");
```

In `persist.test.ts`, insert before `const { dataset } = await dx.packageDataset({`:

```ts
  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
```

In `apps/data-exchange/src/server.ts`, replace the `POST /datasets` block with:

```ts
    if (req.method === "POST" && url.pathname === "/datasets") {
      const body = JSON.parse(await readBody(req));
      try {
        const result = await dx.packageDataset(body);
        dx.catalog.updateStatus(result.dataset.id, "listed");
        await dx.flush();
        res.end(JSON.stringify(result));
      } catch (err) {
        if (err instanceof ConsentRequiredError) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: err.code }));
          return;
        }
        throw err;
      }
      return;
    }
```

and add `ConsentRequiredError` to that file's existing import from `@infinitum/data-exchange`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @infinitum/data-exchange test && pnpm --filter @infinitum/data-exchange typecheck && pnpm --filter ./apps/data-exchange typecheck`
Expected: new test file PASS (2 tests); `index.test.ts` and `persist.test.ts` PASS. `collectors.test.ts` FAILS at this point (fixed in Task 3).

- [ ] **Step 5: Commit**

```bash
git add packages/data-exchange/src apps/data-exchange/src/server.ts
git commit -m "data-exchange: require existing consent to package data; revoke delists"
```

### Task 3: Collectors skip without consent; FABRIC share is 70%

**Files:**
- Modify: `packages/data-exchange/src/revshare.ts` (per-product share table)
- Modify: `packages/data-exchange/src/catalog.ts:17` (default from table)
- Modify: `packages/data-exchange/src/collectors.ts` (`listDataset` returns `skippedReason`)
- Modify: `packages/data-exchange/src/collectors.test.ts`
- Test: `packages/data-exchange/src/fabric-share.test.ts` (new)

**Interfaces:**
- Consumes: `ConsentRequiredError`, `DataExchange.packageDataset` (Task 2)
- Produces: `export const PRODUCT_REV_SHARE_PCT: Partial<Record<ProductId, number>>` with `fabric: 70`
- Produces: `export const DEFAULT_REV_SHARE_PCT = 85`

- [ ] **Step 1: Write the failing tests**

`packages/data-exchange/src/fabric-share.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange } from "./index.ts";
import { FabricCollector } from "./collectors.ts";

test("FABRIC datasets pay the contributor 70%", async () => {
  const dx = new DataExchange();
  await dx.consent.grant({ cid: "cid_f", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const r = await new FabricCollector(dx).collect("cid_f");
  assert.ok(r.datasetId);
  assert.equal(dx.catalog.get(r.datasetId!)!.revSharePct, 70);
  const sale = await dx.sell(r.datasetId!, "broker_acme", 100);
  assert.equal(sale?.userShareUsd, 70);
  assert.equal(sale?.platformShareUsd, 30);
});

test("the FABRIC collector lists nothing without consent", async () => {
  const dx = new DataExchange();
  const r = await new FabricCollector(dx).collect("cid_none");
  assert.deepEqual(r, { skippedReason: "consent_required" });
  assert.equal(dx.listForSale().length, 0);
});
```

Replace the body of `collectors.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange } from "./index.ts";
import { createCollectors } from "./collectors.ts";

test("collectors list only products the person consented to", async () => {
  const dx = new DataExchange();
  const collectors = createCollectors(dx);
  assert.equal(collectors.length, 14);

  const none = await Promise.all(collectors.map((c) => c.collect("cid_testuser")));
  assert.ok(none.every((r) => r.skippedReason === "consent_required"));
  assert.equal(dx.listForSale().length, 0);

  for (const c of collectors) {
    await dx.consent.grant({ cid: "cid_testuser", product: c.product, scopes: ["usage_metrics"], purpose: "data_licensing" });
  }
  const results = await Promise.all(collectors.map((c) => c.collect("cid_testuser")));
  assert.ok(results.every((r) => r.datasetId));
  const products = new Set(dx.listForSale().map((d) => d.product));
  for (const p of ["scalus", "veil", "fabric", "aether", "hrvst", "firm"]) assert.ok(products.has(p as never));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/data-exchange && node --test --experimental-strip-types src/fabric-share.test.ts src/collectors.test.ts`
Expected: FAIL — share is 85 not 70; collectors reject with `ConsentRequiredError` instead of returning `skippedReason`.

- [ ] **Step 3: Write minimal implementation**

In `revshare.ts`, add at the top after the import (and add `ProductId` to the type import from `./types.ts`):

```ts
export const DEFAULT_REV_SHARE_PCT = 85;

/** Contributor share by product. FABRIC follows infinitum-revenue catalog.ts (contributorShareBps 7000). */
export const PRODUCT_REV_SHARE_PCT: Partial<Record<ProductId, number>> = {
  fabric: 70,
};
```

In `catalog.ts`, import `{ DEFAULT_REV_SHARE_PCT, PRODUCT_REV_SHARE_PCT } from "./revshare.ts"` and change line 17 to:

```ts
      revSharePct: params.revSharePct ?? PRODUCT_REV_SHARE_PCT[params.product] ?? DEFAULT_REV_SHARE_PCT,
```

In `collectors.ts`, import `{ ConsentRequiredError } from "./index.ts"` and replace `listDataset` with:

```ts
async function listDataset(
  dx: DataExchange,
  params: Parameters<DataExchange["packageDataset"]>[0],
): Promise<CollectorResult> {
  try {
    const { dataset } = await dx.packageDataset(params);
    dx.catalog.updateStatus(dataset.id, "listed");
    return { datasetId: dataset.id };
  } catch (err) {
    if (err instanceof ConsentRequiredError) return { skippedReason: "consent_required" };
    throw err;
  }
}
```

Update the comments that say 85% in `index.ts` (class comment and `settlePayout`) and `revshare.ts` to: `contributor share per product (PRODUCT_REV_SHARE_PCT; default 85%, FABRIC 70%)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: both exit 0. `@infinitum/data-exchange` reports 16 tests, 0 failures; the whole repo 394 tests, 0 failures (389 before this plan + 5 new).

Plan check: Tasks 1–3 were applied once in a throwaway copy of `main` at `5328038` on 2026-11-07 (not committed); `pnpm -r typecheck` exited 0 and `pnpm -r test` gave 394 tests, 0 failures. The `apps/data-exchange/src/server.ts` change was not part of that check.

- [ ] **Step 5: Commit**

```bash
git add packages/data-exchange/src
git commit -m "data-exchange: collectors skip without consent; FABRIC contributor share 70%"
```

### Task 4: Pull request

- [ ] **Step 1:** Run `pnpm -r typecheck && pnpm -r test` once more and copy the totals into the PR body.
- [ ] **Step 2:** `git push -u origin feat/data-exchange-explicit-consent` and `gh pr create --draft --base main --title "Data exchange: explicit consent and FABRIC 70% share"`. Do not merge without review.
