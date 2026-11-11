/** Fixed-window counter. One process only; a second Drive host needs its own limit or a shared store. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.hits.size > 10_000) this.prune(now);
    const current = this.hits.get(key);
    if (!current || now - current.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return { ok: true };
    }
    if (current.count >= this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((current.windowStart + this.windowMs - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    current.count += 1;
    return { ok: true };
  }

  /** Drop expired windows so anonymous clients cannot grow this map without bound. */
  private prune(now: number) {
    for (const [key, value] of this.hits) {
      if (now - value.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
