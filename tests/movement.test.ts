/**
 * Movement, rule by rule.
 *
 * Each test quotes the rulebook clause it enforces, and is written against that
 * clause rather than against the implementation — the point is to catch the
 * engine being confidently wrong, so a test that merely restates what the code
 * already does is worth nothing here.
 *
 * Covers pp. 2-5 and 7: coasting, fuel, the overload manoeuvre, gravity,
 * weak gravity, orbits, takeoff and landing, crashes, leaving the chart,
 * ramming, asteroid hazards, and disablement.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Hex,
  type Ship,
  DEFAULT_MAP,
  add,
  applyCommand,
  createInitialState,
  distance,
  hex,
  key,
  length as speed,
  makePlayer,
  makeShip,
  neighbor,
  predictedEndpoint,
  reachableEndpoints,
  sub,
  traceSegment,
  withinRadius,
} from '../src/engine/index.js';
import { courseThroughCentre } from '../src/engine/movement.js';
import { BODIES } from '../src/engine/mapdata.js';

const map = DEFAULT_MAP;
const A = 'a';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const game = (ships: readonly Ship[]): GameState =>
  createInitialState({
    scenarioId: 'movement',
    seed: 99,
    players: [makePlayer(A, 'Pilot', 'Test', '#e8703a')],
    ships,
  });

const ok = (s: GameState, cmd: Command): GameState => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const refused = (s: GameState, cmd: Command): void => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
};

/** One whole game turn (a single player, so a player-turn is a day). */
const turn = (s: GameState): GameState => {
  let next = s;
  for (let i = 0; i < 5; i++) next = ok(next, { type: 'endPhase', by: A });
  return next;
};

const shipOf = (s: GameState): Ship => s.ships['s']!;

/**
 * A start hex whose whole run is genuinely empty — no body within two hexes,
 * no asteroids, never off-chart. Picking "somewhere that looks blank" is how a
 * test ends up quietly flying through Luna.
 */
const clearLane = (v: Hex, turns = 6): Hex => {
  for (let q = -32; q <= 32; q++) {
    for (let r = -32; r <= 32; r++) {
      const start = hex(q, r);
      let good = true;
      for (let t = 0; t <= turns; t++) {
        const p = add(start, hex(v.q * t, v.r * t));
        if (!map.inBounds(p) || map.isAsteroid(p) || BODIES.some((b) => distance(b.hex, p) <= 2)) {
          good = false;
          break;
        }
      }
      if (good) return start;
    }
  }
  throw new Error('no clear lane');
};

const corvette = (pos: Hex, velocity: Hex, fuel = 20): Ship =>
  makeShip({ id: 's', owner: A, shipClass: 'corvette', pos, velocity, fuel });

const TERRA = map.body('terra')!;
const LUNA = map.body('luna')!;

// ---------------------------------------------------------------------------

describe('coasting', () => {
  it('holds direction and distance with no thrust or gravity', () => {
    // "A ship which is not accelerated by thrust or gravity will move as it did
    //  in the previous turn, in the same direction, and traveling an equal
    //  distance."
    for (const v of [hex(3, 0), hex(0, 2), hex(2, -2), hex(1, 1)]) {
      const start = clearLane(v);
      let s = game([corvette(start, v)]);
      for (let t = 1; t <= 5; t++) {
        s = turn(s);
        const ship = shipOf(s);
        expect({ v: key(v), t, pos: key(ship.pos), fuel: ship.fuel }).toEqual({
          v: key(v),
          t,
          pos: key(add(start, hex(v.q * t, v.r * t))),
          fuel: 20,
        });
      }
    }
  });

  it('predicts the endpoint as position plus velocity', () => {
    const start = clearLane(hex(2, 0));
    const s = game([corvette(start, hex(2, 0))]);
    expect(key(predictedEndpoint(s, shipOf(s), map))).toBe(key(add(start, hex(2, 0))));
  });
});

