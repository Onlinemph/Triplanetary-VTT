/**
 * Interplanetary War — "A long two-player scenario".
 *
 * Rulebook p. 12:
 *
 *   "The Terran colonies have labored under the seeming yoke of oppression and
 *    now are rising to declare themselves equals to Mother Terra...
 *
 *    Ships: The Terran player selects a fleet using the MegaCredit system and an
 *    allowance of MCr 1600... Terran ships may be placed on – or in orbit around –
 *    Terra, Luna, and Venus, or stationary in space within detector range of
 *    those worlds.
 *
 *    The Rebel player selects a fleet using an allowance of MCr 1000... Rebel
 *    ships may be placed on – or in orbit around – Callisto (the Rebel home
 *    world), Io, Ganymede, and Mars, or stationary in space within detector range
 *    of those worlds.
 *
 *    In addition to ships, mines, torpedoes, and nukes may be purchased by the
 *    players and stockpiled on ships or on bases... Fuel is available free at
 *    bases. Each player controls bases which can produce replacement spacecraft
 *    and ordnance. Each base generates MCr 0.1 per turn...
 *
 *    Planets may not be captured, but bases may be destroyed by detonating nukes
 *    on their hexsides. If all bases on a planet are destroyed, all MCr on the
 *    planet are also destroyed.
 *
 *    Victory: The Terran player wins decisively if the Rebel fleet is destroyed.
 *    That victory is reduced to marginal if any Terran hexside has been
 *    devastated. The Rebel player wins if three or more Terran hexsides and one
 *    Luna Hexside have been devastated."
 */

