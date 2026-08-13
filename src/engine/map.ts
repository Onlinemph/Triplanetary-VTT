/**
 * The indexed game map.
 *
 * ## Why gravity is computed rather than drawn
 *
 * The rulebook says gravity is "represented by the arrows in hexes adjacent to
 * those bodies", and that a ship moving one hex per turn between adjacent
 * gravity hexes stays in orbit indefinitely. Those two statements together
 * *determine* every arrow, so we derive them instead of transcribing them.
 *
 * Take a body at the origin and label its six gravity hexes by the unit vectors
 * `e_k`. A ship coasting from `g1` to `g2` has velocity `g2 - g1`; next turn it
 * moves to `g2 + (g2 - g1) + d(g2)`, where `d(g2)` is the gravity arrow it
 * picked up. For that endpoint to be the next gravity hex `g3` around the ring:
 *
 *     d(g2) = g3 - 2*g2 + g1
 *
 * Writing hex vectors as complex numbers with `w = e^(i*pi/3)`, and taking
 * `g1 = w^k`, `g2 = w^(k+1)`, `g3 = w^(k+2)`:
 *
 *     d = w^(k+2) - 2*w^(k+1) + w^k = w^k * (w - 1)^2 = w^k * w^4 = w^(k+4)
 *
 * and `w^(k+4)` is exactly the direction from `w^(k+1)` back to the origin.
 * So **every gravity arrow points straight at the body it belongs to.**
 *
 * Running the same algebra for a clockwise orbit (`g3 = w^(k-2)`) yields the
 * same inward arrow, which is why the rules can offer the pilot a free choice
 * of "clockwise or counter-clockwise orbit" from a standing start. It also
 * makes takeoff fall out for free: a ship boosted into the gravity hex above
 * its base is left stationary, and the inward arrow drops it back onto the
 * planet next turn "unless fuel is spent" — exactly as written.
 */

import {
  type Hex,
  type HexSide,
  add,
  distance,
  eq,
  hexSide,
  key,
  neighbor,
  sideGravityHex,
  sideKey,
  sub,
} from './hex.js';
import { courseHitsDisc, traceSegment } from './geometry.js';
import {
  type AstralBody,
  type BeltData,
  type GravityStrength,
  BODIES,
  buildBelt,
  inBounds,
} from './mapdata.js';

/** One body's gravitational pull on one hex. */
export interface GravitySource {
  readonly bodyId: string;
  readonly strength: Exclude<GravityStrength, 'none'>;
  /** Unit hex vector pointing from this hex at the body. */
  readonly arrow: Hex;
}

export interface PlanetaryBaseSite {
  readonly id: string;
  readonly bodyId: string;
  readonly side: HexSide;
  /** The gravity hex directly above this hexside. */
  readonly gravityHex: Hex;
  readonly hasPlanetaryDefences: boolean;
}

export interface AsteroidBaseSite {
  readonly id: string;
  readonly bodyId: string;
  readonly hex: Hex;
}

/** Detection ranges, rulebook p. 8. */
export const DETECTION_RANGE_SHIP = 3;
export const DETECTION_RANGE_PLANETARY_BASE = 5;

export class GameMap {
  readonly id = 'inner-system';
  readonly bodies: readonly AstralBody[];
  readonly belt: BeltData;

  private readonly bodyByHex = new Map<string, AstralBody>();
  private readonly gravityByHex = new Map<string, GravitySource[]>();
  private readonly planetaryBases: PlanetaryBaseSite[] = [];
  private readonly asteroidBases: AsteroidBaseSite[] = [];
  private readonly bodyById = new Map<string, AstralBody>();

