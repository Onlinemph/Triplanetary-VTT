/**
 * The fastest way there.
 *
 * ## Why a search and not a heuristic
 *
 * "A ship which is not accelerated by thrust or gravity will move as it did in
 * the previous turn." That one sentence is what makes greedy navigation wrong.
 * A burn made now is felt for the rest of the game, so the course that closes
 * the most distance *this* turn is routinely not on the fastest route: the quick
 * way to Venus is to spend three turns building speed you will spend three more
 * turns shedding, and no amount of looking one turn ahead finds that.
 *
 * So the pilot searches. The trick is choosing the right thing to search over.
 * A ship's future depends on exactly two things — where it is and how fast it is
 * going — and both are on the counter already:
 *
 *     state = (position, velocity)
 *
 * That is the whole state space. Gravity needs no extra field, because the pull
 * a ship is carrying was picked up on the leg it just flew, and that leg is
 * `position - velocity` to `position`. Fuel is not part of the state either; it
 * only ever counts down, so it rides along as a cost and prunes the frontier.
 *
 * From any node there are seven successors — coast, or burn one point in one of
 * the six directions — and the cost of an edge is one turn. Finding the fastest
 * route is then an ordinary shortest-path problem, and A* solves it exactly.
 *
 * ## The heuristic
 *
 * A ship at speed *s* covers at most `s + (s+1) + (s+2) + …` hexes, gaining one
 * hex of speed per turn, so the fewest turns that can possibly cover *d* hexes
 * is the smallest *t* with `s·t + t(t+1)/2 ≥ d`. That is a genuine lower bound —
 * it assumes a straight line and a burn every turn — which is what makes the
 * first route A* finds provably the fastest one, not merely a good one.
 *
 * ## What it will not do
 *
 * The search plans against the board as it stands, so a moving target is chased
 * rather than intercepted, and it does not model the other player's replies. It
 * re-plans from scratch every turn, which is what keeps that honest.
 *
 * Pure, like everything else here: no `Math.random`, no `Date`. Ties break on
 * hex order, so the same position always yields the same route.
 */

import {
  type GameMap,
  type GameState,
  type Hex,
  type Ship,
  add,
  crashBody,
  denseAsteroidsOnCourse,
  distance,
  effectiveGravity,
  hasScanners,
  hasUnlimitedFuel,
  key,
  leashBroken,
  length,
  neighbors,
  sub,
  traceSegment,
} from '../engine/index.js';

// ---------------------------------------------------------------------------
// What counts as arriving
// ---------------------------------------------------------------------------

/**
 * How the route is meant to end. The difference is not cosmetic: arriving at a
 * world at speed four is not arriving, it is a flyby, and the rules make the
 * distinction for you — landing needs an orbit, and an orbit needs speed one.
 */
export type Arrival =
  /** Be within `within` hexes of the goal, at any speed. Gun range, or a flyby. */
  | 'reach'
  /** Be in the goal hex, stopped. Asteroid bases: "by simply stopping in the hex". */
  | 'stop'
  /**
   * Be in orbit around `bodyId`, and — when `goal` is a hex of that body's
   * gravity ring — in that particular hex.
   *
   * Both readings are needed. Landing wants any orbit: "a ship may only land by
   * expending one fuel point while in orbit". Refuelling wants one specific hex
   * of the ring: "the ship must ... pass through the gravity hex directly above
   * the base's hex side while in orbit".
   */
  | 'orbit'
  /** Be in the goal hex at no more than one hex per turn: the prospector's trawl. */
  | 'cruise'
  /**
   * Match courses: the same hex *and* the same vector, which is what looting,
   * capture, rescue and cargo transfer all require. A hard target for a greedy
   * pilot and an easy one for a search.
   */
  | 'match'
  /**
   * Pass through `bodyId`'s gravity, at any speed, without stopping.
   *
   * The Grand Tour's own words: "each ship must pass through at least one
   * gravity hex" of every full-gravity body. Passing is not arriving — a racer
   * screams by and carries the speed on to the next world — and it is counted
   * over the hexes the leg *entered*, not merely where it ended, which is why
   * this cannot be expressed as a distance to the endpoint.
   */
  | 'flyby';

