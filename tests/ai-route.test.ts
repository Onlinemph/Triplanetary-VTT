/**
 * Routing: the fastest way there.
 *
 * A greedy pilot asks "which course closes the most distance this turn?" and
 * gets a wrong answer often enough to matter, because "a ship which is not
 * accelerated by thrust or gravity will move as it did in the previous turn" —
 * the burn you make now is felt for the rest of the game. The quick way to Venus
 * is to build speed you will then spend turns shedding, and one turn of
 * lookahead cannot see that.
 *
 * So these tests are about two claims, and both are checked by *flying* the
 * route through the real engine rather than by inspecting the plan:
 *
 *  1. The route is legal — every leg is a course `applyCommand` accepts, no
 *     crashes, no map exits, within the fuel aboard.
 *  2. The route is honest — the ship really does arrive, in the way the arrival
 *     mode promised, no later than the search said it would.
 *
 * The second is the one that catches a search which has drifted away from the
 * rules it is supposed to be modelling. A plan that says nine turns and takes
 * fourteen is a plan built on a mistaken idea of gravity.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Hex,
  type Ship,
  type ShipClass,
  type PlayerId,
  applyCommand,
  activePlayer,
  createInitialState,
  distance,
  eq,
  hex,
  length as speed,
  makePlayer,
  makeShip,
  key,
  reachableEndpoints,
  sub,
  traceSegment,
} from '../src/engine/index.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { type RouteRequest, routeTo } from '../src/ai/route.js';
import { brakingCourse, courseToward, isRunaway } from '../src/ai/navigate.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

const rig = (ships: readonly Ship[]): GameState =>
  createInitialState({
    scenarioId: 'route',
    seed: 7,
    players: [makePlayer(A, 'A', 'Alpha', '#fff'), makePlayer(B, 'B', 'Beta', '#000')],
    ships,
  });

const corvette = (pos: Hex, velocity: Hex = hex(0, 0), extra: Partial<Ship> = {}): Ship => ({
  ...makeShip({ id: 's', owner: A, shipClass: 'corvette', pos, velocity }),
  ...extra,
});

/** One whole turn for every seat. */
const endTurn = (s: GameState): GameState => {
  let next = s;
  for (let i = 0; i < 5 * next.playerOrder.length; i += 1) {
    const out = applyCommand(next, { type: 'endPhase', by: activePlayer(next) }, map);
    if (!out.result.ok) return next;
    next = out.state;
  }
  return next;
};

const ok = (s: GameState, cmd: Command): GameState => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

interface Flight {
  /** Turns taken to arrive, or `null` if it never did. */
  readonly turns: number | null;
  /** What the search predicted on the very first turn. */
  readonly predicted: number | null;
  readonly state: GameState;
  readonly died: boolean;
  readonly fuelSpent: number;
}

/**
 * Fly a route to its destination through the real engine, re-planning each turn.
 *
 * `arrived` is the arrival test — the same question the search was asked, posed
 * independently here so a bug in the search cannot make itself true.
 */
const fly = (
  start: GameState,
  shipId: string,
  request: (s: GameState, ship: Ship) => RouteRequest | null,
  arrived: (ship: Ship, s: GameState) => boolean,
  cap = 40,
): Flight => {
  let s = start;
  let predicted: number | null = null;
  const fuel0 = s.ships[shipId]!.fuel;

  for (let turn = 0; turn < cap; turn += 1) {
    const ship = s.ships[shipId]!;
    if (ship.destroyed) return { turns: null, predicted, state: s, died: true, fuelSpent: 0 };
    if (arrived(ship, s)) {
      return { turns: turn, predicted, state: s, died: false, fuelSpent: fuel0 - ship.fuel };
    }
    const req = request(s, ship);
    if (req === null) return { turns: null, predicted, state: s, died: false, fuelSpent: 0 };
    const route = routeTo(s, ship, req, map);
    if (route === null) return { turns: null, predicted, state: s, died: false, fuelSpent: 0 };
    if (predicted === null) predicted = route.turns;

    // Every leg the search proposes must be one the engine offers.
    const option = reachableEndpoints(s, ship, map).find((o) => eq(o.endpoint, route.endpoint));
    expect({
      leg: `${ship.id}@${turn}`,
      offered: option !== undefined,
      crash: option?.crashesInto,
      exit: option?.exitsMap,
    }).toEqual({ leg: `${ship.id}@${turn}`, offered: true, crash: undefined, exit: false });

    s = ok(s, { type: 'plotCourse', by: A, ship: shipId, endpoint: route.endpoint });
    s = endTurn(s);
  }
  return { turns: null, predicted, state: s, died: false, fuelSpent: 0 };
};

