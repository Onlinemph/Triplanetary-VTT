/**
 * The Train: the scenario that gives Section 9 somewhere to go, and the exit
 * goals the computer learned for it — a counter whose job is leaving heads
 * for the edge, its side stays with it, the other side goes for it. The
 * same goal is what makes a breakthrough force in the custom battle actually
 * try to break through.
 */

import { describe, expect, it } from 'vitest';
import { toOffset } from '../../src/ogre/engine/hex.js';
import { hasRoute } from '../../src/ogre/engine/map.js';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import {
  setupActor,
  type GameState,
  type Unit,
  isOgre,
  onBoard,
} from '../../src/ogre/engine/types.js';
import { aiPlan } from '../../src/ogre/ai/player.js';
import { playGame } from '../../src/ogre/ai/simulate.js';
import {
  CUSTOM,
  DEFAULT_CUSTOM,
  ESCORT_PLAYER,
  RAIDER_PLAYER,
  TRAIN,
  mapOf,
  railLine,
  scenarioById,
} from '../../src/ogre/scenarios/index.js';
import type { Command } from '../../src/ogre/engine/commands.js';

const map = TRAIN.map;
const trainOf = (state: GameState): Unit =>
  Object.values(state.units).find((u) => u.kind === 'unit' && u.classId === 'TRAIN')!;
const col = (u: Unit): number => toOffset(u.pos).col;

/** A game opens in the recovery phase; the decisions start with movement. */
const toMovement = (state: GameState, check = TRAIN.checkVictory): GameState => {
  let s = state;
  for (let guard = 0; guard < 4 && s.phase !== 'movement'; guard++) {
    s = applyCommand(
      s,
      { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! },
      map,
      check,
    ).state;
  }
  return s;
};

/** Dispatch a plan the way the shell does: in order, skipping what is refused. */
const run = (state: GameState, plan: readonly Command[]): GameState => {
  let s = state;
  for (const cmd of plan) {
    const out = applyCommand(s, cmd, map, TRAIN.checkVictory);
    if (out.result.ok) s = out.state;
  }
  return s;
};

describe('The Train', () => {
  const state = TRAIN.build({ seed: 5 });

  it('is in the scenario table', () => {
    expect(scenarioById('train')).toBe(TRAIN);
    expect(state.playerOrder).toEqual([ESCORT_PLAYER, RAIDER_PLAYER]);
  });

  it('puts the train at the west end of the line, rolling, with six squads aboard', () => {
    const line = railLine(map);
    expect(line.length).toBe(map.cols);
    const train = trainOf(state);
    expect(train.pos).toEqual(line[0]);
    expect(hasRoute(map, train.pos, 'rail')).toBe(true);
    expect((train as { trainSpeed?: number }).trainSpeed).toBe(2);

    const riders = Object.values(state.units).filter(
      (u) => u.kind === 'unit' && u.ridingOn === train.id,
    );
    expect(riders.reduce((n, u) => n + (u.kind === 'unit' ? u.squads : 0), 0)).toBe(6);
    for (const r of riders) expect(r.pos).toEqual(train.pos);
  });

  it('forms the escort up in the west and the raiders in the east', () => {
    const escort = Object.values(state.units).filter(
      (u) => u.owner === ESCORT_PLAYER && u.kind === 'unit' && u.classId !== 'TRAIN' && !u.ridingOn,
    );
    const raiders = Object.values(state.units).filter((u) => u.owner === RAIDER_PLAYER);
    expect(escort.length).toBe(12);
    expect(raiders.length).toBeGreaterThan(10);
    for (const u of escort) expect(col(u)).toBeLessThanOrEqual(Math.round(map.cols / 4));
    for (const u of raiders) expect(col(u)).toBeGreaterThanOrEqual(Math.round(map.cols / 2));
  });

  it('tells the computer who is leaving, by which edge, and which counter has to make it', () => {
    expect(state.scenarioData['exitEdge']).toBe('east');
    expect(state.scenarioData['exitSide']).toBe(ESCORT_PLAYER);
    expect(state.scenarioData['exitUnits']).toEqual([trainOf(state).id]);
  });

  it('keeps the train on the rails during deployment', () => {
    let s = TRAIN.build({ seed: 5, setup: true });
    expect(setupActor(s)).toBe(RAIDER_PLAYER);
    s = applyCommand(s, { type: 'finishSetup', by: RAIDER_PLAYER }, map).state;
    expect(setupActor(s)).toBe(ESCORT_PLAYER);
    const train = trainOf(s);
    const line = railLine(map);
    const offRail = { q: line[0]!.q, r: line[0]!.r + 1 };
    const refused = applyCommand(
      s,
      { type: 'placeUnit', by: ESCORT_PLAYER, unit: train.id, at: offRail },
      map,
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? '' : refused.result.reason).toMatch(/rails/);
    const moved = applyCommand(
      s,
      { type: 'placeUnit', by: ESCORT_PLAYER, unit: train.id, at: line[1]! },
      map,
    );
    expect(moved.result.ok).toBe(true);
    // The riders came with it.
    for (const r of Object.values(moved.state.units).filter(
      (u) => u.kind === 'unit' && u.ridingOn === train.id,
    )) {
      expect(r.pos).toEqual(line[1]);
    }
  });

  it('ends when the train leaves east, dies, or runs out of time', () => {
    const train = trainOf(state);
    const withTrain = (patch: Partial<Unit>): GameState => ({
      ...state,
      units: { ...state.units, [train.id]: { ...train, ...patch } as Unit },
    });
    expect(TRAIN.checkVictory(state)).toBeNull();
    expect(TRAIN.checkVictory(withTrain({ offMap: 'east' }))).toMatchObject({
      winners: [ESCORT_PLAYER],
      level: 'complete',
    });
    expect(TRAIN.checkVictory(withTrain({ offMap: 'west' }))).toBeNull();
    expect(TRAIN.checkVictory(withTrain({ destroyed: true }))).toMatchObject({
      winners: [RAIDER_PLAYER],
      level: 'complete',
    });
    expect(TRAIN.checkVictory({ ...state, turn: 13 })).toMatchObject({
      winners: [RAIDER_PLAYER],
      level: 'standard',
    });
    const raidersGone: GameState = {
      ...state,
      units: Object.fromEntries(
        Object.entries(state.units).map(([id, u]) => [
          id,
          u.owner === RAIDER_PLAYER ? { ...u, destroyed: true } : u,
        ]),
      ),
    };
    expect(TRAIN.checkVictory(raidersGone)).toMatchObject({ winners: [ESCORT_PLAYER] });
  });

  it('grades the escort’s win by what it kept', () => {
    const train = trainOf(state);
    const bled: GameState = {
      ...state,
      units: Object.fromEntries(
        Object.entries(state.units).map(([id, u]) => [
          id,
          id === train.id
            ? { ...u, offMap: 'east' as const }
            : u.owner === ESCORT_PLAYER && u.kind === 'unit' && !u.ridingOn
              ? { ...u, destroyed: true }
              : u,
        ]),
      ),
    };
    expect(TRAIN.checkVictory(bled)).toMatchObject({ winners: [ESCORT_PLAYER], level: 'standard' });
  });
});

