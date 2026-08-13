/**
 * Lateral 7 — "A short two-player scenario".
 *
 * Rulebook p. 10:
 *
 *   "A liner is outbound from Venus carrying industrial magnates to an
 *    interplanetary mining conference at Ganymede. Other considerations prevent
 *    the Navy from escorting this ship, but one dreadnaught (the Tycho Brahe,
 *    number 101) is on station in the Belt to respond to possible distress
 *    calls. Pirates have been menacing the rich trans-Belt shipping lanes with
 *    raids from their unapproachable base at Clandestine. If the pirates can
 *    capture and ransom the passengers on the liner, they will be able to double
 *    the size of their fleet.
 *
 *    Ships: The pirates get two corsairs and one corvette (white on black), plus
 *    nine dummy counters... Each pirate corsair begins the game with one mine on
 *    board. The Navy gets one dreadnaught, three dummies (frigates), and a
 *    liner... The dreadnaught begins with one mine and one torpedo on board.
 *
 *    Special Rules: The liner is placed on Venus. The dreadnaught and three
 *    dummies are placed in any asteroid hexes, inverted to conceal their
 *    identities. The pirate then places their three ships and nine dummies in
 *    any unoccupied asteroid hexes. All ships begin at zero velocity.
 *
 *    Because ship sailings are published, the pirate knows the location of the
 *    liner. Each pirate ship, on its first acceleration, must remove three
 *    dummies. The dreadnaught, on its first acceleration, must remove its three
 *    dummies. The dreadnaught, however, may not move until a pirate is detected
 *    by a ship or a base."
 */