/** The same journey flown by the old one-turn-at-a-time navigator, for contrast. */
const flyGreedy = (
  start: GameState,
  shipId: string,
  goal: Hex,
  arrived: (ship: Ship, s: GameState) => boolean,
  cap = 40,
): number | null => {
  let s = start;
  for (let turn = 0; turn < cap; turn += 1) {
    const ship = s.ships[shipId]!;
    if (ship.destroyed) return null;
    if (arrived(ship, s)) return turn;
    const course = isRunaway(ship, goal)
      ? (brakingCourse(s, ship, map) ?? courseToward(s, ship, goal, map))
      : courseToward(s, ship, goal, map);
    if (course === null) return null;
    const out = applyCommand(
      s,
      { type: 'plotCourse', by: A, ship: shipId, endpoint: course.endpoint },
      map,
    );
    if (out.result.ok) s = out.state;
    s = endTurn(s);
  }
  return null;
};

/**
 * A genuinely empty lane: no asteroid and no body anywhere near the run.
 *
 * Picking a hex that merely *looks* blank is how a routing test ends up
 * measuring an asteroid hit instead of a route — the Belt is wide, and a
 * corvette that takes a D1 on the way "cannot maneuver" for the rest of it.
 */
const clearLane = (from: Hex, direction: Hex, turns = 8): boolean => {
  for (let t = 0; t <= turns; t += 1) {
    for (let side = -2; side <= 2; side += 1) {
      const h = hex(from.q + direction.q * t + side, from.r + direction.r * t);
      if (!map.inBounds(h) || map.isAsteroid(h)) return false;
      if (map.bodies.some((b) => distance(b.hex, h) <= 2)) return false;
    }
  }
  return true;
};

const findLane = (direction: Hex, turns = 8): Hex => {
  for (let r = -30; r <= 30; r += 1) {
    for (let q = -30; q <= 30; q += 1) {
      const h = hex(q, r);
      if (clearLane(h, direction, turns)) return h;
    }
  }
  throw new Error('no clear lane on this chart');
};

/** Empty space with sixteen clear hexes ahead of it, for the arithmetic tests. */
const DEEP = findLane(hex(1, 0), 17);

/**
 * A hex `d` out from a world with clear space between the two — no rock, and no
 * *other* body in the way. The approach to a planet is a routing problem; the
 * approach to a planet through the Belt is a different one.
 */
const openApproach = (target: Hex, d: number): Hex => {
  const candidates: Hex[] = [];
  for (let q = -30; q <= 30; q += 1) {
    for (let r = -30; r <= 30; r += 1) {
      const h = hex(q, r);
      if (distance(h, target) !== d || !map.inBounds(h)) continue;
      const path = traceSegment(h, target).entered;
      if (path.some((p) => map.isAsteroid(p))) continue;
      if (map.bodies.some((b) => !eq(b.hex, target) && path.some((p) => distance(b.hex, p) <= 2))) {
        continue;
      }
      candidates.push(h);
    }
  }
  const best = candidates.sort((a, b) => key(a).localeCompare(key(b)))[0];
  if (!best) throw new Error(`no clear approach to ${target.q},${target.r} at ${d}`);
  return best;
};

// ---------------------------------------------------------------------------
// The arithmetic it is built on
// ---------------------------------------------------------------------------

