/**
 * Map and gravity tests.
 *
 * The important one is `orbit stability`: it demonstrates that the derived
 * inward gravity arrows reproduce the rulebook's orbit behaviour exactly,
 * including the free choice of direction from a standing start.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { traceSegment } from '../src/engine/geometry.js';
import { DIRECTIONS, add, distance, hex, key, neighbor, sub, type Hex } from '../src/engine/hex.js';
import { BODIES, inBounds, solarDistance } from '../src/engine/mapdata.js';

const map = DEFAULT_MAP;

describe('chart', () => {
  it('places every body inside the chart', () => {
    for (const b of BODIES) expect(inBounds(b.hex)).toBe(true);
  });

  it('gives every body its own hex', () => {
    const seen = new Set(BODIES.map((b) => key(b.hex)));
    expect(seen.size).toBe(BODIES.length);
  });

  it('keeps bodies far enough apart that gravity rings never overlap', () => {
    for (const a of BODIES) {
      for (const b of BODIES) {
        if (a.id === b.id) continue;
        if (a.gravity === 'none' || b.gravity === 'none') continue;
        // Distance >= 3 guarantees no hex is a gravity hex of two bodies.
        expect(distance(a.hex, b.hex)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('orders the planets outward from Sol', () => {
    const radius = (id: string) => solarDistance(BODIES.find((b) => b.id === id)!.hex);
    expect(radius('mercury')).toBeLessThan(radius('venus'));
    expect(radius('venus')).toBeLessThan(radius('terra'));
    expect(radius('terra')).toBeLessThan(radius('mars'));
    expect(radius('mars')).toBeLessThan(radius('ceres'));
    expect(radius('ceres')).toBeLessThan(radius('jupiter'));
  });

  it('has exactly six habitable full-gravity worlds, as Grand Tour requires', () => {
    // "each astral body with full gravity (the six habitable ones, plus Jupiter
    //  and the Sun)"
    const habitableFull = BODIES.filter((b) => b.habitable && b.gravity === 'full');
    expect(habitableFull.map((b) => b.id).sort()).toEqual([
      'callisto',
      'ganymede',
      'mars',
      'mercury',
      'terra',
      'venus',
    ]);
  });

  it('gives Luna and Io weak gravity and nothing else', () => {
    const weak = BODIES.filter((b) => b.gravity === 'weak').map((b) => b.id);
    expect(weak.sort()).toEqual(['io', 'luna']);
  });
});

describe('gravity', () => {
  it('gives every body exactly six gravity hexes', () => {
    for (const body of BODIES) {
      if (body.gravity === 'none') continue;
      const ring = [0, 1, 2, 3, 4, 5].map((d) => neighbor(body.hex, d));
      for (const g of ring) {
        const sources = map.gravityAt(g);
        expect(sources.some((s) => s.bodyId === body.id)).toBe(true);
      }
    }
  });

  it('points every arrow straight at its body', () => {
    for (const body of BODIES) {
      if (body.gravity === 'none') continue;
      for (let d = 0; d < 6; d++) {
        const g = neighbor(body.hex, d);
        const src = map.gravityAt(g).find((s) => s.bodyId === body.id)!;
        expect(key(add(g, src.arrow))).toBe(key(body.hex));
      }
    }
  });

  it('treats the second of a consecutive weak-gravity run as full gravity', () => {
    const luna = map.body('luna')!;
    const a = neighbor(luna.hex, 0);
    const b = neighbor(luna.hex, 1);
    const { mandatory, optional } = map.accumulateGravity([a, b]);
    // First is the pilot's choice; second is compulsory.
    expect(optional.map(key)).toEqual([key(a)]);
    expect(key(mandatory)).toBe(key(sub(luna.hex, b)));
  });

  it('makes a lone weak-gravity hex entirely optional', () => {
    const io = map.body('io')!;
    const g = neighbor(io.hex, 2);
    const { mandatory, optional } = map.accumulateGravity([g]);
    expect(optional.map(key)).toEqual([key(g)]);
    expect(key(mandatory)).toBe('0,0');
  });
});

/** Coast one turn under the movement rules, returning the new kinematic state. */
const coast = (
  pos: Hex,
  velocity: Hex,
  pendingGravity: Hex,
  burn?: number,
): { pos: Hex; velocity: Hex; pendingGravity: Hex; crashed: boolean } => {
  let endpoint = add(add(pos, velocity), pendingGravity);
  if (burn !== undefined) endpoint = neighbor(endpoint, burn);
  const crashed = map.crashedInto(pos, endpoint) !== undefined;
  return {
    pos: endpoint,
    velocity: sub(endpoint, pos),
    pendingGravity: map.gravityFromMove(pos, endpoint).mandatory,
    crashed,
  };
};