import type { HexSide } from '@engine/hex.js';
import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { CARGO, SHIP_CLASSES, type CargoKind, type ShipClass } from '@engine/ships.js';
import { createInitialState } from '@engine/state.js';
import {
  type CargoItem,
  type GameState,
  type PlayerId,
  type Ship,
  type VictoryState,
  activePlayer,
} from '@engine/types.js';
import {
  type PlayerSpec,
  baseSidesOf,
  buildBases,
  buildPlayers,
  hold,
  inOrbit,
  landed,
  ownedShips,
  seedOf,
  sidesOnBody,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const TERRA: PlayerId = 'terra';
const REBELS: PlayerId = 'rebels';

const SPECS: readonly PlayerSpec[] = [
  { id: TERRA, faction: 'Terra', color: '#3f7fd0', name: 'Mother Terra' },
  { id: REBELS, faction: 'Colonial Rebels', color: '#b83b3b', name: 'Colonial Rebels' },
];

export const TERRAN_ALLOWANCE = 1600;
export const REBEL_ALLOWANCE = 1000;

/** "Each base generates MCr 0.1 per turn." */
export const BASE_INCOME_PER_TURN = 0.1;

const REBEL_WIN_TERRAN_SIDES = 3;
const REBEL_WIN_LUNA_SIDES = 1;

interface FleetEntry {
  readonly shipClass: ShipClass;
  readonly count: number;
  /** Ordnance loaded into the first `count` hulls of this type, hull by hull. */
  readonly loads?: readonly Partial<Record<CargoKind, number>>[];
}

/**
 * A legal default spend of MCr 1600.
 *
 *   dreadnaught 600 + 2 frigates 300 + 4 corsairs 320 + 5 corvettes 200
 *   + 2 packets 40 + 2 transports 20 + tanker 10        = MCr 1490
 *   3 torpedoes 60 + 5 mines 50                          = MCr  110
 *                                                        --------------
 *                                                          MCr 1600
 */
const TERRAN_FLEET: readonly FleetEntry[] = [
  { shipClass: 'dreadnaught', count: 1, loads: [{ torpedo: 2, mine: 1 }] },
  { shipClass: 'frigate', count: 2, loads: [{ torpedo: 1, mine: 2 }, { mine: 2 }] },
  { shipClass: 'corsair', count: 4 },
  { shipClass: 'corvette', count: 5 },
  { shipClass: 'packet', count: 2 },
  { shipClass: 'transport', count: 2 },
  { shipClass: 'tanker', count: 1 },
];

/**
 * A legal default spend of MCr 1000.
 *
 *   frigate 150 + 3 corsairs 240 + 5 corvettes 200 + 2 packets 40
 *   + 2 transports 20 + tanker 10                       = MCr  660
 *   1 nuke 300 + 2 torpedoes 40                          = MCr  340
 *                                                        --------------
 *                                                          MCr 1000
 *
 * The single nuke is the point: the Rebel victory condition is written in
 * devastated hexsides, and nothing else devastates one.
 */
const REBEL_FLEET: readonly FleetEntry[] = [
  { shipClass: 'frigate', count: 1, loads: [{ nuke: 1, torpedo: 1 }] },
  { shipClass: 'corsair', count: 3 },
  { shipClass: 'corvette', count: 5 },
  { shipClass: 'packet', count: 2, loads: [{ torpedo: 1 }, {}] },
  { shipClass: 'transport', count: 2 },
  { shipClass: 'tanker', count: 1 },
];

export const fleetCost = (fleet: readonly FleetEntry[]): number => {
  let total = 0;
  for (const entry of fleet) {
    total += SHIP_CLASSES[entry.shipClass].cost * entry.count;
    for (const load of entry.loads ?? []) {
      for (const kind of Object.keys(load) as CargoKind[]) {
        total += (CARGO[kind].cost ?? 0) * (load[kind] ?? 0);
      }
    }
  }
  return total;
};

/** Flagship classes start in orbit over their home world; the rest are on the ground. */
const ORBITS_AT_START: ReadonlySet<ShipClass> = new Set<ShipClass>(['dreadnaught', 'frigate']);

const buildFleet = (
  map: GameMap,
  owner: PlayerId,
  fleet: readonly FleetEntry[],
  worlds: readonly string[],
  startNumber: number,
): Ship[] => {
  const sites: { world: string; side: HexSide }[] = [];
  for (const world of worlds) {
    for (const side of baseSidesOf(map, world)) sites.push({ world, side });
  }

  const ships: Ship[] = [];
  let n = startNumber;
  let orbitIndex = 0;

  for (const entry of fleet) {
    for (let i = 0; i < entry.count; i++) {
      const cargo: CargoItem[] = hold(entry.loads?.[i] ?? {});
      const o = {
        id: `${owner}-${entry.shipClass}-${i + 1}`,
        owner,
        shipClass: entry.shipClass,
        number: n,
        cargo,
      };
      if (ORBITS_AT_START.has(entry.shipClass)) {
        const world = worlds[orbitIndex % worlds.length]!;
        orbitIndex += 1;
        const side = baseSidesOf(map, world)[0];
        ships.push(inOrbit(o, map, world, side?.dir ?? 0));
      } else {
        const site = sites[n % Math.max(1, sites.length)]!;
        ships.push(landed(o, site.side));
      }
      n += 1;
    }
  }
  return ships;
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;

  const terranWorlds = ['terra', 'luna', 'venus'];
  const rebelWorlds = ['callisto', 'io', 'ganymede', 'mars'];

  const ships = [
    ...buildFleet(map, TERRA, TERRAN_FLEET, terranWorlds, 1),
    ...buildFleet(map, REBELS, REBEL_FLEET, rebelWorlds, 100),
  ];

  return createInitialState({
    scenarioId: 'interplanetary-war',
    seed: seedOf(opts),
    players: buildPlayers(
      // The allowances are spent on the fleets above, so both treasuries open empty.
      SPECS.map((s) => ({ ...s, megacredits: 0 })),
      opts,
    ),
    ships,
    bases: buildBases(map, {
      owners: {
        terra: TERRA,
        luna: TERRA,
        venus: TERRA,
        callisto: REBELS,
        io: REBELS,
        ganymede: REBELS,
        mars: REBELS,
        // Mercury, Ceres and Clandestine take no side in this war.
        mercury: null,
        ceres: null,
        clandestine: null,
      },
    }),
    options: {
      // "mines, torpedoes, and nukes may be purchased by the players."
      nukesAllowed: true,
      ...opts.options,
    },
    scenarioData: {
      // "Ships appear immediately on any world controlled by the player" —
      // Mercury, Ceres and Clandestine are nobody's shipyard here.
      purchaseRequiresControl: true,
      interplanetaryWar: {
        allowance: { [TERRA]: TERRAN_ALLOWANCE, [REBELS]: REBEL_ALLOWANCE },
        defaultFleets: { [TERRA]: TERRAN_FLEET, [REBELS]: REBEL_FLEET },
        defaultFleetCost: {
          [TERRA]: fleetCost(TERRAN_FLEET),
          [REBELS]: fleetCost(REBEL_FLEET),
        },
        placement: { [TERRA]: terranWorlds, [REBELS]: rebelWorlds },
        baseIncomePerTurn: BASE_INCOME_PER_TURN,
        /**
         * "The Terran player must physically transport all MCr to Terra before
         * they may be used. Further, they may only be transported in commercial
         * ships; each MCr requires one ton of cargo space."
         */
        terranCreditsMustBeShipped: true,
        creditsMassPerMCr: CARGO.megacredits.mass,
        rebelCreditsAreTransmitted: true,
        victoryThresholds: {
          terranSidesForRebelWin: REBEL_WIN_TERRAN_SIDES,
          lunaSidesForRebelWin: REBEL_WIN_LUNA_SIDES,
        },
      },
    },
  });
};

/**
 * "Each player controls bases which can produce replacement spacecraft and
 * ordnance. Each base generates MCr 0.1 per turn."
 *
 * Booked as each player's own player-turn closes, so every base pays its owner
 * exactly once a game turn. The Rebels "can use and spend their MCr freely; they
 * are considered transmitted to Callisto without problem"; the Terran player's
 * obligation to ship theirs home is recorded in `scenarioData` and is not
 * modelled (see docs/RULES-MAPPING.md).
 */
const endPlayerTurn = (state: GameState): GameState => {
  const player = activePlayer(state);
  const bases = Object.values(state.bases).filter((b) => !b.destroyed && b.owner === player);
  if (bases.length === 0) return state;
  const purse = state.players[player];
  if (!purse) return state;
  const income = Math.round(bases.length * BASE_INCOME_PER_TURN * 1000) / 1000;
  return {
    ...state,
    players: {
      ...state.players,
      [player]: {
        ...purse,
        megacredits: Math.round((purse.megacredits + income) * 1000) / 1000,
      },
    },
  };
};

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const terranSides = sidesOnBody(map, 'terra', state.devastatedSides).length;
  const lunaSides = sidesOnBody(map, 'luna', state.devastatedSides).length;

  // "The Rebel player wins if three or more Terran hexsides and one Luna Hexside
  // have been devastated."
  if (terranSides >= REBEL_WIN_TERRAN_SIDES && lunaSides >= REBEL_WIN_LUNA_SIDES) {
    return victory(
      [REBELS],
      'decisive',
      `${terranSides} Terran hexsides and ${lunaSides} on Luna lie devastated. Mother Terra is broken.`,
    );
  }

  // "The Terran player wins decisively if the Rebel fleet is destroyed. That
  // victory is reduced to marginal if any Terran hexside has been devastated."
  if (ownedShips(state, REBELS).length === 0) {
    return terranSides > 0
      ? victory(
          [TERRA],
          'marginal',
          `The rebel fleet is destroyed, but ${terranSides} Terran hexside(s) were devastated first.`,
        )
      : victory([TERRA], 'decisive', 'The rebel fleet is destroyed and Terra is untouched.');
  }

  return null;
};

