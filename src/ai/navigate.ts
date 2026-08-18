/**
 * Astrogation for a computer pilot.
 *
 * The hard part of playing Triplanetary is not choosing a target, it is getting
 * there. A ship changes its course by one hex per turn, so a burn made now is
 * felt for the rest of the game, and the only way to stop is to have started
 * stopping several turns ago:
 *
 *   "One fuel point allows a ship to alter its predicted course by one hex in
 *    any direction."
 *   "This may result in turning, speeding up, or slowing down."
 *
 * That gives the navigator its one real idea. Braking sheds a hex of speed per
 * turn, so coming to rest from speed *v* needs `v(v+1)/2` hexes of room. A
 * course is worth flying if it closes the distance *and* still leaves enough
 * room to stop; when nothing does, the ship brakes instead. It is the same
 * arithmetic a player does by eye, and it is why a good pilot starts slowing
 * down long before arriving.
 *
 * Everything here is a pure function of the state. No `Math.random`, no `Date`:
 * ties break on hex order so the same position always produces the same course,
 * which is what lets a solo game be replayed from its seed and command log.
 */

import {
  type GameMap,
  type Hex,
  type PlotOption,
  type Ship,
  type GameState,
  add,
  denseAsteroidsOnCourse,
  distance,
  hasScanners,
  hasUnlimitedFuel,
  key,
  leashBroken,
  length,
  neighbors,
  reachableEndpoints,
  sub,
} from '../engine/index.js';

/** How much room stopping from this speed needs, braking one hex per turn. */
export const brakingRoom = (speed: number): number => (speed * (speed + 1)) / 2;

export interface CourseChoice {
  readonly endpoint: Hex;
  readonly accel: 0 | 1 | 2;
  /** Distance from the endpoint to the goal, for the caller's own reasoning. */
  readonly closing: number;
}

/**
 * Every course this ship may legally fly that will not simply kill it.
 *
 * Crashes and map exits are legal orders — "any ship whose final course places
 * it off the map is considered eliminated" is a rule, not a refusal — so the
 * engine offers them and the pilot has to decline them itself. Overload is left
 * out: "warships may perform one overload maneuver between maintenance
 * stopovers", and spending the only one on ordinary navigation is a bad trade.
 *
 * Asteroids are *not* excluded. "A die is rolled for each asteroid hex entered",
 * and on the asteroid column that is nothing on a 1-4, D1 on a 5 and D2 on a 6 —
 * a risk, not a wall. Refusing it outright would leave a pirate based at
 * Clandestine unable to leave home, since every course out of the Belt crosses
 * rock. It is priced in {@link courseToward} instead.
 */
export const safeCourses = (state: GameState, ship: Ship, map: GameMap): PlotOption[] =>
  reachableEndpoints(state, ship, map).filter(
    (o) =>
      !o.crashesInto &&
      !o.exitsMap &&
      o.accel <= 1 &&
      // "Only ships possessing scanners may enter those hexes. Other ships are
      // destroyed" — the dense cordon around Clandestine is not a risk to price,
      // it is certain death.
      (hasScanners(state, ship) ||
        denseAsteroidsOnCourse(state, map, ship.pos, o.endpoint).length === 0) &&
      // A scenario may confine a ship to a neighbourhood ("Vega and Sirius may
      // not leave detector range of Venus"). The engine refuses such a course;
      // the pilot should not have offered it.
      leashBroken(state, ship, o.endpoint, map) === null,
  );

/**
 * Would this course leave the ship able to come to rest again?
 *
 * Braking sheds one hex of speed per turn and costs a fuel point each time, so a
 * ship carrying speed *v* needs *v* points in the tank to ever stop. A course
 * that ends with less than that is a course that ends at the rim — the ship
 * coasts, unable to turn, until "its final course places it off the map".
 */
export const solvent = (ship: Ship, o: PlotOption): boolean =>
  hasUnlimitedFuel(ship) || o.distance <= ship.fuel - o.accel;

/** Hex-equivalents of detour the pilot will accept to miss one asteroid hex. */
const ASTEROID_PENALTY = 1;

/**
 * Would the ship still have somewhere to go next turn?
 *
 * The trap this catches is the one the rulebook itself warns about. A ship that
 * comes to rest inside a gravity hex is not safe there: "a ship that does not
 * move is still sitting in the gravity hex, and is pulled again" — "unless fuel
 * is spent on the next turn, the ship would fall back to the planet and crash."
 * Stopping one hex above Terra looks like arriving; it is falling.
 *
 * So each candidate course is played one turn further: take the velocity it
 * leaves, add the gravity that course picks up, and ask whether *any* of the
 * seven hexes reachable from there — the drift itself and its six neighbours,
 * one fuel point being all a ship may burn in a turn — is somewhere the ship
 * could survive. A course with no such continuation is a course into a planet,
 * however good it looks this turn.
 */
