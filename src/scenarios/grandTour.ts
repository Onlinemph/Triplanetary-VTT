/**
 * Grand Tour, 2037 AD — "A medium-length multi-player scenario".
 *
 * Rulebook p. 9:
 *
 *   "Gesichtkreis Sternschiffbau, A.G. offers a grand prize of royalties to the
 *    winner of its decennial Grand Tour competition...
 *
 *    Ships: Each racer starts with one corvette at a different (if possible)
 *    habitable full-gravity world.
 *
 *    Special Rules: Fuel is available only at bases on Terra, Venus, Mars, and
 *    Callisto. There is no cost for fuel. Combat is not allowed (but see the
 *    variant rule!) You may erase each ship's course arrows as soon as it
 *    refuels, to keep players from easily shadowing previous routes.
 *
 *    Victory: Each ship must pass through at least one gravity hex of each
 *    astral body with full gravity (the six habitable ones, plus Jupiter and the
 *    Sun) and return to land on its starting world. The first ship to do so
 *    wins. In case of ties, the lowest fuel consumption wins."
 */

import { eq } from '@engine/hex.js';
import { traceSegment } from '@engine/geometry.js';
import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  baseSideToward,
  buildBases,
  buildPlayers,
  fuelBurned,
  landed,
  mutualDefeat,
  ownedShips,
  seatCount,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

/**
 * "the six habitable ones" — the habitable worlds whose gravity is full, which
 * is every habitable world except weak-gravity Luna and Io and the gravity-less
 * asteroids Ceres and Clandestine. They double as the starting worlds.
 */
const START_WORLDS: readonly string[] = [
  'terra',
  'mars',
  'venus',
  'callisto',
  'mercury',
  'ganymede',
];

/** "each astral body with full gravity (the six habitable ones, plus Jupiter and the Sun)". */
export const fullGravityBodies = (map: GameMap): string[] =>
  map.bodies.filter((b) => b.gravity === 'full').map((b) => b.id);

/** "Fuel is available only at bases on Terra, Venus, Mars, and Callisto." */
const FUEL_WORLDS: readonly string[] = ['terra', 'venus', 'mars', 'callisto'];

const PALETTE = ['#5b9bd5', '#d1795a', '#e8c98f', '#8d8478', '#b9a48c', '#a8a294'];

const specFor = (index: number): PlayerSpec => {
  const world = START_WORLDS[index] ?? 'terra';
  const name = world.charAt(0).toUpperCase() + world.slice(1);
  return {
    id: `racer${index + 1}`,
    faction: `${name} Entry`,
    color: PALETTE[index] ?? '#cccccc',
    name: `${name} Racer`,
  };
};

const ALL_SPECS: readonly PlayerSpec[] = START_WORLDS.map((_, i) => specFor(i));

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const sol = map.body('sol')!;
  const count = seatCount(opts, 2, START_WORLDS.length, START_WORLDS.length);
  const specs = ALL_SPECS.slice(0, count);

  const starts: Record<PlayerId, string> = {};
  const ships: Ship[] = specs.map((spec, i) => {
    const world = START_WORLDS[i]!;
    starts[spec.id] = world;
    return landed(
      {
        id: `${spec.id}-corvette`,
        owner: spec.id,
        shipClass: 'corvette',
        number: i + 1,
        name: `${spec.faction} corvette`,
      },
      // The sunward base side: every route starts by falling in toward Sol,
      // which every entrant has to round anyway.
      baseSideToward(map, world, sol.hex),
    );
  });

  return createInitialState({
    scenarioId: 'grand-tour',
    seed: seedOf(opts),
    players: buildPlayers(specs, opts),
    ships,
    // The contest is run under the eye of the whole System; no base belongs to
    // any racer, and the fuel restriction is a rule of the competition rather
    // than a matter of who owns what.
    bases: buildBases(map),
    options: opts.options ?? {},
    scenarioData: {
      startWorlds: starts,
      requiredBodies: fullGravityBodies(map),
      fuelBases: FUEL_WORLDS,
      // "Combat is not allowed (but see the variant rule!)"
      combatForbidden: true,
      combatVariant: {
        enabled: false,
        losesBy: [
          'firing while in detection range of a world',
          'firing while in detection range of a third-party ship',
          'firing on someone who survives to reach any world',
        ],
        note: 'Self-defense is allowed; a racer is not disqualified for counterattacking on the turn of attack.',
      },
      routeVariants: [
        'Start all players on Terra.',
        'Announce a required route before the race: alphabetical order, order of size, or order from the Sun.',
      ],
    },
  });
};

