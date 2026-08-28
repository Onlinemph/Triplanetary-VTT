/**
 * Hex grid primitives.
 *
 * Ogre is played on a **flat-top** hex grid arranged in columns, and its maps
 * number every hex with a four-digit column-row label: `1401` is column 14,
 * row 01. Scenario setup instructions are written in that language — "no hex
 * whose number ends in 17 or higher" — so the label is part of the rules, not
 * decoration, and `label()` / `parseLabel()` below are the bridge to it.
 *
 * Internally we use *axial* coordinates `{q, r}` for storage and *cube*
 * coordinates `(x, y, z)` with `x + y + z === 0` for arithmetic, following the
 * conventions at https://www.redblobgames.com/grids/hexagons/.
 *
 * The mapping is:  x = q,  z = r,  y = -q - r.
 *
 * Axial direction vectors are the same for flat-top and pointy-top layouts;
 * only the projection to pixels differs. That is why this file's arithmetic
 * looks identical to a pointy-top implementation and only `toPixel`,
 * `fromPixel` and `corners` know which way up the hexes sit.
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
export const eq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

/**
 * The six neighbour directions.
 *
 * Index arithmetic on this array is meaningful: `DIRECTIONS[(i + 3) % 6]` is
 * the reverse of `DIRECTIONS[i]`, which is what lets a hexside be named from
 * either of the two hexes it separates (see {@link canonicalSide}).
 *
 * With the flat-top projection below, index 0 points south-east and the
 * indices run clockwise: SE, S, SW, NW, N, NE.
 */
export const DIRECTIONS: readonly Hex[] = [
  hex(1, 0), //  0: south-east
  hex(0, 1), //  1: south
  hex(-1, 1), //  2: south-west
  hex(-1, 0), //  3: north-west
  hex(0, -1), //  4: north
  hex(1, -1), //  5: north-east
] as const;

export const DIRECTION_NAMES: readonly string[] = ['SE', 'S', 'SW', 'NW', 'N', 'NE'] as const;

export const wrapDir = (dir: number): number => ((dir % 6) + 6) % 6;

export const neighbor = (h: Hex, dir: number): Hex => add(h, DIRECTIONS[wrapDir(dir)]!);

export const neighbors = (h: Hex): Hex[] => DIRECTIONS.map((d) => add(h, d));

/**
 * Hex (Manhattan-on-cube) distance — the number of steps between two hexes,
 * and therefore the game's notion of *range*. Ogre has no line of sight:
 * "There are no limitations for line of sight. All units are capable of
 * indirect fire and may attack anything within their range" (7.02), so range
 * is this number and nothing else.
 */
export const distance = (a: Hex, b: Hex): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const dy = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dy));
};

/** Which of `DIRECTIONS` points from `a` toward `b`, when adjacent; else -1. */
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
// Map labels (column-row, as printed on the map)
// ---------------------------------------------------------------------------

/**
 * Offset coordinates, one-based, as printed on an Ogre map.
 *
 * The layout is "odd-q": columns run left to right, rows run top to bottom,
 * and odd-numbered columns are pushed half a hex *down* relative to even ones.
 * That is the arrangement on the published maps, where the top edge alternates
 * between a full hex and a half hex.
 */
export interface Offset {
  readonly col: number;
  readonly row: number;
}

export const toOffset = (h: Hex): Offset => {
  const col = h.q + 1;
  const row = h.r + ((h.q - (h.q & 1)) >> 1) + 1;
  return { col, row };
};

export const fromOffset = (o: Offset): Hex => {
  const q = o.col - 1;
  const r = o.row - 1 - ((q - (q & 1)) >> 1);
  return hex(q, r);
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** The map's own name for a hex, e.g. `hex(13, ...)` -> `"1401"`. */
export const label = (h: Hex): string => {
  const o = toOffset(h);
  return `${pad2(o.col)}${pad2(o.row)}`;
};

/** Inverse of {@link label}. Accepts `"1401"` and `"14-01"`. */
export const parseLabel = (text: string): Hex | null => {
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length !== 4) return null;
  const col = Number(digits.slice(0, 2));
  const row = Number(digits.slice(2));
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  return fromOffset({ col, row });
};

// ---------------------------------------------------------------------------
// Hexsides
// ---------------------------------------------------------------------------

/**
 * A hexside is identified by a hex plus a direction index — but every hexside
 * has two such names, one from each side. Streams and ridges are properties of
 * the *side*, not of either hex (2.02), so the map stores them under a
 * canonical name and both hexes look them up the same way.
 */
export interface HexSide {
  readonly hex: Hex;
  readonly dir: number;
}

export const hexSide = (h: Hex, dir: number): HexSide => ({ hex: h, dir: wrapDir(dir) });

/**
 * Pick one of a hexside's two names deterministically, so that
 * `canonicalSide(a, dirTo(b))` and `canonicalSide(b, dirTo(a))` agree.
 */
export const canonicalSide = (h: Hex, dir: number): HexSide => {
  const d = wrapDir(dir);
  if (d < 3) return { hex: h, dir: d };
  const other = neighbor(h, d);
  return { hex: other, dir: wrapDir(d + 3) };
};

export const sideKey = (s: HexSide): string => `${s.hex.q},${s.hex.r}:${s.dir}`;

/** The canonical key of the side between two adjacent hexes; '' if not adjacent. */
export const sideKeyBetween = (a: Hex, b: Hex): string => {
  const dir = directionTo(a, b);
  return dir < 0 ? '' : sideKey(canonicalSide(a, dir));
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

// ---------------------------------------------------------------------------
// Pixel projection (flat-top)
// ---------------------------------------------------------------------------

/** sqrt(3), precomputed. */
export const SQRT3 = Math.sqrt(3);

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Project a (possibly fractional) hex to pixel space for a flat-top layout
 * where `size` is the centre-to-vertex distance.
 */
export const toPixel = (h: FracHex, size: number): Point => ({
  x: size * 1.5 * h.q,
  y: size * SQRT3 * (h.r + h.q / 2),
});

/** Inverse of {@link toPixel}; returns a fractional hex. */
export const fromPixel = (p: Point, size: number): FracHex => {
  const q = ((2 / 3) * p.x) / size;
  const r = ((-1 / 3) * p.x + (SQRT3 / 3) * p.y) / size;
  return { q, r };
};

/**
 * The six corners of a flat-top hex, in pixel space, starting at due east.
 *
 * `radius` draws a smaller hexagon *concentric with* the hex — the inset
 * outlines a board needs for selection, hover and reachability. It is a
 * separate argument because `size` fixes where the hex sits and `radius` only
 * how big it is drawn: passing a reduced `size` instead would scale the whole
 * layout toward hex `(0, 0)`, so the hexagon would drift further off its hex
 * the further across the map it lay.
 */
export const corners = (h: Hex, size: number, radius: number = size): Point[] => {
  const c = toPixel(h, size);
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * 60 * i;
    out.push({ x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) });
  }
  return out;
};

/**
 * The two corner indices bounding the hexside in direction `dir`, matching the
 * corner order of {@link corners}. Used to draw stream and ridge hexsides.
 */
export const sideCorners = (dir: number): readonly [number, number] => {
  // Direction 0 (south-east) lies between the corners at 0° and 60°.
  const d = wrapDir(dir);
  return [d, (d + 1) % 6];
};

/** Centre-to-centre distance between adjacent hexes, in pixels. */
export const pitch = (size: number): number => size * SQRT3;