export interface RouteRequest {
  readonly goal: Hex;
  readonly arrival: Arrival;
  /** For `'orbit'`. */
  readonly bodyId?: string;
  /**
   * The goal's own velocity, when it is drifting.
   *
   * A disabled ship "cannot maneuver", so its course is fixed and known: it will
   * be `goal + t·goalVelocity` in *t* turns. Steering at where it is now would
   * be chasing its wake, so the search aims where it is going to be. Left unset
   * the goal is treated as fixed, which is the honest assumption for anything
   * that can still steer.
   */
  readonly goalVelocity?: Hex;
  /** For `'reach'`: how close is close enough. Defaults to 0. */
  readonly within?: number;
  /**
   * For `'reach'`: the speed to be down to on arrival. Defaults to 2, which is
   * the rulebook's own free allowance — "subtract 1 from the die roll for each
   * hex of velocity difference over 2" — so a ship that screams past its target
   * at speed eight has not arrived, it has missed.
   */
  readonly endSpeed?: number;
  /** A hard ceiling on route length. */
  readonly maxTurns?: number;
  /**
   * Turns of slack over the theoretical best before the search gives up.
   *
   * A route much longer than the straight-line ideal is one the search will
   * spend a great deal of effort proving does not exist, so it is bounded near
   * the ideal and the caller falls back to steering by eye.
   */
  readonly slack?: number;
}