import type { Hex } from '@engine/hex.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { createRng } from '@engine/rng.js';
import type { ShipClass } from '@engine/ships.js';
import { cargoCount, createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  asteroidHexes,
  atAsteroidBase,
  baseSideToward,
  buildBases,
  buildPlayers,
  hold,
  isAtAsteroidBase,
  isLandedOn,
  landed,
  mutualDefeat,
  pickSpaced,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const PIRATES: PlayerId = 'pirates';
const NAVY: PlayerId = 'navy';

const SPECS: readonly PlayerSpec[] = [
  { id: PIRATES, faction: 'Pirates', color: '#2b2b31', name: 'Pirates' },
  { id: NAVY, faction: 'Navy', color: '#2f6fb5', name: 'Navy' },
];

/**
 * A counter placed face-down to conceal whether it is a ship at all.
 *
 * Dummies have no game existence beyond their position: they cannot move, fight
 * or be shot at, and they leave the board the moment their owner's real ships
 * light their engines. Modelling them as `Ship`s would give them a combat
 * strength and a fuel tank they do not have, so they live here instead.
 */
export interface DummyCounter {
  readonly id: string;
  readonly owner: PlayerId;
  /** The counter's printed face, revealed only when it is removed. */
  readonly shipClass: ShipClass;
  readonly hex: Hex;
}

export const LATERAL7_DUMMIES_KEY = 'dummies';

const PIRATE_DUMMY_FACES: readonly ShipClass[] = [
  'corvette',
  'corsair',
  'corvette',
  'corsair',
  'corvette',
  'corsair',
  'corvette',
  'corsair',
  'corvette',
];

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const ganymede = map.body('ganymede')!;
  const clandestine = map.body('clandestine')!;

  // "The dreadnaught and three dummies are placed in any asteroid hexes... The
  // pirate then places their three ships and nine dummies in any unoccupied
  // asteroid hexes." Sixteen distinct hexes, spread out, drawn deterministically
  // from the seed so a saved game lays the Belt out the same way every time.
  const picked = pickSpaced(createRng(seedOf(opts)), asteroidHexes(map), 16, 2);
  const sites = picked.hexes;
  const siteAt = (i: number): Hex => sites[i] ?? clandestine.hex;

  const ships: Ship[] = [];

  // "The liner is placed on Venus", bound for the conference at Ganymede.
  ships.push(
    landed(
      {
        id: 'liner',
        owner: NAVY,
        shipClass: 'liner',
        number: 7,
        name: 'Lateral 7',
        // The magnates themselves. A liner "has no weapons and no capacity for
        // other cargo", and passengers are massless, so they fit and nothing else does.
        cargo: hold({ passengers: 1 }),
      },
      baseSideToward(map, 'venus', ganymede.hex),
    ),
  );

  // "The dreadnaught begins with one mine and one torpedo on board." Ships
  // parked in an asteroid hex at zero velocity are at rest on the rock —
  // "Ships may land at... any unnamed asteroid in the Belt, by simply stopping
  // in the hex" — which is also the location the movement phase would compute.
  ships.push(
    atAsteroidBase(
      {
        id: 'tycho-brahe',
        owner: NAVY,
        shipClass: 'dreadnaught',
        number: 101,
        name: 'Tycho Brahe',
        cargo: hold({ mine: 1, torpedo: 1 }),
      },
      siteAt(0),
    ),
  );

  // "Each pirate corsair begins the game with one mine on board."
  ships.push(
    atAsteroidBase(
      { id: 'pirate-corsair-1', owner: PIRATES, shipClass: 'corsair', number: 1, cargo: hold({ mine: 1 }) },
      siteAt(4),
    ),
    atAsteroidBase(
      { id: 'pirate-corsair-2', owner: PIRATES, shipClass: 'corsair', number: 2, cargo: hold({ mine: 1 }) },
      siteAt(5),
    ),
    atAsteroidBase({ id: 'pirate-corvette', owner: PIRATES, shipClass: 'corvette', number: 3 }, siteAt(6)),
  );

  const dummies: DummyCounter[] = [];
  for (let i = 0; i < 3; i++) {
    dummies.push({
      id: `navy-dummy-${i + 1}`,
      owner: NAVY,
      shipClass: 'frigate',
      hex: siteAt(1 + i),
    });
  }
  for (let i = 0; i < 9; i++) {
    dummies.push({
      id: `pirate-dummy-${i + 1}`,
      owner: PIRATES,
      shipClass: PIRATE_DUMMY_FACES[i] ?? 'corvette',
      hex: siteAt(7 + i),
    });
  }

  // "Each pirate ship, on its first acceleration, must remove three dummies. The
  // dreadnaught, on its first acceleration, must remove its three dummies."
  const assignments: Record<string, string[]> = {
    'tycho-brahe': dummies.filter((d) => d.owner === NAVY).map((d) => d.id),
    'pirate-corsair-1': ['pirate-dummy-1', 'pirate-dummy-2', 'pirate-dummy-3'],
    'pirate-corsair-2': ['pirate-dummy-4', 'pirate-dummy-5', 'pirate-dummy-6'],
    'pirate-corvette': ['pirate-dummy-7', 'pirate-dummy-8', 'pirate-dummy-9'],
  };

  return createInitialState({
    scenarioId: 'lateral-7',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships,
    bases: buildBases(map, {
      owners: {
        // "The Navy has bases on Mars, Terra, and Callisto."
        terra: NAVY,
        mars: NAVY,
        callisto: NAVY,
        // "The pirate base is Clandestine."
        clandestine: PIRATES,
        // The liner's port of departure and its destination are civil ports,
        // open to anyone who can reach them.
        venus: null,
        ganymede: null,
      },
      // Nothing else is in play this scenario.
      absent: ['mercury', 'luna', 'io', 'ceres'],
    }),
    options: {
      // Inverted counters, an unapproachable pirate base, and a dreadnaught that
      // may not stir until something is spotted: this scenario is hidden movement.
      fogOfWar: true,
      ...opts.options,
    },
    scenarioData: {
      [LATERAL7_DUMMIES_KEY]: dummies,
      dummyAssignments: assignments,
      // "The dreadnaught, however, may not move until a pirate is detected by a
      // ship or a base."
      dreadnaughtHeldUntilContact: 'tycho-brahe',
      // "Because ship sailings are published, the pirate knows the location of
      // the liner."
      alwaysVisibleToPirates: ['liner'],
      passengerShip: 'liner',
    },
  });
};

