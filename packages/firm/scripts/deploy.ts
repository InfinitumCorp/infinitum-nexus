/**
 * Contract deployment scaffold.
 * Includes FirmToken, ProjectTokens, and VeilClaim.
 *
 * Usage:
 *   RPC_URL=... PRIVATE_KEY=... node packages/firm/scripts/deploy.ts
 *
 * After a real deploy, write the addresses to apps/veil/deployed.json
 * and load them in the extension via chrome.storage.
 */
import { PROJECT_TOKENS } from "../src/tokens.ts";

export interface DeployResult {
  firm: string;
  veilClaim: string;
  projects: Record<string, string>;
  rpc: string;
  note: string;
}

export async function deploy(rpcUrl: string, _privateKey: string): Promise<DeployResult> {
  // Scaffold: returns placeholder addresses.
  // Real implementation would:
  // 1. Compile FirmToken.sol / ProjectToken.sol / VeilClaim.sol
  // 2. Deploy FirmToken with initial supply
  // 3. Deploy each ProjectToken
  // 4. Deploy VeilClaim
  // 5. Fund VeilClaim
  // 6. Write addresses to deployed.json
  const firm = "0xFIRM000000000000000000000000000000000000";
  const veilClaim = "0xVEIL000000000000000000000000000000000000";
  const projects: Record<string, string> = {};
  for (const t of PROJECT_TOKENS) {
    projects[t.symbol] = `0x${t.symbol.padEnd(40, "0").slice(0, 40)}`;
  }
  return {
    firm,
    veilClaim,
    projects,
    rpc: rpcUrl,
    note: "Scaffold addresses. Replace with real deploys, then set chrome.storage.local.veilClaim.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rpc = process.env.RPC_URL ?? "http://localhost:8545";
  const key = process.env.PRIVATE_KEY ?? "";
  const result = await deploy(rpc, key);
  console.log(JSON.stringify(result, null, 2));
}
