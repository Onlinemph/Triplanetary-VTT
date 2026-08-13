/**
 * Exact course geometry.
 *
 * Almost every Triplanetary rule that isn't a die roll reduces to one question:
 * *which hexes does this course arrow actually touch, and how?* The rules are
 * precise, and they distinguish three cases that a naive line-drawing routine
 * would smear together:
 *
 *  - **Entering** a hex (the course passes through its interior). This is what
 *    gravity, asteroids and detection care about.
 *  - **Running along a hexside** between two hexes. Figure 7 of the rulebook is
 *    explicit that this is *not* entering either one: "the new course runs
 *    exactly along the edge of a gravity hex. The ship has not entered gravity
 *    hex III." A course like axial (1,1) does this for its whole length.
 *  - **Touching a hex at a single point** (a vertex graze). Mines, torpedoes and
 *    nukes detonate when a course "passes through any portion of the hex", so
 *    these count for ordnance even though they are not entries.
 *
 * The tracer below computes all three exactly, with no sampling.
 *
 * ## How it works
 *
 * Write a hex's cube coordinates as `x = q`, `z = r`, `y = -q - r`, and define
 *
 *     u = x - y = 2q + r
 *     v = y - z = -q - 2r
 *     w = z - x = r - q            (so u + v + w = 0)
 *
 * The Voronoi cell of hex `h` — that is, the hex itself — is exactly
 *
 *     |u - u_h| <= 1  and  |v - v_h| <= 1  and  |w - w_h| <= 1
 *
 * because each inequality is the perpendicular bisector against one opposing
 * pair of neighbours. Since `u`, `v` and `w` are linear along a straight course,
 * every hex boundary the course meets happens where one of them crosses an
 * integer. Solving for those crossings gives an exact, ordered subdivision of
 * the course; evaluating the midpoint of each sub-interval names the hex (or,
 * when two hexes tie, the hexside) the course occupies there.
 */

import {
  type Hex,
  type Point,
  add,
  distance,
  eq,
  hex,
  key,
  round,
  SQRT3,
} from './hex.js';

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Plane projection (unit pitch)
// ---------------------------------------------------------------------------

/**
 * Project a hex (or fractional hex) into a plane where the centre-to-centre
 * distance between adjacent hexes is exactly 1.
 *
 * All continuous geometry — astral body discs, line of sight — is expressed in
 * these units, so a disc radius of 0.5 exactly inscribes its hex.
 */
export const toPlane = (h: { q: number; r: number }): Point => ({
  x: h.q + h.r / 2,
  y: (h.r * SQRT3) / 2,
});

// ---------------------------------------------------------------------------
// Cell membership
// ---------------------------------------------------------------------------

const uOf = (q: number, r: number): number => 2 * q + r;
const vOf = (q: number, r: number): number => -q - 2 * r;
const wOf = (q: number, r: number): number => r - q;

/**
 * Every hex whose closed cell contains the fractional point `(q, r)`.
 *
 * Returns one hex for an interior point, two for a point on a hexside, and
 * three for a point on a vertex.
 */