/** Every live ship currently carrying the magnates. */
const passengerCarriers = (state: GameState): Ship[] =>
  Object.values(state.ships).filter((s) => !s.destroyed && cargoCount(s, 'passengers') > 0);

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const carriers = passengerCarriers(state);

  // "If the passengers of the liner, while on the liner or after transfer to
  // another ship, are destroyed, both players lose."
  if (carriers.length === 0) {
    return mutualDefeat('The magnates are dead. Both sides have failed.');
  }

  const dreadnaughtLost = state.ships['tycho-brahe']?.destroyed === true;
  const pirateLost = Object.values(state.ships).some((s) => s.owner === PIRATES && s.destroyed);

  // "The pirate wins by matching courses with the liner, transferring the
  // passengers, and taking them to Clandestine."
  const ransomed = carriers.some(
    (s) => (s.capturedBy ?? s.owner) === PIRATES && isAtAsteroidBase(map, s, 'clandestine'),
  );
  if (ransomed) {
    return dreadnaughtLost
      ? victory([PIRATES], 'decisive', 'The magnates are held at Clandestine and the Tycho Brahe is wreckage.')
      : victory([PIRATES], 'marginal', 'The magnates are held for ransom at Clandestine.');
  }

  // "The Navy wins if the liner makes it to Ganymede."
  const liner = state.ships['liner'];
  if (liner && !liner.destroyed && cargoCount(liner, 'passengers') > 0 && isLandedOn(map, liner, 'ganymede')) {
    return pirateLost
      ? victory([NAVY], 'decisive', 'Lateral 7 is down at Ganymede and a pirate has been destroyed.')
      : victory([NAVY], 'marginal', 'Lateral 7 has landed at Ganymede with the magnates aboard.');
  }

  return null;
};

export const lateral7: ScenarioDef = {
  id: 'lateral-7',
  name: 'Lateral 7',
  blurb: 'Pirates hunt a liner across the Belt while a dreadnaught waits, hidden.',
  description:
    'A liner is outbound from Venus carrying industrial magnates to an interplanetary ' +
    'mining conference at Ganymede. Other considerations prevent the Navy from ' +
    'escorting this ship, but one dreadnaught — the Tycho Brahe, number 101 — is on ' +
    'station in the Belt to respond to possible distress calls. Pirates have been ' +
    'menacing the rich trans-Belt shipping lanes with raids from their unapproachable ' +
    'base at Clandestine. If the pirates can capture and ransom the passengers on the ' +
    'liner, they will be able to double the size of their fleet.',
  players: { min: 2, max: 2 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'The dreadnaught and three dummies are placed in any asteroid hexes, inverted to conceal their identities. The pirate then places three ships and nine dummies in any unoccupied asteroid hexes. All ships begin at zero velocity.',
    'Because ship sailings are published, the pirate knows the location of the liner.',
    'Each pirate ship, on its first acceleration, must remove three dummies. The dreadnaught, on its first acceleration, must remove its three dummies.',
    'The dreadnaught may not move until a pirate is detected by a ship or a base.',
    'Clandestine may not be attacked, and ships which reach it drop off the opposing side’s detectors. Only ships with scanners may enter the dense asteroids around it.',
    'Victory: the pirate wins by matching courses with the liner, transferring the passengers, and taking them to Clandestine — decisively if the dreadnaught is also destroyed. The Navy wins if the liner makes it to Ganymede — decisively if a pirate ship is also destroyed.',
    'If the passengers are destroyed, on the liner or after transfer, both players lose.',
    'Variant: the liner may begin at Terra instead of Venus.',
  ],
};
