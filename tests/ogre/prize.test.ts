/**
 * Orbital Drop §6.02: "the base is captured intact in the second case only"
 * — when the garrison is gone, not when the base is razed. An assault the
 * computer fights against a base's militia must therefore end with the
 * garrison dead and the building standing, not the other way round, and the
 * scenario says so to the computer with `scenarioData.prizeIntact`.
 */

import { describe, expect, it } from 'vitest';
import { ASSAULT } from '../../src/ogre/scenarios/index.js';
import { playOrder } from '../../src/ogre/ai/simulate.js';
import type { OrderOfBattle } from '../../src/campaign/orders.js';

const order = (seed: number): OrderOfBattle => ({
  battleId: `drop-${seed}-mercury:0`,
  seed,
  scenarioId: 'assault',
  sides: [
    { player: 'combine', faction: 'North American Combine', forces: { HVY: 1, MSL: 1, INF: 15 } },
    { player: 'militia', faction: 'Base Militia', forces: { INF: 6 } },
  ],
  terms: {
    world: 'mercury',
    profile: 'dead',
    base: 'admin',
    entryEdge: 'west',
    reaction: {},
    reactionTurn: 5,
    orbitalStrikes: [],
  },
});

describe('an assault wants the base intact', () => {
  it('marks the prize for the computer', () => {
    const s = ASSAULT.build({ seed: 1, order: order(1) });
    expect(s.scenarioData['prizeIntact']).toBe(true);
  });

  it('hunts the militia down and takes the base whole', () => {
    for (const seed of [1, 2, 3]) {
      const fought = playOrder(ASSAULT, order(seed), undefined, { maxTurns: 40 });
      expect(`${seed}: ${fought.result.winners.join()} ${fought.result.level}`).toBe(
        `${seed}: combine complete`,
      );
      const admin = Object.values(fought.state.buildings).find((b) => b.kind === 'admin')!;
      expect(admin.destroyed).toBe(false);
    }
  }, 60_000);
});
