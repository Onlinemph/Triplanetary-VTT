/**
 * A bare board and two players, for tests that want to place exactly three
 * counters and watch what happens.
 *
 * Every test in this suite is hermetic because the engine is pure: a fixed
 * seed, a starting position and a list of commands is a complete game.
 */

import { type Hex, hex } from '../../src/ogre/engine/hex.js';
import type { GameMap } from '../../src/ogre/engine/map.js';
import type { Terrain } from '../../src/ogre/engine/terrain.js';
import type { OgreTypeId } from '../../src/ogre/engine/ogres.js';
import type { UnitClassId } from '../../src/ogre/engine/units.js';
import { type GameState, type Phase } from '../../src/ogre/engine/types.js';
import {
  createGame,
  makeOgre,
  makePlayer,
  makeUnit,
  withUnit,
} from '../../src/ogre/engine/state.js';

export const A = 'a';
export const B = 'b';

export const flatMap = (cols = 12, rows = 12, terrain: Record<string, Terrain> = {}): GameMap => ({
  id: 'test',
  name: 'Test board',
  cols,
  rows,
  terrain,
  sides: {},
  routes: {},
  blurb: 'A featureless plain, for tests.',
});

export const newGame = (opts: { seed?: number; stackingLimit?: number } = {}): GameState =>
  createGame({
    scenarioId: 'test',
    mapId: 'test',
    seed: opts.seed ?? 1,
    players: [
      makePlayer(A, 'Player A', 'Combine', '#f00'),
      makePlayer(B, 'Player B', 'Paneurope', '#00f'),
    ],
    options: { stackingLimit: opts.stackingLimit ?? 1 },
  });

export const at = (col: number, row: number): Hex => {
  const q = col - 1;
  return hex(q, row - 1 - ((q - (q & 1)) >> 1));
};

export const put = (
  state: GameState,
  owner: string,
  classId: UnitClassId,
  h: Hex,
  squads = 1,
  id = `${owner}-${classId}-${Object.keys(state.units).length + 1}`,
): { state: GameState; id: string } => ({
  state: withUnit(state, makeUnit(id, owner, classId, h, squads)),
  id,
});

export const putOgre = (
  state: GameState,
  owner: string,
  typeId: OgreTypeId,
  h: Hex,
  id = `${owner}-ogre-${Object.keys(state.units).length + 1}`,
): { state: GameState; id: string } => ({
  state: withUnit(state, makeOgre(id, owner, typeId, h)),
  id,
});

export const inPhase = (state: GameState, phase: Phase): GameState => ({ ...state, phase });

/**
 * Fix the next die roll.
 *
 * mulberry32's state is one integer, so a test that needs a particular result
 * searches for a seed that produces it rather than stubbing the generator —
 * which keeps the engine's determinism property honest.
 */
export const seedForRoll = (want: number, from = 0): number => {
  for (let seed = from; seed < from + 100000; seed++) {
    if (rollWithSeed(seed) === want) return seed;
  }
  throw new Error(`no seed produces a ${want}`);
};

const rollWithSeed = (seed: number): number => {
  const a = (seed + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 6) + 1;
};

/** Flip a conventional unit face-down, the way a D result does. */
export const setDisabled = (
  state: GameState,
  id: string,
  kind: 'combat' | 'terrain',
  ordinal = 0,
): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'unit') return state;
  return {
    ...state,
    units: { ...state.units, [id]: { ...u, disabled: kind, disabledAt: ordinal } },
  };
};
