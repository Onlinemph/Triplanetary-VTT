/**
 * The computer opponent: it plays every seat of every scenario to a finish
 * without stalling, proposes orders the engine accepts, and uses the special
 * orders the scenarios add — reserves, orbital strikes, deployment.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { type GameState, activePlayer, setupActor } from '../../src/ogre/engine/types.js';
import { overrunActor } from '../../src/ogre/engine/overrun.js';
import { aiPlan, decisionKey } from '../../src/ogre/ai/player.js';
import { ASSAULT, SCENARIOS, scenarioById } from '../../src/ogre/scenarios/index.js';
import type { ScenarioDef } from '../../src/ogre/scenarios/types.js';
import type { OrderOfBattle } from '@campaign/orders.js';

/** The shell's loop, in miniature: plan, dispatch one at a time, re-plan on change. */
const playOut = (
  def: ScenarioDef,
  start: GameState,
  cap = 6000,
): { state: GameState; commands: number; refused: number } => {
  let s = start;
  let commands = 0;
  let refused = 0;
  let plan: { key: string; commands: ReturnType<typeof aiPlan> } | null = null;
  for (let i = 0; i < cap && !s.victory; i++) {
    const who = setupActor(s) ?? overrunActor(s) ?? activePlayer(s);
    const k = decisionKey(s);
    if (!plan || plan.key !== k) plan = { key: k, commands: aiPlan(s, def.map, who) };
    const cmd = plan.commands.shift();
    if (!cmd) {
      // The plan must always end with the order that moves on; an empty plan
      // here is the failure this test exists to catch.
      throw new Error(`the AI had nothing to say at ${k}`);
    }
    const out = applyCommand(s, cmd, def.map, def.checkVictory);
    commands++;
    if (!out.result.ok) {
      refused++;
      continue;
    }
    s = out.state;
  }
  return { state: s, commands, refused };
};

describe('the computer opponent', () => {
  it('plays Mark III Attack to a verdict from both seats', () => {
    const def = scenarioById('mark-iii-attack')!;
    const played = playOut(def, def.build({ seed: 21, setup: true }));
    expect(played.state.victory).not.toBeNull();
    // The rules of thumb are asked of the engine's previews, so almost
    // everything it proposes is legal.
    expect(played.refused).toBeLessThan(played.commands * 0.1);
  });

  it('finishes every scenario in the picker', () => {
    for (const def of SCENARIOS) {
      const played = playOut(def, def.build({ seed: 5, setup: true }), 9000);
      expect(played.state.victory, def.name).not.toBeNull();
    }
  });

  it('brings the reserves on and calls the strikes down in an assault', () => {
    const order: OrderOfBattle = {
      battleId: 'drop-ai-1-mars:0',
      seed: 12,
      scenarioId: 'assault',
      sides: [
        { player: 'combine', faction: 'North American Combine', forces: { HVY: 3, MSL: 2, INF: 9, MK3: 1 } },
        { player: 'paneuro', faction: 'Paneuropean Federation', forces: { HVY: 2, INF: 12 } },
      ],
      terms: {
        world: 'mars',
        profile: 'dead',
        entryEdge: 'west',
        reaction: { HVY: 2, INF: 3 },
        reactionTurn: 3,
        orbitalStrikes: [3, 2],
      },
    };
    const played = playOut(ASSAULT, ASSAULT.build({ seed: order.seed, order, setup: true }));
    const text = played.state.log.map((e) => e.text).join('\n');
    expect(text).toMatch(/Orbital strike/);
    expect(played.state.victory).not.toBeNull();
    // Either the reserves came on, or the battle ended before turn 3 — and a
    // battle that short is its own kind of proof.
    if (played.state.turn >= 3 || played.state.log.some((e) => e.turn >= 3)) {
      expect(text).toMatch(/races back from dispersal/);
    }
  });

  it('says nothing when the decision is not its own', () => {
    const def = scenarioById('crossing')!;
    const s = def.build({ seed: 2, setup: true });
    // The defence sets up first in The Crossing: the Ogre, who moves first,
    // has nothing to say yet, and the defence has exactly one thing.
    expect(setupActor(s)).toBe(s.playerOrder[1]);
    expect(aiPlan(s, def.map, s.playerOrder[0]!)).toEqual([]);
    expect(aiPlan(s, def.map, s.playerOrder[1]!)).toEqual([
      { type: 'finishSetup', by: s.playerOrder[1] },
    ]);
  });
});