describe('the shape of a journey', () => {
  /**
   * "One fuel point allows a ship to alter its predicted course by one hex in
   * any direction", so speed rises by at most one hex per turn. From a
   * standstill a ship covers 1, then 2, then 3 — `t(t+1)/2` hexes in `t` turns,
   * and no route can beat that.
   */
  it('crosses open space as fast as the acceleration rule allows', () => {
    for (const d of [1, 3, 6, 10, 15]) {
      const goal = hex(DEEP.q + d, DEEP.r);
      const flight = fly(
        rig([corvette(DEEP)]),
        's',
        () => ({ goal, arrival: 'reach', within: 0, endSpeed: 99 }),
        (ship) => eq(ship.pos, goal),
      );
      // t(t+1)/2 >= d, and the ship is not allowed to do better than that.
      let ideal = 0;
      while ((ideal * (ideal + 1)) / 2 < d) ideal += 1;
      expect({ d, turns: flight.turns }).toEqual({ d, turns: ideal });
    }
  });

  /**
   * Arriving *stopped* is a different problem: the speed has to come back off,
   * one hex per turn. The best profile is a triangle — accelerate, then brake —
   * so covering `d` hexes and halting needs about `2·√d` turns rather than `√2d`.
   */
  it('takes the accelerate-and-brake profile when it has to stop', () => {
    const cases: { d: number; turns: number }[] = [
      { d: 1, turns: 2 }, // out one hex, then kill the speed
      { d: 4, turns: 4 }, // 1,2,1
      { d: 9, turns: 6 }, // 1,2,3,2,1
      { d: 16, turns: 8 },
    ];
    for (const c of cases) {
      const goal = hex(DEEP.q + c.d, DEEP.r);
      const flight = fly(
        rig([corvette(DEEP)]),
        's',
        () => ({ goal, arrival: 'stop' }),
        (ship) => eq(ship.pos, goal) && speed(ship.velocity) === 0,
      );
      expect({ d: c.d, turns: flight.turns }).toEqual({ d: c.d, turns: c.turns });
    }
  });
});

// ---------------------------------------------------------------------------
// Faster than steering by eye
// ---------------------------------------------------------------------------

describe('it beats one-turn-at-a-time steering', () => {
  /**
   * The case the search exists for. A greedy pilot will not build speed it
   * cannot see a use for this turn, so it crawls; the search knows the whole
   * profile up front and commits to it.
   */
  it('reaches a distant world in fewer turns', () => {
    const venus = map.body('venus')!;
    const from = openApproach(venus.hex, 12);
    const arrived = (ship: Ship): boolean => map.orbitOf(ship.pos, ship.velocity)?.id === 'venus';

    const searched = fly(
      rig([corvette(from)]),
      's',
      () => ({ goal: venus.hex, arrival: 'orbit', bodyId: 'venus' }),
      arrived,
    );
    const greedy = flyGreedy(rig([corvette(from)]), 's', venus.hex, arrived);

    expect(searched.turns).not.toBeNull();
    // Strictly better, not merely no worse — this is the whole point.
    expect({ searched: searched.turns, greedy }).toEqual({
      searched: searched.turns,
      greedy,
    });
    expect(searched.turns!).toBeLessThan(greedy ?? Infinity);
  });

  /**
   * Not one lucky case: the same comparison across five worlds at five ranges.
   *
   * The greedy pilot does not merely take longer on some of these — it never
   * arrives at all, because an orbit is a specific one-hex burn and a navigator
   * choosing the course that closes the most ground never happens to make it.
   */
  it('gets into orbit around every world, faster, where steering by eye often cannot at all', () => {
    const cases: { body: string; d: number }[] = [
      { body: 'venus', d: 12 },
      { body: 'mars', d: 9 },
      { body: 'terra', d: 14 },
      { body: 'luna', d: 11 },
      { body: 'jupiter', d: 16 },
    ];
    const results = cases.map(({ body, d }) => {
      const target = map.body(body)!;
      const from = openApproach(target.hex, d);
      const arrived = (ship: Ship): boolean => map.orbitOf(ship.pos, ship.velocity)?.id === body;
      const searched = fly(
        rig([corvette(from)]),
        's',
        () => ({ goal: target.hex, arrival: 'orbit', bodyId: body }),
        arrived,
      ).turns;
      const greedy = flyGreedy(rig([corvette(from)]), 's', target.hex, arrived);
      return { body, searched, greedy };
    });

    // Every journey completed by the search...
    expect(results.filter((r) => r.searched === null)).toEqual([]);
    // ...and never slower than steering by eye, which sometimes never arrives.
    for (const r of results) {
      expect(`${r.body}: ${r.searched} vs ${r.greedy}`).toBe(
        `${r.body}: ${r.searched} vs ${r.greedy}`,
      );
      expect(r.searched!).toBeLessThan(r.greedy ?? Infinity);
    }
  });
});

// ---------------------------------------------------------------------------
// Arrival means what it says
// ---------------------------------------------------------------------------