/**
 * The turn a ship completed the tour, or `null`.
 *
 * Walked leg by leg so that the *order* is respected: the landing at home only
 * counts once every full-gravity body has already been passed. Refuelling stops
 * at the home world earlier in the race are therefore ignored, as they must be.
 */
const completionTurn = (map: GameMap, ship: Ship, homeId: string): number | null => {
  const home = map.body(homeId);
  if (!home) return null;
  const required = new Set(fullGravityBodies(map));
  const seen = new Set<string>();

  const visit = (h: { q: number; r: number }): void => {
    for (const src of map.gravityAt(h)) seen.add(src.bodyId);
  };

  for (const leg of ship.course) {
    // "Each ship must pass through at least one gravity hex" — entered, not
    // merely skimmed along the edge of (Figure 7).
    for (const h of traceSegment(leg.from, leg.to).entered) visit(h);
    if (!eq(leg.to, home.hex)) continue;
    let complete = true;
    for (const id of required) {
      if (!seen.has(id)) {
        complete = false;
        break;
      }
    }
    // A leg ending inside a body's hex is a landing; any other contact with the
    // printed disc would have eliminated the ship.
    if (complete && !ship.destroyed) return leg.turn;
  }
  return null;
};

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const starts = (state.scenarioData['startWorlds'] ?? {}) as Record<PlayerId, string>;

  interface Entry {
    readonly player: PlayerId;
    readonly turn: number | null;
    readonly fuel: number;
    readonly alive: boolean;
  }

  const entries: Entry[] = state.playerOrder.map((player) => {
    const home = starts[player] ?? 'terra';
    let turn: number | null = null;
    let fuel = 0;
    for (const ship of Object.values(state.ships)) {
      if (ship.owner !== player) continue;
      fuel += fuelBurned(ship);
      const done = completionTurn(map, ship, home);
      if (done !== null && (turn === null || done < turn)) turn = done;
    }
    return { player, turn, fuel, alive: ownedShips(state, player).length > 0 };
  });

  const finishers = entries.filter((e) => e.turn !== null);
  if (finishers.length === 0) {
    return entries.every((e) => !e.alive)
      ? mutualDefeat('Every entrant was lost; the Grand Tour is abandoned.')
      : null;
  }

  const best = Math.min(...finishers.map((e) => e.turn!));
  // Hold the result open while somebody could still finish on the same day.
  const stillRunning = entries.some((e) => e.turn === null && e.alive);
  if (stillRunning && state.turn <= best) return null;

  const onBest = finishers.filter((e) => e.turn === best);
  // "In case of ties, the lowest fuel consumption wins."
  const leanest = Math.min(...onBest.map((e) => e.fuel));
  const winners = onBest.filter((e) => e.fuel === leanest).map((e) => e.player);
  return victory(
    winners,
    winners.length === 1 ? 'decisive' : 'marginal',
    `Grand Tour completed on day ${best} for ${leanest} fuel points.`,
  );
};

export const grandTour: ScenarioDef = {
  id: 'grand-tour',
  name: 'Grand Tour, 2037 AD',
  blurb: 'A multi-player race around every full-gravity body and home again.',
  description:
    'Gesichtkreis Sternschiffbau, A.G. offers a grand prize of royalties to the ' +
    'winner of its decennial Grand Tour competition. Each racer starts with one ' +
    'corvette at a different habitable full-gravity world. Every ship must pass ' +
    'through at least one gravity hex of each full-gravity body — Mercury, Venus, ' +
    'Terra, Mars, Ganymede, Callisto, Jupiter and Sol — and return to land on its ' +
    'starting world. First home wins; ties go to the lowest fuel consumption.',
  players: { min: 2, max: 6 },
  length: 'medium',
  playerTemplates: templatesOf(ALL_SPECS),
  build,
  checkVictory,
  specialRules: [
    'Fuel is available only at bases on Terra, Venus, Mars and Callisto. There is no cost for fuel.',
    'Combat is not allowed.',
    'You may erase each ship’s course arrows as soon as it refuels, to keep players from shadowing previous routes.',
    'Variant — combat happens anyway: a player loses by (a) firing while in detection range of a world, (b) firing while in detection range of a third-party ship, or (c) firing on someone who survives to reach any world. Self-defence is allowed; a racer is not disqualified for counterattacking on the turn of attack.',
    'Variant — start all players on Terra.',
    'Variant — announce a required route just before the race: alphabetical order, order of size, or order from the Sun.',
  ],
};
