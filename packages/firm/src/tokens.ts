/**
 * Project-specific tokens paired with FIRM.
 * Each is an ERC-20-style token that can be read via the same JSON-RPC client.
 */
import { createRpcClient, erc20BalanceOf, type RpcClient } from "./evm-client.ts";

export interface ProjectToken {
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  contractAddress: string;
  product: string;
  totalSupply(): Promise<string>;
  balanceOf(owner: string): Promise<string>;
}

export interface ProjectTokenSpec {
  symbol: string;
  name: string;
  product: string;
  chainId: number;
  contractAddress: string;
  rpcUrl: string;
}

export const PROJECT_TOKENS: Omit<ProjectTokenSpec, "rpcUrl" | "contractAddress" | "chainId">[] = [
  { symbol: "HRVST", name: "Harvest", product: "hrvst" },
  { symbol: "ARCT", name: "Architect", product: "conductor" },
  { symbol: "SPCTR", name: "Spectre", product: "spectre" },
  { symbol: "SCLV", name: "Scalus", product: "scalus" },
];

export function createProjectToken(spec: ProjectTokenSpec): ProjectToken & { client: RpcClient } {
  const client = createRpcClient(spec.rpcUrl);
  return {
    symbol: spec.symbol,
    name: spec.name,
    decimals: 18,
    chainId: spec.chainId,
    contractAddress: spec.contractAddress,
    product: spec.product,
    client,
    async totalSupply() {
      const result = await client.call("eth_call", [{ to: spec.contractAddress, data: "0x18160ddd" }, "latest"]);
      return String(result);
    },
    async balanceOf(owner: string) {
      return erc20BalanceOf(client, spec.contractAddress, owner);
    },
  };
}

export function createAllProjectTokens(
  rpcUrl: string,
  chainId: number,
  addresses: Record<string, string>,
): ProjectToken[] {
  return PROJECT_TOKENS.filter((t) => addresses[t.symbol]).map((t) =>
    createProjectToken({
      ...t,
      rpcUrl,
      chainId,
      contractAddress: addresses[t.symbol],
    }),
  );
}