export const hexesContaining = (q: number, r: number): Hex[] => {
  const u = uOf(q, r);
  const v = vOf(q, r);
  const w = wOf(q, r);
  const seed = round({ q, r });

  const out: Hex[] = [];
  // The containing hexes are always among the nearest hex and its neighbours.
  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      const h = hex(seed.q + dq, seed.r + dr);
      if (
        Math.abs(u - uOf(h.q, h.r)) <= 1 + EPS &&
        Math.abs(v - vOf(h.q, h.r)) <= 1 + EPS &&
        Math.abs(w - wOf(h.q, h.r)) <= 1 + EPS
      ) {
        out.push(h);
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export type TouchMode =
  /** The course passes through this hex's interior. */
  | 'interior'
  /** The course runs along one of this hex's sides without entering it. */
  | 'edge'
  /** The course touches this hex at a single vertex. */
  | 'vertex';

export interface Touch {
  readonly hex: Hex;
  readonly mode: TouchMode;
  /** Parameter along the course, 0 at the tail and 1 at the arrowhead. */
  readonly t: number;
}

export interface Trace {
  /**
   * Hexes the course *enters*, in travel order, including both endpoints.
   * This is the list the movement, gravity and detection rules use.
   */
  readonly entered: Hex[];
  /**
   * Every hex the course touches in any way, in travel order. Ordnance
   * detonation ("any portion of the hex") uses this list.
   */
  readonly touched: Touch[];
  /**
   * Pairs of hexes the course runs *between*, along their shared hexside.
   * The asteroid rule has a special case for this: "A ship passing along a
   * hexside between two asteroid hexes is considered to have entered one
   * asteroid hex."
   */
  readonly edgeRuns: ReadonlyArray<readonly [Hex, Hex]>;
}

/**
 * Trace a course arrow from the centre of `a` to the centre of `b`.
 *
 * A zero-length course (a stationary ship) traces to its own hex only.
 */
export const traceSegment = (a: Hex, b: Hex): Trace => {
  if (eq(a, b)) {
    return {
      entered: [a],
      touched: [{ hex: a, mode: 'interior', t: 0 }],
      edgeRuns: [],
    };
  }

  const u0 = uOf(a.q, a.r);
  const u1 = uOf(b.q, b.r);
  const v0 = vOf(a.q, a.r);
  const v1 = vOf(b.q, b.r);
  const w0 = wOf(a.q, a.r);
  const w1 = wOf(b.q, b.r);

  // Every boundary the course meets is an integer crossing of u, v or w.
  const cuts: number[] = [];
  const addCuts = (f0: number, f1: number): void => {
    if (f0 === f1) return; // constant: the course runs parallel to this family
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
      const t = (k - f0) / (f1 - f0);
      if (t > EPS && t < 1 - EPS) cuts.push(t);
    }
  };
  addCuts(u0, u1);
  addCuts(v0, v1);
  addCuts(w0, w1);

  cuts.sort((x, y) => x - y);
  const stops: number[] = [0];
  for (const t of cuts) {
    const last = stops[stops.length - 1]!;
    if (t - last > EPS) stops.push(t);
  }
  if (1 - stops[stops.length - 1]! > EPS) stops.push(1);

  const at = (t: number): { q: number; r: number } => ({
    q: a.q + (b.q - a.q) * t,
    r: a.r + (b.r - a.r) * t,
  });

  const entered: Hex[] = [];
  const touched: Touch[] = [];
  const edgeRuns: Array<readonly [Hex, Hex]> = [];
  const enteredKeys = new Set<string>();
  const touchedKeys = new Set<string>();

  const pushEntered = (h: Hex, t: number): void => {
    const k = key(h);
    if (!enteredKeys.has(k)) {
      enteredKeys.add(k);
      entered.push(h);
    }
    if (!touchedKeys.has(k)) {
      touchedKeys.add(k);
      touched.push({ hex: h, mode: 'interior', t });
    }
  };

  const pushTouchOnly = (h: Hex, mode: TouchMode, t: number): void => {
    const k = key(h);
    if (touchedKeys.has(k)) return;
    touchedKeys.add(k);
    touched.push({ hex: h, mode, t });
  };

  // Walk each open sub-interval and name the cell (or hexside) it occupies.
  for (let i = 0; i + 1 < stops.length; i++) {
    const t0 = stops[i]!;
    const t1 = stops[i + 1]!;
    const tm = (t0 + t1) / 2;
    const p = at(tm);
    const cells = hexesContaining(p.q, p.r);

    if (cells.length === 1) {
      pushEntered(cells[0]!, tm);
    } else if (cells.length === 2) {
      // The course runs along the shared hexside for this whole sub-interval.
      const pair = [cells[0]!, cells[1]!] as const;
      edgeRuns.push(pair);
      pushTouchOnly(pair[0], 'edge', tm);
      pushTouchOnly(pair[1], 'edge', tm);
    } else {
      // Degenerate (should not occur over an interval); fall back to rounding.
      pushEntered(round(p), tm);
    }
  }

  // Vertex grazes: at an interior stop where three cells meet, the third hex is
  // touched at a single point without ever being entered.
  for (let i = 1; i + 1 < stops.length; i++) {
    const t = stops[i]!;
    const p = at(t);
    const cells = hexesContaining(p.q, p.r);
    if (cells.length === 3) {
      for (const c of cells) pushTouchOnly(c, 'vertex', t);
    }
  }

  // The tail and head hexes are always entered, whatever the interior did.
  if (!enteredKeys.has(key(a))) entered.unshift(a);
  if (!enteredKeys.has(key(b))) entered.push(b);
  enteredKeys.add(key(a));
  enteredKeys.add(key(b));
  if (!touchedKeys.has(key(a))) touched.unshift({ hex: a, mode: 'interior', t: 0 });
  if (!touchedKeys.has(key(b))) touched.push({ hex: b, mode: 'interior', t: 1 });

  touched.sort((p, r) => p.t - r.t);
  return { entered, touched, edgeRuns };
};

// ---------------------------------------------------------------------------
// Discs: crashes and line of sight
// ---------------------------------------------------------------------------

/**
 * Shortest distance from the segment `a`→`b` to the point `c`, all in plane
 * coordinates (unit pitch).
 */
export const segmentPointDistance = (a: Point, b: Point, c: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return Math.hypot(c.x - a.x, c.y - a.y);
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
};

/**
 * Does a course from the centre of hex `a` to the centre of hex `b` intersect
 * the printed disc of an astral body centred on hex `centre`?
 *
 * `radius` is in unit-pitch plane units, so 0.5 exactly inscribes a hex. Real
 * bodies are drawn smaller than their hex — the rulebook is explicit that "they
 * do not cover their entire hex" and that the uncovered corners belong to the
 * adjacent gravity hexes.
 */
export const courseHitsDisc = (
  a: Hex,
  b: Hex,
  centre: Hex,
  radius: number,
): boolean => segmentPointDistance(toPlane(a), toPlane(b), toPlane(centre)) < radius - EPS;

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * Combat range: "always measured from the attacker's closest approach to the
 * target's final position."
 *
 * The attacker's closest approach is evaluated over every hex its course
 * entered this turn, including where it started and where it stopped.
 */
export const closestApproach = (attackerPath: readonly Hex[], target: Hex): number => {
  let best = Infinity;
  for (const h of attackerPath) {
    const d = distance(h, target);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
};

/** Convenience: the course a ship flies from `from` with velocity `v`. */
export const courseFrom = (from: Hex, v: Hex): { from: Hex; to: Hex } => ({
  from,
  to: add(from, v),
});
