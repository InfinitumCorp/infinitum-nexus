/**
 * FIRM DEX interface.
 * Scaffold for a simple AMM-style swap of project tokens against FIRM.
 * Production would call a Uniswap-style router via the EVM client.
 */
import type { RpcClient } from "./evm-client.ts";

export interface DexPool {
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
}

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  priceImpact: number;
}

export interface FirmDex {
  quote(tokenIn: string, tokenOut: string, amountIn: string): Promise<SwapQuote>;
  swap(tokenIn: string, tokenOut: string, amountIn: string, minAmountOut: string): Promise<{ txHash: string }>;
}

export function createFirmDex(_client: RpcClient, _routerAddress: string): FirmDex {
  return {
    async quote(tokenIn, tokenOut, amountIn) {
      // Scaffold: 1:1 quote with zero impact
      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: amountIn,
        priceImpact: 0,
      };
    },
    async swap(tokenIn, tokenOut, amountIn, minAmountOut) {
      // Scaffold: returns a placeholder tx hash until router call is wired
      return { txHash: `0xswap_${tokenIn}_${tokenOut}_${amountIn}_${minAmountOut}` };
    },
  };
}
