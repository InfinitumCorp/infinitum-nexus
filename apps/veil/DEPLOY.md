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
1. Compile the Solidity contracts
2. Deploy FirmToken, ProjectTokens, and VeilClaim
3. Fund VeilClaim with ETH or $VEIL
4. Set the VeilClaim address in the extension:
   ```js
   chrome.storage.local.set({ veilClaim: "0x..." })
   ```

## After deploy
- Extension Claim button becomes enabled once `veilClaim` is set and balance > 0
- Real signing still needs the Web Crypto key wired to a transaction sender
