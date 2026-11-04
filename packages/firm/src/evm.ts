/**
 * FIRM EVM interface stubs.
 * Concrete implementations (ethers/viem) come later; these define the shape.
 */
import type { FirmToken, FirmWallet, Settlement } from "./interfaces.ts";

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

/** Placeholder factory — real one would connect to an RPC. */
export function createEvmFirmToken(_chainId: number, _address: string): EvmFirmToken {
  return {
    symbol: "FIRM",
    name: "Firmament",
    decimals: 18,
    chainId: _chainId,
    contractAddress: _address,
    async totalSupply() { return "0"; },
    async balanceOf() { return "0"; },
    async transfer() { return { txHash: "0xstub" }; },
  };
}