export const escapable = (ship: Ship, o: PlotOption, map: GameMap): boolean => {
  const from = o.endpoint;
  const velocity = sub(o.endpoint, ship.pos);
  const { mandatory } = map.gravityFromMove(ship.pos, o.endpoint);
  const drift = add(add(from, velocity), mandatory);
  const canBurn = hasUnlimitedFuel(ship) || ship.fuel - o.accel > 0;
  const candidates = canBurn ? [drift, ...neighbors(drift)] : [drift];
  return candidates.some((to) => map.crashedInto(from, to) === undefined && map.inBounds(to));
};

/**
 * The course that best closes on `goal` while staying able to stop there.
 *
 * Returns `null` when the ship has no legal course at all, which happens to a
 * ship boxed in by the rim; the caller should then let it coast.
 */
export const courseToward = (
  state: GameState,
  ship: Ship,
  goal: Hex,
  map: GameMap,
  /**
   * Arrive at a walking pace. "Any ship may prospect by passing through an
   * asteroid hex at a speed of 1" — a prospector that hurries surveys nothing,
   * so the trawl is flown at one hex per turn even though it is slower.
   */
  cruise = false,
): CourseChoice | null => {
  const all = safeCourses(state, ship, map);
  const options = cruise
    ? all.filter((o) => o.distance <= 1).length > 0
      ? all.filter((o) => o.distance <= 1)
      : all
    : all;
  if (options.length === 0) return null;

  const scored = options.map((o) => {
    const closing = distance(o.endpoint, goal);
    const speed = o.distance;
    return {
      o,
      closing,
      speed,
      canStop: brakingRoom(speed) <= closing + 1,
      solvent: solvent(ship, o),
      escapable: escapable(ship, o, map),
      cost: closing - speed + ASTEROID_PENALTY * o.asteroidHexes.length,
    };
  });

  // Survival first, in order of how quickly it kills you: a course with no
  // continuation is a crash next turn; a course that spends the last of the fuel
  // while still moving is the rim a few turns later; then the courses that leave
  // room to stop at the far end.
  const alive = scored.filter((x) => x.escapable);
  const living = alive.length > 0 ? alive : scored;
  const afford = living.filter((x) => x.solvent);
  const pool = afford.length > 0 ? afford : living;
  const usable = pool.filter((x) => x.canStop);
  const finalists = usable.length > 0 ? usable : pool;

  finalists.sort(
    (a, b) =>
      // Progress first: how much closer this leaves us, allowing for the speed
      // we will still be carrying and for any rock in the way.
      a.cost - b.cost || a.speed - b.speed || key(a.o.endpoint).localeCompare(key(b.o.endpoint)),
  );
  const best = finalists[0]!;
  return { endpoint: best.o.endpoint, accel: best.o.accel, closing: best.closing };
};

/**
 * A course that puts the ship in orbit around `bodyId`, if one is available.
 *
 * "A ship which moves at one hex per turn from one gravity hex to an adjacent
 * gravity hex of the same body is in orbit." Worth asking for directly rather
 * than steering toward: an orbit is a specific one-hex burn, and a navigator
 * aiming only at a gravity hex will usually arrive too fast to be caught.
 */
export const orbitalCourse = (
  state: GameState,
  ship: Ship,
  bodyId: string,
  map: GameMap,
): CourseChoice | null => {
  for (const o of safeCourses(state, ship, map)) {
    if (!escapable(ship, o, map)) continue;
    const orbit = map.orbitOf(o.endpoint, sub(o.endpoint, ship.pos));
    if (orbit?.id === bodyId) {
      return { endpoint: o.endpoint, accel: o.accel, closing: 0 };
    }
  }
  return null;
};

/**
 * The course that sheds the most speed.
 *
 * What a pilot flies when there is nowhere to be: a ship coasting at speed six
 * has no options at all next turn, so slowing down is never wasted.
 */
export const brakingCourse = (state: GameState, ship: Ship, map: GameMap): CourseChoice | null => {
  const options = safeCourses(state, ship, map);
  if (options.length === 0) return null;
  const escaping = options.filter((o) => escapable(ship, o, map));
  const best = [...(escaping.length > 0 ? escaping : options)].sort(
    (a, b) =>
      a.distance - b.distance ||
      a.asteroidHexes.length - b.asteroidHexes.length ||
      key(a.endpoint).localeCompare(key(b.endpoint)),
  )[0]!;
  return { endpoint: best.endpoint, accel: best.accel, closing: 0 };
};

/** Is this ship going fast enough that it needs to think about stopping? */
export const isRunaway = (ship: Ship, goal: Hex | null): boolean => {
  const speed = length(ship.velocity);
  if (speed <= 1) return false;
  if (goal === null) return speed >= 4;
  return brakingRoom(speed) > distance(ship.pos, goal) + 1;
};
