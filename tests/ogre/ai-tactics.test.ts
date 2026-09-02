/**
 * The tactics the computer opponent is expected to have learned: not rules
 * it was told, but what its weight table makes it do on an open board with
 * one problem in front of it.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import {
  type GameState,
  type Phase,
  type PlayerId,
  type Unit,
  activePlayer,
} from '../../src/ogre/engine/types.js';
import { makeOgre, makeUnit } from '../../src/ogre/engine/state.js';
import { type Hex, distance, hexLine } from '../../src/ogre/engine/hex.js';
import { allHexes, terrainAt } from '../../src/ogre/engine/map.js';
import { aiPlan } from '../../src/ogre/ai/player.js';
import { scenarioById } from '../../src/ogre/scenarios/index.js';
import { DEFENSE_PLAYER, OGRE_PLAYER } from '../../src/ogre/scenarios/ogreAttack.js';

const def = scenarioById('mark-iii-attack')!;
const base = def.build({ seed: 7 });
const cp = Object.values(base.units).find((u) => u.kind === 'unit' && u.classId === 'CP')!;

// Clear ground well away from the post, so the post is not the answer.
const clear = (h: Hex): boolean =>
  terrainAt(def.map, h, base.terrainOverrides) === 'clear' && distance(h, cp.pos) > 10;

/**
 * Two clear hexes `d` apart with clear ground all along the line between
 * them, the second nearer the command post than the first — so the far one
 * is on the near one's way to the post.
 */
const openPair = (d: number): [Hex, Hex] => {
  const hexes = allHexes(def.map).filter(clear);
  for (const a of hexes) {
    for (const b of hexes) {
      if (distance(a, b) !== d) continue;
      if (d > 3 && distance(b, cp.pos) >= distance(a, cp.pos) - 2) continue;
      if (hexLine(a, b).every(clear)) return [a, b];
    }
  }
  throw new Error(`no open line of ${d} hexes on the map`);
};

/** A board with only these counters on it and the post kept as the Ogre's objective. */
const boardWith = (
  units: readonly Unit[],
  opts: { turn?: number; phase?: Phase; active?: PlayerId } = {},
): GameState => {
  const kept: Record<string, Unit> = { [cp.id]: cp };
  for (const u of units) kept[u.id] = u;
  return {
    ...base,
    turn: opts.turn ?? 3,
    phase: opts.phase ?? 'movement',
    activePlayerIndex: base.playerOrder.indexOf(opts.active ?? OGRE_PLAYER),
    units: kept,
  };
};

/** Let the computer play the phase the state is in, through the engine. */
const playPhase = (state: GameState): { state: GameState; commands: ReturnType<typeof aiPlan> } => {
  const player = activePlayer(state);
  const commands = aiPlan(state, def.map, player);
  let s = state;
  for (const cmd of commands) {
    const out = applyCommand(s, cmd, def.map);
    if (out.result.ok) s = out.state;
  }
  return { state: s, commands };
};

const spentMissiles = (ogre: ReturnType<typeof makeOgre>): ReturnType<typeof makeOgre> => ({
  ...ogre,
  weapons: ogre.weapons.map((w) => (w.kind === 'missile' ? { ...w, fired: true } : w)),
});

describe('the cybertank and the howitzer', () => {
  it('closes to missile range and kills it with a missile', () => {
    const [from, at] = openPair(8);
    const ogre = makeOgre('mk3', OGRE_PLAYER, 'MK3', from);
    const hwz = makeUnit('hwz', DEFENSE_PLAYER, 'HWZ', at);
    const start = boardWith([ogre, hwz]);

    const moved = playPhase(start);
    const after = moved.state.units['mk3']!;
    expect(distance(after.pos, at)).toBeLessThanOrEqual(5);
    expect(moved.state.phase).toBe('fire');

    const fired = playPhase(moved.state);
    const missileShot = fired.commands.find(
      (c) =>
        c.type === 'attack' &&
        c.target.kind === 'unit' &&
        c.target.unit === 'hwz' &&
        c.attackers.some((a) => {
          const w = ogre.weapons.find((x) => x.id === a.weapon);
          return w?.kind === 'missile' || w?.kind === 'missileRack';
        }),
    );
    expect(missileShot).toBeDefined();
    // Six against one is an automatic kill: the howitzer is gone.
    expect(fired.state.units['hwz']!.destroyed).toBe(true);
  });
});

describe('the missile tank and the cybertank', () => {
  it('fires from its own range, outside the secondary batteries, once the missiles are spent', () => {
    const [near, far] = openPair(5);
    const ogre = spentMissiles(makeOgre('mk3', OGRE_PLAYER, 'MK3', far));
    const msl = makeUnit('msl', DEFENSE_PLAYER, 'MSL', near);
    const start = boardWith([ogre, msl], { active: DEFENSE_PLAYER });

    // It could close to two; it stops at three or four, where the secondaries
    // cannot reach it without the cybertank moving first.
    const moved = playPhase(start);
    const after = moved.state.units['msl']!;
    expect(distance(after.pos, far)).toBeGreaterThanOrEqual(3);
    expect(distance(after.pos, far)).toBeLessThanOrEqual(4);

    const fired = playPhase(moved.state);
    const shot = fired.commands.find(
      (c) => c.type === 'attack' && 'unit' in c.target && c.target.unit === 'mk3',
    );
    expect(shot).toBeDefined();
  });
});

describe('the GEV and the cybertank', () => {
  /**
   * Hit and run: a GEV that has fired at close range uses its second move
   * to leave the batteries that could reach it without the cybertank
   * moving, so that killing it costs the cybertank its own move — which,
   * with a post to reach, it will usually not pay.
   */
  it('having fired at close range, uses its second move to get out of the batteries', () => {
    const [near, far] = openPair(2);
    const ogre = makeOgre('mk3', OGRE_PLAYER, 'MK3', far);
    const gev = { ...makeUnit('gev', DEFENSE_PLAYER, 'GEV', near), firedThisPhase: true };
    const start = boardWith([ogre, gev], { active: DEFENSE_PLAYER, phase: 'gevMovement' });

    const away = playPhase(start);
    const end = away.state.units['gev']!.pos;
    // Outside the main battery's three: only the missiles reach without a
    // move, and a cybertank keeps those for a howitzer or the post.
    expect(distance(end, far)).toBeGreaterThan(3);
  });
});
