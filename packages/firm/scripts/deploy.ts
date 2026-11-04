/**
 * Contract deployment scaffold.
 * In production this would use ethers/viem + a private key to deploy FirmToken
 * and ProjectToken contracts, then write the addresses to a config file.
 *
 * Usage (once wired):
 *   RPC_URL=... PRIVATE_KEY=... node packages/firm/scripts/deploy.ts
 */
import { PROJECT_TOKENS } from "../src/tokens.ts";

export interface DeployResult {
  firm: string;
  projects: Record<string, string>;
}

export async function deploy(_rpcUrl: string, _privateKey: string): Promise<DeployResult> {
  // Scaffold: returns placeholder addresses.
  // Real implementation would:
  // 1. Compile FirmToken.sol / ProjectToken.sol
  // 2. Deploy FirmToken with initial supply
  // 3. Deploy each ProjectToken
  // 4. Optionally create FIRM pairs on a DEX
  const firm = "0xFIRM000000000000000000000000000000000000";
  const projects: Record<string, string> = {};
  for (const t of PROJECT_TOKENS) {
    projects[t.symbol] = `0x${t.symbol.padEnd(40, "0").slice(0, 40)}`;
  }
  return { firm, projects };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rpc = process.env.RPC_URL ?? "http://localhost:8545";
  const key = process.env.PRIVATE_KEY ?? "";
  const result = await deploy(rpc, key);
  console.log(JSON.stringify(result, null, 2));
}