describe('orbit stability', () => {
  const terra = map.body('terra')!;
  const ring = new Set([0, 1, 2, 3, 4, 5].map((d) => key(neighbor(terra.hex, d))));

  it('lets a ship boosted off the surface enter orbit in either direction', () => {
    // Takeoff leaves the ship stationary in the gravity hex above its base.
    const start = neighbor(terra.hex, 0);

    const senses: number[] = [];
    const outcomes = [0, 1, 2, 3, 4, 5].map((burn) => {
      let s = coast(start, hex(0, 0), map.gravityFromMove(start, start).mandatory, burn);
      if (s.crashed) return 'crash';
      const sense = map.orbitSense(s.pos, s.velocity);
      for (let t = 0; t < 30; t++) {
        s = coast(s.pos, s.velocity, s.pendingGravity);
        if (s.crashed) return 'crash';
        if (!ring.has(key(s.pos))) return 'escape';
      }
      senses.push(sense);
      return 'orbit';
    });

    // "By expending a point of fuel, the ship may enter clockwise or
    //  counter-clockwise orbit."  Exactly two of the six burns do that, and
    // they are the two opposite senses -- which is the whole point of the rule.
    expect(outcomes.filter((o) => o === 'orbit')).toHaveLength(2);
    expect(senses.slice().sort()).toEqual([-1, 1]);

    // Burning straight across the planet flies through its disc; burning back
    // to where it started leaves the ship stationary, and it then falls in.
    expect(outcomes.filter((o) => o === 'crash')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'escape')).toHaveLength(2);
  });

  it('drops a stationary ship out of a gravity hex onto the planet', () => {
    // "The planetary surface gravity immediately cancels takeoff velocity,
    //  leaving the ship stationary in the gravity hex immediately above the
    //  base. Unless fuel is spent on the next turn, the ship would fall back to
    //  the planet and crash."
    const start = neighbor(terra.hex, 0);
    const pending = map.gravityFromMove(start, start).mandatory;
    expect(key(pending)).toBe(key(sub(terra.hex, start)));

    const next = coast(start, hex(0, 0), pending);
    expect(key(next.pos)).toBe(key(terra.hex));
    expect(next.crashed).toBe(true);
  });

  it('keeps an established orbit forever without burning fuel', () => {
    // "such a ship will continue to orbit until fuel is burned"
    for (const body of BODIES.filter((b) => b.gravity === 'full' && b.id !== 'sol')) {
      const bodyRing = new Set([0, 1, 2, 3, 4, 5].map((d) => key(neighbor(body.hex, d))));
      // Seed a legal orbit: one hex per turn between adjacent gravity hexes.
      const from = neighbor(body.hex, 0);
      const to = neighbor(body.hex, 1);
      let s = {
        pos: to,
        velocity: sub(to, from),
        pendingGravity: map.accumulateGravity([to]).mandatory,
        crashed: false,
      };
      for (let t = 0; t < 40; t++) {
        s = coast(s.pos, s.velocity, s.pendingGravity);
        expect(s.crashed).toBe(false);
        expect(bodyRing.has(key(s.pos))).toBe(true);
      }
    }
  });

  it('identifies an orbit and its sense', () => {
    const from = neighbor(terra.hex, 0);
    const to = neighbor(terra.hex, 1);
    const v = sub(to, from);
    expect(map.orbitOf(to, v)?.id).toBe('terra');
    expect(Math.abs(map.orbitSense(to, v))).toBe(1);
    // The reverse orbit has the opposite sense.
    expect(map.orbitSense(to, v)).toBe(-map.orbitSense(from, sub(from, to)));
  });

  it('does not call a fast fly-by an orbit', () => {
    const g = neighbor(terra.hex, 0);
    expect(map.orbitOf(g, hex(2, 0))).toBeUndefined();
  });
});

describe('hazards', () => {
  it('never rolls asteroid hazards at one hex per turn', () => {
    const belt = [...map.belt.asteroids].slice(0, 40);
    for (const k of belt) {
      const [q, r] = k.split(',').map(Number);
      const h = hex(q!, r!);
      expect(map.asteroidHazards(h, neighbor(h, 0))).toHaveLength(0);
    }
  });

  it('counts a hexside run between two asteroid hexes as a single entry', () => {
    // A course of the form d[i] + d[i+1] runs along the hexside shared by
    // X+d[i] and X+d[i+1] without entering either. Find one where both grazed
    // hexes are asteroids and neither endpoint is, so the pair is all we count.
    let found = 0;
    for (const k of map.belt.asteroids) {
      const [aq, ar] = k.split(',').map(Number);
      const a = hex(aq!, ar!);
      for (let i = 0; i < 6; i++) {
        const from = sub(a, DIRECTIONS[i]!);
        const b = add(from, DIRECTIONS[(i + 1) % 6]!);
        if (!map.belt.asteroids.has(key(b))) continue;
        const to = add(from, add(DIRECTIONS[i]!, DIRECTIONS[(i + 1) % 6]!));
        if (map.isAsteroid(from) || map.isAsteroid(to)) continue;

        const trace = traceSegment(from, to);
        // Sanity: the tracer really does graze rather than enter.
        expect(trace.edgeRuns).toHaveLength(1);
        expect(new Set([key(trace.edgeRuns[0]![0]), key(trace.edgeRuns[0]![1])])).toEqual(
          new Set([key(a), key(b)]),
        );
        expect(trace.entered.map(key)).toEqual([key(from), key(to)]);

        // "A ship passing along a hexside between two asteroid hexes is
        //  considered to have entered one asteroid hex."  One roll, not two.
        expect(map.asteroidHazards(from, to)).toHaveLength(1);
        found++;
        break;
      }
      if (found >= 5) break;
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('line of sight', () => {
  it('is blocked by a planet but not by asteroids', () => {
    const terra = map.body('terra')!;
    const through = map.lineOfSightBlockedBy(
      add(terra.hex, hex(-3, 0)),
      add(terra.hex, hex(3, 0)),
    );
    expect(through?.id).toBe('terra');

    const ceres = map.body('ceres')!;
    // Ceres is a major asteroid: a collision hazard, but never a sight blocker.
    expect(ceres.blocksLineOfSight).toBe(false);
  });

  it('lets a ship in a body’s own hex still shoot', () => {
    const ceres = map.body('ceres')!;
    expect(map.hasLineOfSight(ceres.hex, add(ceres.hex, hex(2, 0)))).toBe(true);
  });
});
