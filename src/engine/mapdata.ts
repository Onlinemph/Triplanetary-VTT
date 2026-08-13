/**
 * The Solar System chart.
 *
 * The board is a circular chart of the inner system on the plane of the
 * ecliptic, with Sol at the centre. Bodies do not move — the rulebook is
 * explicit that moving planets were tried and "doesn't seem to add enough play
 * value to justify the bookkeeping."
 *
 * ## Where these numbers come from
 *
 * Orbital radii are compressed for playability, exactly as the printed map
 * compresses them; what matters for the rules is the *topology*, and that is
 * pinned by the rulebook:
 *
 *  - Every astral body occupies exactly one hex, with a printed disc smaller
 *    than the hex ("they do not cover their entire hex"), so each body has
 *    exactly six gravity hexes and exactly six hexsides — which is what lets
 *    the rules speak of "the gravity hex directly above the base's hex side".
 *  - Luna and Io have weak gravity; everything else with gravity has full
 *    gravity. The Grand Tour scenario confirms the roster: victory requires
 *    passing a gravity hex of "each astral body with full gravity (the six
 *    habitable ones, plus Jupiter and the Sun)" — and the six habitable
 *    full-gravity worlds are exactly Mercury, Venus, Terra, Mars, Ganymede and
 *    Callisto once Luna and Io are excluded as weak.
 *  - Base counts are from p. 7: "Io and Callisto have only one base each.
 *    Mercury has two. Terra, Luna, Mars, and Venus have bases on all six sides."
 *
 * Body positions are a faithful reconstruction rather than a copy of the
 * published artwork. They live here as plain data: swapping in different
 * coordinates changes the chart and nothing else, because every derived fact
 * (gravity arrows, orbits, detection footprints, landing sides) is computed.
 */

import { type Hex, distance, hex, key, round, SQRT3 } from './hex.js';

export type BodyKind = 'star' | 'planet' | 'moon' | 'majorAsteroid';
export type GravityStrength = 'full' | 'weak' | 'none';

export interface AstralBody {
  readonly id: string;
  readonly name: string;
  readonly kind: BodyKind;
  readonly hex: Hex;
  /**
   * Printed disc radius in unit-pitch plane units. Always below 0.5 so the disc
   * sits inside its hex; "portions of astral body hexes not covered by the
   * printed disk are considered to be part of the adjacent gravity hexes."
   */
  readonly discRadius: number;
  readonly gravity: GravityStrength;
  /**
   * Line of sight: "Attacks may be made through other ships, ordnance, and
   * asteroids, but not through moons, planets, or Sol."
   */
  readonly blocksLineOfSight: boolean;
  /** Hexside landing (worlds) versus simply stopping in the hex (asteroids). */
  readonly landing: 'hexside' | 'stop' | 'none';
  /** Which hexsides carry a base, as direction indices 0-5. */
  readonly baseSides: readonly number[];
  /** Whether those bases have planetary defences. */
  readonly planetaryDefences: boolean;
  /** Renderer hints. */
  readonly color: string;
  readonly glow: string;
  readonly habitable: boolean;
}

/** Place a body at polar coordinates around Sol, snapped to the nearest hex. */
const at = (radius: number, degrees: number): Hex => {
  const rad = (degrees * Math.PI) / 180;
  const x = radius * Math.cos(rad);
  const y = radius * Math.sin(rad);
  // Invert the unit-pitch projection: x = q + r/2, y = r * sqrt(3)/2.
  const r = (2 * y) / SQRT3;
  const q = x - r / 2;
  return round({ q, r });
};

/** Place a body relative to another (used for the Jovian moons and Luna). */
const near = (anchor: Hex, radius: number, degrees: number): Hex => {
  const offset = at(radius, degrees);
  return hex(anchor.q + offset.q, anchor.r + offset.r);
};

const ALL_SIDES = [0, 1, 2, 3, 4, 5];

