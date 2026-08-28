/**
 * **The Crossing** — an original scenario, not one of the published ones.
 *
 * The two starting scenarios are played on bare cratered ground, where the only
 * terrain decision is "which way round the hole". This one exists to exercise
 * the green map, where terrain is most of the game: a river only GEVs, infantry
 * and cybertanks can cross away from a bridge, swamp that swallows heavy
 * armour, and towns that triple an infantry counter's defence.
 *
 * It follows the general scenario rules (1.06-1.09) — a unit allowance, a
 * victory-point tally — rather than inventing new machinery.
 */

import { type Hex, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, terrainAt } from '../engine/map.js';
import { GEV_MAP } from '../engine/mapdata.js';
import { ogreType } from '../engine/ogres.js';
import { createRng, nextInt, shuffle } from '../engine/rng.js';
import { type GameState, type VictoryState, isOgre, onBoard } from '../engine/types.js';
import { createGame, log, makeOgre, makePlayer, withUnit } from '../engine/state.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import { type Deployer, buyArmor, infantryCounters, isFree, place } from './helpers.js';

const OGRE_PLAYER = 'ogre';
const DEFENSE_PLAYER = 'defense';

const ARMOR_UNITS = 16;
const SQUADS = 24;
/** The Ogre wins by getting off the far edge; the defence wins by stopping it. */
const TURN_LIMIT = 12;

const westEdge = (map: GameMap): Hex[] =>
  allHexes(map).filter(
    (h) => toOffset(h).col === 1 && terrainAt(map, h) !== 'crater' && terrainAt(map, h) !== 'water',
  );

const build = (map: GameMap, opts: ScenarioBuildOptions): GameState => {
  const base = createGame({
    scenarioId: 'crossing',
    mapId: map.id,
    seed: opts.seed,
    players: [
      makePlayer(OGRE_PLAYER, 'Ogre', 'Paneuropean Federation', '#5b9bd5'),
      makePlayer(DEFENSE_PLAYER, 'Defence', 'North American Combine', '#d94f4f'),
    ],
    options: {
      // The green maps allow real stacking (5.02.2), which brings spillover
      // fire into play — and they are where overrun combat belongs. The two
      // starting scenarios use the simpler ramming rules instead (1.01), and
      // the rules insist on one or the other, never both (6.00).
      stackingLimit: 5,
      overrunCombat: true,
      ...opts.options,
    },
    scenarioData: { turnLimit: TURN_LIMIT, ogreEscapeEdge: 'east' },
  });

  let rng = createRng(opts.seed ^ 0xc0ff);
  const d: Deployer = { state: base, serial: 1 };

  // The Ogre enters from the west edge.
  const west = westEdge(map);
  const entryPick = nextInt(rng, Math.max(1, west.length));
  rng = entryPick.state;
  const entry = west[entryPick.value] ?? west[0]!;
  d.state = withUnit(d.state, makeOgre(`${OGRE_PLAYER}-mk3`, OGRE_PLAYER, 'MK3', entry));

  // The defence holds the eastern two thirds.
  const defenceGround = allHexes(map).filter((h) => {
    const col = toOffset(h).col;
    const t = terrainAt(map, h);
    return col >= Math.round(map.cols / 3) && t !== 'crater' && t !== 'water';
  });
  const order = shuffle(rng, defenceGround);
  rng = order.state;
  const hexes = order.items.filter((h) => isFree(d.state, h));

  const buy = buyArmor(rng, ARMOR_UNITS);
  rng = buy.rng;
  for (const cls of buy.units) place(d, DEFENSE_PLAYER, cls, hexes);
  for (const squads of infantryCounters(SQUADS)) {
    place(d, DEFENSE_PLAYER, 'INF', hexes, squads);
  }

  return log(
    d.state,
    'info',
    `${ogreType('MK3').name} comes over the western border. It has ${TURN_LIMIT} turns to reach the far edge.`,
    [entry],
  );
};

const checkVictory = (state: GameState): VictoryState | null => {
  const ogre = Object.values(state.units).find((u) => isOgre(u));
  if (!ogre) return null;

  if (!ogre.destroyed && ogre.offMap === 'east') {
    return {
      winners: [OGRE_PLAYER],
      level: 'complete',
      reason: 'The cybertank is through the line and away east.',
    };
  }
  if (ogre.destroyed) {
    return {
      winners: [DEFENSE_PLAYER],
      level: 'complete',
      reason: 'The cybertank is a wreck short of the far edge.',
    };
  }
  const limit = (state.scenarioData['turnLimit'] as number | undefined) ?? TURN_LIMIT;
  if (state.turn > limit) {
    return {
      winners: [DEFENSE_PLAYER],
      level: 'standard',
      reason: `The Ogre failed to break through inside ${limit} turns.`,
    };
  }
  if (!Object.values(state.units).some((u) => u.owner === DEFENSE_PLAYER && onBoard(u))) {
    return {
      winners: [OGRE_PLAYER],
      level: 'complete',
      reason: 'Nothing is left of the defence.',
    };
  }
  return null;
};

export const CROSSING: ScenarioDef = {
  id: 'crossing',
  name: 'The Crossing',
  mapId: GEV_MAP.id,
  players: 2,
  map: GEV_MAP,
  blurb: `A ${ogreType('MK3').name} must break through settled country and off the far edge.`,
  briefing:
    'An original scenario for the green map, where terrain does the work the craters cannot.\n\n' +
    `A ${ogreType('MK3').name} enters from the west edge. The defence has ${ARMOR_UNITS} armour ` +
    `units and ${SQUADS} squads of infantry, set up anywhere in the eastern two thirds.\n\n` +
    'Things worth knowing here that never came up on the orange map: only GEVs, infantry, ' +
    'Ogres and Superheavies cross water; heavy tracked units that enter swamp may be stuck ' +
    'there for the rest of the game; towns triple an infantry counter’s defence and double ' +
    'everybody else’s; and up to five vehicles may share a hex, which means every attack ' +
    'spills over onto whatever else is standing there.\n\n' +
    'This scenario uses overrun combat rather than ramming. Drive into an occupied hex and ' +
    'the two sides shoot it out at point-blank range, the defender first, until one of them ' +
    'is gone — and at that range a "disabled" result is a kill. Infantry double their attack ' +
    'strength in an overrun, which is the one place a squad is genuinely frightening.',
  victoryConditions: [
    'Ogre leaves by the east edge: Ogre victory.',
    'Ogre destroyed: defence victory.',
    `Ogre still on the map after ${TURN_LIMIT} turns: defence victory.`,
    'All defending units destroyed: Ogre victory.',
  ],
  build: (opts) => build(GEV_MAP, opts),
  checkVictory,
};
