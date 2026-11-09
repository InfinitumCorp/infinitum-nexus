import type { OrbitalProduct } from "./backend.ts";
export interface OrbitalClientOptions {
  origin: string;
  token: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}
/** Browser-safe explicit-bearer adapter. No CID cookies, token persistence or automatic retries. */
export class OrbitalClient {
  readonly #origin: string;
  readonly #token: OrbitalClientOptions["token"];
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: OrbitalClientOptions) {
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
    product: OrbitalProduct,
    command: Record<string, unknown>,
  ): Promise<T> {
    if (!["firmament", "orbis"].includes(product))
      throw new Error("Unsupported orbital product");
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw new Error("Object command required");
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).length > 65536)
      throw new Error("Orbital request too large");
    const token = await this.#token();
    if (typeof token !== "string" || !/^\S{1,512}$/.test(token))
      throw new Error("Explicit session bearer required");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/api/orbital/${product}`, {
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
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Orbital transport failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Orbital request denied (${response.status})`);
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
      throw new Error("Invalid orbital response");
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
          throw new Error("Orbital response too large");
        }
        chunks.push(next.value);
      }
    } catch {
      throw new Error("Invalid orbital response");
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
      throw new Error("Invalid orbital response");
    }
  }
}
