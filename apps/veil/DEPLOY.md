# VEIL Deploy Notes

## Contracts
- `packages/firm/contracts/VeilClaim.sol` — claim contract for $VEIL rewards
- `packages/firm/contracts/FirmToken.sol` — FIRM token
- `packages/firm/contracts/ProjectToken.sol` — project tokens

## Deploy (scaffold)
```bash
RPC_URL=https://mainnet.base.org PRIVATE_KEY=0x... node packages/firm/scripts/deploy.ts
```

Returns placeholder addresses today. Real deploy needs:
1. Compile the Solidity contracts (`solc` or Hardhat/Foundry)
2. Deploy FirmToken, ProjectTokens, and VeilClaim
3. Fund VeilClaim with ETH or $VEIL
4. Write the real addresses into `apps/veil/deployed.json`
5. In the extension console or background:
   ```js
   const cfg = await fetch(chrome.runtime.getURL("deployed.json")).then(r => r.json());
   chrome.storage.local.set({ veilClaim: cfg.veilClaim, firmRpc: cfg.rpc });
   ```

## Signing
- Extension generates an ECDSA P-256 key via Web Crypto
- `sign.js` can sign a claim payload
- Production: send the signature with a `VeilClaim.claim` transaction

## After deploy
- Extension Claim button becomes enabled once `veilClaim` is set and balance > 0
