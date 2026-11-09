/**
 * Architect Spectre adapter.
 * Thin wrapper around the HTTP instrument for Spectre endpoints.
 */
export interface SpectreCall {
  path: string;
  method?: string;
  body?: unknown;
}

export async function callSpectre(base: string, call: SpectreCall): Promise<{ status: number; body: unknown }> {
  const url = `${base}${call.path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: call.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: call.body ? JSON.stringify(call.body) : undefined,
    });
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}
