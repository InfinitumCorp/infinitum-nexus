/** Optional bridge lines. These are not the path browser traffic takes. */

export class VeilError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function veilFail(code: string, message: string, status: number): never {
  throw new VeilError(code, message, status);
}

const BRIDGE = /^(?:bridge\s+)?(?:[a-z0-9]{1,20}\s+)?(?:\[[0-9a-f:.]+\]|[0-9a-z.-]+):\d{1,5}\b/i;

export function parseBridge(input: unknown): string {
  if (typeof input !== "string") veilFail("invalid_bridge", "Bridge line must be text", 500);
  const text = input.trim();
  if (!text || text.length > 400 || /[\r\n\u0000]/.test(text)) veilFail("invalid_bridge", "Bridge line is empty or too long", 500);
  if (/BEGIN |PRIVATE KEY/i.test(text)) veilFail("invalid_bridge", "Bridge line was refused", 500);
  if (!BRIDGE.test(text)) veilFail("invalid_bridge", "Bridge line is not a Tor bridge", 500);
  return text;
}

export function parseBridges(input: unknown): string[] {
  if (!Array.isArray(input)) veilFail("invalid_bridge", "Bridge list must be a list", 500);
  if (input.length > 32) veilFail("invalid_bridge", "Bridge list is too large", 500);
  return input.map((line) => parseBridge(line));
}
