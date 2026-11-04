/**
 * Contract deployment scaffold.
 * Includes FirmToken, ProjectTokens, and VeilClaim.
 *
 * Usage:
 *   RPC_URL=... PRIVATE_KEY=... node packages/firm/scripts/deploy.ts
 */
import { PROJECT_TOKENS } from "../src/tokens.ts";

export interface DeployResult {
  firm: string;
  veilClaim: string;
  projects: Record<string, string>;
}

export async function deploy(_rpcUrl: string, _privateKey: string): Promise<DeployResult> {
  // Scaffold: returns placeholder addresses.
  // Real implementation would compile and deploy:
  // 1. FirmToken.sol
  // 2. ProjectToken.sol for each project
  // 3. VeilClaim.sol
  const firm = "0xFIRM000000000000000000000000000000000000";
  const veilClaim = "0xVEIL000000000000000000000000000000000000";
  const projects: Record<string, string> = {};
  for (const t of PROJECT_TOKENS) {
    projects[t.symbol] = `0x${t.symbol.padEnd(40, "0").slice(0, 40)}`;
  }
  return { firm, veilClaim, projects };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rpc = process.env.RPC_URL ?? "http://localhost:8545";
  const key = process.env.PRIVATE_KEY ?? "";
  const result = await deploy(rpc, key);
  console.log(JSON.stringify(result, null, 2));
}
