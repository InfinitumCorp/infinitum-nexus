# FIRM Suite embed

One drop-in block that puts the FIRM Suite into every Infinitum commercial product:
FIRM™ (the token every product settles through), FIRM Wallet™ (self-custody for Solana,
Ethereum and Base, firmwallet.app) and Firmament Network™ (the CPO, firmnetwork.app).

```html
<link rel="stylesheet" href="/firm-suite.css">
<script type="module" src="/firm-suite.js"></script>

<firm-suite product="scalvs"></firm-suite>                                   <!-- early access -->
<firm-suite product="cumulus-mail" wallet-endpoint="/api/wallet" signin-href="/"></firm-suite>
```

- `product`: registry key (`scalvs`, `architect`, `spectre`, `metatron`, `fabric`, `cumulus-cloud`,
  `cumulus-mail`, `cumulus-exchange`, `veil`, `eidetic`, `hrvst`, ...). Shows the product's token next to `$FIRM`.
- Wallet: set `el.wallet = { address, balances }`, pass a `wallet` JSON attribute, or a same-origin
  `wallet-endpoint` (401/403 shows "Sign in with Cumulus://ID"). Without a wallet it links to early access.
  It never invents addresses or balances.
- Early-access and CPO links carry `?ref=<product>`, which the launch Worker stores with the signup.
- No inline scripts or styles: works under `default-src 'self'` CSPs. Military editions are not in the registry.

Copies: nexus apps in `copies.json` (re-sync with `node packages/firm/suite/sync.mjs`; a test fails on drift).
Standalone repos keep a plain copy that must be re-copied by hand.
