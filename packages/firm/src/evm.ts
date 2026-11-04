/**
 * FIRM EVM interface + real JSON-RPC client.
 */
import type { FirmToken, FirmWallet, Settlement } from "./interfaces.ts";
import { createRpcClient, erc20BalanceOf, getBalance, type RpcClient } from "./evm-client.ts";

export interface EvmFirmToken extends FirmToken {
  chainId: number;
  contractAddress: string;
}

export interface EvmFirmWallet extends FirmWallet {
  chainId: number;
  /** Sign an EIP-712 typed data payload. */
  signTypedData(domain: unknown, types: unknown, value: unknown): Promise<string>;
}

export interface EvmSettlement extends Settlement {
  /** Wait for the on-chain receipt and then record on Firmament. */
  settleOnChain(txHash: string): Promise<{ ledgerHash: string; confirmed: boolean }>;
}

export interface EvmFirmOptions {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
}

/** Create an EVM FIRM token that talks to a real JSON-RPC endpoint. */
export function createEvmFirmToken(opts: EvmFirmOptions): EvmFirmToken & { client: RpcClient } {
  const client = createRpcClient(opts.rpcUrl);
  return {
    symbol: "FIRM",
    name: "Firmament",
    decimals: 18,
    chainId: opts.chainId,
    contractAddress: opts.contractAddress,
    client,
    async totalSupply() {
      // totalSupply() selector 0x18160ddd
      const result = await client.call("eth_call", [{ to: opts.contractAddress, data: "0x18160ddd" }, "latest"]);
      return String(result);
    },
    async balanceOf(owner: string) {
      return erc20BalanceOf(client, opts.contractAddress, owner);
    },
    async transfer() {
      // Signing is still external; this returns a placeholder until a wallet is attached.
      return { txHash: "0xpending-signature" };
    },
  };
}

export { getBalance };
