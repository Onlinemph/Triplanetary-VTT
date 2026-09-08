/**
 * The last optional and advanced rules: the Superheavy's record sheet
 * (13.07), bridges as targets (13.02), the drone's deployment (14.01) and
 * combat engineering (15) — each proved against the reducer on a bare board.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { key } from '../../src/ogre/engine/hex.js';
import { layRoute, setSide, emptyBuilder, routeBetween } from '../../src/ogre/engine/map.js';
import type { GameMap } from '../../src/ogre/engine/map.js';
import { previewAttack } from '../../src/ogre/engine/combat.js';
import { stepInfo } from '../../src/ogre/engine/movement.js';
import { defenseOf, movementAllowance, printedAttack } from '../../src/ogre/engine/state.js';
import {
  SUPERHEAVY_SHEET,
  bridgeStands,
  engineerTasks,
  entrenchedAt,
  sheetOf,
} from '../../src/ogre/engine/engineering.js';
import { mineAt } from '../../src/ogre/engine/concealment.js';
import { type GameState, onBoard } from '../../src/ogre/engine/types.js';
import { A, B, at, flatMap, inPhase, newGame, put, seedForRoll } from './helpers.js';

const map = flatMap();

const run = (
  s: GameState,
  cmd: Parameters<typeof applyCommand>[1],
  m: GameMap = map,
): GameState => {
  const out = applyCommand(s, cmd, m);
  if (!out.result.ok) throw new Error(out.result.reason);
  return out.state;
};

const moveFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'movement'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

const fireFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'fire'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

const withOptions = (s: GameState, options: Partial<GameState['options']>): GameState => ({
  ...s,
  options: { ...s.options, ...options },
});

// ---------------------------------------------------------------------------
// 13.07 The Superheavy's record sheet
// ---------------------------------------------------------------------------

describe('the Superheavy on its record sheet (13.07)', () => {
  const board = (option: boolean): { state: GameState; shvy: string; hwz: string } => {
    let s = withOptions(newGame({ seed: seedForRoll(6) }), { superheavyRecordSheet: option });
    const shvy = put(s, B, 'SHVY', at(6, 6));
    s = shvy.state;
    // Three howitzers: 18 against D5 is 3-1 — enough to force an X on a 6.
    const h1 = put(s, A, 'HWZ', at(3, 6));
    s = h1.state;
    const h2 = put(s, A, 'HWZ', at(3, 7));
    s = h2.state;
    const h3 = put(s, A, 'HWZ', at(3, 5));
    s = h3.state;
    return { state: fireFor(s, A), shvy: shvy.id, hwz: h1.id };
  };

  it('is a whole counter without the option, and a sheet with it', () => {
    const off = board(false);
    expect(sheetOf(off.state, off.state.units[off.shvy]!)).toBeNull();
    const on = board(true);
    expect(sheetOf(on.state, on.state.units[on.shvy]!)).toEqual(SUPERHEAVY_SHEET);
  });

  it('loses a component to an X rather than the counter', () => {
    const { state, shvy } = board(true);
    const attackers = Object.values(state.units)
      .filter((u) => u.owner === A)
      .map((u) => ({ unit: u.id }));
    const next = run(state, {
      type: 'attack',
      by: A,
      attackers,
      target: { kind: 'unit', unit: shvy },
    });
    const u = next.units[shvy]!;
    expect(onBoard(u)).toBe(true);
    const sheet = sheetOf(next, u)!;
    expect(sheet.guns + sheet.ap + sheet.treads).toBe(6);
    expect(next.log.some((e) => /Superheavy Tank loses/.test(e.text))).toBe(true);
  });

  it('shoots with the guns it has left and moves on the tread units it has left', () => {
    const built = board(true);
    const shvy = built.shvy;
    let state = built.state;
    const u = state.units[shvy]!;
    if (u.kind !== 'unit') throw new Error('not a unit');
    state = {
      ...state,
      units: { ...state.units, [shvy]: { ...u, sheet: { guns: 1, ap: 0, treads: 1 } } },
    };
    const worn = state.units[shvy]!;
    if (worn.kind !== 'unit') throw new Error('not a unit');
    expect(printedAttack(worn)).toBe(3);
    expect(movementAllowance(worn, 'movement', state.options)).toBe(1);
    // No antipersonnel weapons left: it can no longer walk through infantry.
    const inf = put(state, A, 'INF', at(7, 6), 3);
    const step = stepInfo(inf.state, map, worn, at(6, 6), at(7, 6));
    expect(step.ok).toBe(false);
  });

  it('is a wreck once it has neither a gun nor a tread unit', () => {
    const built = board(true);
    const shvy = built.shvy;
    let state = built.state;
    const u = state.units[shvy]!;
    if (u.kind !== 'unit') throw new Error('not a unit');
    state = {
      ...state,
      units: { ...state.units, [shvy]: { ...u, sheet: { guns: 0, ap: 1, treads: 1 } } },
    };
    // A D takes the last tread unit; that alone does not finish it.
    const attackers = Object.values(state.units)
      .filter((x) => x.owner === A)
      .map((x) => ({ unit: x.id }));
    let hit = false;
    for (let seed = 1; seed < 60 && !hit; seed++) {
      const s = { ...state, rng: { seed } };
      const out = applyCommand(
        s,
        { type: 'attack', by: A, attackers, target: { kind: 'unit', unit: shvy } },
        map,
      );
      const after = out.state.units[shvy]!;
      if (!onBoard(after)) {
        hit = true;
        expect(out.state.log.some((e) => /is a wreck/.test(e.text))).toBe(true);
      }
    }
    expect(hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13.02 Bridges
// ---------------------------------------------------------------------------

describe('bridges as targets (13.02)', () => {
  /** A road running east along row 6, crossing a stream between columns 5 and 6. */
  const bridged = (): GameMap => {
    const b = emptyBuilder();
    layRoute(b, [at(3, 6), at(4, 6), at(5, 6), at(6, 6), at(7, 6)], 'road');
    setSide(b, at(5, 6), at(6, 6), 'stream');
    return { ...flatMap(), terrain: b.terrain, sides: b.sides, routes: b.routes };
  };

  it('stand until an X drops them, and then the road is cut across that hexside only', () => {
    const m = bridged();
    let s = withOptions(newGame({ seed: seedForRoll(6) }), { terrainDamage: true });
    const hwz = put(s, A, 'HWZ', at(3, 7));
    s = fireFor(hwz.state, A);
    expect(bridgeStands(s, m, at(5, 6), at(6, 6))).toBe(true);
    const preview = previewAttack(s, m, [{ unit: hwz.id }], {
      kind: 'bridge',
      hex: at(5, 6),
      toward: at(6, 6),
    });
    expect(preview.ok).toBe(true);
    expect(preview.defenseStrength).toBe(4);
    const next = run(
      s,
      {
        type: 'attack',
        by: A,
        attackers: [{ unit: hwz.id }],
        target: { kind: 'bridge', hex: at(5, 6), toward: at(6, 6) },
      },
      m,
    );
    expect(bridgeStands(next, m, at(5, 6), at(6, 6))).toBe(false);
    expect(routeBetween(m, at(5, 6), at(6, 6), next.routesCut, next.bridgesDown)).toBeUndefined();
    expect(routeBetween(m, at(4, 6), at(5, 6), next.routesCut, next.bridgesDown)).toBe('road');
    // A heavy tank can no longer cross there: a stream stops it.
    const tank = put(next, A, 'HVY', at(5, 6));
    const step = stepInfo(tank.state, m, tank.state.units[tank.id]!, at(5, 6), at(6, 6));
    expect(step.ok && step.onRoute).toBe(false);
  });

  it('are not a target without terrain damage in play', () => {
    const m = bridged();
    let s = newGame({ seed: 1 });
    const hwz = put(s, A, 'HWZ', at(3, 7));
    s = fireFor(hwz.state, A);
    const preview = previewAttack(s, m, [{ unit: hwz.id }], {
      kind: 'bridge',
      hex: at(5, 6),
      toward: at(6, 6),
    });
    expect(preview.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14.01 The Light Artillery Drone
// ---------------------------------------------------------------------------

describe('the drone rides and sets up (14.01)', () => {
  it('mounts a carrier as one squad, and cannot fire the turn it is set down', () => {
    // The green map's stacking (5.02.2): the drone and its carrier share a hex.
    let s = newGame({ seed: 1, stackingLimit: 5 });
    const pc = put(s, A, 'GEVPC', at(4, 6));
    s = pc.state;
    const lad = put(s, A, 'LAD', at(4, 6));
    s = moveFor(lad.state, A);
    s = run(s, { type: 'mount', by: A, unit: lad.id, carrier: pc.id });
    expect((s.units[lad.id] as { ridingOn?: string }).ridingOn).toBe(pc.id);
    // Carried along.
    s = run(s, { type: 'moveUnit', by: A, unit: pc.id, path: [at(5, 6), at(6, 6)] });
    expect(key(s.units[lad.id]!.pos)).toBe(key(at(6, 6)));
    // Next turn: set it down, and it is setting up.
    s = run(s, { type: 'endPhase', by: A }); // fire
    s = run(s, { type: 'endPhase', by: A }); // gev movement
    s = run(s, { type: 'endPhase', by: A }); // B's turn
    for (let i = 0; i < 4; i++) s = run(s, { type: 'endPhase', by: B });
    s = run(s, { type: 'endPhase', by: A }); // A's recovery -> movement
    expect(s.phase).toBe('movement');
    s = run(s, { type: 'dismount', by: A, unit: lad.id });
    const down = s.units[lad.id]!;
    expect((down as { ridingOn?: string }).ridingOn).toBeUndefined();
    expect((down as { firedThisPhase: boolean }).firedThisPhase).toBe(true);
    s = run(s, { type: 'endPhase', by: A });
    const enemy = put(s, B, 'HVY', at(8, 6));
    s = enemy.state;
    const shot = applyCommand(
      s,
      {
        type: 'attack',
        by: A,
        attackers: [{ unit: lad.id }],
        target: { kind: 'unit', unit: enemy.id },
      },
      map,
    );
    expect(shot.result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15 Combat engineering
// ---------------------------------------------------------------------------

describe('combat engineers (15)', () => {
  it('entrench a hex for the whole phase, and infantry there defend as in forest', () => {
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6), 2);
    s = ce.state;
    const inf = put(s, A, 'INF', at(5, 6), 3);
    s = moveFor(inf.state, A);
    const tasks = engineerTasks(s, map, s.units[ce.id]!);
    expect(tasks.map((t) => t.task)).toContain('entrench');
    s = run(s, { type: 'engineer', by: A, unit: ce.id, task: 'entrench' });
    expect(entrenchedAt(s, at(5, 6))).toBe(true);
    expect(s.units[ce.id]!.movementEnded).toBe(true);
    expect(defenseOf(s, map, s.units[inf.id]!)).toBe(6); // 3 squads, doubled
    // Not twice in the same phase, and not after moving.
    expect(
      applyCommand(s, { type: 'engineer', by: A, unit: ce.id, task: 'entrench' }, map).result.ok,
    ).toBe(false);
  });

  it('clear a known minefield, and drop a bridge beside them', () => {
    const b = emptyBuilder();
    layRoute(b, [at(4, 6), at(5, 6), at(6, 6)], 'road');
    setSide(b, at(5, 6), at(6, 6), 'stream');
    const m: GameMap = { ...flatMap(), terrain: b.terrain, sides: b.sides, routes: b.routes };
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6));
    s = ce.state;
    s = {
      ...s,
      mines: [{ id: 'mine-b-1', owner: B, pos: at(5, 6), revealed: true }],
    };
    s = moveFor(s, A);
    const tasks = engineerTasks(s, m, s.units[ce.id]!).map((t) => t.task);
    expect(tasks).toContain('clearMines');
    expect(tasks).toContain('demolish');
    const cleared = run(s, { type: 'engineer', by: A, unit: ce.id, task: 'clearMines' }, m);
    expect(mineAt(cleared, at(5, 6))).toBeUndefined();
    const blown = run(
      s,
      { type: 'engineer', by: A, unit: ce.id, task: 'demolish', toward: at(6, 6) },
      m,
    );
    expect(bridgeStands(blown, m, at(5, 6), at(6, 6))).toBe(false);
    // Only engineers do the work.
    const tank = put(s, A, 'HVY', at(7, 6));
    expect(
      applyCommand(tank.state, { type: 'engineer', by: A, unit: tank.id, task: 'entrench' }, m)
        .result.ok,
    ).toBe(false);
  });
});