describe('arrival modes', () => {
  it('stops dead when asked to stop', () => {
    const goal = hex(DEEP.q + 7, DEEP.r);
    const flight = fly(
      rig([corvette(DEEP)]),
      's',
      () => ({ goal, arrival: 'stop' }),
      (ship) => eq(ship.pos, goal) && speed(ship.velocity) === 0,
    );
    expect(flight.turns).not.toBeNull();
    const ship = flight.state.ships['s']!;
    expect({ at: eq(ship.pos, goal), stopped: speed(ship.velocity) }).toEqual({
      at: true,
      stopped: 0,
    });
  });

  /**
   * "A ship which moves at one hex per turn from one gravity hex to an adjacent
   * gravity hex of the same body is in orbit." An orbit is a specific one-hex
   * burn, not a place — which is why it needs its own arrival mode.
   */
  it('settles into orbit rather than flying past', () => {
    const mars = map.body('mars')!;
    const flight = fly(
      rig([corvette(openApproach(mars.hex, 9))]),
      's',
      () => ({ goal: mars.hex, arrival: 'orbit', bodyId: 'mars' }),
      (ship) => map.orbitOf(ship.pos, ship.velocity)?.id === 'mars',
    );
    expect(flight.turns).not.toBeNull();
    const ship = flight.state.ships['s']!;
    expect(map.orbitOf(ship.pos, ship.velocity)?.id).toBe('mars');
    expect(speed(ship.velocity)).toBe(1);
  });

  /**
   * "Any ship may prospect by passing through an asteroid hex at a speed of 1" —
   * the one errand where hurrying achieves nothing.
   */
  it('arrives at a walking pace when told to cruise', () => {
    const goal = hex(DEEP.q + 6, DEEP.r);
    const flight = fly(
      rig([corvette(DEEP)]),
      's',
      () => ({ goal, arrival: 'cruise' }),
      (ship) => eq(ship.pos, goal) && speed(ship.velocity) <= 1,
    );
    expect(flight.turns).not.toBeNull();
    expect(speed(flight.state.ships['s']!.velocity)).toBeLessThanOrEqual(1);
  });

  /**
   * "A disabled ship may be looted or captured by any enemy ship which matches
   * courses with it" — the same hex *and* the same vector. A drifting prize is
   * therefore intercepted rather than chased: it "cannot maneuver", so where it
   * will be is arithmetic.
   */
  it('intercepts a drifting prize instead of chasing its wake', () => {
    const prizeStart = hex(DEEP.q + 9, DEEP.r);
    const prizeVelocity = hex(1, 0);
    const start = rig([
      corvette(DEEP),
      {
        ...makeShip({ id: 'p', owner: B, shipClass: 'transport', pos: prizeStart }),
        velocity: prizeVelocity,
        disabled: 9,
      },
    ]);

    const flight = fly(
      start,
      's',
      (s) => {
        const prize = s.ships['p']!;
        return { goal: prize.pos, arrival: 'match', goalVelocity: prize.velocity };
      },
      (ship, s) => {
        const prize = s.ships['p']!;
        return eq(ship.pos, prize.pos) && eq(ship.velocity, prize.velocity);
      },
    );
    expect(flight.turns).not.toBeNull();
    const chaser = flight.state.ships['s']!;
    const prize = flight.state.ships['p']!;
    expect({ hex: eq(chaser.pos, prize.pos), vector: eq(chaser.velocity, prize.velocity) }).toEqual(
      {
        hex: true,
        vector: true,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

describe('the plan is honest', () => {
  /**
   * A route that says nine turns and takes fourteen is a route built on a
   * mistaken idea of gravity. Re-planning can only ever find something as good
   * as what is left of the original plan, so the flown journey must come in at
   * or under the first estimate.
   */
  it('arrives no later than it said it would', () => {
    const cases: { from: Hex; goal: Hex; request: RouteRequest }[] = [
      {
        from: DEEP,
        goal: hex(DEEP.q + 11, DEEP.r),
        request: { goal: hex(DEEP.q + 11, DEEP.r), arrival: 'stop' },
      },
      {
        from: openApproach(map.body('mars')!.hex, 9),
        goal: map.body('mars')!.hex,
        request: { goal: map.body('mars')!.hex, arrival: 'orbit', bodyId: 'mars' },
      },
      {
        from: openApproach(map.body('venus')!.hex, 10),
        goal: map.body('venus')!.hex,
        request: { goal: map.body('venus')!.hex, arrival: 'reach', within: 1 },
      },
    ];
    for (const c of cases) {
      const arrived = (ship: Ship): boolean => {
        if (c.request.arrival === 'stop') {
          return eq(ship.pos, c.goal) && speed(ship.velocity) === 0;
        }
        if (c.request.arrival === 'orbit') {
          return map.orbitOf(ship.pos, ship.velocity)?.id === c.request.bodyId;
        }
        return distance(ship.pos, c.goal) <= (c.request.within ?? 0) && speed(ship.velocity) <= 2;
      };
      const flight = fly(rig([corvette(c.from)]), 's', () => c.request, arrived);
      expect({ goal: `${c.goal.q},${c.goal.r}`, arrived: flight.turns !== null }).toEqual({
        goal: `${c.goal.q},${c.goal.r}`,
        arrived: true,
      });
      expect(flight.turns!).toBeLessThanOrEqual(flight.predicted!);
    }
  });

  it('never plots a leg the engine would refuse', () => {
    // `fly` asserts this on every leg; this case simply exercises a long one
    // through the busy middle of the chart.
    const flight = fly(
      rig([corvette(openApproach(map.body('luna')!.hex, 11))]),
      's',
      () => ({ goal: map.body('luna')!.hex, arrival: 'reach', within: 1 }),
      (ship) => distance(ship.pos, map.body('luna')!.hex) <= 1,
    );
    expect(flight.died).toBe(false);
  });

  /**
   * "When a ship has burned all of its fuel points, it is out of fuel; further
   * acceleration (except by gravity) is impossible." A plan that spends fuel the
   * ship has not got is not a plan.
   */
  it('never plans to spend fuel the ship does not have', () => {
    const goal = hex(DEEP.q + 12, DEEP.r);
    for (const fuel of [1, 2, 3, 5]) {
      const ship = corvette(DEEP, hex(0, 0), { fuel });
      const route = routeTo(rig([ship]), ship, { goal, arrival: 'stop' }, map);
      if (route !== null)
        expect({ fuel, burns: route.burns <= fuel }).toEqual({ fuel, burns: true });
    }
  });

  it('gives the same route twice', () => {
    const ship = corvette(openApproach(map.body('terra')!.hex, 9), hex(0, 0));
    const state = rig([ship]);
    const req: RouteRequest = { goal: map.body('terra')!.hex, arrival: 'orbit', bodyId: 'terra' };
    expect(routeTo(state, ship, req, map)).toEqual(routeTo(state, ship, req, map));
  });
});

// ---------------------------------------------------------------------------
// It knows what it cannot do
// ---------------------------------------------------------------------------

describe('bounds', () => {
  it('returns nothing for a goal outside its horizon rather than guessing', () => {
    const ship = corvette(DEEP);
    const route = routeTo(
      rig([ship]),
      ship,
      { goal: hex(DEEP.q + 26, DEEP.r), arrival: 'stop', maxTurns: 3 },
      map,
    );
    expect(route).toBeNull();
  });

  it('returns nothing when the ship is already where it was sent', () => {
    const ship = corvette(DEEP);
    expect(routeTo(rig([ship]), ship, { goal: DEEP, arrival: 'stop' }, map)).toBeNull();
  });

  /**
   * "Only ships possessing scanners may enter those hexes. Other ships are
   * destroyed" — the dense cordon around Clandestine is not a risk to price in,
   * it is a wall.
   */
  it('will not route a ship without scanners through the Clandestine cordon', () => {
    const clandestine = map.body('clandestine')!;
    const from = hex(clandestine.hex.q - 6, clandestine.hex.r);
    const ship = corvette(from);
    const state = rig([ship]);
    const route = routeTo(state, ship, { goal: clandestine.hex, arrival: 'stop' }, map);
    if (route !== null) {
      const dense = map.asteroidHazards(from, route.endpoint).filter((h) => map.isDenseAsteroid(h));
      expect(dense).toEqual([]);
    }
  });
});

/** Ship classes referenced above must exist; a typo here would silently pass. */
it('uses real ship classes', () => {
  const classes: ShipClass[] = ['corvette', 'transport'];
  for (const c of classes) {
    expect(makeShip({ id: 'x', owner: A as PlayerId, shipClass: c, pos: DEEP }).shipClass).toBe(c);
  }
  expect(sub(hex(2, 1), hex(1, 1))).toEqual(hex(1, 0));
});
