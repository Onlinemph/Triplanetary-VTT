/**
 * Retribution — "A medium-length two-player scenario".
 *
 * Rulebook pp. 11-12:
 *
 *   "The answer (as learned and forgotten by every generation since Adam) is not
 *    to run from the tyrant but to depose him...
 *
 *    Ships: The Enforcers receive two corsairs, each in orbit around a different
 *    planet selected by the player, and one frigate on a base at Luna. The Sons
 *    of Liberty receive a total of ten corvettes one at a time. A corvette does
 *    not appear until the previous one has accomplished its mission or been
 *    destroyed. Corvettes may appear at any base except Luna, Ceres, or Terra.
 *
 *    Special Rules: Corvettes for the Sons of Liberty may fly one of two
 *    missions: a flight to Clandestine to help build the Freedom Fleet, or a
 *    suicidal attack on Terra.
 *
 *    Each corvette which manages to crash into Terra (while not disabled)
 *    sufficiently scares the First Citizen that he reassigns one ship to the
 *    Terra Security Patrol... If three corvettes successfully crash into Terra,
 *    all three Enforcer ships must be withdrawn into Terran Security Patrol.
 *
 *    After all ten corvettes have appeared... all corvettes which have stopped at
 *    Clandestine may be converted into the Freedom Fleet. Total the combat
 *    strength of all corvettes at Clandestine, and double it...
 *
 *    The Enforcers have all bases on the map with the exception of Clandestine,
 *    but only the bases at Terra and Luna have planetary defenses."
 */

import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { rollDie } from '@engine/rng.js';
import { createInitialState, log } from '@engine/state.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  baseSidesOf,
  buildBases,
  buildPlayers,
  inOrbit,
  landed,
  ownedShips,
  seedOf,
  sideOf,
  templatesOf,
  turnsGrounded,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const ENFORCERS: PlayerId = 'enforcers';
const SONS: PlayerId = 'sons-of-liberty';

const SPECS: readonly PlayerSpec[] = [
  { id: ENFORCERS, faction: 'Enforcers', color: '#26262c', name: 'Enforcers' },
  { id: SONS, faction: 'Sons of Liberty', color: '#c8452f', name: 'Sons of Liberty' },
];

/** "If the Enforcers hide, keeping their ships grounded for 12 or more turns..." */
const HIDING_LIMIT = 12;

export const CORVETTE_ALLOWANCE = 10;

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;

  return createInitialState({
    scenarioId: 'retribution',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships: [
      // "two corsairs, each in orbit around a different planet selected by the
      // player" — Terra and Mars by default; a setup screen may move them.
      inOrbit(
        {
          id: 'enforcer-corsair-1',
          owner: ENFORCERS,
          shipClass: 'corsair',
          number: 1,
          name: 'Praetor',
        },
        map,
        'terra',
        0,
      ),
      inOrbit(
        {
          id: 'enforcer-corsair-2',
          owner: ENFORCERS,
          shipClass: 'corsair',
          number: 2,
          name: 'Lictor',
        },
        map,
        'mars',
        0,
      ),
      // "one frigate on a base at Luna."
      landed(
        {
          id: 'enforcer-frigate',
          owner: ENFORCERS,
          shipClass: 'frigate',
          number: 3,
          name: 'First Citizen',
        },
        sideOf(map, 'luna', 0),
      ),
      // The first of the ten. It is put in orbit above the base it rose from:
      // every base on the chart belongs to the Enforcers, so a rebel corvette
      // that appears at one has necessarily already lifted off.
      inOrbit(
        { id: 'sol-corvette-1', owner: SONS, shipClass: 'corvette', number: 4, name: 'Liberty 1' },
        map,
        'venus',
        0,
      ),
    ],
    bases: buildBases(map, {
      // "The Enforcers have all bases on the map with the exception of
      // Clandestine..."
      defaultOwner: ENFORCERS,
      owners: { clandestine: SONS },
      // "...but only the bases at Terra and Luna have planetary defenses."
      defences: ['terra', 'luna'],
    }),
    options: opts.options ?? {},
    scenarioData: {
      retribution: {
        corvettesTotal: CORVETTE_ALLOWANCE,
        corvettesAppeared: 1,
        /** "Corvettes may appear at any base except Luna, Ceres, or Terra." */
        spawnExcludes: ['luna', 'ceres', 'terra'],
        missions: ['clandestine', 'terra-strike'],
        /** Corvettes that have crashed into Terra while not disabled. */
        terraCrashes: 0,
        /** Enforcer ships pinned to the Terra Security Patrol, one per crash. */
        securityPatrol: [],
        freedomFleet: {
          formed: false,
          /** "Total the combat strength of all corvettes at Clandestine, and double it." */
          multiplier: 2,
          /** "Torches may be selected." */
          torchesAllowed: true,
        },
        hidingLimit: HIDING_LIMIT,
      },
      // "Torpedoes and mines are available only to the Enforcers, but also only
      // from Terran bases."
      ordnanceSources: { [ENFORCERS]: ['terra'] },
      ordnanceDeniedTo: [SONS],
    },
  });
};

