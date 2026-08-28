/**
 * The two starting scenarios: **Mark III Attack** and **Mark V Attack**.
 *
 * "This represents an Ogre attack on a heavily guarded command post." The two
 * are the same scenario with different numbers — "Play is identical to Mark III
 * Attack, except..." — so they are built by one function here, and the
 * differences are the four fields of `Terms`.
 *
 * The setup constraints are the rulebook's, verbatim in effect:
 *
 *  - The defence gets a fixed allowance of infantry squads and armour units.
 *  - "No more than 20 attack strength points may be set up in this [Central]
 *    area."
 *  - "The rest of the defending force must be set up in the North Area."
 *  - "No defenders may set up in the South Area (that is, in any hex whose
 *    number ends in 17 or higher)."
 *  - "No units may start in, or enter, a crater hex."
 *  - "The Command Post may be placed anywhere, but the farther north it is, the
 *    safer it is!"
 */

import { toOffset } from '../engine/hex.js';
import { type GameMap, areaOf } from '../engine/map.js';
import { OGRE_MAP } from '../engine/mapdata.js';
import { type OgreTypeId, ogreType } from '../engine/ogres.js';
import { createRng, nextInt, shuffle } from '../engine/rng.js';
import { unitClass } from '../engine/units.js';
import { type GameState, type VictoryState, onBoard, surviving, isOgre } from '../engine/types.js';
import { createGame, log, makeOgre, makePlayer, printedAttack, withUnit } from '../engine/state.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import {
  type Deployer,
  attackStrengthOf,
  buyArmor,
  infantryCounters,
  place,
  shuffledOpenHexes,
  southEdgeHexes,
} from './helpers.js';

export const OGRE_PLAYER = 'ogre';
export const DEFENSE_PLAYER = 'defense';

interface Terms {
  readonly id: string;
  readonly name: string;
  readonly ogre: OgreTypeId;
  readonly squads: number;
  readonly armorUnits: number;
  /** "No more than N attack strength points may be set up in this area." */
  readonly centralLimit: number;
  /** Attack strength that must survive alongside the CP for a complete win. */
  readonly completeWinStrength: number;
}

const MARK_III: Terms = {
  id: 'mark-iii-attack',
  name: 'Mark III Attack',
  ogre: 'MK3',
  squads: 20,
  armorUnits: 12,
  centralLimit: 20,
  completeWinStrength: 30,
};

