/**
 * Lightweight JSON-RPC EVM client for FIRM.
 * Uses public eth_call / eth_getBalance endpoints (no ethers/viem dependency).
 */
export interface RpcClient {
  call(method: string, params: unknown[]): Promise<unknown>;
}

export function createRpcClient(url: string): RpcClient {
  return {
    async call(method, params) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result;
    },
  };
}

/** Minimal ERC-20 balanceOf call (selector 0x70a08231). */
export async function erc20BalanceOf(client: RpcClient, token: string, owner: string): Promise<string> {
  const data = "0x70a08231" + owner.replace(/^0x/, "").padStart(64, "0");
  const result = await client.call("eth_call", [{ to: token, data }, "latest"]);
  return String(result);
}

/** Native balance. */
export async function getBalance(client: RpcClient, address: string): Promise<string> {
  const result = await client.call("eth_getBalance", [address, "latest"]);
  return String(result);
}

export async function getChainId(client: RpcClient): Promise<number> {
  const result = await client.call("eth_chainId", []);
  return Number.parseInt(String(result), 16);
}