describe('burning fuel', () => {
  it('offers the predicted hex and its six neighbours for one point', () => {
    // "One fuel point allows a ship to alter its predicted course by one hex in
    //  any direction." / Figure 3: "any hex adjacent to C".
    const start = clearLane(hex(2, 0));
    const s = game([corvette(start, hex(2, 0))]);
    const C = add(start, hex(2, 0));
    const opts = reachableEndpoints(s, shipOf(s), map);

    expect(opts.filter((o) => o.accel === 0)).toHaveLength(1);
    expect(opts.filter((o) => o.accel === 1)).toHaveLength(6);
    for (const o of opts.filter((o) => o.accel === 1)) {
      expect(distance(o.endpoint, C)).toBe(1);
    }
  });

  it('sets velocity to the whole arrow from the old position', () => {
    // "A straight line from the ship's original position to the new endpoint
    //  represents the ship's velocity for that turn."
    const start = clearLane(hex(2, 0));
    const target = neighbor(add(start, hex(2, 0)), 5);
    let s = game([corvette(start, hex(2, 0))]);
    s = ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: target });
    s = turn(s);
    expect(key(shipOf(s).velocity)).toBe(key(sub(target, start)));
    expect(shipOf(s).fuel).toBe(19);
  });

  it('lets a ship slow down, stop, and reverse over successive turns', () => {
    // "This may result in turning, speeding up, or slowing down." There is no
    // one-turn reversal: a burn shifts the arrowhead one hex, so shedding speed
    // N takes N turns. The Escape scenario depends on exactly this, asking for
    // "sufficient fuel remaining to make a dead stop, plus one fuel point".
    const v = hex(3, 0);
    const start = clearLane(v, 10);
    let s = game([corvette(start, v)]);

    const speeds: number[] = [speed(shipOf(s).velocity)];
    for (let t = 0; t < 3; t++) {
      const ship = shipOf(s);
      const braking = reachableEndpoints(s, ship, map)
        .filter((o) => o.accel === 1 && !o.crashesInto && !o.exitsMap)
        .sort((x, y) => speed(sub(x.endpoint, ship.pos)) - speed(sub(y.endpoint, ship.pos)))[0]!;
      s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: braking.endpoint }));
      speeds.push(speed(shipOf(s).velocity));
    }
    expect(speeds).toEqual([3, 2, 1, 0]);
    expect(shipOf(s).fuel).toBe(17); // one point per hex of speed shed

    // Stopped, it can now accelerate the other way.
    const back = neighbor(shipOf(s).pos, 3);
    s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: back }));
    expect(key(shipOf(s).velocity)).toBe(key(sub(back, sub(back, hex(-1, 0)))));
    expect(speed(shipOf(s).velocity)).toBe(1);
  });

  it('forbids acceleration once the tanks are dry', () => {
    // "When a ship has burned all of its fuel points, it is out of fuel;
    //  further acceleration (except by gravity) is impossible."
    const start = clearLane(hex(2, 0));
    const s = game([corvette(start, hex(2, 0), 0)]);
    const target = neighbor(add(start, hex(2, 0)), 1);
    refused(s, { type: 'plotCourse', by: A, ship: 's', endpoint: target });
    // It still coasts.
    expect(key(shipOf(turn(s)).pos)).toBe(key(add(start, hex(2, 0))));
  });
});

describe('the overload manoeuvre', () => {
  it('spends two points for a two-hex vector change', () => {
    // "Overload allows expenditure of two fuel points in one turn; the result
    //  is a vector change of two hexes rather than the usual one."
    const start = clearLane(hex(2, 0));
    const s = game([corvette(start, hex(2, 0))]);
    const two = reachableEndpoints(s, shipOf(s), map).filter((o) => o.accel === 2);
    expect(two).toHaveLength(12);
    for (const o of two) expect(distance(o.endpoint, add(start, hex(2, 0)))).toBe(2);

    const after = turn(
      ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: two[0]!.endpoint, overload: true }),
    );
    expect(after.ships['s']!.fuel).toBe(18);
  });

  it('allows only one between maintenance stopovers', () => {
    // "Warships may perform one overload maneuver between maintenance stopovers."
    const start = clearLane(hex(2, 0), 10);
    let s = game([corvette(start, hex(2, 0))]);
    const first = reachableEndpoints(s, shipOf(s), map).find((o) => o.accel === 2)!;
    s = turn(
      ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: first.endpoint, overload: true }),
    );
    expect(shipOf(s).overloadAvailable).toBe(false);

    const again = reachableEndpoints(s, shipOf(s), map).find((o) => o.accel === 2);
    if (again) {
      refused(s, {
        type: 'plotCourse',
        by: A,
        ship: 's',
        endpoint: again.endpoint,
        overload: true,
      });
    }
  });

  it('is closed to every commercial class', () => {
    // "Commercial ships (transports, packets, tankers, liners) may not perform
    //  the overload maneuver."
    for (const cls of ['transport', 'packet', 'tanker', 'liner'] as const) {
      const start = clearLane(hex(2, 0));
      const s = game([
        makeShip({ id: 's', owner: A, shipClass: cls, pos: start, velocity: hex(2, 0) }),
      ]);
      expect(reachableEndpoints(s, shipOf(s), map).filter((o) => o.accel === 2)).toHaveLength(0);
    }
  });
});

