/**
 * Escape — "A short two-player scenario".
 *
 * Rulebook pp. 9-10:
 *
 *   "The Pilgrims, oppressed by the First Citizen and his infamous Enforcers,
 *    have secretly prepared a transport and two decoys for an escape to the
 *    stars! ...
 *
 *    Ships: The Pilgrims receive three transports (white on blue) on Terra. The
 *    Enforcers receive one corvette in orbit around Terra and a corsair in orbit
 *    around Venus (white on black counters).
 *
 *    Special Rules: The Pilgrims secretly designate one transport to contain the
 *    fugitives; the other two are decoys crewed by volunteers. Beginning on Day
 *    1, the Pilgrim may launch his ships from Terra in any manner he wishes.
 *    Ships still on Terra may not be attacked. Decoy ships are revealed only if
 *    the Enforcer matches course and inspects the ship in question. Otherwise,
 *    ship identities are revealed only at the end of the game.
 *
 *    Mines and torpedoes are not available to either player. The Pilgrim decoys
 *    may ram. Only Terra, Venus, and Io have bases.
 *
 *    All bases on the map belong to the Enforcers. Planetary defenses are not
 *    operating. There is no time limit to this scenario."
 */

import { length as vectorLength } from '@engine/hex.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { solarDistance } from '@engine/mapdata.js';
import { createInitialState } from '@engine/state.js';
import { rollDie } from '@engine/rng.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  buildBases,
  buildPlayers,
  everDisabled,
  inOrbit,
  landed,
  ownedShips,
  seedOf,
  sideOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const PILGRIMS: PlayerId = 'pilgrims';
const ENFORCERS: PlayerId = 'enforcers';

const SPECS: readonly PlayerSpec[] = [
  { id: PILGRIMS, faction: 'Pilgrims', color: '#f2f6ff', name: 'Pilgrims' },
  { id: ENFORCERS, faction: 'Enforcers', color: '#3a3f4b', name: 'Enforcers' },
];

const TRANSPORT_IDS = ['pilgrim-1', 'pilgrim-2', 'pilgrim-3'] as const;

/**
 * Where the secret lives.
 *
 * "Otherwise, ship identities are revealed only at the end of the game", so this
 * key is deliberately namespaced: everything under `secret` is for the engine
 * and the owning player, never for the interface's public panels.
 */
export const ESCAPE_SECRET_KEY = 'secret';

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;

  // "The Pilgrims secretly designate one transport to contain the fugitives."
  // The draw runs through the game's own generator so a seed reproduces it and
  // nothing outside the state knows the answer.
  const draw = rollDie({ seed: seedOf(opts) >>> 0 });
  const fugitive = TRANSPORT_IDS[draw.value % TRANSPORT_IDS.length]!;

  // Three transports on Terra, on three separate hexsides so each can lift off
  // independently — "the Pilgrim may launch his ships from Terra in any manner
  // he wishes."
  const launchSides = [0, 2, 4];
  const ships: Ship[] = TRANSPORT_IDS.map((id, i) =>
    landed(
      { id, owner: PILGRIMS, shipClass: 'transport', number: i + 1, name: `Pilgrim ${i + 1}` },
      sideOf(map, 'terra', launchSides[i] ?? 0),
    ),
  );

  ships.push(
    inOrbit(
      {
        id: 'enforcer-corvette',
        owner: ENFORCERS,
        shipClass: 'corvette',
        number: 4,
        name: 'Enforcer Vigilance',
      },
      map,
      'terra',
      0,
    ),
    inOrbit(
      {
        id: 'enforcer-corsair',
        owner: ENFORCERS,
        shipClass: 'corsair',
        number: 5,
        name: 'Enforcer Retribution',
      },
      map,
      'venus',
      3,
    ),
  );

  return createInitialState({
    scenarioId: 'escape',
    seed: seedOf(opts),
    players: buildPlayers(SPECS, opts),
    ships,
    bases: buildBases(map, {
      // "All bases on the map belong to the Enforcers."
      defaultOwner: ENFORCERS,
      // ...with three exceptions. "Beginning on Day 1, the Pilgrim may launch his
      // ships from Terra in any manner he wishes", but "boosters [are] available
      // only at friendly bases" — so the three pads the Pilgrims "have secretly
      // prepared" are left unclaimed, and an unclaimed base serves anyone. The
      // Enforcers lose nothing by it: all six Terran bases sit in Terra's own
      // hex, so their detection field and their own resupply are unchanged.
      sites: Object.fromEntries(launchSides.map((d) => [`terra:${d}`, null])),
      // "Only Terra, Venus, and Io have bases."
      absent: ['mercury', 'luna', 'mars', 'ceres', 'clandestine', 'ganymede', 'callisto'],
      // "Planetary defenses are not operating."
      defences: 'none',
    }),
    options: {
      // Decoys are decoys only if the Enforcer cannot see which is which.
      fogOfWar: true,
      nukesAllowed: false,
      ...opts.options,
    },
    scenarioData: {
      [ESCAPE_SECRET_KEY]: { fugitiveShip: fugitive },
      decoyShips: TRANSPORT_IDS.filter((id) => id !== fugitive),
      // "Mines and torpedoes are not available to either player."
      ordnanceAvailable: [],
      noTimeLimit: true,
    },
  });
};

