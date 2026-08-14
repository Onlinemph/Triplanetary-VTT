/**
 * Deterministic, position-hashed noise for decorative geometry.
 *
 * The starfield, the asteroid chips and the rocky silhouettes of Ceres and
 * Clandestine all need to look scattered without *being* random: the same hex
 * must produce the same rubble on every client, every frame, forever. So there
 * is no `Math.random` anywhere in the renderer — every ornament is a pure
 * function of its own coordinates, exactly as `mapdata.ts` builds the belt.
 */

/** 32-bit integer hash of two coordinates plus a salt. Returns a uint32. */
export const hash2 = (x: number, y: number, salt: number): number => {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/** Hashed noise in [0, 1). */
export const noise2 = (x: number, y: number, salt: number): number =>
  hash2(x, y, salt) / 4294967296;

/** Hashed noise in [lo, hi). */
export const range2 = (x: number, y: number, salt: number, lo: number, hi: number): number =>
  lo + noise2(x, y, salt) * (hi - lo);

/** Hashed integer in [lo, hi]. */
export const int2 = (x: number, y: number, salt: number, lo: number, hi: number): number =>
  lo + Math.floor(noise2(x, y, salt) * (hi - lo + 1));

/**
 * A tiny deterministic stream, for when one seed has to produce a run of values
 * (the chips inside a single asteroid hex, the stars inside one cache cell).
 * Mulberry32 — small, fast, and good enough for scatter.
 */
export class Stream {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Next value in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Pick from a non-empty list. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] ?? items[0]!;
  }
}
