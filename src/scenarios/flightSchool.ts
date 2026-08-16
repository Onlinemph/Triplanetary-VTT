/**
 * Flight School — a solo shakedown cruise.
 *
 * Not from the rulebook. Triplanetary's rules are short but its *movement* is
 * the part that takes a few turns to feel, and every printed scenario asks you
 * to fly well while somebody shoots at you. This is the same vector movement
 * with nothing else attached: one ship, no opposition, no time limit, and six
 * exercises that each isolate one thing the rules do.
 *
 * The exercises are the rulebook's own clauses, in the order they bite:
 *
 *   1. Lift off       — "Boosters are provided free of charge... leaving the ship
 *                        stationary in the gravity hex above the base."
 *   2. Get under way  — "One fuel point allows a ship to alter its predicted
 *                        course by one hex in any direction", so speed is built
 *                        one hex per turn and coasting is free.
 *   3. Come about     — "This may result in turning, speeding up, or slowing
 *                        down." Shedding speed N costs N turns and N points;
 *                        there is no one-turn reversal. This is the exercise
 *                        that catches everybody.
 *   4. Make orbit     — "A ship which moves at one hex per turn from one gravity
 *                        hex to an adjacent gravity hex of the same body is in
 *                        orbit."
 *   5. Set down       — "A ship may only land by expending one fuel point while
 *                        in orbit."
 *   6. Come home      — all of the above, in one trip, backwards.
 *
 * Nothing here can be failed. The ship is a torch — "an experimental warship
 * with unlimited fuel" — so a bad burn costs time and score, never the game, and
 * a student cannot strand themselves in deep space with dry tanks. Fuel *points
 * burned* are still counted, so there is something to get better at.
 */

import { toPlane } from '@engine/geometry.js';
import { type Hex, length as vectorLength } from '@engine/hex.js';
import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { createInitialState, log } from '@engine/state.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  baseSideToward,
  buildBases,
  buildPlayers,
  fuelBurned,
  landed,
  ownedShips,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const CADET: PlayerId = 'cadet';

const SPECS: readonly PlayerSpec[] = [
  { id: CADET, faction: 'Academy', color: '#5fb4d8', name: 'Cadet' },
];

/** The one hull in the yard: unlimited fuel, so nobody drifts out of the lesson. */
const SCHOOL_SHIP = 'torch' as const;

/** Speed that counts as "under way" — fast enough that stopping takes planning. */
const CRUISE_SPEED = 3;

/**
 * Fuel points a well-flown circuit costs.
 *
 * Pinned to something real rather than picked: `tests/rules-flight-school.test.ts`
 * flies the whole course with a pilot that brakes and turns without planning
 * ahead, and spends 19. Par is set below that, so the autopilot misses it and a
 * player who thinks a turn ahead can beat it. It is a target, not a proven
 * optimum — beating it comfortably is the point.
 */
export const FLIGHT_SCHOOL_PAR = 16;

export interface Exercise {
  readonly id: string;
  readonly name: string;
  /** What the rulebook says, so the lesson is the rule and not a paraphrase. */
  readonly clause: string;
  /** What to actually do, for somebody who has not flown one of these before. */
  readonly hint: string;
}

