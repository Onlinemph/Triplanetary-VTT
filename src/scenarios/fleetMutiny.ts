/**
 * Fleet Mutiny — "A short two-player scenario".
 *
 * Rulebook p. 12:
 *
 *   "There are two versions of this historical incident. The official account
 *    states briefly that a few dissident officers, misled by a maniac, attempted
 *    and failed an insurrection in which certain fleet elements were to hold
 *    Terran cities for ransom. The unofficial account is somewhat different...
 *
 *    Ships: The Empire chooses a fleet of 12 ships and 2 orbital bases (using
 *    red, white, and blue counters). These may be placed anywhere on the map, but
 *    no ship may be closer than three hexes to any other. Vessels in gravity
 *    hexes may be assumed to be in orbit, and the direction of their orbits
 *    indicated.
 *
 *    Special Rules: All bases begin under the control of the Empire. Planetary
 *    defenses are not in operation.
 *
 *    The Rebel player designates five ships and/or orbital bases, and rolls a die
 *    for each one. On a roll of 6, the ship does not rebel. Otherwise it becomes
 *    part of the starting Rebel force.
 *
 *    Planetary hexsides may be suppressed for the remainder of the game by
 *    gunfire from a ship orbiting overhead... A planetary base is captured if an
 *    enemy warship lands there while no friendly warship is present.
 *
 *    Victory: The Empire wins decisively if all Rebel ships and bases are
 *    eliminated and fewer than three Terran hexsides have been suppressed. The
 *    win is marginal if exactly three Terran hexsides have been suppressed. The
 *    Rebel wins decisively by suppressing at least four Terran hexsides, and
 *    loses otherwise."
 */

import { suppressedSides } from '@engine/combat.js';
import type { Hex } from '@engine/hex.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { createRng, rollDie, shuffle } from '@engine/rng.js';
import type { ShipClass } from '@engine/ships.js';
import { createInitialState } from '@engine/state.js';
import type { BaseState, GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  buildBases,
  buildPlayers,
  inSpace,
  orbitAtHex,
  ownedShips,
  pickSpaced,
  seedOf,
  sidesOnBody,
  sitesAround,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const EMPIRE: PlayerId = 'empire';
const REBELS: PlayerId = 'rebels';

const SPECS: readonly PlayerSpec[] = [
  { id: EMPIRE, faction: 'Empire', color: '#3f7fd0', name: 'Empire' },
  { id: REBELS, faction: 'Rebels', color: '#b83b3b', name: 'Rebels' },
];

/** "a fleet of 12 ships and 2 orbital bases". */
const IMPERIAL_FLEET: readonly ShipClass[] = [
  'dreadnaught',
  'frigate',
  'frigate',
  'corsair',
  'corsair',
  'corsair',
  'corvette',
  'corvette',
  'corvette',
  'corvette',
  'packet',
  'transport',
];

const ORBITAL_BASES = 2;
const SUBORNED = 5;
const REBEL_WIN_HEXSIDES = 4;
const EMPIRE_MARGINAL_HEXSIDES = 3;

/** The worlds the incident is fought over; the fleet is stationed among them. */
const STATIONS: readonly string[] = [
  'terra',
  'luna',
  'venus',
  'mars',
  'mercury',
  'ceres',
  'io',
  'ganymede',
  'callisto',
];

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  let rng = createRng(seedOf(opts));

  // "These may be placed anywhere on the map, but no ship may be closer than
  // three hexes to any other."
  const stations = sitesAround(map, STATIONS, 5);

  // The orbital bases go first, and only into gravity hexes: "In a gravity hex of
  // a planet or satellite... The base remains in that gravity hex; it does not
  // literally orbit." The hulls are then spaced against the bases as well as
  // against each other.
  const basePick = pickSpaced(
    rng,
    stations.filter((h) => map.gravityAt(h).length > 0),
    ORBITAL_BASES,
    3,
  );
  rng = basePick.rng;
  const baseSites = basePick.hexes;

  const shipPick = pickSpaced(rng, stations, IMPERIAL_FLEET.length, 3, baseSites);
  rng = shipPick.rng;
  const sites = shipPick.hexes;

  const ships: Ship[] = [];
  const orbitalBases: { id: string; owner: PlayerId; hex: Hex }[] = [];

  const station = (
    o: {
      id: string;
      owner: PlayerId;
      shipClass: ShipClass;
      number: number;
    },
    at: Hex,
  ): Ship =>
    // "Vessels in gravity hexes may be assumed to be in orbit."
    orbitAtHex(o, map, at) ?? inSpace(o, at);

  IMPERIAL_FLEET.forEach((cls, i) => {
    const at = sites[i] ?? map.body('terra')!.hex;
    ships.push(
      station({ id: `empire-${cls}-${i + 1}`, owner: EMPIRE, shipClass: cls, number: i + 1 }, at),
    );
  });

  for (let i = 0; i < ORBITAL_BASES; i++) {
    const at = baseSites[i]!;
    const id = `empire-orbital-${i + 1}`;
    // An orbital base is both a counter that fights and a base that resupplies,
    // so it is seeded as both: the ship carries its combat strength of 16, the
    // `BaseState` carries its fuel and ordnance stores. It is *not* put in orbit
    // like the hulls above — "The base remains in that gravity hex; it does not
    // literally orbit" — because a counter that drifts away from its own
    // `BaseState` breaks the pairing the p. 8 resupply/fire lockout depends on.
    ships.push(inSpace({ id, owner: EMPIRE, shipClass: 'orbitalBase', number: 90 + i }, at));
    orbitalBases.push({ id, owner: EMPIRE, hex: at });
  }

  // "The Rebel player designates five ships and/or orbital bases, and rolls a die
  // for each one. On a roll of 6, the ship does not rebel."
  const draw = shuffle(
    rng,
    ships.map((s) => s.id),
  );
  rng = draw.state;
  const designated = draw.items.slice(0, SUBORNED);
  const rebelIds: string[] = [];
  const loyalIds: string[] = [];
  for (const id of designated) {
    const roll = rollDie(rng);
    rng = roll.state;
    if (roll.value === 6) loyalIds.push(id);
    else rebelIds.push(id);
  }

  const rebelSet = new Set(rebelIds);
  const crewed: Ship[] = ships.map((s) => (rebelSet.has(s.id) ? { ...s, owner: REBELS } : s));

  const bases: BaseState[] = buildBases(map, {
    // "All bases begin under the control of the Empire."
    defaultOwner: EMPIRE,
    // "Planetary defenses are not in operation."
    defences: 'none',
    orbital: orbitalBases.map((b) => ({
      ...b,
      owner: rebelSet.has(b.id) ? REBELS : EMPIRE,
    })),
  });

  return createInitialState({
    scenarioId: 'fleet-mutiny',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships: crewed,
    bases,
    options: opts.options ?? {},
    scenarioData: {
      // "A planetary base is captured if an enemy warship lands there while no
      // friendly warship is present."
      baseCaptureByLanding: true,
      fleetMutiny: {
        imperialFleet: IMPERIAL_FLEET,
        orbitalBases: ORBITAL_BASES,
        /** Rebuilding the fleet is a placement exercise, not a purchase. */
        allowance: { ships: IMPERIAL_FLEET.length, orbitalBases: ORBITAL_BASES },
        minimumSeparation: 3,
        designated,
        suborned: rebelIds,
        stayedLoyal: loyalIds,
        rebelWinHexsides: REBEL_WIN_HEXSIDES,
        empireMarginalHexsides: EMPIRE_MARGINAL_HEXSIDES,
      },
    },
  });
};

