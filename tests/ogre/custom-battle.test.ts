/**
 * The custom battle: a scenario built from an order of battle rather than a
 * printed allowance. What it must get right is that the same order always
 * builds the same board, that every force lands on legal ground, and that
 * each of the three endings fires when the rulebook's shape says it should.
 */

import { describe, expect, it } from 'vitest';
import type { OrderOfBattle } from '../../src/campaign/orders.js';
import { areaOf, terrainAt } from '../../src/ogre/engine/map.js';
import { toOffset } from '../../src/ogre/engine/hex.js';
import { unitClass } from '../../src/ogre/engine/units.js';
import { OGRE_MAP, GEV_MAP } from '../../src/ogre/engine/mapdata.js';
import { type GameState, isOgre, onBoard } from '../../src/ogre/engine/types.js';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import {
  CUSTOM,
  DEFAULT_CUSTOM,
  customMap,
  describeCustom,
  expandForces,
  forceValue,
  mapOf,
  readTerms,
  scenarioById,
} from '../../src/ogre/scenarios/index.js';

const order = (
  over: Partial<OrderOfBattle> & { terms?: Record<string, unknown> },
): OrderOfBattle => ({
  ...DEFAULT_CUSTOM,
  seed: 11,
  ...over,
  terms: { ...DEFAULT_CUSTOM.terms, ...(over.terms ?? {}) },
});

const unitsOf = (state: GameState, owner: string) =>
  Object.values(state.units).filter((u) => u.owner === owner && onBoard(u));

describe('the custom battle', () => {
  it('is in the scenario table and builds its default order with nothing supplied', () => {
    expect(scenarioById('custom')).toBe(CUSTOM);
    const state = CUSTOM.build({ seed: 5 });
    expect(state.playerOrder).toEqual(['attacker', 'defender']);
    expect(unitsOf(state, 'attacker').some(isOgre)).toBe(true);
    expect(unitsOf(state, 'defender').some((u) => u.kind === 'unit' && u.classId === 'CP')).toBe(
      true,
    );
  });

  it('builds the same board twice from the same order, and a different one from another seed', () => {
    const a = CUSTOM.build({ order: order({ seed: 3 }), seed: 0 });
    const b = CUSTOM.build({ order: order({ seed: 3 }), seed: 99 });
    const c = CUSTOM.build({ order: order({ seed: 4 }), seed: 0 });
    expect(a.units).toEqual(b.units);
    expect(a.units).not.toEqual(c.units);
  });

  it('lands every counter of both forces on standable ground in its own area', () => {
    const o = order({
      sides: [
        { player: 'red', faction: 'Combine', forces: { MK5: 1, HVY: 4, GEV: 6, INF: 12 } },
        { player: 'blue', faction: 'Paneurope', forces: { MK3: 1, HVY: 3, HWZ: 2, INF: 18 } },
      ],
    });
    const state = CUSTOM.build({ order: o, seed: 0 });
    const map = mapOf(CUSTOM, state);
    expect(map).toBe(OGRE_MAP);
    const red = unitsOf(state, 'red');
    const blue = unitsOf(state, 'blue');
    expect(red.filter(isOgre)).toHaveLength(1);
    expect(blue.filter(isOgre)).toHaveLength(1);
    expect(red.filter((u) => u.kind === 'unit' && u.classId === 'HVY')).toHaveLength(4);
    // Twelve squads split 3/3/3/3.
    expect(red.filter((u) => u.kind === 'unit' && u.classId === 'INF')).toHaveLength(4);
    // A command post for the defence, placed by the terms.
    expect(blue.filter((u) => u.kind === 'unit' && u.classId === 'CP')).toHaveLength(1);
    for (const u of [...red, ...blue]) expect(terrainAt(map, u.pos)).not.toBe('crater');
    // The setup zones say where each side may rearrange: every counter is inside its own.
    const withSetup = CUSTOM.build({ order: o, seed: 0, setup: true });
    const zones = withSetup.setup!.zones;
    for (const u of unitsOf(withSetup, 'red'))
      expect(zones['red']!.hexes).toContain(`${u.pos.q},${u.pos.r}`);
    for (const u of unitsOf(withSetup, 'blue'))
      expect(zones['blue']!.hexes).toContain(`${u.pos.q},${u.pos.r}`);
    expect(withSetup.setup!.order).toEqual(['blue', 'red']);
  });

  it('keeps the screen under the central ceiling when the terms set one', () => {
    const state = CUSTOM.build({ order: order({ terms: { centralLimit: 10 } }), seed: 0 });
    const map = mapOf(CUSTOM, state);
    const forward = unitsOf(state, 'defender').filter((u) => areaOf(map, u.pos) === 'central');
    const strength = forward.reduce(
      (n, u) => n + (u.kind === 'unit' ? unitClassAttack(u.classId) * u.squads : 0),
      0,
    );
    expect(strength).toBeLessThanOrEqual(10);
  });

  it('plays on the green map, with the river between the sides', () => {
    const state = CUSTOM.build({ order: order({ terms: { map: { kind: 'gev' } } }), seed: 0 });
    const map = mapOf(CUSTOM, state);
    expect(map).toBe(GEV_MAP);
    expect(state.options.stackingLimit).toBe(5);
    expect(state.options.overrunCombat).toBe(true);
    for (const u of unitsOf(state, 'attacker')) expect(toOffset(u.pos).col).toBeLessThanOrEqual(6);
    for (const u of unitsOf(state, 'defender'))
      expect(toOffset(u.pos).col).toBeGreaterThanOrEqual(9);
    for (const u of [...unitsOf(state, 'attacker'), ...unitsOf(state, 'defender')]) {
      expect(terrainAt(map, u.pos)).not.toBe('water');
    }
  });

  it('generates a fresh board from a seed, the same one every time, with the areas rescaled', () => {
    const spec = { kind: 'ogre' as const, seed: 77, cols: 15, rows: 30, craterDensity: 0.2 };
    const a = customMap(spec);
    const b = customMap(spec);
    expect(a).toBe(b);
    expect(a.cols).toBe(15);
    expect(a.rows).toBe(30);
    expect(a.areaLines).toEqual({ north: 11, south: 24 });
    expect(a.id).not.toBe(OGRE_MAP.id);
    const state = CUSTOM.build({ order: order({ terms: { map: spec } }), seed: 0 });
    expect(mapOf(CUSTOM, state)).toBe(a);
    expect(state.mapId).toBe(a.id);
    // A board built for another player from the same order is the same board.
    expect(customMap(readTerms(order({ terms: { map: spec } }).terms).map)).toBe(a);
  });

  it('refuses a unit the game does not field, and clamps an absurd map', () => {
    expect(() => expandForces({ TARDIS: 1 })).toThrow(/not a unit/);
    expect(() => expandForces({ CRL: 1 })).toThrow(/not a unit/);
    const terms = readTerms({ map: { kind: 'gev', cols: 400, rows: 2 }, victory: 'nonsense' });
    expect(terms.map).toEqual({ kind: 'gev', cols: 40, rows: 12 });
    expect(terms.victory).toBe('command-post');
  });

  it('prices a force in armour units and squads', () => {
    expect(forceValue({ MK3: 1, HVY: 2, LT: 2, INF: 7, GEV: 0 })).toEqual({
      armorUnits: 17 + 2 + 1,
      squads: 7,
      counters: 1 + 2 + 2 + 3,
    });
    const lines = describeCustom(DEFAULT_CUSTOM);
    expect(lines[0]).toMatch(/^Map: Ogre map/);
    expect(lines[1]).toMatch(/Command post/);
    expect(lines[2]).toMatch(/attacking.*Ogre Mark III, 2 × Heavy Tank, 3 × GEV, 6 squads/);
  });
});

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