export interface Route {
  /** The course to plot *this* turn — the first step of the fastest route. */
  readonly endpoint: Hex;
  readonly accel: 0 | 1;
  /** Turns the whole route takes, arrival included. */
  readonly turns: number;
  /** Fuel the whole route spends. */
  readonly burns: number;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The farthest a ship at speed `s` can travel in `t` turns and still be down to
 * speed `end` when it gets there.
 *
 * Speed changes by at most one hex per turn in either direction, so the leg
 * lengths form a triangle: leg *i* can be no longer than `s + i` (all the
 * acceleration so far) and no longer than `end + (t - i)` (all the braking still
 * to come). Take the smaller of the two on every leg and you have the best
 * possible profile — accelerate, coast over the peak, brake.
 *
 * With `end = Infinity` the braking half disappears and this collapses to the
 * familiar `s·t + t(t+1)/2`. That difference is the whole reason the arrival
 * modes matter to the search: reaching a hex at speed six is eight turns of work
 * the pilot then has to undo, and a heuristic that ignores it sends A* hunting
 * through thousands of positions it will never use.
 */
const reachIn = (speed: number, turns: number, end: number): number => {
  if (!Number.isFinite(end)) return speed * turns + (turns * (turns + 1)) / 2;
  let total = 0;
  for (let i = 1; i <= turns; i += 1) total += Math.max(0, Math.min(speed + i, end + turns - i));
  return total;
};

/**
 * The fewest turns that could possibly cover `d` hexes from speed `s`, arriving
 * at no more than speed `end`.
 */
const turnsToCover = (d: number, speed: number, end = Infinity): number => {
  const braking = Number.isFinite(end) ? Math.max(0, speed - end) : 0;
  if (d <= 0) return braking;
  let t = Math.max(1, braking);
  while (reachIn(speed, t, end) < d) t += 1;
  return t;
};

/**
 * A ceiling on speed, so the frontier cannot run away.
 *
 * Nothing in the rules caps a ship's speed, but a course longer than this
 * crosses the whole chart in a turn and cannot be stopped inside one either —
 * `v(v+1)/2` hexes of room at speed nine is more than the map is wide.
 */
const MAX_SPEED = 9;

/** Expansions before the search gives up and the caller falls back to greedy. */
const NODE_BUDGET = 6000;

/**
 * What the pilot will pay, in turns, to miss one asteroid hex.
 *
 * "A die is rolled for each asteroid hex entered", and on the asteroid column
 * that is nothing on a 1-4, D1 on a 5 and D2 on a 6. Real, but small — a
 * fraction of a turn, so it settles ties rather than choosing routes.
 */
const ASTEROID_COST = 0.25;

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

interface Node {
  readonly pos: Hex;
  readonly velocity: Hex;
  readonly turns: number;
  readonly burns: number;
  readonly risk: number;
  /** The endpoint of the very first leg, carried down so the answer is one hop. */
  readonly first: Hex | null;
  readonly firstAccel: 0 | 1;
}

const stateKey = (pos: Hex, velocity: Hex): string =>
  `${pos.q},${pos.r}|${velocity.q},${velocity.r}`;

/**
 * The fastest route from where this ship is to where it wants to be, or `null`
 * when there is none inside the search's bounds.
 *
 * Only the first leg is returned. The rest of the route is not a plan the pilot
 * commits to — it re-plans from scratch next turn, which is how it copes with a
 * target that moved and damage it did not expect.
 */
export const routeTo = (
  state: GameState,
  ship: Ship,
  request: RouteRequest,
  map: GameMap,
): Route | null => {
  // The horizon is set from the theoretical best rather than fixed. A* only
  // pays for the layers it fails to find the goal in, so a generous cap costs
  // nothing when the route is easy and everything when it does not exist:
  // allowing a few turns of slack over the ideal bounds the worst case without
  // rejecting any route a pilot would actually fly.
  const slack = request.slack ?? 4;
  const within = request.within ?? 0;
  const endSpeed = request.endSpeed ?? 2;
  const drift = request.goalVelocity ?? { q: 0, r: 0 };
  const goalAt = (turns: number): Hex =>
    add(request.goal, { q: drift.q * turns, r: drift.r * turns });
  const fuel = hasUnlimitedFuel(ship) ? Infinity : ship.fuel;
  const scanners = hasScanners(state, ship);
  const leashed = isLeashed(state, ship);

  const reached = (pos: Hex, velocity: Hex, turns: number): boolean => {
    const goal = goalAt(turns);
    switch (request.arrival) {
      case 'reach':
        return distance(pos, goal) <= within && length(sub(velocity, drift)) <= endSpeed;
      case 'stop':
        return distance(pos, goal) === 0 && length(velocity) === 0;
      case 'cruise':
        return distance(pos, goal) === 0 && length(velocity) <= 1;
      case 'match':
        return distance(pos, goal) === 0 && length(sub(velocity, drift)) === 0;
      case 'flyby':
        return traceSegment(sub(pos, velocity), pos).entered.some((h) =>
          map.gravityAt(h).some((g) => g.bodyId === request.bodyId),
        );
      case 'orbit':
        return (
          map.orbitOf(pos, velocity)?.id === request.bodyId &&
          (!ringGoal || distance(pos, request.goal) === 0)
        );
    }
  };

  /**
   * An admissible lower bound on the turns still to come.
   *
   * Each mode names the speed the ship has to be down to when it arrives, which
   * is what makes the bound tight: you cannot both sprint the distance and be
   * stopped at the end of it.
   */
  const orbitBody = request.bodyId === undefined ? undefined : map.body(request.bodyId);
  /** Is the goal one named hex of the ring, rather than the body itself? */
  const ringGoal =
    request.arrival === 'orbit' &&
    map.gravityAt(request.goal).some((g) => g.bodyId === request.bodyId);
  const heuristic = (pos: Hex, velocity: Hex, turns: number): number => {
    const speed = length(velocity);
    // A drifting goal is easiest to reason about from inside its own frame:
    // relative position and relative velocity, with the target standing still.
    const relative = length(sub(velocity, drift));
    const gap = distance(pos, goalAt(turns));
    switch (request.arrival) {
      case 'reach':
        return turnsToCover(gap - within, relative, endSpeed);
      case 'stop':
        return turnsToCover(gap, speed, 0);
      case 'cruise':
        return turnsToCover(gap, speed, 1);
      case 'match':
        // Two bounds, neither dominating: closing the gap, and turning the
        // vector round one hex per turn until it matches.
        return Math.max(turnsToCover(gap, relative, 0), length(sub(velocity, drift)));
      case 'flyby':
        // The gravity ring is the six hexes around the body, and there is no
        // speed to shed: a pass is a pass at any velocity.
        return orbitBody === undefined ? 0 : turnsToCover(distance(pos, orbitBody.hex) - 1, speed);
      case 'orbit':
        // An orbit is a gravity hex, and the gravity ring is the six hexes
        // around the body — so the ship must reach distance 1, at speed 1. When
        // one particular ring hex is named, that hex is the bound instead.
        if (ringGoal) return turnsToCover(gap, speed, 1);
        return orbitBody === undefined
          ? 0
          : turnsToCover(distance(pos, orbitBody.hex) - 1, speed, 1);
    }
  };

  /**
   * What one leg costs, or a negative number if the ship may not fly it.
   *
   * The same leg turns up over and over — a hex can be entered on many different
   * vectors — and each answer needs a crash check and a traced path, which are
   * the two most expensive things in the search. Memoised, the frontier costs a
   * fraction of what it otherwise would.
   *
   * Every refusal here is a rule: "if a ship's course vector intersects the
   * printed outline of an astral body, it has crashed"; "any ship whose final
   * course places it off the map is considered eliminated"; "only ships
   * possessing scanners may enter those hexes. Other ships are destroyed."
   */
  const cleared = new Set(state.clearedAsteroids);
  const legs = new Map<string, number>();
  const legCost = (from: Hex, to: Hex): number => {
    const k = `${from.q},${from.r}>${to.q},${to.r}`;
    const cached = legs.get(k);
    if (cached !== undefined) return cached;

    let cost = -1;
    if (map.inBounds(to) && crashBody(map, from, to) === undefined) {
      const rock = map.asteroidHazards(from, to, cleared);
      const dense = scanners ? 0 : denseAsteroidsOnCourse(state, map, from, to).length;
      if (dense === 0) cost = rock.length;
    }
    legs.set(k, cost);
    return cost;
  };

  /** A scenario's leash, checked per leg only for the ships that carry one. */
  const legAllowed = (from: Hex, to: Hex): boolean =>
    !leashed || leashBroken(state, { ...ship, pos: from }, to, map) === null;

  /**
   * Does this position and vector leave the ship anywhere to go next turn?
   *
   * The trap the rulebook warns about, and one a route search walks straight
   * into if you let it: a gravity hex is a fine place to *be* and a fatal place
   * to *stop*. "A ship that does not move is still sitting in the gravity hex,
   * and is pulled again" — "unless fuel is spent on the next turn, the ship
   * would fall back to the planet and crash." Arriving in orbit over Terra at
   * the exact moment the tanks run dry is not arriving.
   *
   * So no node is entered unless at least one continuation from it survives.
   * That covers the arrival too, which is where it matters most: a route is only
   * a route if the ship is still there the turn after it finishes.
   */
  const survivors = new Map<string, boolean>();
  const survivable = (pos: Hex, velocity: Hex, burns: number): boolean => {
    const canBurn = burns < fuel;
    const k = `${stateKey(pos, velocity)}${canBurn ? '+' : ''}`;
    const cached = survivors.get(k);
    if (cached !== undefined) return cached;

    const drift = add(add(pos, velocity), map.gravityFromMove(sub(pos, velocity), pos).mandatory);
    const candidates = canBurn ? [drift, ...neighbors(drift)] : [drift];
    const out = candidates.some((to) => legCost(pos, to) >= 0);
    survivors.set(k, out);
    return out;
  };

  /**
   * Could the ship still come to rest from here?
   *
   * Braking sheds one hex of speed per turn and costs a point each time, so a
   * plan that leaves the ship carrying more speed than it has fuel is a plan
   * that ends at the rim: it can no longer turn, and "any ship whose final
   * course places it off the map is considered eliminated". Charging it against
   * the route rather than checking it afterwards is what stops the search
   * spending the tank on a fast arrival.
   */
  const solvent = (velocity: Hex, burns: number): boolean =>
    !Number.isFinite(fuel) || burns + length(velocity) <= fuel;

  // The root's gravity is the ship's own stored pull, which is authoritative:
  // after a takeoff it is the arrow of the hex the boosters left it in, and a
  // ship that has accepted an optional weak arrow is carrying that too.
  const rootGravity = effectiveGravity(ship, map);

  const maxTurns = Math.min(request.maxTurns ?? 20, heuristic(ship.pos, ship.velocity, 0) + slack);

  const start: Node = {
    pos: ship.pos,
    velocity: ship.velocity,
    turns: 0,
    burns: 0,
    risk: 0,
    first: null,
    firstAccel: 0,
  };
  if (reached(start.pos, start.velocity, 0)) return null; // already there

  // A bucket queue: edge costs are whole turns, so `f` is a small integer and
  // the frontier sorts itself.
  const buckets: Node[][] = [];
  const push = (n: Node): void => {
    const f = n.turns + heuristic(n.pos, n.velocity, n.turns);
    if (f > maxTurns) return;
    (buckets[f] ??= []).push(n);
  };
  push(start);

  const seen = new Map<string, number>();
  let expansions = 0;

  for (let f = 0; f <= maxTurns; f += 1) {
    const bucket = buckets[f];
    if (!bucket) continue;
    // Deepest first inside a bucket. Every node here has the same total estimate,
    // so the one furthest along has the least guessing left in it — the standard
    // A* tie-break, and on a grid where thousands of routes tie it is the
    // difference between diving at the goal and fanning out across the chart.
    // After that: fewer burns, less rock, and hex order, which is what makes the
    // answer reproducible.
    bucket.sort(
      (a, b) =>
        b.turns - a.turns ||
        a.burns - b.burns ||
        a.risk - b.risk ||
        key(a.pos).localeCompare(key(b.pos)) ||
        key(a.velocity).localeCompare(key(b.velocity)),
    );

    for (let i = 0; i < bucket.length; i += 1) {
      const node = bucket[i]!;
      if (node.turns >= maxTurns) continue;

      const k = stateKey(node.pos, node.velocity);
      const before = seen.get(k);
      if (before !== undefined && before <= node.burns) continue;
      seen.set(k, node.burns);

      expansions += 1;
      if (expansions > NODE_BUDGET) return null;

      const gravity = node.turns === 0 ? rootGravity : carriedGravity(node, map);
      const base = add(add(node.pos, node.velocity), gravity);

      for (const [endpoint, accel] of [
        [base, 0] as const,
        ...neighbors(base).map((h) => [h, 1] as const),
      ]) {
        if (accel === 1 && node.burns + 1 > fuel) continue;
        const velocity = sub(endpoint, node.pos);
        if (length(velocity) > MAX_SPEED) continue;

        const hazards = legCost(node.pos, endpoint);
        if (hazards < 0) continue;
        if (!legAllowed(node.pos, endpoint)) continue;
        if (!solvent(velocity, node.burns + accel)) continue;
        if (!survivable(endpoint, velocity, node.burns + accel)) continue;

        const next: Node = {
          pos: endpoint,
          velocity,
          turns: node.turns + 1,
          burns: node.burns + accel,
          risk: node.risk + hazards * ASTEROID_COST,
          first: node.first ?? endpoint,
          firstAccel: node.first === null ? accel : node.firstAccel,
        };

        if (reached(endpoint, velocity, next.turns)) {
          return {
            endpoint: next.first!,
            accel: next.firstAccel,
            turns: next.turns,
            burns: next.burns,
          };
        }
        push(next);
      }
    }
  }
  return null;
};

/**
 * The gravity a node is carrying, derived rather than stored.
 *
 * "Gravity comes from the hexes the course entered" on the leg just flown, and
 * that leg is `pos - velocity` to `pos` — which is why the search needs no third
 * field. Weak arrows are treated as declined, the engine's own default, and
 * declining one only ever helps a pilot who wanted to be somewhere else.
 */
const carriedGravity = (node: Node, map: GameMap): Hex =>
  map.gravityFromMove(sub(node.pos, node.velocity), node.pos).mandatory;

/** Is this ship one a scenario has confined to a neighbourhood? */
const isLeashed = (state: GameState, ship: Ship): boolean => {
  const raw = state.scenarioData['heldNear'];
  if (typeof raw !== 'object' || raw === null) return false;
  const ships = (raw as { ships?: unknown }).ships;
  return Array.isArray(ships) && ships.includes(ship.id);
};
