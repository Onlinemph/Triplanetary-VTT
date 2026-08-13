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

import { DEFAULT_MAP } from '@engine/map.js';
import { createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
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
        { id: 'enforcer-corsair-1', owner: ENFORCERS, shipClass: 'corsair', number: 1, name: 'Praetor' },
        map,
        'terra',
        0,
      ),
      inOrbit(
        { id: 'enforcer-corsair-2', owner: ENFORCERS, shipClass: 'corsair', number: 2, name: 'Lictor' },
        map,
        'mars',
        0,
      ),
      // "one frigate on a base at Luna."
      landed(
        { id: 'enforcer-frigate', owner: ENFORCERS, shipClass: 'frigate', number: 3, name: 'First Citizen' },
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