export const FLIGHT_SCHOOL_EXERCISES: readonly Exercise[] = [
  {
    id: 'liftOff',
    name: 'Lift off',
    clause:
      '"Boosters are provided free of charge, and lift the ship one hex, leaving it stationary in the gravity hex above the base."',
    hint: 'Take Off costs nothing and leaves you stationary one hex up. Careful: unless you burn fuel on the next turn, gravity drops you straight back onto the planet.',
  },
  {
    id: 'underWay',
    name: 'Get under way',
    clause:
      '"One fuel point allows a ship to alter its predicted course by one hex in any direction."',
    hint: `Reach a speed of ${CRUISE_SPEED} hexes per turn. You can only change your course by one hex per turn, so speed is built up a hex at a time — and once built, coasting is free.`,
  },
  {
    id: 'comeAbout',
    name: 'Come about',
    clause: '"This may result in turning, speeding up, or slowing down."',
    hint: 'Now head back the way you came. There is no handbrake: shedding speed N takes N turns and N fuel points, and only then can you build speed the other way. Watch the ghost arrow shorten each turn.',
  },
  {
    id: 'makeOrbit',
    name: 'Make orbit',
    clause:
      '"A ship which moves at one hex per turn from one gravity hex to an adjacent gravity hex of the same body is in orbit."',
    hint: 'Arrive at a world slowly. Once you are in a gravity hex moving one hex per turn into the next one round, gravity does the rest and you will circle for free. The reachable-hex overlay marks the orbital burns.',
  },
  {
    id: 'setDown',
    name: 'Set down',
    clause: '"A ship may only land by expending one fuel point while in orbit."',
    hint: 'From orbit, land on any world other than Terra. Luna and Io have weak gravity and are the gentlest to approach.',
  },
  {
    id: 'comeHome',
    name: 'Come home',
    clause:
      '"It must take off from the hex side where it landed" — and everything above, run backwards.',
    hint: 'Lift off again and put the ship back down on Terra. The whole circuit in one trip: that is the course.',
  },
];

const FLIGHT_SCHOOL_KEY = 'flightSchool';

export interface FlightSchoolProgress {
  /** Exercise ids completed, in the order they were completed. */
  readonly done: readonly string[];
  /**
   * Heading held when the ship first reached cruise speed, kept so "come about"
   * can be judged against where it was actually going rather than against north.
   */
  readonly outbound: Hex | null;
  readonly par: number;
}

const EMPTY: FlightSchoolProgress = { done: [], outbound: null, par: FLIGHT_SCHOOL_PAR };

export const flightSchoolProgress = (state: GameState): FlightSchoolProgress => {
  const raw = state.scenarioData[FLIGHT_SCHOOL_KEY] as Partial<FlightSchoolProgress> | undefined;
  return raw ? { ...EMPTY, ...raw } : EMPTY;
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const luna = map.body('luna')!;

  return createInitialState({
    scenarioId: 'flight-school',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships: [
      landed(
        {
          id: 'school-ship',
          owner: CADET,
          shipClass: SCHOOL_SHIP,
          number: 1,
          name: 'Academy Torch',
        },
        // Facing Luna: the first thing worth flying to is the closest thing to
        // fly to, and a cadet who simply burns straight ahead ends up near it.
        baseSideToward(map, 'terra', luna.hex),
      ),
    ],
    // Every base is the Academy's, so refuelling and repairs are available
    // anywhere and a wrong turn is never a dead end.
    bases: buildBases(map, { defaultOwner: CADET }),
    options: {
      // Nothing to hide from and nobody to shoot; the extra systems would only
      // put controls on screen that this scenario never uses.
      fogOfWar: false,
      nukesAllowed: false,
      advancedCombat: false,
      ...opts.options,
    },
    scenarioData: {
      [FLIGHT_SCHOOL_KEY]: EMPTY,
      // There is no time limit and nothing to shoot at.
      noTimeLimit: true,
      combatForbidden: true,
    },
  });
};

/** Are these two headings pointing at opposite halves of the sky? */
const opposed = (a: Hex, b: Hex): boolean => {
  const p = toPlane(a);
  const q = toPlane(b);
  return p.x * q.x + p.y * q.y < 0;
};

const bodyUnder = (map: GameMap, ship: Ship): string | undefined =>
  ship.location.kind === 'landed' ? map.bodyAt(ship.location.side.hex)?.id : undefined;

/**
 * Mark off whatever the cadet has just demonstrated.
 *
 * Read from the ship's *current* state once per turn rather than reconstructed
 * from its course record: position, velocity and location say exactly what the
 * rules are talking about, and none of the six exercises needs a history the
 * state does not already carry.
 */
