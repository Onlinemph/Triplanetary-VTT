/**
 * The computer opponent: it plays every seat of every scenario to a finish
 * without stalling, proposes orders the engine accepts, and uses the special
 * orders the scenarios add — reserves, orbital strikes, deployment.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { type GameState, activePlayer, setupActor } from '../../src/ogre/engine/types.js';
import { overrunActor } from '../../src/ogre/engine/overrun.js';
import { neighbors } from '../../src/ogre/engine/hex.js';
import { inBounds, terrainAt } from '../../src/ogre/engine/map.js';
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
        {
          player: 'combine',
          faction: 'North American Combine',
          forces: { HVY: 3, MSL: 2, INF: 9, MK3: 1 },
        },
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
    // has nothing to say yet, and the defence rearranges its counters and
    // then says it is ready.
    expect(setupActor(s)).toBe(s.playerOrder[1]);
    expect(aiPlan(s, def.map, s.playerOrder[0]!)).toEqual([]);
    const plan = aiPlan(s, def.map, s.playerOrder[1]!);
    expect(plan[plan.length - 1]).toEqual({ type: 'finishSetup', by: s.playerOrder[1] });
    for (const cmd of plan.slice(0, -1)) expect(cmd.type).toBe('placeUnit');
  });
});

describe('the computer Ogre in a crater pocket', () => {
  /**
   * Hex 9,13 on the printed map is a pocket: craters on four sides, the two
   * open sides both farther from the command post than the pocket itself as
   * the crow flies. An Ogre that counted straight lines would sit there
   * until the game ended. It has to walk around.
   */
  it('walks out, even when the way out is a step back', () => {
    const def = scenarioById('mark-iii-attack')!;
    const start = def.build({ seed: 5 });
    const ogre = Object.values(start.units).find((u) => u.kind === 'ogre')!;
    const cp = Object.values(start.units).find((u) => u.kind === 'unit' && u.classId === 'CP')!;
    const pocket = { q: 9, r: 13 };
    // A tank on the one equal-distance hex three steps west, so the only
    // moves left all look like retreats.
    const cork = Object.values(start.units).find(
      (u) => u.owner === 'defense' && u.kind === 'unit' && u.classId === 'HVY',
    )!;
    let state: GameState = {
      ...start,
      turn: 3,
      phase: 'movement',
      activePlayerIndex: 0,
      units: {
        ...start.units,
        [ogre.id]: { ...ogre, pos: pocket, phaseStart: pocket, movementEnded: false },
        [cork.id]: { ...cork, pos: { q: 7, r: 13 }, phaseStart: { q: 7, r: 13 } },
      },
    };
    // Steps to the post over ground an Ogre can cross.
    const walk = (from: { q: number; r: number }): number => {
      const seen = new Map<string, number>([[`${from.q},${from.r}`, 0]]);
      const queue = [from];
      for (let i = 0; i < queue.length; i++) {
        const at = queue[i]!;
        const d = seen.get(`${at.q},${at.r}`)!;
        if (at.q === cp.pos.q && at.r === cp.pos.r) return d;
        for (const n of neighbors(at)) {
          const k = `${n.q},${n.r}`;
          if (seen.has(k) || !inBounds(def.map, n)) continue;
          const t = terrainAt(def.map, n, state.terrainOverrides);
          if (t === 'crater' || t === 'water') continue;
          seen.set(k, d + 1);
          queue.push(n);
        }
      }
      return Infinity;
    };
    const before = walk(pocket);
    // Three of the Ogre's movement phases, with the defence standing still:
    // out of the pocket, through the cork, and on.
    for (let phases = 0; phases < 3; phases++) {
      for (const cmd of aiPlan(state, def.map, 'ogre')) {
        if (cmd.type !== 'moveUnit' && cmd.type !== 'ram') continue;
        const out = applyCommand(state, cmd, def.map);
        if (out.result.ok) state = out.state;
      }
      expect(state.units[ogre.id]!.pos).not.toEqual(pocket);
      // Round the clock to the Ogre's next movement phase; nobody else acts.
      const turn = state.turn;
      for (let guard = 0; guard < 40; guard++) {
        if (state.turn > turn && state.phase === 'movement' && activePlayer(state) === 'ogre')
          break;
        const out = applyCommand(state, { type: 'endPhase', by: activePlayer(state) }, def.map);
        expect(out.result.ok).toBe(true);
        state = out.state;
      }
    }
    // Real progress by ground, the ram and the pocket notwithstanding.
    expect(walk(state.units[ogre.id]!.pos)).toBeLessThanOrEqual(before - 6);
    expect(state.units[cork.id]!.destroyed).toBe(true);
  });
});