  constructor(bodies: readonly AstralBody[] = BODIES, belt: BeltData = buildBelt()) {
    this.bodies = bodies;
    this.belt = belt;

    for (const body of bodies) {
      this.bodyByHex.set(key(body.hex), body);
      this.bodyById.set(body.id, body);

      // Gravity: every adjacent hex gets an arrow pointing at the body.
      if (body.gravity !== 'none') {
        for (let dir = 0; dir < 6; dir++) {
          const g = neighbor(body.hex, dir);
          const k = key(g);
          const list = this.gravityByHex.get(k) ?? [];
          list.push({
            bodyId: body.id,
            strength: body.gravity,
            arrow: sub(body.hex, g),
          });
          this.gravityByHex.set(k, list);
        }
      }

      // Bases.
      if (body.landing === 'hexside') {
        for (const dir of body.baseSides) {
          const side = hexSide(body.hex, dir);
          this.planetaryBases.push({
            id: `${body.id}:${dir}`,
            bodyId: body.id,
            side,
            gravityHex: sideGravityHex(side),
            hasPlanetaryDefences: body.planetaryDefences,
          });
        }
      } else if (body.landing === 'stop') {
        this.asteroidBases.push({ id: body.id, bodyId: body.id, hex: body.hex });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  body(id: string): AstralBody | undefined {
    return this.bodyById.get(id);
  }

  bodyAt(h: Hex): AstralBody | undefined {
    return this.bodyByHex.get(key(h));
  }

  inBounds(h: Hex): boolean {
    return inBounds(h);
  }

  /** All gravity sources acting on a hex; empty for clear space. */
  gravityAt(h: Hex): readonly GravitySource[] {
    return this.gravityByHex.get(key(h)) ?? [];
  }

  isGravityHex(h: Hex): boolean {
    return this.gravityByHex.has(key(h));
  }

  isAsteroid(h: Hex, cleared: ReadonlySet<string> = new Set()): boolean {
    const k = key(h);
    if (cleared.has(k)) return false;
    return this.belt.asteroids.has(k) || this.belt.denseAsteroids.has(k);
  }

  /** The dense cordon around Clandestine, impassable without scanners. */
  isDenseAsteroid(h: Hex, cleared: ReadonlySet<string> = new Set()): boolean {
    const k = key(h);
    return !cleared.has(k) && this.belt.denseAsteroids.has(k);
  }

  allPlanetaryBases(): readonly PlanetaryBaseSite[] {
    return this.planetaryBases;
  }

  allAsteroidBases(): readonly AsteroidBaseSite[] {
    return this.asteroidBases;
  }

  planetaryBaseAt(side: HexSide): PlanetaryBaseSite | undefined {
    const k = sideKey(side);
    return this.planetaryBases.find((b) => sideKey(b.side) === k);
  }

  /** The planetary base whose gravity hex is `h`, if any. */
  planetaryBaseBelow(h: Hex): PlanetaryBaseSite | undefined {
    return this.planetaryBases.find((b) => eq(b.gravityHex, h));
  }

  // -------------------------------------------------------------------------
  // Gravity accumulation
  // -------------------------------------------------------------------------

  /**
   * Work out the gravity a course picks up.
   *
   * Full-gravity hexes are mandatory and cumulative. Weak gravity (Luna, Io) is
   * optional — but only the *first* hex of a consecutive run: "When two or more
   * weak gravity hexes are entered consecutively, the second and later hexes
   * have the effect of full gravity hexes, regardless of how the first such hex
   * is treated." Runs are counted along the order the course entered them.
   */
  accumulateGravity(entered: readonly Hex[]): {
    mandatory: Hex;
    optional: Hex[];
  } {
    let mandatory: Hex = { q: 0, r: 0 };
    const optional: Hex[] = [];

    // Track, per body, how long the current unbroken run of weak-gravity hexes is.
    let weakRun = 0;

    for (const h of entered) {
      const sources = this.gravityAt(h);
      if (sources.length === 0) {
        weakRun = 0;
        continue;
      }

      let sawWeak = false;
      for (const src of sources) {
        if (src.strength === 'full') {
          mandatory = add(mandatory, src.arrow);
        } else {
          sawWeak = true;
          if (weakRun > 0) {
            // Second or later in a consecutive run: acts as full gravity.
            mandatory = add(mandatory, src.arrow);
          } else {
            optional.push(h);
          }
        }
      }
      weakRun = sawWeak ? weakRun + 1 : 0;
    }

    return { mandatory, optional };
  }

  /**
   * The gravity a ship (or ordnance) picks up from one turn of movement.
   *
   * This is the accessor the rules layer should use; `accumulateGravity` is the
   * lower-level primitive. Two cases:
   *
   *  - **Moving.** Gravity comes from the hexes the course *entered*, excluding
   *    the hex it started in. That hex's pull was already applied on the turn the
   *    ship arrived there — Figure 6 counts "the gravity hexes entered last
   *    turn", and double-counting the tail would break orbits.
   *  - **Stationary.** A ship that does not move is still sitting in the gravity
   *    hex, and is pulled again. This is not a special case bolted on: it is the
   *    rule that makes takeoff work. A ship boosted off the surface is "stationary
   *    in the gravity hex immediately above the base", and "unless fuel is spent
   *    on the next turn, the ship would fall back to the planet and crash."
   *    Without this, a stationary ship would hover over a planet forever, free.
   */
  gravityFromMove(from: Hex, to: Hex): { mandatory: Hex; optional: Hex[] } {
    if (eq(from, to)) return this.accumulateGravity([from]);
    return this.accumulateGravity(traceSegment(from, to).entered.slice(1));
  }

  /** The weak-gravity arrow a hex would contribute, if the pilot accepts it. */
  weakGravityArrow(h: Hex): Hex {
    let out: Hex = { q: 0, r: 0 };
    for (const src of this.gravityAt(h)) {
      if (src.strength === 'weak') out = add(out, src.arrow);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Collisions and sight lines
  // -------------------------------------------------------------------------

  /**
   * The body a course crashes into, if any. "If a ship's course vector
   * intersects the printed outline of an astral body, it has crashed."
   */
  crashedInto(from: Hex, to: Hex): AstralBody | undefined {
    for (const body of this.bodies) {
      if (courseHitsDisc(from, to, body.hex, body.discRadius)) return body;
    }
    return undefined;
  }

  /**
   * The body blocking a sight line, if any. Asteroids never block; moons,
   * planets and Sol always do.
   */
  lineOfSightBlockedBy(from: Hex, to: Hex): AstralBody | undefined {
    for (const body of this.bodies) {
      if (!body.blocksLineOfSight) continue;
      // A body in either endpoint's own hex does not block that ship's fire.
      if (eq(body.hex, from) || eq(body.hex, to)) continue;
      if (courseHitsDisc(from, to, body.hex, body.discRadius)) return body;
    }
    return undefined;
  }

  hasLineOfSight(from: Hex, to: Hex): boolean {
    return this.lineOfSightBlockedBy(from, to) === undefined;
  }

  // -------------------------------------------------------------------------
  // Asteroid hazard
  // -------------------------------------------------------------------------

  /**
   * How many asteroid hazard rolls a course provokes.
   *
   * "A die is rolled for each asteroid hex entered." Plus the hexside case:
   * "A ship passing along a hexside between two asteroid hexes is considered to
   * have entered one asteroid hex" — one roll for the pair, not two.
   *
   * Ships travelling at one hex per turn are never affected.
   */
  asteroidHazards(
    from: Hex,
    to: Hex,
    cleared: ReadonlySet<string> = new Set(),
  ): Hex[] {
    if (distance(from, to) <= 1) return [];
    const trace = traceSegment(from, to);
    const out: Hex[] = [];
    const seen = new Set<string>();

    for (const h of trace.entered) {
      if (this.isAsteroid(h, cleared) && !seen.has(key(h))) {
        seen.add(key(h));
        out.push(h);
      }
    }
    for (const [a, b] of trace.edgeRuns) {
      const aAst = this.isAsteroid(a, cleared);
      const bAst = this.isAsteroid(b, cleared);
      if (aAst && bAst) {
        // Counts as entering exactly one of them.
        const pick = seen.has(key(a)) ? b : a;
        if (!seen.has(key(pick))) {
          seen.add(key(pick));
          out.push(pick);
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Orbits
  // -------------------------------------------------------------------------

  /**
   * Is a ship in orbit? "A ship which moves at one hex per turn from one
   * gravity hex to an adjacent gravity hex of the same body is in orbit."
   */
  orbitOf(pos: Hex, velocity: Hex): AstralBody | undefined {
    if (distance({ q: 0, r: 0 }, velocity) !== 1) return undefined;
    const previous = sub(pos, velocity);
    const here = this.gravityAt(pos);
    const there = this.gravityAt(previous);
    for (const a of here) {
      for (const b of there) {
        if (a.bodyId === b.bodyId) return this.bodyById.get(a.bodyId);
      }
    }
    return undefined;
  }

  /** Sense of an orbit: +1 counter-clockwise, -1 clockwise, 0 if not orbiting. */
  orbitSense(pos: Hex, velocity: Hex): number {
    const body = this.orbitOf(pos, velocity);
    if (!body) return 0;
    const previous = sub(pos, velocity);
    const a = sub(previous, body.hex);
    const b = sub(pos, body.hex);
    // Cross product in cube space tells us which way round the ring we went.
    const cross = a.q * b.r - a.r * b.q;
    return Math.sign(cross);
  }
}

/** The standard chart, built once. */
export const DEFAULT_MAP = new GameMap();
