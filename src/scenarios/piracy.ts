/**
 * Piracy — "A long three-player scenario".
 *
 * Rulebook pp. 10-11:
 *
 *   "The System's growing economy is threatened by pirates striking from their
 *    secret base in the asteroid belt. The players represent the Patrol, the
 *    Merchants, and the Pirates.
 *
 *    Special Rules: For this scenario to work, the Patrol and Merchant players
 *    must be willing to ignore undetected pirate ships until they are legally
 *    detected.
 *
 *    The Patrol starts with a Dreadnaught and a Corsair on Luna... The Merchant
 *    starts with two Transports on Terra... The Pirates start with two Corsairs
 *    on Clandestine."
 *
 * The economy here runs on the combat-strength point system rather than
 * MegaCredits, so the price tables are recorded in `scenarioData` for the
 * purchase screen; `Player.points` carries the running score.
 */

import { DEFAULT_MAP } from '@engine/map.js';
import { createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  atAsteroidBase,
  buildBases,
  buildPlayers,
  landed,
  ownedShips,
  seedOf,
  sideOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const PATROL: PlayerId = 'patrol';
const MERCHANTS: PlayerId = 'merchants';
const PIRATES: PlayerId = 'pirates';

/**
 * The Patrol and the Merchants are on the same side: the Patrol "also wins a
 * marginal victory if the Merchant wins", and the Merchant wins alongside the
 * Patrol when the pirate fleet is destroyed. Alliance is also what lets merchant
 * hulls refuel at the Patrol's bases.
 */
const SPECS: readonly PlayerSpec[] = [
  { id: PATROL, faction: 'Patrol', color: '#2f6fb5', name: 'Space Patrol', allies: [MERCHANTS] },
  { id: MERCHANTS, faction: 'Merchants', color: '#4fae7a', name: 'Merchants', allies: [PATROL] },
  { id: PIRATES, faction: 'Pirates', color: '#2b2b31', name: 'Pirates' },
];

/** "Cargoes may be delivered from any inhabited world to any other inhabited world." */
const inhabitedWorlds = (): string[] =>
  DEFAULT_MAP.bodies.filter((b) => b.habitable).map((b) => b.id);

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;

  return createInitialState({
    scenarioId: 'piracy',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships: [
      // "The Patrol starts with a Dreadnaught and a Corsair on Luna."
      landed(
        {
          id: 'patrol-dreadnaught',
          owner: PATROL,
          shipClass: 'dreadnaught',
          number: 1,
          name: 'Argus',
        },
        sideOf(map, 'luna', 0),
      ),
      landed(
        { id: 'patrol-corsair', owner: PATROL, shipClass: 'corsair', number: 2, name: 'Sentinel' },
        sideOf(map, 'luna', 3),
      ),
      // "The Merchant starts with two Transports on Terra, and announces their
      // first destinations."
      landed(
        { id: 'merchant-transport-1', owner: MERCHANTS, shipClass: 'transport', number: 3 },
        sideOf(map, 'terra', 1),
      ),
      landed(
        { id: 'merchant-transport-2', owner: MERCHANTS, shipClass: 'transport', number: 4 },
        sideOf(map, 'terra', 4),
      ),
      // "The Pirates start with two Corsairs on Clandestine."
      atAsteroidBase(
        { id: 'pirate-corsair-1', owner: PIRATES, shipClass: 'corsair', number: 5 },
        map.body('clandestine')!.hex,
      ),
      atAsteroidBase(
        { id: 'pirate-corsair-2', owner: PIRATES, shipClass: 'corsair', number: 6 },
        map.body('clandestine')!.hex,
      ),
    ],
    bases: buildBases(map, {
      // The civilised System answers to the Patrol; merchant ships use those
      // bases through the alliance.
      defaultOwner: PATROL,
      owners: {
        clandestine: PIRATES,
        // "The Pirates... may buy new ships on Ganymede", so Ganymede is a port
        // that asks no questions. So is rowdy Ceres.
        ganymede: null,
        ceres: null,
      },
    }),
    options: {
      // "the Patrol and Merchant players must be willing to ignore undetected
      // pirate ships until they are legally detected" — so hide them properly.
      fogOfWar: true,
      ...opts.options,
    },
    scenarioData: {
      piracy: {
        patrol: {
          /** "The Patrol earns points equal to the combat strength of destroyed pirate ships." */
          pointsPerPirateCombatStrength: 1,
          /** "2 points for every point of combat strength." */
          shipCostPerCombatStrength: 2,
          purchaseAt: 'luna',
          /** "must first return them to Luna for repair and refit." */
          prizeRefitAt: 'luna',
          circuits: {
            inner: ['terra', 'mars', 'venus', 'mercury'],
            outer: ['callisto', 'io', 'ganymede'],
            /** "Circuits do not have to land at each world, but must pass within 2 hexes." */
            passWithin: 2,
          },
        },
        merchants: {
          pointsPerDelivery: 2,
          pointsLostPerShipLost: 4,
          purchaseAt: 'terra',
          shipPrices: { transport: 8, packet: 12 },
        },
        pirates: {
          pointsPerLootedShip: 2,
          shipCostPerCombatStrength: 2,
          purchaseAt: 'ganymede',
          prizeRefitAt: 'clandestine',
          /** "or by scoring 8 points in a single trade cycle." */
          cycleTarget: 8,
        },
        inhabitedWorlds: inhabitedWorlds(),
        /** Worlds that have already received a cargo in the current cycle. */
        cycleDeliveries: [],
        /** Points the pirates have scored inside the current trade cycle. */
        pirateCyclePoints: 0,
      },
      // "The Patrol may buy new ships on Luna"; the Merchant on Terra; the
      // Pirates on Ganymede. Everything in this scenario is bought with points,
      // so the MegaCredit catalogue stays shut.
      purchasableClasses: [
        'transport',
        'packet',
        'tanker',
        'liner',
        'corvette',
        'corsair',
        'frigate',
        'dreadnaught',
      ],
    },
  });
};