export const interplanetaryWar: ScenarioDef = {
  id: 'interplanetary-war',
  name: 'Interplanetary War',
  blurb: 'MCr 1600 of Terran fleet against MCr 1000 of colonial rebellion.',
  description:
    'The Terran colonies have laboured under the seeming yoke of oppression and now ' +
    'are rising to declare themselves equals to Mother Terra. The exhausted home ' +
    'world, after giving the best metals from her breast and the prime of humanity ' +
    'from her womb, sees this as an impertinence of the worst sort. Terra fields MCr ' +
    '1600 from Terra, Luna and Venus; the Rebels MCr 1000 from Callisto, Io, Ganymede ' +
    'and Mars. Bases pay MCr 0.1 a turn, and only nukes can settle it.',
  players: { min: 2, max: 2 },
  length: 'long',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  endPlayerTurn,
  specialRules: [
    'Terran ships may be placed on — or in orbit around — Terra, Luna and Venus, or stationary in space within detector range of those worlds. Rebel ships likewise at Callisto (the Rebel home world), Io, Ganymede and Mars.',
    'In addition to ships, mines, torpedoes and nukes may be purchased and stockpiled on ships or on bases. These stockpiles must be noted. Fuel is free at bases.',
    'Each base generates MCr 0.1 per turn. Ships appear immediately on any world controlled by the player.',
    'The Rebels may use and spend their MCr freely; they are considered transmitted to Callisto without problem. The Terran player must physically transport all MCr to Terra before they may be used, and only in commercial ships — each MCr requires one ton of cargo space.',
    'Planets may not be captured, but bases may be destroyed by detonating nukes on their hexsides. If all bases on a planet are destroyed, all MCr on the planet are also destroyed.',
    'Victory: Terra wins decisively if the Rebel fleet is destroyed, reduced to marginal if any Terran hexside has been devastated. The Rebel wins if three or more Terran hexsides and one Luna hexside have been devastated.',
  ],
};
