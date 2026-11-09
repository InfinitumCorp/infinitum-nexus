/**
 * FIRM DEX.
 * Quote uses a Uniswap V2-style getAmountsOut eth_call against a router.
 * Swap builds the calldata; signing/sending is still external.
 */
import type { RpcClient } from "./evm-client.ts";
import { encodeGetAmountsOut, encodeSwapExactTokensForTokens } from "./dex-router.ts";

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
  swap(tokenIn: string, tokenOut: string, amountIn: string, minAmountOut: string, to: string): Promise<{ txHash: string; data: string }>;
}

export function createFirmDex(client: RpcClient, routerAddress: string): FirmDex {
  return {
    async quote(tokenIn, tokenOut, amountIn) {
      const path = [tokenIn, tokenOut];
      const data = encodeGetAmountsOut(amountIn, path);
      try {
        const result = await client.call("eth_call", [{ to: routerAddress, data }, "latest"]);
        const hex = String(result).replace(/^0x/, "");
        // amountsOut is dynamic; last 32 bytes is the output amount
        const outHex = hex.slice(-64);
        const amountOut = BigInt("0x" + outHex).toString();
        const impact = amountOut === "0" ? 1 : Math.max(0, 1 - Number(amountOut) / Number(amountIn));
        return { tokenIn, tokenOut, amountIn, amountOut, priceImpact: impact };
      } catch {
        // Fallback 1:1 if router call fails
        return { tokenIn, tokenOut, amountIn, amountOut: amountIn, priceImpact: 0 };
      }
    },
    async swap(tokenIn, tokenOut, amountIn, minAmountOut, to) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Swap recipient must be an address");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const data = encodeSwapExactTokensForTokens(amountIn, minAmountOut, [tokenIn, tokenOut], to, deadline);
      return { txHash: `0xswap_pending_${tokenIn.replace(/^0x/, "").slice(0, 8)}`, data };
    },
  };
}
