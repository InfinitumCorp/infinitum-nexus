/**
 * Seeded random numbers for METATRON simulations.
 *
 * Every simulation takes a seed, so the same question always gives the same
 * answer, and two scenarios compared with the same seed see the same luck
 * ("common random numbers"): the difference between them is the change you
 * made, not noise.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  normal(mean?: number, sd?: number): number;
  uniform(min: number, max: number): number;
  bernoulli(p: number): boolean;
  /** A new independent stream derived from this one. */
  fork(salt: number): Rng;
}

/** mulberry32: small, fast, good enough for Monte Carlo (not for cryptography). */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  let spare: number | null = null;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    normal(mean = 0, sd = 1) {
      if (spare !== null) {
        const z = spare;
        spare = null;
        return mean + sd * z;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return mean + sd * r * Math.cos(2 * Math.PI * v);
    },
    uniform(min, max) {
      return min + (max - min) * next();
    },
    bernoulli(p) {
      return next() < p;
    },
    fork(salt) {
      return createRng(hash(seed, salt));
    },
  };
  return rng;
}

/** Mix two integers into a new seed. */
export function hash(a: number, b: number): number {
  // Mix each input fully before combining. XOR-ing them first would make
  // (seed 9, run r) equal (seed 10, run r ^ 3): different seeds, same futures.
  return fmix(fmix(a) ^ Math.imul(fmix(b ^ 0x9e3779b9), 0x27d4eb2f));
}

/** murmur3 finalizer: a bijective 32-bit mix. */
function fmix(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
