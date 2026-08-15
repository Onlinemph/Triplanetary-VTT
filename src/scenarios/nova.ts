/**
 * Nova — "A short three-player scenario".
 *
 * Rulebook p. 11:
 *
 *   "The players represent the American-dominated WestBloc, the Russian-dominated
 *    EastBloc, and the Alien attackers.
 *
 *    Ships: Both the EastBloc and the WestBloc players select fleets of 50 combat
 *    points each... The Alien invader receives a fleet of four corsairs.
 *
 *    Special Rules: EastBloc and WestBloc must roll dice to determine where their
 *    colonies are and decide which parts of Terra they rule. The EastBloc selects
 *    three adjacent Terran hexsides; the WestBloc gets the other three. The
 *    WestBloc then selects one Luna hex side as a moon colony; the EastBloc then
 *    selects any other Luna hex side as its moon colony. Finally, each side rolls
 *    one die to determine where their farther colony is located: 1=Venus, 2=Mars,
 *    3=Ceres, 4=Callisto, 5=Clandestine, and 6=Mercury. The colony has only one
 *    base; if it is a world, the owner specifies the hex side. If both sides roll
 *    the same number, both roll again.
 *
 *    After all EastBloc and WestBloc ships have been placed on friendly bases,
 *    the Alien enters the map with its four corsairs; they may enter at any point
 *    along the map edge closest to Jupiter at a speed of one hex per turn. They
 *    are detected immediately.
 *
 *    The Alien ships are AI-piloted remnants of an ancient fleet. Each one carries
 *    a nova bomb and automatically activates it if it reaches orbit around Sol...
 *    Alien ships begin with a full load of mines but cannot resupply or refuel."
 */

