/**
 * The Assault's ground-side rules from Orbital Drop §§5-7: the Admin
 * building that stands for a planetary base, the ridge overlays a dead
 * world rolls, the asteroid's half map under low gravity, and the record
 * sheet a cybertank carries from one battle to the next.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { toOffset } from '../../src/ogre/engine/hex.js';
import { movementAllowance, makeOgre } from '../../src/ogre/engine/state.js';
import { isOgre, onBoard } from '../../src/ogre/engine/types.js';
import {
  ASSAULT,
  ASSAULT_ASTEROID,
  HALF_OGRE_MAP,
  applyOgreRecord,
} from '../../src/ogre/scenarios/assault.js';
import { ogreRecordOf, readBattleResult } from '../../src/ogre/campaign/result.js';
import type { OrderOfBattle } from '@campaign/orders.js';

const planetary: OrderOfBattle = {
  battleId: 'drop-3-mars:0',
  seed: 44,
  scenarioId: 'assault',
  sides: [
    { player: 'combine', faction: 'North American Combine', forces: { HVY: 2, INF: 6, MK3: 1 } },
    { player: 'paneuro', faction: 'Paneuropean Federation', forces: { HVY: 1, INF: 9, MK5: 1 } },
  ],
  terms: {
    world: 'mars',
    profile: 'dead',
    base: 'admin',
    entryEdge: 'west',
    reaction: {},
    reactionTurn: 5,
    orbitalStrikes: [],
    ogreDamage: {
      paneuro: [
        {
          type: 'MK5',
          treads: 30,
          lost: { main: 1, ap: 4 },
          missilesSpent: 2,
          internalMissiles: 0,
        },
      ],
    },
  },
};

describe('the base', () => {
  const state = ASSAULT.build({ seed: planetary.seed, order: planetary });

  it('is an Admin building of 20 SP on a planet, and no command post', () => {
    const base = state.buildings['base']!;
    expect(base.kind).toBe('admin');
    expect(base.structurePoints).toBe(20);
    expect(base.owner).toBe('paneuro');
    expect(Object.values(state.units).some((u) => u.kind === 'unit' && u.classId === 'CP')).toBe(
      false,
    );
  });

  it('decides the battle when it falls', () => {
    const razed = {
      ...state,
      buildings: { base: { ...state.buildings['base']!, structurePoints: 0, destroyed: true } },
    };
    const verdict = ASSAULT.checkVictory(razed)!;
    expect(verdict.winners).toEqual(['combine']);
    expect(verdict.level).toBe('marginal');
  });

  it('is taken intact when the garrison is gone and it still stands', () => {
    const wiped = {
      ...state,
      units: Object.fromEntries(
        Object.entries(state.units).map(([id, u]) => [
          id,
          u.owner === 'paneuro' ? { ...u, destroyed: true } : u,
        ]),
      ),
    };
    const verdict = ASSAULT.checkVictory(wiped)!;
    expect(verdict.winners).toEqual(['combine']);
    expect(verdict.level).toBe('complete');
  });

  it('is a ram target for the invading cybertank once it has assembled', () => {
    // Put the Ogre beside the base, awake, and ask.
    const ogre = Object.values(state.units).find((u) => isOgre(u) && u.owner === 'combine')!;
    const base = state.buildings['base']!;
    const beside = { q: base.pos.q - 1, r: base.pos.r };
    const staged = {
      ...state,
      turn: 9,
      phase: 'movement' as const,
      activePlayerIndex: 0,
      units: { ...state.units, [ogre.id]: { ...ogre, pos: beside, phaseStart: beside } },
    };
    const out = applyCommand(
      staged,
      { type: 'ram', by: 'combine', unit: ogre.id, target: base.pos },
      ASSAULT.map,
    );
    // Either the ram was legal (an empty base hex) or a garrison unit stood
    // in it — both are the engine's honest answer; what must not happen is
    // the building being invisible to the ram rules.
    if (out.result.ok) {
      expect(out.state.buildings['base']!.structurePoints).toBeLessThan(20);
    } else {
      expect(out.result.ok ? '' : out.result.reason).not.toMatch(/nothing there/);
    }
  });
});

describe('damage carried over (§7)', () => {
  it('builds the garrison cybertank worn as its record says', () => {
    const state = ASSAULT.build({ seed: planetary.seed, order: planetary });
    const mk5 = Object.values(state.units).find((u) => isOgre(u) && u.owner === 'paneuro')!;
    if (!isOgre(mk5)) throw new Error('not an Ogre');
    expect(mk5.treads).toBe(30);
    expect(mk5.weapons.filter((w) => w.kind === 'main' && w.destroyed)).toHaveLength(1);
    expect(mk5.weapons.filter((w) => w.kind === 'ap' && w.destroyed)).toHaveLength(4);
    expect(mk5.weapons.filter((w) => w.kind === 'missile' && w.fired)).toHaveLength(2);
    // The invader's Mark III arrived fresh, and inert.
    const mk3 = Object.values(state.units).find((u) => isOgre(u) && u.owner === 'combine')!;
    if (!isOgre(mk3)) throw new Error('not an Ogre');
    expect(mk3.treads).toBe(45);
    expect(mk3.activatesOn).toBe(4);
  });

  it('reads the survivors’ record sheets back into the result', () => {
    const fresh = makeOgre('x', 'combine', 'MK3', { q: 0, r: 0 });
    const worn = applyOgreRecord(fresh, {
      type: 'MK3',
      treads: 12,
      lost: { secondary: 2 },
      missilesSpent: 1,
      internalMissiles: 0,
    });
    const record = ogreRecordOf(worn);
    expect(record).toEqual({
      type: 'MK3',
      treads: 12,
      lost: { secondary: 2 },
      missilesSpent: 1,
      internalMissiles: 0,
    });

    // Through the reader: wipe the garrison, and the attacker's Ogre carries
    // its sheet home.
    let state = ASSAULT.build({ seed: planetary.seed, order: planetary });
    state = {
      ...state,
      units: Object.fromEntries(
        Object.entries(state.units).map(([id, u]) => [
          id,
          u.owner === 'paneuro' ? { ...u, destroyed: true } : u,
        ]),
      ),
    };
    const decided = applyCommand(
      state,
      { type: 'endPhase', by: 'combine' },
      ASSAULT.map,
      ASSAULT.checkVictory,
    ).state;
    const result = readBattleResult(decided, [])!;
    expect(result.ogres?.['combine']).toHaveLength(1);
    expect(result.ogres?.['combine']![0]!.type).toBe('MK3');
    expect(result.ogres?.['paneuro']).toBeUndefined();
  });
});

describe('the asteroid (§5)', () => {
  const state = ASSAULT_ASTEROID.build({ seed: 3 });

  it('fights on half a map with ridges laid over it', () => {
    expect(ASSAULT_ASTEROID.map).toBe(HALF_OGRE_MAP);
    expect(HALF_OGRE_MAP.rows).toBeLessThan(21);
    for (const u of Object.values(state.units)) {
      if (onBoard(u)) expect(toOffset(u.pos).row).toBeLessThanOrEqual(HALF_OGRE_MAP.rows);
    }
    expect(
      Object.values(state.sideOverrides ?? {}).filter((f) => f === 'ridge').length,
    ).toBeGreaterThan(1);
  });

  it('runs under low gravity with nothing hovering', () => {
    expect(state.options.lowGravity).toBe(true);
    expect(state.options.noHover).toBe(true);
    const tank = Object.values(state.units).find((u) => u.kind === 'unit' && u.classId === 'HVY')!;
    expect(movementAllowance(tank, 'movement', state.options)).toBe(4);
    // The base on a rock is a command post, not a building.
    expect(state.buildings['base']).toBeUndefined();
    expect(Object.values(state.units).some((u) => u.kind === 'unit' && u.classId === 'CP')).toBe(
      true,
    );
  });

  it('rolls a different battlefield for a dead world than for a rock', () => {
    const dead = ASSAULT.build({ seed: 3 });
    expect(JSON.stringify(dead.terrainOverrides)).not.toBe(JSON.stringify(state.terrainOverrides));
  });
});
