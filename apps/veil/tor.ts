/**
 * VEIL Tor proxy helpers.
 * Runtime proxy is controlled by the extension background via chrome.proxy.
 * This module is for monorepo tests / documentation.
 */
export interface TorFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const TOR_PROXY = "socks5://127.0.0.1:9050";

export async function torFetch(opts: TorFetchOptions): Promise<{ status: number; body: string }> {
  // In the extension, browser-level proxy is preferred.
  // This remains a direct fetch for non-extension contexts.
  const res = await fetch(opts.url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
  return { status: res.status, body: await res.text() };
}

export function getTorConfig() {
  return {
    host: "127.0.0.1",
    port: 9050,
    scheme: "socks5",
    note: "Enable via VEIL sidebar Privacy panel (requires local Tor on 9050)"
  };
}