/** The Pilgrim ship the fugitives are actually aboard. */
const fugitiveOf = (state: GameState): Ship | undefined => {
  const secret = state.scenarioData[ESCAPE_SECRET_KEY] as
    | { fugitiveShip?: string }
    | undefined;
  const id = secret?.fugitiveShip;
  return id ? state.ships[id] : undefined;
};

/**
 * "The Pilgrims win a decisive victory if the fugitive ship exits the board
 * beyond Jupiter with sufficient fuel remaining to make a dead stop, plus one
 * fuel point."
 *
 * The chart is a disc centred on Sol, so any exit is already outside Jupiter's
 * orbit; the test below states the condition anyway, because it is the rule.
 * A dead stop from speed *v* costs *v* fuel points — one point per hex of vector
 * change — so the requirement is `fuel >= speed + 1`.
 */
const escaped = (ship: Ship): { exited: boolean; withFuel: boolean } => {
  const exited = ship.destroyed && ship.destroyedBy === 'left the map';
  if (!exited) return { exited: false, withFuel: false };
  const jupiter = DEFAULT_MAP.body('jupiter');
  const beyondJupiter =
    jupiter === undefined || solarDistance(ship.pos) >= solarDistance(jupiter.hex);
  const needed = vectorLength(ship.velocity) + 1;
  return { exited: beyondJupiter, withFuel: ship.fuel >= needed };
};

const checkVictory = (state: GameState): VictoryState | null => {
  const fugitive = fugitiveOf(state);
  if (!fugitive) return null;

  const run = escaped(fugitive);
  if (run.exited) {
    return run.withFuel
      ? victory(
          [PILGRIMS],
          'decisive',
          'The fugitive ship is away beyond Jupiter with fuel enough to stop at journey’s end.',
        )
      : victory(
          [PILGRIMS],
          'marginal',
          'The fugitives are away, but without the fuel to decelerate at journey’s end.',
        );
  }

  // "The Enforcers win a decisive victory if they capture the Pilgrims (loot
  // their transport) and return safely to a base." A prize that has reached a
  // base friendly to its captor is refitted into that captor's service.
  if (fugitive.owner === ENFORCERS && !fugitive.destroyed) {
    return victory(
      [ENFORCERS],
      'decisive',
      'The fugitives were taken and brought home; the First Citizen is pleased.',
    );
  }

  if (fugitive.destroyed) {
    // "The Pilgrims win a moral victory if they are destroyed or captured but
    // disable at least one Enforcer ship, even temporarily, in the process."
    const bloodied = Object.values(state.ships).some(
      (s) => s.owner === ENFORCERS && (s.destroyed || everDisabled(state, s)),
    );
    if (bloodied) {
      return victory(
        [PILGRIMS, ENFORCERS],
        'moral',
        'The fugitive transport was destroyed — a marginal Enforcer win — but the Pilgrims disabled an Enforcer ship on the way out, and win a moral victory.',
      );
    }
    return victory(
      [ENFORCERS],
      'marginal',
      'The transport carrying the fugitives was destroyed.',
    );
  }

  // Every Pilgrim hull gone while the fugitives somehow survive is impossible;
  // the fugitive ship is one of them. Nothing is decided yet.
  if (ownedShips(state, PILGRIMS).length === 0) return null;
  return null;
};

export const escape: ScenarioDef = {
  id: 'escape',
  name: 'Escape',
  blurb: 'Three transports run for the stars; one of them carries the fugitives.',
  description:
    'The Pilgrims, oppressed by the First Citizen and his infamous Enforcers, have ' +
    'secretly prepared a transport and two decoys for an escape to the stars. The ' +
    'transport is equipped with Long Sleep capsules; it is only necessary that the ' +
    'ship leave the Solar System with enough fuel remaining to allow manoeuvre and ' +
    'deceleration at journey’s end. But first, they must elude the Enforcers — one ' +
    'corvette in orbit around Terra, and a corsair in orbit around Venus.',
  players: { min: 2, max: 2 },
  length: 'short',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  specialRules: [
    'The Pilgrims secretly designate one transport to contain the fugitives; the other two are decoys crewed by volunteers.',
    'Beginning on Day 1, the Pilgrim may launch his ships from Terra in any manner he wishes. Ships still on Terra may not be attacked.',
    'Decoy ships are revealed only if the Enforcer matches course and inspects the ship in question. Otherwise, ship identities are revealed only at the end of the game.',
    'Mines and torpedoes are not available to either player. The Pilgrim decoys may ram.',
    'Only Terra, Venus and Io have bases. All bases belong to the Enforcers, and planetary defences are not operating.',
    'There is no time limit to this scenario.',
    'Victory: Pilgrims decisive — the fugitive ship exits the board beyond Jupiter with fuel enough for a dead stop plus one point (it may be disabled). Marginal — it exits with less. Moral — destroyed or captured, but at least one Enforcer ship was disabled, even temporarily.',
    'Victory: Enforcers marginal — destroy the transport carrying the Pilgrims. Decisive — capture the Pilgrims (loot their transport) and return safely to a base.',
  ],
};
