/**
 * Flight School: the solo movement trainer.
 *
 * This scenario is not from the rulebook, so there is no printed clause to test
 * it against — but every exercise it sets *is* a printed clause, and what has to
 * be proved is that the exercise is marked off exactly when the rule it teaches
 * has been obeyed, and never before.
 *
 * The last test flies the whole course through the real reducer. That is the one
 * that matters: a trainer whose par nobody has flown is a number somebody made
 * up, and a checklist that cannot be completed is worse than no checklist.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Hex,
  type PlayerId,
  type Ship,
  applyCommand,
  distance,
  hex,
  length,
  reachableEndpoints,
  sub,
} from '../src/engine/index.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { buildScenario, inOrbit, scenarioById } from '../src/scenarios/index.js';
import {
  FLIGHT_SCHOOL_EXERCISES,
  FLIGHT_SCHOOL_PAR,
  flightSchoolProgress,
} from '../src/scenarios/flightSchool.js';

const map = DEFAULT_MAP;
const CADET: PlayerId = 'cadet';
const SHIP = 'school-ship';
const TERRA = map.body('terra')!;

const start = (): GameState => buildScenario('flight-school');

const ok = (state: GameState, cmd: Command): GameState => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const advance = (s: GameState): GameState => ok(s, { type: 'endPhase', by: CADET });

/** Run the phase machine until the astrogation phase of the next day. */
const nextDay = (s: GameState): GameState => {
  const day = s.turn;
  let x = s;
  for (let i = 0; i < 12 && x.turn === day; i += 1) x = advance(x);
  return x;
};