const wipe = (state: GameState, owner: string): GameState => ({
  ...state,
  units: Object.fromEntries(
    Object.entries(state.units).map(([id, u]) => [
      id,
      u.owner === owner && !(u.kind === 'unit' && u.classId === 'CP')
        ? { ...u, destroyed: true }
        : u,
    ]),
  ),
});

const killCp = (state: GameState): GameState => ({
  ...state,
  units: Object.fromEntries(
    Object.entries(state.units).map(([id, u]) => [
      id,
      u.kind === 'unit' && u.classId === 'CP' ? { ...u, destroyed: true } : u,
    ]),
  ),
});

const exitAttackers = (
  state: GameState,
  edge: 'north' | 'south' | 'east' | 'west',
  share = 1,
): GameState => {
  const mine = Object.values(state.units).filter((u) => u.owner === 'attacker' && onBoard(u));
  const leaving = new Set(mine.slice(0, Math.ceil(mine.length * share)).map((u) => u.id));
  return {
    ...state,
    units: Object.fromEntries(
      Object.entries(state.units).map(([id, u]) => [
        id,
        leaving.has(id)
          ? { ...u, offMap: edge }
          : u.owner === 'attacker'
            ? { ...u, destroyed: true }
            : u,
      ]),
    ),
  };
};