interface RetributionData {
  corvettesTotal?: number;
  corvettesAppeared?: number;
  spawnExcludes?: readonly string[];
  freedomFleet?: { formed?: boolean };
}

const retributionData = (state: GameState): RetributionData =>
  (state.scenarioData['retribution'] ?? {}) as RetributionData;

const withRetributionData = (state: GameState, patch: RetributionData): GameState => ({
  ...state,
  scenarioData: {
    ...state.scenarioData,
    retribution: { ...retributionData(state), ...patch },
  },
});

/**
 * A corvette still flying its mission.
 *
 * "A corvette does not appear until the previous one has accomplished its
 * mission or been destroyed." The two missions are "a flight to Clandestine to
 * help build the Freedom Fleet, or a suicidal attack on Terra", so a corvette
 * that has stopped at Clandestine is done — it waits there to be counted into
 * the Freedom Fleet — and one that is destroyed (crashing into Terra included)
 * is done. Anything else is still out there.
 */
const stillFlying = (state: GameState, map: GameMap): Ship[] =>
  ownedShips(state, SONS).filter((s) => {
    if (s.shipClass !== 'corvette') return true;
    const atClandestine =
      s.location.kind === 'asteroidBase' && map.bodyAt(s.pos)?.id === 'clandestine';
    return !atClandestine;
  });

/**
 * Release the next corvette.
 *
 * "The Sons of Liberty receive a total of ten corvettes... one at a time. A
 * corvette does not appear until the previous one has accomplished its mission
 * or been destroyed. Corvettes may appear at any base except Luna, Ceres, or
 * Terra." The player picks the base at the table; with no command for that
 * choice the die does it, out of `state.rng` so replays still match. Every base
 * on the chart but Clandestine is an Enforcer base, so a rebel corvette that
 * appears at one has necessarily already lifted off: it starts in orbit.
 */
const endPlayerTurn = (state: GameState, map: GameMap): GameState => {
  const data = retributionData(state);
  const total = data.corvettesTotal ?? CORVETTE_ALLOWANCE;
  const appeared = data.corvettesAppeared ?? 1;
  if (appeared >= total) return state;
  if (data.freedomFleet?.formed === true) return state;
  if (stillFlying(state, map).length > 0) return state;

  const excluded = new Set(data.spawnExcludes ?? []);
  const worlds = map.bodies
    .filter((b) => !excluded.has(b.id))
    .map((b) => b.id)
    .filter((id) => baseSidesOf(map, id).length > 0)
    .sort();
  if (worlds.length === 0) return state;

  const pick = rollDie(state.rng);
  const world = worlds[(pick.value - 1) % worlds.length]!;
  const number = state.nextShipNumber;
  const corvette = inOrbit(
    {
      id: `sol-corvette-${appeared + 1}`,
      owner: SONS,
      shipClass: 'corvette',
      number,
      name: `Liberty ${appeared + 1}`,
    },
    map,
    world,
    0,
  );

  let s: GameState = {
    ...state,
    rng: pick.state,
    nextShipNumber: number + 1,
    ships: { ...state.ships, [corvette.id]: corvette },
  };
  s = withRetributionData(s, { corvettesAppeared: appeared + 1 });
  return log(
    s,
    `Liberty ${appeared + 1} rises from ${map.body(world)?.name ?? world} — corvette ${appeared + 1} of ${total}.`,
    { severity: 'warn', focus: [corvette.pos] },
  );
};