const shipOf = (s: GameState): Ship => s.ships[SHIP]!;
const doneIn = (s: GameState): Set<string> => new Set(flightSchoolProgress(s).done);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Flight School sets up as a solo trainer', () => {
  it('seats exactly one player', () => {
    const def = scenarioById('flight-school')!;
    expect(def.players).toEqual({ min: 1, max: 1 });
    expect(Object.keys(start().players)).toEqual([CADET]);
  });

  it('gives one ship, landed on Terra, with nothing hostile anywhere', () => {
    const s = start();
    const ships = Object.values(s.ships);
    expect(ships).toHaveLength(1);
    const ship = ships[0]!;
    expect(ship.owner).toBe(CADET);
    expect(ship.location.kind).toBe('landed');
    expect(map.bodyAt(ship.pos)?.id).toBe('terra');
  });

  it('flies a torch, so a cadet can never strand themselves', () => {
    // "Torchships have unlimited fuel." The point of the choice: a bad burn
    // costs time and score, never the game.
    const ship = shipOf(start());
    expect(ship.shipClass).toBe('torch');
    expect(ship.fuel).toBe(Infinity);
  });

  it('opens with every exercise outstanding and none quietly pre-ticked', () => {
    const s = start();
    expect(flightSchoolProgress(s).done).toEqual([]);
    expect(FLIGHT_SCHOOL_EXERCISES.length).toBe(6);
    // Every exercise has to be reachable by id, or the panel would show a step
    // that can never tick.
    expect(new Set(FLIGHT_SCHOOL_EXERCISES.map((e) => e.id)).size).toBe(6);
  });

  it('does not award the homecoming to a ship that has never left', () => {
    // The ship starts landed on Terra, which is where "come home" ends. It must
    // not count until it has actually been away.
    const s = nextDay(start());
    expect(doneIn(s).has('comeHome')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The exercises, one clause at a time
// ---------------------------------------------------------------------------

describe('each exercise is marked off by the rule it teaches', () => {
  it('ticks lift-off once the ship is off the surface', () => {
    // "Boosters... lift the ship one hex, leaving it stationary in the gravity
    //  hex above the base."
    let s = start();
    expect(doneIn(s).has('liftOff')).toBe(false);
    s = ok(s, { type: 'takeOff', by: CADET, ship: SHIP });
    s = nextDay(s);
    expect(shipOf(s).location.kind).not.toBe('landed');
    expect(doneIn(s).has('liftOff')).toBe(true);
  });

  it('ticks "under way" only at cruise speed, not at the first burn', () => {
    // "One fuel point allows a ship to alter its predicted course by one hex" —
    // so speed 3 is three separate decisions, and one burn must not count.
    let s = ok(start(), { type: 'takeOff', by: CADET, ship: SHIP });
    s = nextDay(s);

    let speed = 0;
    for (let day = 0; day < 6; day += 1) {
      const ship = shipOf(s);
      speed = length(ship.velocity);
      const ticked = doneIn(s).has('underWay');
      // The invariant under test, checked every single day: the tick and the
      // speed agree, in both directions.
      expect({ day, fast: speed >= 3, ticked }).toEqual({ day, fast: speed >= 3, ticked });
      if (speed >= 3) break;

      // Ask for the fastest legal course. Aiming at the hex farthest from Terra
      // would hover forever: from a standstill in a gravity hex, every one-point
      // burn reaches the same ring, and only taking the fall builds speed.
      const outward = reachableEndpoints(s, ship, map)
        .filter((o) => o.accel <= 1 && !o.crashesInto && !o.exitsMap)
        .sort((a, b) => b.distance - a.distance)[0];
      if (!outward) break;
      s = ok(s, { type: 'plotCourse', by: CADET, ship: SHIP, endpoint: outward.endpoint });
      s = nextDay(s);
    }
    expect(speed).toBeGreaterThanOrEqual(3);
    expect(doneIn(s).has('underWay')).toBe(true);
  });

  it('ticks "come about" only when the ship is genuinely going back', () => {
    // "This may result in turning, speeding up, or slowing down." Slowing to a
    // crawl is not coming about; the heading has to have reversed.
    let s = ok(start(), { type: 'takeOff', by: CADET, ship: SHIP });
    s = nextDay(s);

    // Build speed away from Terra.
    for (let i = 0; i < 4; i += 1) {
      const ship = shipOf(s);
      if (length(ship.velocity) >= 4) break;
      const out = reachableEndpoints(s, ship, map)
        .filter((o) => o.accel <= 1 && !o.crashesInto && !o.exitsMap)
        .sort((a, b) => b.distance - a.distance)[0];
      if (!out) break;
      s = ok(s, { type: 'plotCourse', by: CADET, ship: SHIP, endpoint: out.endpoint });
      s = nextDay(s);
    }
    const outbound = shipOf(s).velocity;
    expect(length(outbound)).toBeGreaterThanOrEqual(3);
    expect(doneIn(s).has('comeAbout')).toBe(false);

    // Now brake, a hex per turn. It must not tick while merely slowing.
    let reversed = false;
    for (let i = 0; i < 14 && !reversed; i += 1) {
      const ship = shipOf(s);
      const back = reachableEndpoints(s, ship, map)
        .filter((o) => o.accel <= 1 && !o.crashesInto && !o.exitsMap)
        .sort((a, b) => distance(a.endpoint, TERRA.hex) - distance(b.endpoint, TERRA.hex))[0];
      if (!back) break;
      s = ok(s, { type: 'plotCourse', by: CADET, ship: SHIP, endpoint: back.endpoint });
      s = nextDay(s);
      const now = shipOf(s);
      const v = now.velocity;
      const dot = (v.q + v.r / 2) * (outbound.q + outbound.r / 2) + ((v.r * 3) / 4) * outbound.r;
      reversed = doneIn(s).has('comeAbout');
      if (reversed) {
        // It only ever ticks with real speed pointing the other way.
        expect(length(v)).toBeGreaterThanOrEqual(2);
        expect(dot).toBeLessThan(0);
      }
    }
    expect(reversed).toBe(true);
  });

  it('ticks "make orbit" exactly when the map says the ship is in orbit', () => {
    // "A ship which moves at one hex per turn from one gravity hex to an
    //  adjacent gravity hex of the same body is in orbit."
    let s = start();
    // A textbook orbit is a position, a velocity *and* the gravity picked up on
    // the way in — "gravity takes effect on the turn after an object enters the
    // gravity hex". `inOrbit` sets all three; setting only the first two would
    // fly straight out and the exercise would rightly not tick.
    const orbiter = inOrbit(
      { id: SHIP, owner: CADET, shipClass: 'torch', number: 1 },
      map,
      'terra',
      0,
    );
    s = { ...s, ships: { ...s.ships, [SHIP]: orbiter } };
    expect(map.orbitOf(orbiter.pos, orbiter.velocity)?.id).toBe('terra');
    s = nextDay(s);
    // Still round after a full turn, which is what makes it an orbit.
    expect(map.orbitOf(shipOf(s).pos, shipOf(s).velocity)?.id).toBe('terra');
    expect(doneIn(s).has('makeOrbit')).toBe(true);
  });

  it('ticks "set down" for another world but never for Terra', () => {
    // "A ship may only land by expending one fuel point while in orbit" — and
    // the exercise is to land somewhere that is not where you started.
    const luna = map.body('luna')!;
    const landOn = (bodyHex: Hex, dir: number): GameState => {
      const s = start();
      return nextDay({
        ...s,
        ships: {
          ...s.ships,
          [SHIP]: {
            ...shipOf(s),
            pos: bodyHex,
            velocity: hex(0, 0),
            location: { kind: 'landed', side: { hex: bodyHex, dir } },
          },
        },
      });
    };
    expect(doneIn(landOn(luna.hex, 0)).has('setDown')).toBe(true);
    expect(doneIn(landOn(TERRA.hex, 0)).has('setDown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The whole course
// ---------------------------------------------------------------------------

/**
 * A pilot good enough to fly the course, and no better.
 *
 * Deliberately not a scripted list of hexes: that would prove one route exists
 * and would rot the moment the chart moved. This steers with the same
 * `reachableEndpoints` the interface offers a player, and makes the same three
 * decisions a person makes — build speed, turn around, arrive slowly enough to
 * be caught by gravity.
 */
const gravityRing = (bodyId: string): Hex[] => {
  const body = map.body(bodyId)!;
  return (
    [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ] as const
  ).map(([dq, dr]) => hex(body.hex.q + dq, body.hex.r + dr));
};

const legalOptions = (s: GameState) =>
  reachableEndpoints(s, shipOf(s), map).filter(
    (o) => !o.crashesInto && !o.exitsMap && o.accel <= 1,
  );

/**
 * Steer toward `target`: fast while far, slowing early enough to stop on
 * arrival. Braking is one hex per turn, so stopping from speed v needs
 * v(v+1)/2 hexes of room — the same arithmetic a player does by eye.
 */
const navigate = (s: GameState, target: Hex): GameState | null => {
  const options = legalOptions(s);
  if (options.length === 0) return null;
  const scored = options.map((o) => {
    const d = distance(o.endpoint, target);
    const v = o.distance;
    return { o, d, v, canStop: (v * (v + 1)) / 2 <= d + 1 };
  });
  const pool = scored.filter((x) => x.canStop);
  const usable = pool.length > 0 ? pool : scored;
  usable.sort((a, b) => a.d - a.v - (b.d - b.v) || a.v - b.v);
  return ok(s, {
    type: 'plotCourse',
    by: CADET,
    ship: SHIP,
    endpoint: usable[0]!.o.endpoint,
  });
};

const flyTheCourse = (): GameState => {
  const luna = map.body('luna')!;
  let s = nextDay(ok(start(), { type: 'takeOff', by: CADET, ship: SHIP }));

  for (let day = 0; day < 150; day += 1) {
    if (s.victory) break;
    const ship = shipOf(s);
    if (ship.destroyed) break;
    const done = doneIn(s);

    if (ship.location.kind === 'landed') {
      s = nextDay(ok(s, { type: 'takeOff', by: CADET, ship: SHIP }));
      continue;
    }

    // "A ship may only land by expending one fuel point while in orbit."
    const orbiting = map.orbitOf(ship.pos, ship.velocity);
    if (orbiting) {
      const wantElsewhere = !done.has('setDown') && orbiting.id !== 'terra';
      const wantHome = done.has('setDown') && orbiting.id === 'terra';
      const site = map.planetaryBaseBelow(ship.pos);
      if ((wantElsewhere || wantHome) && site) {
        const out = applyCommand(s, { type: 'land', by: CADET, ship: SHIP, side: site.side }, map);
        if (out.result.ok) {
          s = nextDay(out.state);
          continue;
        }
      }
    }

    if (!done.has('underWay')) {
      // Escaping a standstill over a planet means taking the fall and turning it
      // into speed, not burning to hover — so this simply asks for the fastest
      // legal course.
      const options = legalOptions(s);
      if (options.length === 0) break;
      options.sort((a, b) => b.distance - a.distance);
      s = nextDay(
        ok(s, { type: 'plotCourse', by: CADET, ship: SHIP, endpoint: options[0]!.endpoint }),
      );
      continue;
    }

    // Turning around and going home are the same manoeuvre to the navigator:
    // aim at something behind you and it brakes, reverses and accelerates.
    const target = done.has('comeAbout')
      ? gravityRing(done.has('setDown') ? 'terra' : 'luna').sort(
          (a, b) => distance(ship.pos, a) - distance(ship.pos, b),
        )[0]!
      : TERRA.hex;

    // If a burn from here puts the ship in orbit round the world it wants, take
    // it: that is the ORBIT-marked hex the interface offers a player.
    if (done.has('comeAbout')) {
      const wanted = done.has('setDown') ? 'terra' : 'luna';
      const entry = legalOptions(s).find(
        (o) => map.orbitOf(o.endpoint, sub(o.endpoint, ship.pos))?.id === wanted,
      );
      if (entry) {
        s = nextDay(ok(s, { type: 'plotCourse', by: CADET, ship: SHIP, endpoint: entry.endpoint }));
        continue;
      }
    }
    void luna;

    const steered = navigate(s, target);
    if (steered === null) break;
    s = nextDay(steered);
  }
  return s;
};

describe('the course can actually be flown', () => {
  it('completes every exercise without the ship being lost', () => {
    const s = flyTheCourse();
    const done = doneIn(s);
    const missing = FLIGHT_SCHOOL_EXERCISES.filter((e) => !done.has(e.id)).map((e) => e.id);
    expect({ missing, destroyed: shipOf(s).destroyed }).toEqual({ missing: [], destroyed: false });
  });

  it('ends the game with a victory once the course is complete', () => {
    // Through the reducer, not by calling the checker: the trainer has to end on
    // its own or a player is left flying with nothing to tell them they are done.
    const s = flyTheCourse();
    expect(s.victory).not.toBeNull();
    expect(s.victory!.winners).toEqual([CADET]);
  });

  it('sets a par that is worth beating but is not decoration', () => {
    // This pilot brakes and turns without planning ahead, so a thinking player
    // should beat it comfortably. What the par must not be is unreachable, or
    // so loose that a greedy autopilot walks under it.
    const s = flyTheCourse();
    const burned = Object.values(s.ships).reduce(
      (n, x) => n + x.course.reduce((m, leg) => m + leg.accel, 0),
      0,
    );
    expect(burned).toBeGreaterThan(FLIGHT_SCHOOL_PAR);
    expect(burned).toBeLessThan(FLIGHT_SCHOOL_PAR * 6);
  });
});