describe('the computer in a scenario about leaving', () => {
  it('opens the train up and runs it east', () => {
    const state = toMovement(TRAIN.build({ seed: 5 }));
    const before = trainOf(state);
    const plan = aiPlan(state, map, ESCORT_PLAYER);
    expect(
      plan.some((c) => c.type === 'setTrainSpeed' && c.unit === before.id && c.change === 1),
    ).toBe(true);
    const after = trainOf(run(state, plan));
    expect((after as { trainSpeed?: number }).trainSpeed).toBe(3);
    expect(col(after)).toBeGreaterThan(col(before));
    expect(hasRoute(map, after.pos, 'rail')).toBe(true);
  });

  it('sends the raiders after the train, not after the nearest escort', () => {
    // The escort has moved; now it is the raiders' turn.
    let s = toMovement(TRAIN.build({ seed: 5 }));
    s = run(s, aiPlan(s, map, ESCORT_PLAYER));
    // Skip to the raiders' movement phase.
    for (
      let guard = 0;
      guard < 6 && !(s.phase === 'movement' && s.activePlayerIndex === 1);
      guard++
    ) {
      s = applyCommand(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! }, map).state;
    }
    expect(s.activePlayerIndex).toBe(1);
    const train = trainOf(s);
    const plan = aiPlan(s, map, RAIDER_PLAYER);
    const moves = plan.filter((c) => c.type === 'moveUnit');
    expect(moves.length).toBeGreaterThan(0);
    let closer = 0;
    for (const m of moves) {
      if (m.type !== 'moveUnit') continue;
      const u = s.units[m.unit]!;
      const dest = m.path[m.path.length - 1]!;
      const from = Math.abs(toOffset(u.pos).col - toOffset(train.pos).col);
      const to = Math.abs(toOffset(dest).col - toOffset(train.pos).col);
      if (to < from) closer++;
    }
    expect(closer).toBeGreaterThan(moves.length / 2);
  });

  it('plays the scenario to a verdict', () => {
    const result = playGame(TRAIN, 3, undefined, { maxTurns: 20 });
    expect(result.finished).toBe(true);
    expect([ESCORT_PLAYER, RAIDER_PLAYER]).toContain(result.winners[0]);
    expect(result.turns).toBeLessThanOrEqual(13);
  });

  it('drives a breakthrough force for the far edge, armour and all', () => {
    const order = {
      ...DEFAULT_CUSTOM,
      seed: 11,
      terms: { ...DEFAULT_CUSTOM.terms, victory: 'breakthrough' as const },
    };
    const opening = CUSTOM.build({ order, seed: 0 });
    const board = mapOf(CUSTOM, opening);
    let state = opening;
    for (let guard = 0; guard < 4 && state.phase !== 'movement'; guard++) {
      state = applyCommand(
        state,
        { type: 'endPhase', by: state.playerOrder[state.activePlayerIndex]! },
        board,
        CUSTOM.checkVictory,
      ).state;
    }
    const far = state.scenarioData['farEdge'];
    expect(state.scenarioData['exitEdge']).toBe(far);
    const toward = (h: { q: number; r: number }): number =>
      far === 'north' ? toOffset(h).row : far === 'south' ? board.rows - toOffset(h).row : 0;
    const plan = aiPlan(state, board, 'attacker');
    const armourMoves = plan.filter(
      (c) =>
        c.type === 'moveUnit' && !isOgre(state.units[c.unit]!) && onBoard(state.units[c.unit]!),
    );
    expect(armourMoves.length).toBeGreaterThan(0);
    let closer = 0;
    for (const m of armourMoves) {
      if (m.type !== 'moveUnit') continue;
      const u = state.units[m.unit]!;
      if (toward(m.path[m.path.length - 1]!) < toward(u.pos)) closer++;
    }
    expect(closer).toBeGreaterThan(armourMoves.length / 2);
  });
});