const checkVictory = (state: GameState): VictoryState | null => {
  const data = (state.scenarioData['retribution'] ?? {}) as {
    corvettesTotal?: number;
    corvettesAppeared?: number;
    freedomFleet?: { formed?: boolean };
  };
  const total = data.corvettesTotal ?? CORVETTE_ALLOWANCE;
  const appeared = data.corvettesAppeared ?? 1;

  const enforcers = ownedShips(state, ENFORCERS).length;
  const rebels = ownedShips(state, SONS).length;

  // "The Sons of Liberty win by destroying the Enforcer fleet, and, as a result,
  // freeing Terra."
  if (enforcers === 0) {
    return victory([SONS], 'decisive', 'The Enforcer fleet is destroyed and Terra is free.');
  }

  // "If the Enforcers hide, keeping their ships grounded for 12 or more turns,
  // then the Sons of Liberty win is automatic."
  if (turnsGrounded(state, ENFORCERS) >= HIDING_LIMIT) {
    return victory(
      [SONS],
      'decisive',
      `The Enforcers have kept their fleet grounded for ${HIDING_LIMIT} turns; the rebellion carries the System.`,
    );
  }

  // "If the rebels are indecisive and ground their fleet for at least 12 turns,
  // the rebellion has failed and the Enforcers win."
  if (turnsGrounded(state, SONS) >= HIDING_LIMIT) {
    return victory(
      [ENFORCERS],
      'decisive',
      `The rebel fleet sat idle for ${HIDING_LIMIT} turns; the rebellion has failed.`,
    );
  }

  // "The Enforcers win by staying alive. They receive promotions and extra leave
  // in Paris if they destroy the rebels." The rebellion is only spent once every
  // corvette has been used up and nothing is left flying.
  if (appeared >= total && rebels === 0 && data.freedomFleet?.formed !== true) {
    return victory(
      [ENFORCERS],
      'decisive',
      'All ten corvettes are gone and no Freedom Fleet was ever raised.',
    );
  }

  return null;
};

export const retribution: ScenarioDef = {
  id: 'retribution',
  name: 'Retribution',
  blurb: 'Ten rebel corvettes, one at a time, against the First Citizen’s Enforcers.',
  description:
    'The answer, as learned and forgotten by every generation since Adam, is not to ' +
    'run from the tyrant but to depose him. The whispered story of the brave pilgrims’ ' +
    'ordeal gave heart to the oppressed of the Solar System. The Enforcers hold two ' +
    'corsairs in orbit and a frigate on Luna; the Sons of Liberty get ten corvettes, ' +
    'one at a time, each of which may run for Clandestine to build the Freedom Fleet ' +
    'or dive suicidally into Terra.',
  players: { min: 2, max: 2 },
  length: 'medium',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  endPlayerTurn,
  specialRules: [
    'The Sons of Liberty receive ten corvettes one at a time. A corvette does not appear until the previous one has accomplished its mission or been destroyed. Corvettes may appear at any base except Luna, Ceres or Terra.',
    'Each corvette may fly one of two missions: a flight to Clandestine to help build the Freedom Fleet, or a suicidal attack on Terra.',
    'Each corvette which crashes into Terra while not disabled scares the First Citizen into reassigning one ship to the Terra Security Patrol. Those ships may not venture beyond detector range of Terra or Luna until after the Freedom Fleet has been formed. If three corvettes crash into Terra, all three Enforcer ships must be withdrawn into the Terran Security Patrol.',
    'After all ten corvettes have appeared — or earlier, at the rebel player’s option — all corvettes which have stopped at Clandestine may be converted into the Freedom Fleet. Total their combat strength, double it, and buy a fleet with those points using the combat strength point system. Torches may be selected.',
    'Because the Sons of Liberty own Clandestine, they treat its special asteroids as ordinary asteroids.',
    'Torpedoes and mines are available only to the Enforcers, and only from Terran bases.',
    'The Enforcers have all bases on the map except Clandestine, but only Terra and Luna have planetary defences.',
    'Victory: the Sons of Liberty win by destroying the Enforcer fleet, or automatically if the Enforcers keep their ships grounded for 12 or more turns. The Enforcers win by staying alive, by destroying the rebels, or if the rebels ground their own fleet for at least 12 turns.',
  ],
};
