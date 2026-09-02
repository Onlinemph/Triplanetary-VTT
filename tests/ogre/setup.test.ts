/**
 * Deployment: the players rearrange the seeded board before turn 1, inside
 * the printed areas and under the printed ceilings, and nothing else happens
 * until every side has said it is ready.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { areaOf } from '../../src/ogre/engine/map.js';
import { key, parseKey } from '../../src/ogre/engine/hex.js';
import { legalSetupHexes, limitStatus } from '../../src/ogre/engine/setup.js';
import {
  type ConventionalUnit,
  type GameState,
  isOgre,
  setupActor,
} from '../../src/ogre/engine/types.js';
import { scenarioById, SCENARIOS } from '../../src/ogre/scenarios/index.js';
import { DEFENSE_PLAYER, OGRE_PLAYER } from '../../src/ogre/scenarios/ogreAttack.js';

const scenario = scenarioById('mark-iii-attack')!;
const map = scenario.map;

const defenders = (s: GameState): ConventionalUnit[] =>
  Object.values(s.units).filter(
    (u): u is ConventionalUnit => u.owner === DEFENSE_PLAYER && u.kind === 'unit',
  );

describe('deployment', () => {
  const start = scenario.build({ seed: 31, setup: true });

  it('opens with the defence setting up, and nothing else allowed', () => {
    expect(setupActor(start)).toBe(DEFENSE_PLAYER);
    const moved = applyCommand(start, { type: 'endPhase', by: OGRE_PLAYER }, map);
    expect(moved.result.ok).toBe(false);
    const early = applyCommand(start, { type: 'finishSetup', by: OGRE_PLAYER }, map);
    expect(early.result.ok).toBe(false);
  });

  it('is not opened for a board built without asking', () => {
    expect(scenario.build({ seed: 31 }).setup ?? null).toBeNull();
  });

  it('lets a counter move anywhere inside its area and nowhere outside it', () => {
    const inf = defenders(start).find((u) => u.classId === 'INF')!;
    const legal = legalSetupHexes(start, map, inf);
    expect(legal.length).toBeGreaterThan(10);
    for (const h of legal) expect(areaOf(map, h)).not.toBe('south');

    const south = parseKey(start.setup!.zones[OGRE_PLAYER]!.hexes[0]!);
    const refused = applyCommand(
      start,
      { type: 'placeUnit', by: DEFENSE_PLAYER, unit: inf.id, at: south },
      map,
    );
    expect(refused.result.ok).toBe(false);

    const placed = applyCommand(
      start,
      { type: 'placeUnit', by: DEFENSE_PLAYER, unit: inf.id, at: legal[0]! },
      map,
    );
    expect(placed.result.ok).toBe(true);
    expect(key(placed.state.units[inf.id]!.pos)).toBe(key(legal[0]!));
  });

  it('holds the Central Area to 20 attack strength points', () => {
    const status = limitStatus(start, DEFENSE_PLAYER);
    expect(status).toHaveLength(1);
    expect(status[0]!.max).toBe(20);
    expect(status[0]!.used).toBeLessThanOrEqual(20);

    // Fill the central area past the line and the engine refuses.
    let s = start;
    const central = start.setup!.zones[DEFENSE_PLAYER]!.limits![0]!.hexes.map(parseKey);
    const armour = defenders(start).filter((u) => u.classId !== 'INF' && u.classId !== 'CP');
    let refusedOnce = false;
    for (const u of armour) {
      const free = central.find((h) => legalSetupHexes(s, map, u).some((x) => key(x) === key(h)));
      if (!free) continue;
      const out = applyCommand(
        s,
        { type: 'placeUnit', by: DEFENSE_PLAYER, unit: u.id, at: free },
        map,
      );
      if (!out.result.ok) {
        expect(out.result.ok ? '' : out.result.reason).toMatch(/attack strength/);
        refusedOnce = true;
        break;
      }
      s = out.state;
    }
    expect(refusedOnce).toBe(true);
  });

  it('swaps two counters when one is dropped on the other', () => {
    const [a, b] = defenders(start).filter((u) => u.classId === 'INF');
    const swapped = applyCommand(
      start,
      { type: 'placeUnit', by: DEFENSE_PLAYER, unit: a!.id, at: b!.pos },
      map,
    );
    expect(swapped.result.ok).toBe(true);
    expect(key(swapped.state.units[a!.id]!.pos)).toBe(key(b!.pos));
    expect(key(swapped.state.units[b!.id]!.pos)).toBe(key(a!.pos));
  });

  it('hands the counters to the Ogre, then starts the game', () => {
    const afterDefence = applyCommand(start, { type: 'finishSetup', by: DEFENSE_PLAYER }, map);
    expect(afterDefence.result.ok).toBe(true);
    expect(setupActor(afterDefence.state)).toBe(OGRE_PLAYER);

    const ogre = Object.values(afterDefence.state.units).find(isOgre)!;
    const edge = afterDefence.state.setup!.zones[OGRE_PLAYER]!.hexes.map(parseKey);
    const elsewhere = edge.find((h) => key(h) !== key(ogre.pos))!;
    const moved = applyCommand(
      afterDefence.state,
      { type: 'placeUnit', by: OGRE_PLAYER, unit: ogre.id, at: elsewhere },
      map,
    );
    expect(moved.result.ok).toBe(true);

    const begun = applyCommand(moved.state, { type: 'finishSetup', by: OGRE_PLAYER }, map);
    expect(begun.result.ok).toBe(true);
    expect(begun.state.setup ?? null).toBeNull();
    // Turn 1 runs as it always did.
    const first = applyCommand(begun.state, { type: 'endPhase', by: OGRE_PLAYER }, map);
    expect(first.result.ok).toBe(true);
    expect(first.state.phase).toBe('movement');
  });

  it('gives every scenario a deployment step with both sides zoned', () => {
    for (const def of SCENARIOS) {
      const s = def.build({ seed: 9, setup: true });
      expect(s.setup).not.toBeNull();
      for (const p of s.playerOrder) {
        expect(s.setup!.zones[p]!.hexes.length).toBeGreaterThan(0);
      }
      // The seeded board is already legal under its own ceilings.
      for (const l of limitStatus(s, setupActor(s)!)) expect(l.used).toBeLessThanOrEqual(l.max);
    }
  });
});