const SOL = hex(0, 0);
const MERCURY = at(4, 200);
const VENUS = at(7, 125);
const TERRA = at(11, 25);
const LUNA = near(TERRA, 3, 100);
const MARS = at(14, 285);
const CERES = at(18, 165);
const CLANDESTINE = at(19, 320);
// Jupiter sits far enough out that even its innermost-facing moon stays clear of
// the belt: any moon within 5 hexes is at least 22 from Sol, and the belt ends
// at 20.5. Otherwise a run to Callisto would cross the asteroids every time.
const JUPITER = at(27, 62);
const IO = near(JUPITER, 3, 300);
const GANYMEDE = near(JUPITER, 4, 60);
const CALLISTO = near(JUPITER, 5, 170);

export const BODIES: readonly AstralBody[] = [
  {
    id: 'sol',
    name: 'Sol',
    kind: 'star',
    hex: SOL,
    discRadius: 0.46,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'none',
    baseSides: [],
    planetaryDefences: false,
    color: '#ffd98a',
    glow: '#ff9d2e',
    habitable: false,
  },
  {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    hex: MERCURY,
    discRadius: 0.24,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: [0, 3],
    planetaryDefences: true,
    color: '#b9a48c',
    glow: '#8a765c',
    habitable: true,
  },
  {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    hex: VENUS,
    discRadius: 0.32,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: ALL_SIDES,
    planetaryDefences: true,
    color: '#e8c98f',
    glow: '#c99a4b',
    habitable: true,
  },
  {
    id: 'terra',
    name: 'Terra',
    kind: 'planet',
    hex: TERRA,
    discRadius: 0.33,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: ALL_SIDES,
    planetaryDefences: true,
    color: '#5b9bd5',
    glow: '#2e6ea8',
    habitable: true,
  },
  {
    id: 'luna',
    name: 'Luna',
    kind: 'moon',
    hex: LUNA,
    discRadius: 0.18,
    gravity: 'weak',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: ALL_SIDES,
    planetaryDefences: true,
    color: '#c9c9c9',
    glow: '#8f8f8f',
    habitable: true,
  },
  {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    hex: MARS,
    discRadius: 0.28,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: ALL_SIDES,
    planetaryDefences: true,
    color: '#d1795a',
    glow: '#a34a2c',
    habitable: true,
  },
  {
    id: 'ceres',
    name: 'Ceres',
    kind: 'majorAsteroid',
    hex: CERES,
    discRadius: 0.2,
    gravity: 'none',
    // Asteroids do not block line of sight, even the major ones.
    blocksLineOfSight: false,
    landing: 'stop',
    baseSides: [],
    planetaryDefences: false,
    color: '#9c9384',
    glow: '#6b6355',
    habitable: true,
  },
  {
    id: 'clandestine',
    name: 'Clandestine',
    kind: 'majorAsteroid',
    hex: CLANDESTINE,
    discRadius: 0.2,
    gravity: 'none',
    blocksLineOfSight: false,
    landing: 'stop',
    baseSides: [],
    planetaryDefences: false,
    color: '#7f8fa6',
    glow: '#4a5a72',
    habitable: false,
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    hex: JUPITER,
    discRadius: 0.44,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'none',
    baseSides: [],
    planetaryDefences: false,
    color: '#d8b48c',
    glow: '#a9713c',
    habitable: false,
  },
  {
    id: 'io',
    name: 'Io',
    kind: 'moon',
    hex: IO,
    discRadius: 0.17,
    gravity: 'weak',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: [3],
    planetaryDefences: true,
    color: '#e3d17a',
    glow: '#b09a34',
    habitable: true,
  },
  {
    id: 'ganymede',
    name: 'Ganymede',
    kind: 'moon',
    hex: GANYMEDE,
    discRadius: 0.2,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: [4],
    planetaryDefences: true,
    color: '#a8a294',
    glow: '#6f6a5c',
    habitable: true,
  },
  {
    id: 'callisto',
    name: 'Callisto',
    kind: 'moon',
    hex: CALLISTO,
    discRadius: 0.19,
    gravity: 'full',
    blocksLineOfSight: true,
    landing: 'hexside',
    baseSides: [1],
    planetaryDefences: true,
    color: '#8d8478',
    glow: '#5b5449',
    habitable: true,
  },
];

// ---------------------------------------------------------------------------
// Chart extent
// ---------------------------------------------------------------------------

/**
 * The chart is a disc centred on Sol. "Any ship whose final course places it
 * off the map is considered eliminated."
 */
export const MAP_RADIUS = 34;