describe('how a custom battle ends', () => {
  const cp = CUSTOM.build({ order: order({ terms: { victory: 'command-post' } }), seed: 0 });

  it('command post: goes on while the attack is on the field and the post stands', () => {
    expect(CUSTOM.checkVictory(cp)).toBeNull();
  });

  it('command post: the six printed outcomes, read for a whole force', () => {
    expect(CUSTOM.checkVictory(wipe(killCp(cp), 'defender'))!.level).toBe('complete');
    expect(CUSTOM.checkVictory(wipe(killCp(cp), 'defender'))!.winners).toEqual(['attacker']);
    const away = CUSTOM.checkVictory(exitAttackers(killCp(cp), 'south'))!;
    expect(away).toMatchObject({ winners: ['attacker'], level: 'standard' });
    const dead = CUSTOM.checkVictory(wipe(killCp(cp), 'attacker'))!;
    expect(dead).toMatchObject({ winners: ['attacker'], level: 'marginal' });
    const gotAway = CUSTOM.checkVictory(exitAttackers(cp, 'south'))!;
    expect(gotAway).toMatchObject({ winners: ['defender'], level: 'marginal' });
    const held = CUSTOM.checkVictory(wipe(cp, 'attacker'))!;
    expect(held.winners).toEqual(['defender']);
    expect(held.level).toBe('complete'); // nothing of the defence was lost
  });

  it('command post: the turn limit ends it with the post standing', () => {
    const timed = CUSTOM.build({
      order: order({ terms: { victory: 'command-post', turnLimit: 3 } }),
      seed: 0,
    });
    expect(CUSTOM.checkVictory({ ...timed, turn: 3 })).toBeNull();
    expect(CUSTOM.checkVictory({ ...timed, turn: 4 })).toMatchObject({
      winners: ['defender'],
      level: 'standard',
    });
    expect(CUSTOM.checkVictory({ ...killCp(timed), turn: 4 })).toMatchObject({
      winners: ['attacker'],
      level: 'marginal',
    });
  });

  it('breakthrough: scores by the value that leaves by the far edge', () => {
    const bt = CUSTOM.build({ order: order({ terms: { victory: 'breakthrough' } }), seed: 0 });
    expect(bt.scenarioData['ogreEscapeEdge']).toBe('north');
    expect(CUSTOM.checkVictory(bt)).toBeNull();
    expect(CUSTOM.checkVictory(exitAttackers(bt, 'north'))).toMatchObject({
      winners: ['attacker'],
      level: 'complete',
    });
    // The Ogre alone is most of the force's value: it and nothing else gets through.
    const ogreOnly: GameState = {
      ...bt,
      units: Object.fromEntries(
        Object.entries(bt.units).map(([id, u]) => [
          id,
          u.owner !== 'attacker'
            ? u
            : isOgre(u)
              ? { ...u, offMap: 'north' as const }
              : { ...u, destroyed: true },
        ]),
      ),
    };
    const verdict = CUSTOM.checkVictory(ogreOnly)!;
    expect(verdict.winners).toEqual(['attacker']);
    expect(['standard', 'complete']).toContain(verdict.level);
    // Leaving by the wrong edge is not a breakthrough.
    expect(CUSTOM.checkVictory(exitAttackers(bt, 'south'))).toMatchObject({
      winners: ['defender'],
      level: 'complete',
    });
    expect(CUSTOM.checkVictory(wipe(bt, 'attacker'))).toMatchObject({
      winners: ['defender'],
      level: 'complete',
    });
  });

  it('attrition: compares victory points at the limit, and the defence holds a tie', () => {
    const at = CUSTOM.build({
      order: order({ terms: { victory: 'attrition', turnLimit: 5 } }),
      seed: 0,
    });
    expect(CUSTOM.checkVictory(at)).toBeNull();
    const score = (a: number, d: number, turn = 6): GameState => ({
      ...at,
      turn,
      players: {
        ...at.players,
        attacker: { ...at.players['attacker']!, victoryPoints: a },
        defender: { ...at.players['defender']!, victoryPoints: d },
      },
    });
    expect(CUSTOM.checkVictory(score(10, 10))).toMatchObject({
      winners: ['defender'],
      level: 'marginal',
    });
    expect(CUSTOM.checkVictory(score(30, 10))).toMatchObject({
      winners: ['attacker'],
      level: 'complete',
    });
    expect(CUSTOM.checkVictory(score(16, 10))).toMatchObject({
      winners: ['attacker'],
      level: 'standard',
    });
    expect(CUSTOM.checkVictory(score(12, 10))).toMatchObject({
      winners: ['attacker'],
      level: 'marginal',
    });
    expect(CUSTOM.checkVictory(score(9, 12))).toMatchObject({
      winners: ['defender'],
      level: 'marginal',
    });
    // Elimination ends it before the limit.
    expect(CUSTOM.checkVictory(wipe(score(4, 20, 2), 'attacker'))).toMatchObject({
      winners: ['defender'],
    });
  });

  it('plays: a whole first turn goes through the engine on a custom board', () => {
    const state = CUSTOM.build({ order: order({ seed: 21 }), seed: 0 });
    const map = mapOf(CUSTOM, state);
    let s = state;
    for (let i = 0; i < 12; i++) {
      const who = s.playerOrder[s.activePlayerIndex]!;
      const out = applyCommand(s, { type: 'endPhase', by: who }, map, CUSTOM.checkVictory);
      expect(out.result.ok).toBe(true);
      s = out.state;
    }
    expect(s.turn).toBeGreaterThan(1);
    expect(s.victory).toBeNull();
  });
});

const unitClassAttack = (id: string): number => unitClass(id as never).attack;