const MARK_V: Terms = {
  id: 'mark-v-attack',
  name: 'Mark V Attack',
  ogre: 'MK5',
  squads: 30,
  armorUnits: 20,
  centralLimit: 40,
  completeWinStrength: 50,
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const build = (terms: Terms, map: GameMap, opts: ScenarioBuildOptions): GameState => {
  const base = createGame({
    scenarioId: terms.id,
    mapId: map.id,
    seed: opts.seed,
    players: [
      makePlayer(DEFENSE_PLAYER, 'Defence', 'North American Combine', '#d94f4f'),
      makePlayer(OGRE_PLAYER, 'Ogre', 'Paneuropean Federation', '#5b9bd5'),
    ],
    options: {
      // "In scenarios on the original Ogre map, units may not be stacked"
      // (5.02.1), and 1.01 says these games use the ramming rules.
      stackingLimit: 1,
      overrunCombat: false,
      ...opts.options,
    },
    scenarioData: {
      terms: terms.id,
      // The Ogre wins by leaving the way it came in.
      ogreEscapeEdge: 'south',
      completeWinStrength: terms.completeWinStrength,
    },
  });

  // The defence sets up first, so it moves second: "The attacking player ...
  // moves first."
  const stateWithOrder: GameState = { ...base, playerOrder: [OGRE_PLAYER, DEFENSE_PLAYER] };

  let rng = createRng(opts.seed ^ 0x5eed);
  const d: Deployer = { state: stateWithOrder, serial: 1 };

  // --- The Ogre ----------------------------------------------------------
  const south = southEdgeHexes(map);
  const entryPick = nextInt(rng, south.length);
  rng = entryPick.state;
  const entry = south[entryPick.value]!;
  d.state = withUnit(
    d.state,
    makeOgre(`${OGRE_PLAYER}-${terms.ogre.toLowerCase()}`, OGRE_PLAYER, terms.ogre, entry),
  );

  // --- The defence -------------------------------------------------------
  const buy = buyArmor(rng, terms.armorUnits);
  rng = buy.rng;
  const armour = shuffle(rng, buy.units);
  rng = armour.state;

  const northHexes = shuffledOpenHexes(rng, map, 'north');
  rng = northHexes.rng;
  const centralHexes = shuffledOpenHexes(rng, map, 'central');
  rng = centralHexes.rng;

  // The command post goes as far north as it can: "the farther north it is, the
  // safer it is!"
  const cpHexes = [...northHexes.hexes].sort((a, b) => toOffset(a).row - toOffset(b).row);
  place(d, DEFENSE_PLAYER, 'CP', cpHexes);

  // A screen forward in the Central Area, up to the printed strength limit, and
  // the rest of the force behind the line.
  let central = 0;
  const forward: typeof armour.items = [];
  const rear: typeof armour.items = [];
  for (const cls of armour.items) {
    const strength = unitClass(cls).attack;
    // Howitzers stay home; they outrange everything the Ogre has and have no
    // business in the screen.
    if (cls !== 'HWZ' && central + strength <= terms.centralLimit) {
      forward.push(cls);
      central += strength;
    } else {
      rear.push(cls);
    }
  }

  for (const cls of forward) place(d, DEFENSE_PLAYER, cls, centralHexes.hexes);
  for (const cls of rear) place(d, DEFENSE_PLAYER, cls, northHexes.hexes);

  // Infantry: enough forward to fill the screen's remaining allowance, the rest
  // dug in around the command post.
  for (const squads of infantryCounters(terms.squads)) {
    if (central + squads <= terms.centralLimit) {
      place(d, DEFENSE_PLAYER, 'INF', centralHexes.hexes, squads);
      central += squads;
    } else {
      place(d, DEFENSE_PLAYER, 'INF', northHexes.hexes, squads);
    }
  }

  return log(
    d.state,
    'info',
    `${ogreType(terms.ogre).name} crosses the line of departure. ` +
      `The command post is somewhere north; the defence has ${terms.armorUnits} armour units ` +
      `and ${terms.squads} squads between it and the Ogre.`,
    [entry],
  );
};

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

/**
 * The six outcomes, in the rulebook's order:
 *
 *  - All defending units destroyed: complete Ogre victory.
 *  - Command Post destroyed and Ogre escapes from the south end: Ogre victory.
 *  - Command Post and Ogre destroyed: marginal Ogre victory.
 *  - Command Post survives, but Ogre escapes: marginal defence victory.
 *  - Command Post survives, Ogre destroyed: defence victory.
 *  - Command Post and at least N points of attack strength survive, Ogre
 *    destroyed: complete defence victory.
 *
 * The check only fires once the battle is actually over — "a scenario continues
 * until one force is entirely gone from the map, through destruction,
 * withdrawal, or both" (1.02) — which for this scenario means the Ogre is dead
 * or gone, or the defence is.
 */
const checkVictory =
  (terms: Terms) =>
  (state: GameState): VictoryState | null => {
    const units = Object.values(state.units);
    const ogre = units.find((u) => isOgre(u));
    if (!ogre) return null;

    const ogreDead = ogre.destroyed;
    const ogreEscaped = !ogre.destroyed && ogre.offMap === 'south';
    const ogreGone = ogreDead || ogreEscaped;

    const defenders = units.filter((u) => u.owner === DEFENSE_PLAYER);
    const cp = defenders.find((u) => u.kind === 'unit' && u.classId === 'CP');
    const cpAlive = !!cp && surviving(cp);
    const anyDefenderLeft = defenders.some((u) => onBoard(u));

    // "All defending units destroyed: complete Ogre victory."
    if (!anyDefenderLeft) {
      return {
        winners: [OGRE_PLAYER],
        level: 'complete',
        reason: 'Every defending unit is gone. Complete Ogre victory.',
      };
    }

    if (!ogreGone) return null;

    if (!cpAlive) {
      if (ogreEscaped) {
        return {
          winners: [OGRE_PLAYER],
          level: 'standard',
          reason: 'The command post is destroyed and the Ogre made it off the south edge.',
        };
      }
      return {
        winners: [OGRE_PLAYER],
        level: 'marginal',
        reason: 'The command post is destroyed, but so is the Ogre. Marginal Ogre victory.',
      };
    }

    if (ogreEscaped) {
      return {
        winners: [DEFENSE_PLAYER],
        level: 'marginal',
        reason: 'The command post survives, but the Ogre got away. Marginal defence victory.',
      };
    }

    const strength = attackStrengthOf(state, DEFENSE_PLAYER);
    if (strength >= terms.completeWinStrength) {
      return {
        winners: [DEFENSE_PLAYER],
        level: 'complete',
        reason:
          `The Ogre is wrecked, the command post stands, and ${strength} points of attack ` +
          `strength are still in the field. Complete defence victory.`,
      };
    }
    return {
      winners: [DEFENSE_PLAYER],
      level: 'standard',
      reason: 'The Ogre is wrecked and the command post stands. Defence victory.',
    };
  };

// ---------------------------------------------------------------------------
// The two scenarios
// ---------------------------------------------------------------------------

const make = (terms: Terms): ScenarioDef => {
  const type = ogreType(terms.ogre);
  return {
    id: terms.id,
    name: terms.name,
    mapId: OGRE_MAP.id,
    players: 2,
    map: OGRE_MAP,
    blurb: `A single ${type.name} against a command post and ${terms.armorUnits} armour units.`,
    briefing:
      `An Ogre attack on a heavily guarded command post, on the original cratered map.\n\n` +
      `The defence has ${terms.squads} squads of infantry and ${terms.armorUnits} armour ` +
      `units. No more than ${terms.centralLimit} points of attack strength may set up in ` +
      `the Central Area; the rest of the force sets up in the North Area, and nothing sets ` +
      `up in the South. No unit may start in, or enter, a crater.\n\n` +
      `The ${type.name} enters anywhere along the south edge, spending one movement point ` +
      `to enter its starting hex, and moves first.\n\n` +
      `${type.blurb}`,
    victoryConditions: [
      'All defending units destroyed: complete Ogre victory.',
      'Command Post destroyed and Ogre escapes from the south end: Ogre victory.',
      'Command Post and Ogre destroyed: marginal Ogre victory.',
      'Command Post survives, but Ogre escapes: marginal defence victory.',
      'Command Post survives, Ogre destroyed: defence victory.',
      `Command Post and at least ${terms.completeWinStrength} points of attack strength survive, ` +
        'Ogre destroyed: complete defence victory.',
    ],
    build: (opts) => build(terms, OGRE_MAP, opts),
    checkVictory: checkVictory(terms),
  };
};

export const MARK_III_ATTACK = make(MARK_III);
export const MARK_V_ATTACK = make(MARK_V);

/** Which area of the map a hex belongs to — re-exported for the renderer. */
export { areaOf };

/** Total attack strength still in the field, for the status bar. */
export const defenceStrength = (state: GameState): number =>
  attackStrengthOf(state, DEFENSE_PLAYER);

/** A single unit's printed attack strength, for the after-action report. */
export { printedAttack };