describe('gravity', () => {
  it('takes effect on the turn after the hex is entered', () => {
    // "Gravity takes effect on the turn after an object enters the gravity hex."
    const g = neighbor(TERRA.hex, 0);
    const outside = add(g, hex(2, 0));
    // Fly inward and stop on the gravity hex: no pull this turn, pull next.
    let s = game([corvette(outside, hex(-2, 0))]);
    const before = shipOf(s);
    expect(key(before.pendingGravity)).toBe('0,0');

    s = turn(s); // now sitting in/through the gravity hex
    // Whatever it entered, the pull it carries is the sum of arrows entered.
    const carried = shipOf(s).pendingGravity;
    const entered = traceSegment(before.pos, shipOf(s).pos).entered.slice(1);
    expect(key(carried)).toBe(key(map.accumulateGravity(entered).mandatory));
  });

  it('is cumulative across several gravity hexes on one course', () => {
    // "Gravity is cumulative and mandatory."
    const ring = [0, 1, 2].map((d) => neighbor(TERRA.hex, d));
    const sum = ring.reduce((acc, g) => add(acc, sub(TERRA.hex, g)), hex(0, 0));
    expect(key(map.accumulateGravity(ring).mandatory)).toBe(key(sum));
  });

  it('is mandatory: a full-gravity hex is never optional', () => {
    const g = neighbor(TERRA.hex, 0);
    const { mandatory, optional } = map.accumulateGravity([g]);
    expect(optional).toHaveLength(0);
    expect(key(mandatory)).toBe(key(sub(TERRA.hex, g)));
  });

  it('pulls a stationary ship out of its gravity hex', () => {
    // The takeoff rule states the consequence outright: left stationary in the
    // gravity hex, "unless fuel is spent on the next turn, the ship would fall
    // back to the planet and crash."
    const g = neighbor(TERRA.hex, 0);
    expect(key(map.gravityFromMove(g, g).mandatory)).toBe(key(sub(TERRA.hex, g)));
  });
});

describe('weak gravity', () => {
  const weakRing = (d: number): Hex => neighbor(LUNA.hex, d);

  it('makes a single weak hex the pilot’s choice', () => {
    // "A ship passing through one weak gravity hex may ignore it or use it, as
    //  the player chooses."
    const g = weakRing(0);
    const { mandatory, optional } = map.accumulateGravity([g]);
    expect(key(mandatory)).toBe('0,0');
    expect(optional.map(key)).toEqual([key(g)]);
  });

  it('makes the second of a consecutive run compulsory', () => {
    // "When two or more weak gravity hexes are entered consecutively, the
    //  second and later hexes have the effect of full gravity hexes,
    //  regardless of how the first such hex is treated."
    const a = weakRing(0);
    const b = weakRing(1);
    const { mandatory, optional } = map.accumulateGravity([a, b]);
    expect(optional.map(key)).toEqual([key(a)]);
    expect(key(mandatory)).toBe(key(sub(LUNA.hex, b)));
  });

  it('counts a run across turn boundaries, not just within one course', () => {
    // A ship orbiting Luna enters exactly one weak hex per turn. If the run
    // counter resets each turn, every one of them is "first of a run" and stays
    // optional for ever, and orbits round Luna and Io become free.
    const a = weakRing(0);
    const b = weakRing(1);
    const first = map.accumulateGravity([a]);
    expect(first.optional.map(key)).toEqual([key(a)]);

    const second = map.accumulateGravity([a, b]);
    expect(second.optional.map(key)).not.toContain(key(b));
  });
});

