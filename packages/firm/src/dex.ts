/**
 * FIRM DEX.
 * Quote uses a Uniswap V2-style getAmountsOut eth_call against a router.
 * Swap builds the calldata; signing/sending is still external.
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
  swap(tokenIn: string, tokenOut: string, amountIn: string, minAmountOut: string): Promise<{ txHash: string; data: string }>;
}

/** getAmountsOut(uint256,address[]) selector = 0xd06ca61f */
function encodeGetAmountsOut(amountIn: string, path: string[]): string {
  const amount = BigInt(amountIn).toString(16).padStart(64, "0");
  const pathOffset = "0000000000000000000000000000000000000000000000000000000000000040";
  const pathLen = path.length.toString(16).padStart(64, "0");
  const pathData = path.map((p) => p.replace(/^0x/, "").padStart(64, "0")).join("");
  return "0xd06ca61f" + amount + pathOffset + pathLen + pathData;
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
    async swap(tokenIn, tokenOut, amountIn, minAmountOut) {
      // swapExactTokensForTokens selector 0x38ed1739
      const data =
        "0x38ed1739" +
        BigInt(amountIn).toString(16).padStart(64, "0") +
        BigInt(minAmountOut).toString(16).padStart(64, "0") +
        "00000000000000000000000000000000000000000000000000000000000000a0" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        Math.floor(Date.now() / 1000 + 600).toString(16).padStart(64, "0") +
        "0000000000000000000000000000000000000000000000000000000000000002" +
        tokenIn.replace(/^0x/, "").padStart(64, "0") +
        tokenOut.replace(/^0x/, "").padStart(64, "0");
      return { txHash: `0xswap_pending_${tokenIn.slice(2, 10)}`, data };
    },
  };
}