import { DEFAULT_MAP } from '@engine/map.js';
import { createRng, rollDie } from '@engine/rng.js';
import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';
import { createInitialState } from '@engine/state.js';
import type { BaseState, GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  atAsteroidBase,
  buildBases,
  buildPlayers,
  combatPointCost,
  edgeToward,
  hold,
  inSpace,
  landed,
  rollDistinct,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const WEST: PlayerId = 'westbloc';
const EAST: PlayerId = 'eastbloc';
const ALIEN: PlayerId = 'alien';

const SPECS: readonly PlayerSpec[] = [
  { id: WEST, faction: 'WestBloc', color: '#3f7fd0', name: 'WestBloc' },
  { id: EAST, faction: 'EastBloc', color: '#c0392b', name: 'EastBloc' },
  { id: ALIEN, faction: 'Aliens', color: '#1b1b1b', name: 'Alien Invader' },
];

export const COMBAT_POINT_ALLOWANCE = 50;

/** A default 50-point fleet for each bloc; a buy screen may rebuild either one. */
const WEST_FLEET: readonly ShipClass[] = [
  'dreadnaught', // 15
  'frigate',
  'frigate', // 16 -> 31
  'corsair',
  'corsair',
  'corsair', // 12 -> 43
  'corvette',
  'corvette',
  'corvette', // 6 -> 49
  'liner', // 1 -> 50
];

const EAST_FLEET: readonly ShipClass[] = [
  'frigate',
  'frigate', // 16
  'corsair',
  'corsair',
  'corsair',
  'corsair', // 16 -> 32
  'corvette',
  'corvette',
  'corvette',
  'corvette',
  'corvette',
  'corvette',
  'corvette',
  'corvette', // 16 -> 48
  'packet', // 2 -> 50
];

/** "1=Venus, 2=Mars, 3=Ceres, 4=Callisto, 5=Clandestine, and 6=Mercury." */
const COLONY_TABLE: readonly string[] = [
  'venus',
  'mars',
  'ceres',
  'callisto',
  'clandestine',
  'mercury',
];

/** The one hexside a bloc's farther colony occupies, when the colony is a world. */
const COLONY_SIDE: Readonly<Record<string, number>> = {
  venus: 0,
  mars: 0,
  callisto: 1, // Callisto's only printed base
  mercury: 0,
};

interface Colony {
  readonly bodyId: string;
  /** Base id: `"mars:0"` for a world, `"ceres"` for an asteroid. */
  readonly baseId: string;
}

const colonyFor = (bodyId: string): Colony => {
  const side = COLONY_SIDE[bodyId];
  return { bodyId, baseId: side === undefined ? bodyId : `${bodyId}:${side}` };
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const seed = seedOf(opts);

  // "each side rolls one die to determine where their farther colony is located...
  // If both sides roll the same number, both roll again."
  const draw = rollDistinct(createRng(seed), 2, rollDie);
  const westColony = colonyFor(COLONY_TABLE[(draw.values[0]! - 1) % 6] ?? 'venus');
  const eastColony = colonyFor(COLONY_TABLE[(draw.values[1]! - 1) % 6] ?? 'mars');

  // "The EastBloc selects three adjacent Terran hexsides; the WestBloc gets the
  // other three." A default split; a setup screen may let the players choose.
  const sites: Record<string, PlayerId> = {
    'terra:0': EAST,
    'terra:1': EAST,
    'terra:2': EAST,
    'terra:3': WEST,
    'terra:4': WEST,
    'terra:5': WEST,
    // "The WestBloc then selects one Luna hex side as a moon colony; the EastBloc
    // then selects any other Luna hex side as its moon colony."
    'luna:0': WEST,
    'luna:3': EAST,
    [westColony.baseId]: WEST,
    [eastColony.baseId]: EAST,
  };

  const bases: BaseState[] = buildBases(map, {
    sites,
    // "All bases marked on the map are assumed to be in use unless a scenario
    // indicates differently." Nova says only that "The colony has only one
    // base", which fixes what each *bloc owns*, not what exists; and it never
    // switches defences off, unlike Escape ("Planetary defenses are not
    // operating"), Fleet Mutiny and Retribution, which say so in as many words.
    // The aliens are kept off the unclaimed bases by the rule that actually
    // says so: "Alien ships... cannot resupply or refuel."
  });

  const baseSidesOwnedBy = (owner: PlayerId): BaseState[] =>
    bases.filter((b) => b.owner === owner && !b.destroyed);

  const ships: Ship[] = [];
  let counter = 1;

  const placeFleet = (owner: PlayerId, fleet: readonly ShipClass[]): void => {
    const homes = baseSidesOwnedBy(owner);
    fleet.forEach((cls, i) => {
      const home = homes[i % Math.max(1, homes.length)]!;
      const o = { id: `${owner}-${cls}-${i + 1}`, owner, shipClass: cls, number: counter++ };
      ships.push(home.side ? landed(o, home.side) : atAsteroidBase(o, home.hex));
    });
  };

  placeFleet(WEST, WEST_FLEET);
  placeFleet(EAST, EAST_FLEET);

  // "they may enter at any point along the map edge closest to Jupiter at a speed
  // of one hex per turn."
  const jupiter = map.body('jupiter')!;
  const entry = edgeToward(map, jupiter.hex, 4);
  const alienIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = `alien-corsair-${i + 1}`;
    alienIds.push(id);
    const at = entry.hexes[i] ?? entry.hexes[0]!;
    const corsair = inSpace(
      {
        id,
        owner: ALIEN,
        shipClass: 'corsair',
        number: 900 + i,
        name: `Alien ${i + 1}`,
        // "Alien ships begin with a full load of mines" — a corsair's hold is
        // ten tons, which is exactly one mine.
        cargo: hold({ mine: 1 }),
      },
      at,
      entry.inward,
    );
    // "They are detected immediately."
    ships.push({ ...corsair, detectedBy: [WEST, EAST] });
  }

  return createInitialState({
    scenarioId: 'nova',
    seed,
    players: buildPlayers(SPECS, opts),
    ships,
    bases,
    options: {
      // The nova bomb is not an ordinary nuke and neither bloc may buy one.
      nukesAllowed: false,
      ...opts.options,
    },
    scenarioData: {
      // "note that aliens will not surrender."
      noSurrender: [ALIEN],
      combatPointAllowance: { [WEST]: COMBAT_POINT_ALLOWANCE, [EAST]: COMBAT_POINT_ALLOWANCE },
      combatPointCosts: Object.fromEntries(
        (Object.keys(SHIP_CLASSES) as ShipClass[]).map((c) => [c, combatPointCost(c)]),
      ),
      colonies: { [WEST]: westColony, [EAST]: eastColony },
      alienShips: alienIds,
      /** "Each one carries a nova bomb... Nova bombs do not use any cargo capacity." */
      novaBombs: alienIds,
      // "Alien ships begin with a full load of mines but cannot resupply or refuel."
      resupplyDeniedTo: [ALIEN],
      /**
       * "A human player may declare their bases to be friendly to the other
       * human, if they wish." Off until somebody says so; the interface can set
       * `Player.allies` when they do.
       */
      blocsAllied: false,
    },
  });
};

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const alienIds = (state.scenarioData['alienShips'] ?? []) as readonly string[];

  const aliens = alienIds.map((id) => state.ships[id]).filter((s): s is Ship => s !== undefined);

  // "The Alien force wins, permanently and decisively, by successfully activating
  // a nova bomb while in orbit around the sun." Each ship "automatically
  // activates it if it reaches orbit around Sol", so reaching that orbit *is*
  // the victory — no further action is needed or possible.
  for (const alien of aliens) {
    if (alien.destroyed || alien.capturedBy !== undefined) continue;
    if (map.orbitOf(alien.pos, alien.velocity)?.id === 'sol') {
      return victory(
        [ALIEN],
        'decisive',
        'A nova bomb has been activated in orbit around Sol. Every world will burn.',
      );
    }
  }

  // "The EastBloc or the WestBloc wins by capturing or destroying the last Alien
  // ship (note that aliens will not surrender)."
  const stillFlying = aliens.filter(
    (s) => !s.destroyed && s.capturedBy === undefined && s.owner === ALIEN,
  );
  if (aliens.length > 0 && stillFlying.length === 0) {
    // Variant, and the more interesting reading of the two: "a human decisive
    // victory goes only to a force that captures an Alien vessel and returns it
    // to a friendly base. Both human Blocs may therefore win." A prize that has
    // reached a friendly base has changed owner.
    const claimants = [WEST, EAST].filter((bloc) =>
      aliens.some((s) => !s.destroyed && s.owner === bloc),
    );
    if (claimants.length > 0) {
      return victory(
        claimants,
        'decisive',
        'The alien fleet is broken and a hull has been taken home for study.',
      );
    }
    return victory(
      [WEST, EAST],
      'marginal',
      'The last alien ship is destroyed. The System survives.',
    );
  }

  return null;
};