/** Plane-space distance of a hex from Sol, in unit-pitch units. */
export const solarDistance = (h: Hex): number => {
  const x = h.q + h.r / 2;
  const y = (h.r * SQRT3) / 2;
  return Math.hypot(x, y);
};

export const inBounds = (h: Hex): boolean => solarDistance(h) <= MAP_RADIUS + 0.5;

// ---------------------------------------------------------------------------
// The asteroid belt
// ---------------------------------------------------------------------------

export const BELT_INNER = 16;
export const BELT_OUTER = 20.5;

/**
 * Position-hashed noise in [0, 1).
 *
 * Keyed on the hex itself rather than on an iteration order, so the belt is
 * identical no matter how or when it is generated — no build artefact, no seed
 * to keep in sync between client and server.
 */
const noise = (q: number, r: number, salt: number): number => {
  let h = Math.imul(q | 0, 0x27d4eb2d) ^ Math.imul(r | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Neighbour offsets, mirroring hex.ts DIRECTIONS (kept local to avoid a cycle). */
const DIR_Q = [1, 1, 0, -1, -1, 0];
const DIR_R = [0, -1, -1, 0, 1, 1];

/** Radius of the dense "blue asteroid" cordon that hides Clandestine. */
export const CLANDESTINE_CORDON = 3;

export interface BeltData {
  /** Ordinary asteroid hexes. */
  readonly asteroids: ReadonlySet<string>;
  /**
   * The especially dense asteroids around Clandestine. "Only ships possessing
   * scanners may enter those hexes. Other ships are destroyed."
   */
  readonly denseAsteroids: ReadonlySet<string>;
}

/**
 * Build the belt: a scattered annulus between Mars and Jupiter, thinning at the
 * edges, plus the cordon around Clandestine.
 */
export const buildBelt = (): BeltData => {
  const asteroids = new Set<string>();
  const denseAsteroids = new Set<string>();

  // Keep the belt out of every body's hex and its gravity ring. An asteroid in
  // an orbital ring would sit in the one place ships are obliged to fly through
  // to make orbit, land or resupply.
  const reserved = new Set<string>();
  for (const b of BODIES) {
    reserved.add(key(b.hex));
    // Only bodies with gravity have an orbital ring to protect. Ceres and
    // Clandestine are asteroids themselves — Clandestine in particular *wants*
    // its neighbours filled, with the dense cordon that conceals it.
    if (b.gravity === 'none') continue;
    for (let dir = 0; dir < 6; dir++) {
      reserved.add(key(hex(b.hex.q + DIR_Q[dir]!, b.hex.r + DIR_R[dir]!)));
    }
  }

  for (let q = -MAP_RADIUS - 2; q <= MAP_RADIUS + 2; q++) {
    for (let r = -MAP_RADIUS - 2; r <= MAP_RADIUS + 2; r++) {
      const h = hex(q, r);
      if (!inBounds(h)) continue;
      const k = key(h);
      if (reserved.has(k)) continue;

      const d = solarDistance(h);

      // Clandestine's cordon comes first and overrides ordinary belt rolls.
      if (distance(h, CLANDESTINE) <= CLANDESTINE_CORDON) {
        if (distance(h, CLANDESTINE) > 0) denseAsteroids.add(k);
        continue;
      }

      if (d < BELT_INNER || d > BELT_OUTER) continue;

      // Density peaks mid-belt and falls off toward both edges, with a slow
      // azimuthal wobble so the band never looks like a printed ring.
      const mid = (BELT_INNER + BELT_OUTER) / 2;
      const halfWidth = (BELT_OUTER - BELT_INNER) / 2;
      const t = Math.abs(d - mid) / halfWidth;
      const angle = Math.atan2((h.r * SQRT3) / 2, h.q + h.r / 2);
      const wobble = 0.12 * Math.sin(angle * 3.1) + 0.08 * Math.sin(angle * 7.3 + 1.7);
      const density = 0.62 * (1 - t * t) + wobble;

      if (noise(q, r, 1) < density) asteroids.add(k);
    }
  }

  // Guarantee Ceres sits in the belt proper and is reachable.
  for (const b of BODIES) {
    if (b.kind === 'majorAsteroid') asteroids.delete(key(b.hex));
  }
  return { asteroids, denseAsteroids };
};