describe('orbits', () => {
  it('holds for every full-gravity body without spending fuel', () => {
    // "A ship which moves at one hex per turn from one gravity hex to an
    //  adjacent gravity hex of the same body is in orbit... such a ship will
    //  continue to orbit until fuel is burned to produce a course change."
    for (const body of BODIES.filter((b) => b.gravity === 'full' && b.id !== 'sol')) {
      const ring = new Set([0, 1, 2, 3, 4, 5].map((d) => key(neighbor(body.hex, d))));
      const from = neighbor(body.hex, 0);
      const to = neighbor(body.hex, 1);

      let s = game([corvette(to, sub(to, from))]);
      s = {
        ...s,
        ships: {
          s: { ...shipOf(s), pendingGravity: map.gravityFromMove(from, to).mandatory },
        },
      };
      for (let t = 0; t < 18; t++) {
        s = turn(s);
        const ship = shipOf(s);
        expect({ body: body.id, t, dead: ship.destroyed, inRing: ring.has(key(ship.pos)) }).toEqual(
          {
            body: body.id,
            t,
            dead: false,
            inRing: true,
          },
        );
      }
      expect(shipOf(s).fuel).toBe(20);
    }
  });
});

describe('crashes and the chart edge', () => {
  it('destroys a ship whose course intersects a printed disc', () => {
    // "If a ship's course vector intersects the printed outline of an astral
    //  body, it has crashed. The ship is eliminated."
    const start = add(TERRA.hex, hex(-3, 0));
    const s = game([corvette(start, hex(3, 0))]);
    expect(shipOf(turn(s)).destroyed).toBe(true);
  });

  it('spares a course that clips a body’s hex but misses the disc, and still applies its gravity', () => {
    // "Each of these bodies has a definite size — they do not cover their
    //  entire hex. The course of a ship must intersect the printed image of the
    //  astral body itself for contact to occur." And, for the gap that leaves:
    // "A ship which passes between a gravity hex and the planetary outline is
    //  affected by the gravity hex" — squeezing past must not dodge the pull.
    let checked = 0;
    for (const body of BODIES) {
      const near = withinRadius(body.hex, 3);
      for (const tail of near) {
        for (const head of near) {
          if (key(tail) === key(head)) continue;
          if (!traceSegment(tail, head).entered.some((h) => key(h) === key(body.hex))) continue;
          if (map.crashedInto(tail, head)) continue;

          // Threading the uncovered part of the hex is not a crash...
          expect({ body: body.id, crash: map.crashedInto(tail, head)?.id ?? null }).toEqual({
            body: body.id,
            crash: null,
          });
          // ...and for a body that has gravity, it cannot dodge the pull: the
          // ring cannot be skipped on the way to the body's own hex.
          if (body.gravity !== 'none') {
            const g = map.gravityFromMove(tail, head);
            const pulled = key(g.mandatory) !== '0,0' || g.optional.length > 0;
            expect({ body: body.id, course: `${key(tail)}->${key(head)}`, pulled }).toEqual({
              body: body.id,
              course: `${key(tail)}->${key(head)}`,
              pulled: true,
            });
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('eliminates a ship whose final endpoint leaves the chart', () => {
    // "Any ship whose final course places it off the map is considered
    //  eliminated."
    const edge = hex(33, 0);
    expect(map.inBounds(edge)).toBe(true);
    const s = game([corvette(edge, hex(4, 0))]);
    expect(shipOf(turn(s)).destroyed).toBe(true);
  });
});

describe('takeoff and landing', () => {
  const landed = (dir: number): Ship =>
    makeShip({
      id: 's',
      owner: A,
      shipClass: 'corvette',
      pos: TERRA.hex,
      location: { kind: 'landed', side: { hex: TERRA.hex, dir } },
    });

  it('lifts one hex for free and leaves the ship stationary', () => {
    // "Boosters provide an acceleration of one hex from the world or satellite
    //  to an adjacent hex. Thus, takeoff requires no fuel points. The planetary
    //  surface gravity immediately cancels takeoff velocity, leaving the ship
    //  stationary in the gravity hex immediately above the base."
    let s = game([landed(0)]);
    s = turn(ok(s, { type: 'takeOff', by: A, ship: 's' }));
    const ship = shipOf(s);
    expect(key(ship.pos)).toBe(key(neighbor(TERRA.hex, 0)));
    expect(key(ship.velocity)).toBe('0,0');
    expect(ship.fuel).toBe(20);
  });

  it('falls back onto the planet when no fuel is spent', () => {
    let s = game([landed(0)]);
    s = turn(ok(s, { type: 'takeOff', by: A, ship: 's' }));
    expect(shipOf(s).destroyed).toBe(false);
    s = turn(s);
    expect(shipOf(s).destroyed).toBe(true);
  });

  it('enters orbit in either direction for one fuel point', () => {
    // "By expending a point of fuel, the ship may enter clockwise or
    //  counter-clockwise orbit."
    let s = game([landed(0)]);
    s = turn(ok(s, { type: 'takeOff', by: A, ship: 's' }));

    const ring = new Set([0, 1, 2, 3, 4, 5].map((d) => key(neighbor(TERRA.hex, d))));
    const senses = new Set<number>();
    let orbits = 0;

    for (const opt of reachableEndpoints(s, shipOf(s), map).filter((o) => o.accel === 1)) {
      let t = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: opt.endpoint }));
      if (shipOf(t).destroyed) continue;
      const sense = map.orbitSense(shipOf(t).pos, shipOf(t).velocity);
      let held = true;
      for (let i = 0; i < 14; i++) {
        t = turn(t);
        if (shipOf(t).destroyed || !ring.has(key(shipOf(t).pos))) {
          held = false;
          break;
        }
      }
      if (held) {
        orbits++;
        senses.add(sense);
        expect(shipOf(t).fuel).toBe(19);
      }
    }
    expect(orbits).toBe(2);
    expect([...senses].sort()).toEqual([-1, 1]);
  });
});

describe('disablement', () => {
  it('leaves a disabled ship drifting on its current course', () => {
    // "A disabled ship cannot maneuver, launch ordnance, or attack. It may only
    //  drift on its current course."
    const v = hex(2, 0);
    const start = clearLane(v, 8);
    let s = game([corvette(start, v)]);
    s = { ...s, ships: { s: { ...shipOf(s), disabled: 3 } } };

    const target = neighbor(add(start, v), 1);
    refused(s, { type: 'plotCourse', by: A, ship: 's', endpoint: target });

    s = turn(s);
    expect(key(shipOf(s).pos)).toBe(key(add(start, v)));
    expect(shipOf(s).fuel).toBe(20);
  });
});

describe('asteroid hazards', () => {
  it('never rolls at one hex per turn', () => {
    // "Ships entering any asteroid hex at a speed greater than one hex per turn
    //  may be affected."
    let checked = 0;
    for (const k of [...map.belt.asteroids].slice(0, 60)) {
      const [q, r] = k.split(',').map(Number);
      const h = hex(q!, r!);
      expect(map.asteroidHazards(h, neighbor(h, 0))).toHaveLength(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('does not re-roll the hex the course starts in', () => {
    // A hazard is rolled "for each asteroid hex entered"; the hex a ship is
    // already sitting in was entered on a previous turn and is not re-entered
    // by leaving it.
    for (const k of [...map.belt.asteroids].slice(0, 40)) {
      const [q, r] = k.split(',').map(Number);
      const from = hex(q!, r!);
      const to = add(from, hex(3, 0));
      if (!map.inBounds(to)) continue;
      expect(map.asteroidHazards(from, to).some((h) => key(h) === key(from))).toBe(false);
    }
  });
});

describe('landing', () => {
  it('requires orbit and one fuel point, and binds the ship to that hexside', () => {
    // "A ship may only land by expending one fuel point while in orbit. The
    //  ship then moves to any hex side on the planet... It must take off from
    //  the hex side where it landed."
    const from = neighbor(TERRA.hex, 0);
    const to = neighbor(TERRA.hex, 1);
    let s = game([corvette(to, sub(to, from))]);
    s = {
      ...s,
      ships: { s: { ...shipOf(s), pendingGravity: map.gravityFromMove(from, to).mandatory } },
    };
    expect(map.orbitOf(shipOf(s).pos, shipOf(s).velocity)?.id).toBe('terra');

    s = ok(s, { type: 'land', by: A, ship: 's', side: { hex: TERRA.hex, dir: 3 } });
    s = turn(s);
    const ship = shipOf(s);
    expect(ship.location.kind).toBe('landed');
    if (ship.location.kind === 'landed') expect(ship.location.side.dir).toBe(3);
    expect(ship.fuel).toBe(19);
  });

  it('refuses to land a ship that is not in orbit', () => {
    const start = clearLane(hex(2, 0));
    const s = game([corvette(start, hex(2, 0))]);
    refused(s, { type: 'land', by: A, ship: 's', side: { hex: TERRA.hex, dir: 0 } });
  });

  it('lands on an asteroid by simply stopping in the hex', () => {
    // "Ships may land at Ceres and Clandestine, or at any unnamed asteroid in
    //  the Belt, by simply stopping in the hex."
    const ceres = map.body('ceres')!;
    const approach = neighbor(ceres.hex, 0);
    let s = game([corvette(approach, hex(0, 0))]);

    // Drifting in at speed 1 is arriving, not stopping: the ship is over the
    // rock but still moving, and would carry straight on next turn.
    s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: ceres.hex }));
    expect(key(shipOf(s).pos)).toBe(key(ceres.hex));
    expect(speed(shipOf(s).velocity)).toBe(1);
    expect(shipOf(s).location.kind).toBe('space');
    expect(shipOf(s).destroyed).toBe(false); // a small disc is not a crash

    // Killing the last hex of velocity is what lands it.
    s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: ceres.hex }));
    const ship = shipOf(s);
    expect(key(ship.pos)).toBe(key(ceres.hex));
    expect(speed(ship.velocity)).toBe(0);
    expect(ship.location.kind).toBe('asteroidBase');
  });

  it('lets a ship leave an asteroid base again', () => {
    // The sentence above has to work in both directions. A ship stopped at
    // Ceres is inside the printed outline by definition, so *every* course it
    // could plot starts there; if that counted as intersecting the outline, no
    // ship could ever leave — and the takeoff rule sends it out exactly this
    // way: an asteroid base is left "by accelerating out of the hex".
    const ceres = map.body('ceres')!;
    let s = game([corvette(ceres.hex, hex(0, 0))]);
    const out = neighbor(ceres.hex, 0);

    // The option is offered as a clean course, not as a crash...
    const option = reachableEndpoints(s, shipOf(s), map).find((o) => key(o.endpoint) === key(out));
    expect(option?.crashesInto).toBeUndefined();

    // ...and flying it leaves the rock behind with the ship intact.
    s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: out }));
    expect({ destroyed: shipOf(s).destroyed, at: key(shipOf(s).pos) }).toEqual({
      destroyed: false,
      at: key(out),
    });
  });

  it('lets a ship leave Clandestine too', () => {
    // The other body the rulebook lets a ship stop at, and the one it matters
    // most for: the pirates in Lateral 7 and Piracy are based there.
    // With scanners aboard: "only ships possessing scanners may enter those
    // hexes. Other ships are destroyed" — the dense cordon is a separate rule,
    // and the point here is the rock itself, not the belt around it.
    const clandestine = map.body('clandestine')!;
    let s = game([
      { ...corvette(clandestine.hex, hex(0, 0)), cargo: [{ kind: 'scanners', quantity: 1 }] },
    ]);
    const out = neighbor(clandestine.hex, 0);
    s = turn(ok(s, { type: 'plotCourse', by: A, ship: 's', endpoint: out }));
    expect(shipOf(s).destroyed).toBe(false);
  });

  it('names every body a course touches, not merely the first', () => {
    // The exemption for a departed rock is per body, so the crash check has to
    // see the whole list: a course forgiven for leaving Ceres may still be
    // flying into something else.
    const terra = map.body('terra')!;
    const luna = map.body('luna')!;
    const through = add(terra.hex, sub(terra.hex, luna.hex));
    const hit = map.bodiesHit(luna.hex, through).map((b) => b.id);
    expect(hit).toContain('terra');
    expect(hit).toContain('luna');
  });
});