export const nova: ScenarioDef = {
  id: 'nova',
  name: 'Nova',
  blurb: 'Two Terran blocs and an ancient alien fleet carrying nova bombs.',
  description:
    'The players represent the American-dominated WestBloc, the Russian-dominated ' +
    'EastBloc, and the Alien attackers. Each bloc fields 50 combat points and holds ' +
    'three Terran hexsides, a Luna colony and one farther colony rolled at random. ' +
    'Four alien corsairs enter from the Jupiter edge at one hex per turn, each ' +
    'carrying a nova bomb that arms itself automatically the moment the ship reaches ' +
    'orbit around Sol. When one player wins, both others lose.',
  players: { min: 3, max: 3 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'Each bloc selects a fleet of 50 combat points. Commercial ships cost half their printed strength: a liner 1 point, a transport or tanker half a point.',
    'The EastBloc selects three adjacent Terran hexsides; the WestBloc gets the other three. The WestBloc then selects one Luna hexside, the EastBloc any other. Each side rolls a die for its farther colony: 1=Venus, 2=Mars, 3=Ceres, 4=Callisto, 5=Clandestine, 6=Mercury, rerolling ties. That colony has only one base.',
    'All bloc ships start on friendly bases. The Alien then enters with four corsairs at any point along the map edge closest to Jupiter, at one hex per turn. They are detected immediately.',
    'Each alien corsair carries a nova bomb, which uses no cargo capacity and activates automatically if the ship reaches orbit around Sol. Aliens start with a full load of mines but may never resupply or refuel, and will not surrender.',
    'Resupply is available at friendly bases. A human player may declare their bases friendly to the other human if they wish.',
    'Victory: a bloc wins by capturing or destroying the last alien ship — a ship counts as destroyed once it takes damage that must destroy it, e.g. it can no longer avoid leaving the map. The Aliens win permanently and decisively by activating a nova bomb in orbit around Sol.',
    'Variant: both blocs win marginal victories if all Aliens are destroyed, but a decisive human victory goes only to a force that captures an Alien vessel and returns it to a friendly base. Both blocs may therefore win.',
    'Variant: alter the size of the Alien fleet up or down depending on the relative success of previous play.',
  ],
};