const piracyData = (state: GameState): Record<string, unknown> =>
  (state.scenarioData['piracy'] ?? {}) as Record<string, unknown>;

const checkVictory = (state: GameState): VictoryState | null => {
  const patrolShips = ownedShips(state, PATROL).length;
  const merchantShips = ownedShips(state, MERCHANTS).length;
  const pirateShips = ownedShips(state, PIRATES).length;

  // "The Pirates may win either by wiping out either of the other fleets, or by
  // scoring 8 points in a single trade cycle."
  const pirateData = piracyData(state)['pirates'] as { cycleTarget?: number } | undefined;
  const cycleTarget = pirateData?.cycleTarget ?? 8;
  const cyclePoints = Number(piracyData(state)['pirateCyclePoints'] ?? 0);
  if (pirateShips > 0 && cyclePoints >= cycleTarget) {
    return victory(
      [PIRATES],
      'decisive',
      `The pirates took ${cyclePoints} points inside a single trade cycle.`,
    );
  }
  if (pirateShips > 0 && patrolShips === 0) {
    return victory([PIRATES], 'decisive', 'The Patrol has been wiped out.');
  }
  if (pirateShips > 0 && merchantShips === 0) {
    return victory([PIRATES], 'decisive', 'The merchant fleet has been wiped out.');
  }

  // "If the Patrol destroys the pirate fleet, it wins; the Merchant also wins at
  // that time if they have at least 4 ships."
  if (pirateShips === 0) {
    return merchantShips >= 4
      ? victory(
          [PATROL, MERCHANTS],
          'decisive',
          'The pirate fleet is destroyed and trade is thriving.',
        )
      : victory([PATROL], 'decisive', 'The pirate fleet is destroyed.');
  }

  // "If the Merchant fleet reaches 6 ships, or twice as many as the Pirate has
  // (whichever is greater), the Merchant wins. The Patrol also wins a marginal
  // victory if the Merchant wins."
  const threshold = Math.max(6, pirateShips * 2);
  if (merchantShips >= threshold) {
    return victory(
      [MERCHANTS, PATROL],
      'marginal',
      `The merchant fleet has grown to ${merchantShips} hulls; commerce has outrun piracy.`,
    );
  }

  return null;
};

export const piracy: ScenarioDef = {
  id: 'piracy',
  name: 'Piracy',
  blurb: 'Patrol, Merchants and Pirates fight over the System’s trade lanes.',
  description:
    'The System’s growing economy is threatened by pirates striking from their secret ' +
    'base in the asteroid belt. The Patrol opens with a dreadnaught and a corsair on ' +
    'Luna and must fly pre-plotted circuits until a pirate shows itself; the Merchants ' +
    'run cargoes between the inhabited worlds in cycles; the Pirates work out of ' +
    'Clandestine, looting what they can and selling prizes. Everything is bought with ' +
    'combat-strength points earned in play.',
  players: { min: 3, max: 3 },
  length: 'long',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'For this scenario to work, the Patrol and Merchant players must be willing to ignore undetected pirate ships until they are legally detected.',
    'The Patrol pre-plots circuits in the Inner System (Terra, Mars, Venus, Mercury) and the Outer System (Callisto, Io, Ganymede). Circuits need not land at each world but must pass within 2 hexes. The Patrol may not leave its circuits until a pirate is detected, and must return to them once no pirates are visible; it may modify its circuits at any time while no pirate is detected.',
    'The Patrol earns points equal to the combat strength of destroyed pirate ships, and buys new ships on Luna at 2 points per point of combat strength. Captured ships must first return to Luna for repair and refit; a recaptured merchant ship goes back to the Merchant, who must return it to Terra before it carries more cargo.',
    'The Merchant earns 2 points per cargo delivered and loses 4 when a merchant ship is captured or destroyed. New ships on Terra: 8 points for a transport, 12 for a packet.',
    'Cargo is delivered in cycles: once a planet has received a cargo it may not get another until all worlds have received one. The destination must be announced at take-off, and no points are scored for a world already visited this cycle. Exception: Terra may always receive a cargo from any other world.',
    'The Pirates earn 2 points per merchant ship looted and buy new ships on Ganymede at 2 points per point of combat strength. Captured ships must first return to Clandestine for repair and refit.',
    'Victory: the Patrol wins by destroying the pirate fleet (the Merchant wins too if it has at least 4 ships). The Merchant wins on reaching 6 ships, or twice the Pirate’s count, whichever is greater — a marginal win for the Patrol as well. The Pirates win by wiping out either fleet, or by scoring 8 points in a single trade cycle.',
  ],
};