/** Every rebel asset still in the game: hulls, orbital bases, captured bases. */
const rebelAssets = (state: GameState): number => {
  const ships = ownedShips(state, REBELS).length;
  const bases = Object.values(state.bases).filter((b) => b.owner === REBELS && !b.destroyed).length;
  return ships + bases;
};

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const terranSuppressed = sidesOnBody(map, 'terra', suppressedSides(state)).length;

  // "The Rebel wins decisively by suppressing at least four Terran hexsides."
  if (terranSuppressed >= REBEL_WIN_HEXSIDES) {
    return victory(
      [REBELS],
      'decisive',
      `${terranSuppressed} Terran hexsides lie under rebel guns; the cities have been ransomed.`,
    );
  }

  // "The Empire wins decisively if all Rebel ships and bases are eliminated and
  // fewer than three Terran hexsides have been suppressed. The win is marginal if
  // exactly three Terran hexsides have been suppressed."
  if (rebelAssets(state) === 0) {
    return terranSuppressed >= EMPIRE_MARGINAL_HEXSIDES
      ? victory(
          [EMPIRE],
          'marginal',
          `The mutiny is broken, but ${terranSuppressed} Terran hexsides were suppressed first.`,
        )
      : victory([EMPIRE], 'decisive', 'The mutiny is broken and Terra was barely touched.');
  }

  return null;
};

export const fleetMutiny: ScenarioDef = {
  id: 'fleet-mutiny',
  name: 'Fleet Mutiny',
  blurb: 'Five Imperial units are suborned; Terra’s hexsides are the prize.',
  description:
    'The official account states briefly that a few dissident officers, misled by a ' +
    'maniac, attempted and failed an insurrection in which certain fleet elements were ' +
    'to hold Terran cities for ransom. The unofficial account is somewhat different. ' +
    'The Empire deploys twelve ships and two orbital bases, no two closer than three ' +
    'hexes; the Rebel picks five of them and rolls to see which actually mutiny.',
  players: { min: 2, max: 2 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'The Empire chooses 12 ships and 2 orbital bases and may place them anywhere on the map, but no ship may be closer than three hexes to any other. Vessels in gravity hexes may be assumed to be in orbit, and the direction of their orbits indicated.',
    'All bases begin under the control of the Empire. Planetary defences are not in operation.',
    'The Rebel designates five ships and/or orbital bases and rolls a die for each. On a 6 the unit stays loyal; otherwise it joins the Rebels.',
    'Planetary hexsides may be suppressed for the remainder of the game by gunfire from a ship orbiting overhead. A ship suppressing a hexside may not fire at other targets that turn, and suppression is automatic if it fires. The base on a suppressed hexside is not affected.',
    'A planetary base is captured if an enemy warship lands there while no friendly warship is present.',
    'Victory: the Empire wins decisively if all Rebel ships and bases are eliminated and fewer than three Terran hexsides have been suppressed, marginally if exactly three. The Rebel wins decisively by suppressing at least four Terran hexsides, and loses otherwise.',
    'Variant: increase or decrease the size of the fleet, and place its elements inverted so their identities are concealed from the Rebel player.',
  ],
};
