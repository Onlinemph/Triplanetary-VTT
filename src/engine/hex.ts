/**
 * Hex grid primitives.
 *
 * Triplanetary is played on a pointy-top hex grid. Internally we use *axial*
 * coordinates `{q, r}` for storage and *cube* coordinates `(x, y, z)` with
 * `x + y + z === 0` for arithmetic, following the conventions at
 * https://www.redblobgames.com/grids/hexagons/.
 *
 * The mapping is:  x = q,  z = r,  y = -q - r.
 *
 * A `Hex` is used both for absolute positions and for *vectors* (velocity,
 * gravity, course deltas). The two are structurally identical, which is exactly
 * what vector movement wants: a ship's velocity is the difference between two
 * positions and can be added straight back onto one.
 */

export interface Hex {
  readonly q: number;
  readonly r: number;
}

export const hex = (q: number, r: number): Hex => ({ q, r });

export const ORIGIN: Hex = hex(0, 0);

/** Cube coordinates of a hex. */
export const cubeX = (h: Hex): number => h.q;
export const cubeZ = (h: Hex): number => h.r;
export const cubeY = (h: Hex): number => -h.q - h.r;

export const add = (a: Hex, b: Hex): Hex => hex(a.q + b.q, a.r + b.r);
export const sub = (a: Hex, b: Hex): Hex => hex(a.q - b.q, a.r - b.r);
export const scale = (a: Hex, k: number): Hex => hex(a.q * k, a.r * k);
export const negate = (a: Hex): Hex => hex(-a.q, -a.r);
export const eq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;
export const isZero = (a: Hex): boolean => a.q === 0 && a.r === 0;

/**
 * The six neighbour directions, in counter-clockwise order starting at "east".
 *
 * Index arithmetic on this array is meaningful: `DIRECTIONS[(i + 3) % 6]` is
 * the reverse of `DIRECTIONS[i]`, and rotating an index by ±1 rotates the
 * direction by ±60 degrees. The gravity derivation in `map.ts` relies on this.
 */
export const DIRECTIONS: readonly Hex[] = [
  hex(1, 0), //  0: east
  hex(1, -1), //  1: north-east
  hex(0, -1), //  2: north-west
  hex(-1, 0), //  3: west
  hex(-1, 1), //  4: south-west
  hex(0, 1), //  5: south-east
] as const;

export const neighbor = (h: Hex, dir: number): Hex => add(h, DIRECTIONS[((dir % 6) + 6) % 6]!);

export const neighbors = (h: Hex): Hex[] => DIRECTIONS.map((d) => add(h, d));

/** Hex (Manhattan-on-cube) distance — the number of steps between two hexes. */
export const distance = (a: Hex, b: Hex): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const dy = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dy));
};

/** Length of a vector in hexes — i.e. a ship's speed, in hexes per turn. */
export const length = (v: Hex): number => distance(ORIGIN, v);

/**
 * Which of `DIRECTIONS` points from `a` toward `b`, when the two are exactly
 * one hex apart. Returns -1 otherwise.
 */
export const directionTo = (a: Hex, b: Hex): number => {
  const d = sub(b, a);
  return DIRECTIONS.findIndex((dir) => eq(dir, d));
};

/** All hexes within `radius` steps of `center`, including `center` itself. */
export const withinRadius = (center: Hex, radius: number): Hex[] => {
  const out: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) out.push(hex(center.q + dq, center.r + dr));
  }
  return out;
};

/** The `radius`-step ring around `center` (empty when `radius` is 0). */
export const ring = (center: Hex, radius: number): Hex[] => {
  if (radius <= 0) return radius === 0 ? [center] : [];
  const out: Hex[] = [];
  // Start at the west-most hex of the ring and walk the six sides.
  let h = add(center, scale(DIRECTIONS[4]!, radius));
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push(h);
      h = neighbor(h, side);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Stable string key for use in Map/Set/JSON. */
export const key = (h: Hex): string => `${h.q},${h.r}`;

export const parseKey = (k: string): Hex => {
  const comma = k.indexOf(',');
  return hex(Number(k.slice(0, comma)), Number(k.slice(comma + 1)));
};

// ---------------------------------------------------------------------------
// Fractional hexes and rounding
// ---------------------------------------------------------------------------

export interface FracHex {
  readonly q: number;
  readonly r: number;
}

/**
 * Round a fractional hex to the nearest hex.
 *
 * Standard cube rounding: round all three cube coordinates, then repair the
 * one with the largest rounding error so the invariant `x + y + z === 0` holds.
 */
export const round = (f: FracHex): Hex => {
  const x = f.q;
  const z = f.r;
  const y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);

  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;

  return hex(rx, rz);
};

export const lerp = (a: Hex, b: Hex, t: number): FracHex => ({
  q: a.q + (b.q - a.q) * t,
  r: a.r + (b.r - a.r) * t,
});

// ---------------------------------------------------------------------------
// Pixel projection (pointy-top)
// ---------------------------------------------------------------------------

/** sqrt(3), precomputed. */
export const SQRT3 = Math.sqrt(3);

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Project a (possibly fractional) hex to pixel space for a pointy-top layout
 * where `size` is the centre-to-vertex distance.
 */
export const toPixel = (h: FracHex, size: number): Point => ({
  x: size * SQRT3 * (h.q + h.r / 2),
  y: size * 1.5 * h.r,
});

/** Inverse of {@link toPixel}; returns a fractional hex. */
export const fromPixel = (p: Point, size: number): FracHex => {
  const r = ((2 / 3) * p.y) / size;
  const q = ((SQRT3 / 3) * p.x - (1 / 3) * p.y) / size;
  return { q, r };
};

/** The six corners of a pointy-top hex, in pixel space. */
export const corners = (h: Hex, size: number): Point[] => {
  const c = toPixel(h, size);
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    out.push({ x: c.x + size * Math.cos(angle), y: c.y + size * Math.sin(angle) });
  }
  return out;
};

/**
 * Centre-to-centre distance between adjacent hexes, in pixels, for a layout of
 * the given `size`. Useful for converting hex-space radii (as used for astral
 * body discs) into pixel radii.
 */
export const pitch = (size: number): number => size * SQRT3;

// ---------------------------------------------------------------------------
// Hexsides
// ---------------------------------------------------------------------------

/**
 * A hexside is identified by the hex it belongs to plus a direction index.
 *
 * Triplanetary uses hexsides for planetary bases: a world hex has six sides,
 * each of which may carry a base, and each side lies directly "below" exactly
 * one of the world's six gravity hexes. That one-to-one correspondence is what
 * lets the rules say things like "the gravity hex directly above the base's hex
 * side" — here, side `d` of a world corresponds to gravity hex `neighbor(world, d)`.
 */
export interface HexSide {
  readonly hex: Hex;
  readonly dir: number;
}

export const hexSide = (h: Hex, dir: number): HexSide => ({
  hex: h,
  dir: ((dir % 6) + 6) % 6,
});

export const sideKey = (s: HexSide): string => `${s.hex.q},${s.hex.r}:${s.dir}`;

/** The gravity hex lying directly above a world's hexside. */
export const sideGravityHex = (s: HexSide): Hex => neighbor(s.hex, s.dir);
