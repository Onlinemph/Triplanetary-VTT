/**
 * Bi-Planetary — "A two-player learning scenario".
 *
 * Rulebook p. 9, in full:
 *
 *   "One player starts with a corvette on Mars, one on Venus. Each player must
 *    navigate to the other world and land. The winner is the one who does it in
 *    the fewest turns.
 *
 *    For a longer and harder route, use Mercury and Ganymede, and watch out for
 *    asteroids."
 *
 * There is no combat here and nothing to buy: the whole scenario is the vector
 * movement system, which is what makes it the right first game.
 */

import { DEFAULT_MAP } from '@engine/map.js';
import { createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  baseSideToward,
  buildBases,
  buildPlayers,
  arrivalTurn,
  fuelBurned,
  landed,
  mutualDefeat,
  ownedShips,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const MARS: PlayerId = 'mars';
const VENUS: PlayerId = 'venus';

const SPECS: readonly PlayerSpec[] = [
  { id: MARS, faction: 'Mars', color: '#d1795a', name: 'Mars Pilot' },
  { id: VENUS, faction: 'Venus', color: '#e8c98f', name: 'Venus Pilot' },
];

/** Which world each racer has to reach. Read back by `checkVictory`. */
const TARGETS: Readonly<Record<PlayerId, string>> = {
  [MARS]: 'venus',
  [VENUS]: 'mars',
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const mars = map.body('mars')!;
  const venus = map.body('venus')!;

  // Each corvette starts at the base site facing the world it has to reach —
  // the side a pilot would choose, and a deterministic one.
  const marsSide = baseSideToward(map, 'mars', venus.hex);
  const venusSide = baseSideToward(map, 'venus', mars.hex);

  return createInitialState({
    scenarioId: 'bi-planetary',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships: [
      landed(
        { id: 'mars-corvette', owner: MARS, shipClass: 'corvette', number: 1, name: 'Ares' },
        marsSide,
      ),
      landed(
        { id: 'venus-corvette', owner: VENUS, shipClass: 'corvette', number: 2, name: 'Hesperus' },
        venusSide,
      ),
    ],
    // "All bases marked on the map are assumed to be in use unless a scenario
    // indicates differently." Nobody owns them, so both racers may refuel
    // anywhere they can reach.
    bases: buildBases(map),
    options: opts.options ?? {},
    scenarioData: {
      targets: TARGETS,
      longRoute: { [MARS]: 'ganymede', [VENUS]: 'mercury' },
    },
  });
};

/**
 * "The winner is the one who does it in the fewest turns."
 *
 * A racer's finish is the turn its course first ends inside the target world's
 * hex — which can only be a landing, since any other contact with the printed
 * disc is a crash. The result is only called once neither racer can still beat
 * the other: both down, or one down on a turn the other has already passed.
 */
const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;

  const finish = (player: PlayerId): number | null => {
    const target = TARGETS[player];
    if (!target) return null;
    for (const ship of Object.values(state.ships)) {
      if (ship.owner !== player) continue;
      const turn = arrivalTurn(map, ship, target);
      if (turn !== null) return turn;
    }
    return null;
  };

  const spent = (player: PlayerId): number => {
    let total = 0;
    for (const ship of Object.values(state.ships)) {
      if (ship.owner === player) total += fuelBurned(ship);
    }
    return total;
  };

  const marsTurn = finish(MARS);
  const venusTurn = finish(VENUS);
  const marsAlive = ownedShips(state, MARS).length > 0;
  const venusAlive = ownedShips(state, VENUS).length > 0;

  if (marsTurn !== null && venusTurn !== null) {
    if (marsTurn === venusTurn) {
      // Both touched down on the same day; the tie-break the rules leave unstated
      // is the one the Grand Tour uses — "In case of ties, the lowest fuel
      // consumption wins" — and a genuine dead heat is a shared victory.
      const marsFuel = spent(MARS);
      const venusFuel = spent(VENUS);
      if (marsFuel === venusFuel) {
        return victory([MARS, VENUS], 'marginal', `Both pilots landed on day ${marsTurn}.`);
      }
      const winner = marsFuel < venusFuel ? MARS : VENUS;
      return victory(
        [winner],
        'marginal',
        `Both landed on day ${marsTurn}; the lower fuel burn wins it.`,
      );
    }
    const winner = marsTurn < venusTurn ? MARS : VENUS;
    const fewest = Math.min(marsTurn, venusTurn);
    return victory([winner], 'decisive', `Landed on day ${fewest}, the fewer turns.`);
  }

  if (marsTurn !== null && (!venusAlive || state.turn > marsTurn)) {
    return victory([MARS], 'decisive', `Landed on Venus on day ${marsTurn}.`);
  }
  if (venusTurn !== null && (!marsAlive || state.turn > venusTurn)) {
    return victory([VENUS], 'decisive', `Landed on Mars on day ${venusTurn}.`);
  }
  if (!marsAlive && !venusAlive) {
    return mutualDefeat('Both corvettes were lost before reaching the other world.');
  }
  if (!marsAlive && venusTurn === null) return null;
  return null;
};

export const biPlanetary: ScenarioDef = {
  id: 'bi-planetary',
  name: 'Bi-Planetary',
  blurb: 'A two-player learning scenario: race a corvette to the other world.',
  description:
    'One player starts with a corvette on Mars, one on Venus. Each player must ' +
    'navigate to the other world and land. The winner is the one who does it in ' +
    'the fewest turns. Nothing here but astrogation — no combat, no cargo, no ' +
    'purchases — so it is the scenario to learn vector movement, gravity and ' +
    'orbits on.',
  players: { min: 2, max: 2 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'Each corvette must take off, cross to the other world, enter orbit, and spend a fuel point to land.',
    'A course that touches a printed disc without landing from orbit is a crash, and the ship is eliminated.',
    'Fuel is free at any base; the corvette carries 20 points.',
    'Variant: "For a longer and harder route, use Mercury and Ganymede, and watch out for asteroids."',
  ],
};