describe('ramming', () => {
  const twoShips = (aPos: Hex, aVel: Hex, bPos: Hex): GameState =>
    createInitialState({
      scenarioId: 'ram',
      seed: 4,
      players: [
        makePlayer(A, 'Pilot', 'Test', '#e8703a'),
        makePlayer('b', 'Foe', 'Test', '#4a9fe0'),
      ],
      ships: [
        makeShip({ id: 's', owner: A, shipClass: 'corsair', pos: aPos, velocity: aVel }),
        makeShip({ id: 't', owner: 'b', shipClass: 'corvette', pos: bPos }),
      ],
    });

  it('requires the course to pass through the centre of the target’s hex', () => {
    // "The ramming ship's course must pass through the center of the hex
    //  occupied by the target ship."
    const start = clearLane(hex(2, 0), 8);
    const through = add(start, hex(1, 0)); // dead on the line
    const beside = add(start, hex(1, 1)); // off the line

    expect(courseThroughCentre(start, add(start, hex(2, 0)), through)).toBe(true);
    expect(courseThroughCentre(start, add(start, hex(2, 0)), beside)).toBe(false);

    const offLine = twoShips(start, hex(2, 0), beside);
    refused(offLine, { type: 'declareRam', by: A, ship: 's', target: 't' });
  });

  it('applies its result to both ships', () => {
    // "The results apply to both ships."
    const start = clearLane(hex(2, 0), 8);
    const victim = add(start, hex(1, 0));
    let s = twoShips(start, hex(2, 0), victim);
    s = ok(s, { type: 'declareRam', by: A, ship: 's', target: 't' });
    for (let i = 0; i < 5; i++) s = ok(s, { type: 'endPhase', by: A });

    const rammer = s.ships['s']!;
    const target = s.ships['t']!;
    const hurt = (x: Ship): boolean => x.destroyed || x.disabled > 0;
    // A roll of 1 or 2 is a clean miss for both; otherwise both take it.
    expect(hurt(rammer)).toBe(hurt(target));
  });

  it('allows only one ram attempt per turn', () => {
    // "A ship may ram (or attempt to ram) only one target per turn."
    const start = clearLane(hex(2, 0), 8);
    const victim = add(start, hex(1, 0));
    let s = createInitialState({
      scenarioId: 'ram',
      seed: 4,
      players: [
        makePlayer(A, 'Pilot', 'Test', '#e8703a'),
        makePlayer('b', 'Foe', 'Test', '#4a9fe0'),
      ],
      ships: [
        makeShip({ id: 's', owner: A, shipClass: 'corsair', pos: start, velocity: hex(2, 0) }),
        makeShip({ id: 't', owner: 'b', shipClass: 'corvette', pos: victim }),
        makeShip({ id: 'u', owner: 'b', shipClass: 'corvette', pos: victim }),
      ],
    });
    // Re-declaring before the movement phase is changing your mind, not a
    // second ram: the later declaration replaces the earlier one, so exactly
    // one target is struck.
    s = ok(s, { type: 'declareRam', by: A, ship: 's', target: 't' });
    s = ok(s, { type: 'declareRam', by: A, ship: 's', target: 'u' });
    for (let i = 0; i < 5; i++) s = ok(s, { type: 'endPhase', by: A });

    const hurt = (x: Ship): boolean => x.destroyed || x.disabled > 0;
    const struck = [s.ships['t']!, s.ships['u']!].filter(hurt);
    // Either the ram missed entirely, or it hit only the ship named last.
    if (struck.length > 0) {
      expect(struck.map((x) => x.id)).toEqual(['u']);
    }
  });
});
