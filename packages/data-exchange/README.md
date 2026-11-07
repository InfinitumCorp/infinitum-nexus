# @infinitum/data-exchange

Opt-in Cumulus Data Exchange backend.

## Features
- Explicit consent recorded on Firmament
- Dataset catalog per product
- Marketplace for data brokers
- Contributor revenue share per product: 85% by default, 70% for FABRIC (per infinitum-revenue catalog.ts)
- One soulbound CDAT license token per sale (`CdatLicense.sol` + off-chain issuer)

## Usage
```ts
import { DataExchange } from "@infinitum/data-exchange";

const dx = new DataExchange();
// The person must grant consent first; packageDataset never creates one.
await dx.consent.grant({ cid, product, scopes: ["usage_metrics"], purpose: "data_licensing" });
const { dataset } = await dx.packageDataset({ /* ... */ });
dx.catalog.updateStatus(dataset.id, "listed");
const sale = await dx.sell(dataset.id, "broker_id", 100);
const cdat = dx.cdat.get(sale.cdatTokenId);
```

`dx.mintCalldata(tokenId)` is the ABI-encoded `CdatLicense.mint` call (`0x01d47bed`) to submit on Base.
Pass a snapshot path as the third `DataExchange` argument to persist the catalog, consents, sales, CDAT tokens, and payouts across restarts. `settlePayout(saleId)` marks the owner's share paid.
License and payment records are appended to Firmament when a ledger and signer are passed to `DataExchange`.

## Product integration
Each product collector:
1. Anonymizes / aggregates data
2. Calls packageDataset(), which throws `ConsentRequiredError` unless an active `data_licensing` consent exists; the collector then returns `skippedReason: "consent_required"`
3. `revokeConsent(consentId)` revokes and delists every dataset that relied on it

Private by default. Military/ODIN° data excluded.
Government workloads never enter the public exchange.
