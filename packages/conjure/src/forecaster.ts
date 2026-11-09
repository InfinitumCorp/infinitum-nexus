import { CONJURE_PRODUCT_PRESETS } from "./product-presets.ts";
export interface ConjureForecasterOptions {
  origin: string;
  token: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}
/** Browser-safe explicit-bearer adapter. No CID cookies, token persistence or automatic retries. */
export class ConjureForecaster {
  readonly #origin: string;
  readonly #token: ConjureForecasterOptions["token"];
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: ConjureForecasterOptions) {
    const url = new URL(options.origin);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Trusted TLS origin required");
    this.#origin = url.origin;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async request<T = unknown>(
    product: string,
    command: Record<string, unknown>,
  ): Promise<T> {
    if (!CONJURE_PRODUCT_PRESETS.some((p) => p.product === product))
      throw new Error("Unsupported predict product");
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw new Error("Object command required");
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).length > 65536)
      throw new Error("CONJURE request too large");
    const token = await this.#token();
    if (typeof token !== "string" || !/^\S{1,512}$/.test(token))
      throw new Error("Explicit session bearer required");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/api/predict/${product}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(35000),
      });
    } catch {
      throw new Error("CONJURE transport failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`CONJURE request denied (${response.status})`);
    }
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json" ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Invalid predict response");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 2097152) {
          await reader.cancel();
          throw new Error("CONJURE response too large");
        }
        chunks.push(next.value);
      }
    } catch {
      throw new Error("Invalid predict response");
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as T;
    } catch {
      throw new Error("Invalid predict response");
    }
  }
  start<T = unknown>(product: string, input: Record<string, unknown>) {
    return this.request<T>(product, { ...input, action: "create" });
  }
  advance<T = unknown>(
    product: string,
    repo: string,
    id: string,
    expectedHead: string,
  ) {
    return this.request<T>(product, {
      action: "advance",
      repo,
      id,
      expectedHead,
    });
  }
  stop<T = unknown>(
    product: string,
    repo: string,
    id: string,
    expectedHead: string,
  ) {
    return this.request<T>(product, { action: "stop", repo, id, expectedHead });
  }
  resume<T = unknown>(product: string, repo: string, id: string) {
    return this.request<T>(product, { action: "load", repo, id });
  }
  record<T = unknown>(product: string, input: Record<string, unknown>) {
    return this.request<T>(product, { ...input, action: "record" });
  }
}