const endPlayerTurn = (state: GameState, map: GameMap): GameState => {
  const ship = ownedShips(state, CADET)[0];
  if (!ship || ship.destroyed) return state;

  const progress = flightSchoolProgress(state);
  const done = new Set(progress.done);
  const order: string[] = [...progress.done];
  let outbound = progress.outbound;
  let s = state;

  const complete = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    order.push(id);
    const exercise = FLIGHT_SCHOOL_EXERCISES.find((e) => e.id === id);
    s = log(s, `Exercise complete — ${exercise?.name ?? id}.`, {
      severity: 'good',
      player: CADET,
      focus: [ship.pos],
    });
  };

  const airborne = ship.location.kind !== 'landed';
  const speed = vectorLength(ship.velocity);

  if (airborne) complete('liftOff');

  // "One fuel point allows a ship to alter its predicted course by one hex" —
  // so a speed of three is three turns of deciding to go somewhere.
  if (speed >= CRUISE_SPEED) {
    complete('underWay');
    if (outbound === null) outbound = ship.velocity;
  }

  // "...turning, speeding up, or slowing down." A reversal is only interesting
  // once the ship is genuinely moving the other way, so it needs speed of its
  // own rather than a single hex of drift.
  if (outbound !== null && speed >= 2 && opposed(ship.velocity, outbound)) {
    complete('comeAbout');
  }

  if (map.orbitOf(ship.pos, ship.velocity) !== undefined) complete('makeOrbit');

  const world = bodyUnder(map, ship);
  if (world !== undefined && world !== 'terra') complete('setDown');
  // Home only counts once the ship has actually been away.
  if (world === 'terra' && done.has('liftOff')) complete('comeHome');

  if (order.length === progress.done.length && outbound === progress.outbound) return state;

  const next: FlightSchoolProgress = { done: order, outbound, par: progress.par };
  return { ...s, scenarioData: { ...s.scenarioData, [FLIGHT_SCHOOL_KEY]: next } };
};

const checkVictory = (state: GameState): VictoryState | null => {
  const progress = flightSchoolProgress(state);
  if (progress.done.length < FLIGHT_SCHOOL_EXERCISES.length) {
    // The one way to end without finishing: fly into something, or off the edge.
    // "Any ship whose final course places it off the map is considered
    // eliminated" — the lesson ends, and the log says why.
    const ship = Object.values(state.ships)[0];
    if (ship?.destroyed) {
      return victory(
        [],
        'moral',
        `The school ship was lost — ${ship.destroyedBy ?? 'cause unknown'}. Start again; nothing here is scored against you.`,
      );
    }
    return null;
  }

  const burned = Object.values(state.ships).reduce((n, s) => n + fuelBurned(s), 0);
  const par = progress.par;
  return burned <= par
    ? victory(
        [CADET],
        'decisive',
        `Every exercise flown in ${burned} fuel points, at or under the par of ${par}, on day ${state.turn}.`,
      )
    : victory(
        [CADET],
        'marginal',
        `Every exercise flown, in ${burned} fuel points against a par of ${par}, on day ${state.turn}. Fly it again and spend less.`,
      );
};

export const flightSchool: ScenarioDef = {
  id: 'flight-school',
  name: 'Flight School',
  blurb: 'Solo. One ship, nobody shooting, and six exercises in vector movement.',
  description:
    'Triplanetary is a game about vectors, and vectors take a few turns to feel. ' +
    'This is the movement rules on their own: one torch on Terra, no opposition, ' +
    'no time limit, and six exercises that each isolate one thing the rules do — ' +
    'lifting off, building speed, turning around, making orbit, setting down, and ' +
    'coming home. The ship has unlimited fuel, so a bad burn costs you time and ' +
    'score but never the game. Fuel points burned are counted against a par of ' +
    `${FLIGHT_SCHOOL_PAR}, so there is something to get better at.`,
  players: { min: 1, max: 1 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  endPlayerTurn,
  specialRules: [
    'One ship, one player. Nothing is hostile and there is no time limit.',
    'The school ship is a torch: "an experimental warship with unlimited fuel". You cannot strand yourself, and every base on the chart will refuel and repair you.',
    ...FLIGHT_SCHOOL_EXERCISES.map((e) => `${e.name}: ${e.hint}`),
    `Scoring: complete all six exercises. ${FLIGHT_SCHOOL_PAR} fuel points or fewer is a first in class; more still passes.`,
  ],
};
