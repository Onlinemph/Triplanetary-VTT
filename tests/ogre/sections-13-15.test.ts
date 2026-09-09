/**
 * The last optional and advanced rules: the Superheavy's record sheet
 * (13.07), bridges as targets (13.02), the drone's deployment (14.01) and
 * combat engineering (15) — each proved against the reducer on a bare board.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { key } from '../../src/ogre/engine/hex.js';
import {
  layRoute,
  setSide,
  emptyBuilder,
  routeBetween,
  sideFeatureBetween,
} from '../../src/ogre/engine/map.js';
import type { GameMap } from '../../src/ogre/engine/map.js';
import { previewAttack } from '../../src/ogre/engine/combat.js';
import { stepInfo } from '../../src/ogre/engine/movement.js';
import {
  defenseOf,
  movementAllowance,
  printedAttack,
  withUnit,
} from '../../src/ogre/engine/state.js';
import { rollDie } from '../../src/ogre/engine/rng.js';
import {
  SUPERHEAVY_SHEET,
  bridgeStands,
  engineerTasks,
  engineeringDice,
  entrenchmentAt,
  sheetOf,
  superheavyMove,
  vulcanDice,
} from '../../src/ogre/engine/engineering.js';
import { mineAt } from '../../src/ogre/engine/concealment.js';
import { type GameState, onBoard } from '../../src/ogre/engine/types.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre, seedForRoll } from './helpers.js';

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

  it('takes a component or treads on an X, by the printed die, rather than the counter', () => {
    // The X die is rolled after the CRT die, so walk seeds until each branch
    // of 13.07's table has been seen at least once.
    const attackersOf = (state: GameState) =>
      Object.values(state.units)
        .filter((u) => u.owner === A)
        .map((u) => ({ unit: u.id }));
    let sawGunLoss = false;
    let sawTreadLoss = false;
    let sawWreck = false;
    for (let seed = 1; seed <= 80; seed++) {
      const { state, shvy } = board(true);
      const out = applyCommand(
        { ...state, rng: { seed } },
        {
          type: 'attack',
          by: A,
          attackers: attackersOf(state),
          target: { kind: 'unit', unit: shvy },
        },
        map,
      );
      const u = out.state.units[shvy]!;
      if (!onBoard(u)) {
        sawWreck = true;
        continue;
      }
      const sheet = sheetOf(out.state, u)!;
      if (sheet.guns < SUPERHEAVY_SHEET.guns) {
        // "One main gun and one AP gun are lost. Unit is disabled."
        expect(sheet.ap).toBe(SUPERHEAVY_SHEET.ap - 1);
        expect(u.kind === 'unit' && u.disabled).not.toBe('none');
        sawGunLoss = true;
      } else if (sheet.treads < SUPERHEAVY_SHEET.treads) {
        expect(u.kind === 'unit' && u.disabled).not.toBe('none');
        sawTreadLoss = true;
      }
    }
    expect(sawGunLoss).toBe(true);
    expect(sawTreadLoss).toBe(true);
    expect(sawWreck).toBe(true);
  });

  it('is disabled by a D, and a second D while it is down does nothing more', () => {
    const built = board(true);
    const shvy = built.shvy;
    const u = built.state.units[shvy]!;
    if (u.kind !== 'unit') throw new Error('not a unit');
    const down: GameState = {
      ...built.state,
      units: {
        ...built.state.units,
        [shvy]: { ...u, sheet: { ...SUPERHEAVY_SHEET, disabled: true } },
      },
    };
    const attackers = Object.values(down.units)
      .filter((x) => x.owner === A)
      .map((x) => ({ unit: x.id }));
    // Every seed that produces a D leaves the sheet exactly as it was.
    for (let seed = 1; seed <= 40; seed++) {
      const out = applyCommand(
        { ...down, rng: { seed } },
        { type: 'attack', by: A, attackers, target: { kind: 'unit', unit: shvy } },
        map,
      );
      if (out.state.log.some((e) => /already down/.test(e.text))) {
        const after = out.state.units[shvy]!;
        expect(sheetOf(out.state, after)).toEqual({ ...SUPERHEAVY_SHEET, disabled: true });
        return;
      }
    }
    throw new Error('no D result in 40 seeds');
  });

  it('shoots with the guns it has left and moves on the tread units it has left', () => {
    const built = board(true);
    const shvy = built.shvy;
    let state = built.state;
    const u = state.units[shvy]!;
    if (u.kind !== 'unit') throw new Error('not a unit');
    state = {
      ...state,
      units: { ...state.units, [shvy]: { ...u, sheet: { guns: 1, ap: 0, treads: 4 } } },
    };
    const worn = state.units[shvy]!;
    if (worn.kind !== 'unit') throw new Error('not a unit');
    // One cannon of the printed two: "2 CANNONS ATK 3".
    expect(printedAttack(worn)).toBe(3);
    // Four tread units of eighteen: the bottom band of the printed move track.
    expect(movementAllowance(worn, 'movement', state.options)).toBe(1);
    expect(superheavyMove(SUPERHEAVY_SHEET.treads)).toBe(3);
    expect(superheavyMove(0)).toBe(0);
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
    // With both cannon already gone, a 1-2 on the X die finishes it, and so
    // does a 5 (all treads) or a 6 (destroyed outright).
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
        // Either branch of the printed table finishes it: a 1-2 with both
        // cannon already gone, a 5 that takes the last tread, or a 6.
        expect(
          out.state.log.some((e) =>
            /is a wreck|nothing left to lose|destroyed outright/.test(e.text),
          ),
        ).toBe(true);
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
    expect(preview.defenseStrength).toBe(6);
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
  /** Seeds until the pool's best die is the one we want. */
  const seedForBest = (want: number): number => {
    for (let seed = 1; seed < 400; seed++) {
      const probe = { ...newGame({ seed }), rng: { seed } };
      const d = rollDie(probe.rng);
      if (d.value === want) return seed;
    }
    throw new Error('no seed');
  };

  it('dig entrenchments in the fire phase, for as many squads as the die allows', () => {
    // "a roll of 6 creates a 3-squad entrenchment" (15.03.5).
    let s = { ...newGame({ seed: seedForBest(6) }) };
    const ce = put(s, A, 'CE', at(5, 6), 1);
    s = ce.state;
    // A 3-squad entrenchment, and the engineers' own squad is in it too, so
    // there is room for two more.
    const inf = put(s, A, 'INF', at(5, 6), 2);
    s = { ...fireFor(inf.state, A), rng: { seed: seedForBest(6) } };

    const tasks = engineerTasks(s, map, s.units[ce.id]!);
    expect(tasks.map((t) => t.task)).toContain('entrench');
    // "made during the Fire Phase" — not in the movement phase.
    expect(
      applyCommand(moveFor(s, A), { type: 'engineer', by: A, unit: ce.id, task: 'entrench' }, map)
        .result.ok,
    ).toBe(false);

    s = run(s, { type: 'engineer', by: A, unit: ce.id, task: 'entrench' });
    expect(entrenchmentAt(s, at(5, 6))).toBe(3);
    // The task was their shot for the turn.
    const worked = s.units[ce.id]!;
    expect(worked.kind === 'unit' && worked.firedThisPhase).toBe(true);
    // "Entrenchments double the defense strength of infantry ... in clear
    // terrain": two squads at D1, doubled.
    expect(defenseOf(s, map, s.units[inf.id]!)).toBe(4);
    // "the specific task may be attempted only once per turn" (15.03).
    expect(
      applyCommand(s, { type: 'engineer', by: A, unit: ce.id, task: 'entrench' }, map).result.ok,
    ).toBe(false);
  });

  it('shelters only as many squads as the entrenchment holds', () => {
    // A 1-squad entrenchment: a three-squad counter does not fit in it.
    let s = { ...newGame({ seed: seedForBest(1) }) };
    const ce = put(s, A, 'CE', at(5, 6), 1);
    s = ce.state;
    const inf = put(s, A, 'INF', at(5, 6), 3);
    s = { ...fireFor(inf.state, A), rng: { seed: seedForBest(1) } };
    s = run(s, { type: 'engineer', by: A, unit: ce.id, task: 'entrench' });
    expect(entrenchmentAt(s, at(5, 6))).toBe(1);
    expect(defenseOf(s, map, s.units[inf.id]!)).toBe(3);
  });

  // "Each squad of engineers allows one extra die to be rolled. A Heavy Drone
  // gives two dice; a Vulcan with two arms gives four." (15.03)
  it('musters a die a squad, two for a Heavy Drone and four for a Vulcan', () => {
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6), 3);
    s = ce.state;
    expect(engineeringDice(s, at(5, 6), A)).toBe(3);
    const drone = put(s, A, 'HDRN', at(5, 6));
    s = drone.state;
    expect(engineeringDice(s, at(5, 6), A)).toBe(5);
    const vulcan = putOgre(s, A, 'VULCAN', at(5, 6));
    s = vulcan.state;
    expect(engineeringDice(s, at(5, 6), A)).toBe(9);
    // "A Vulcan rolls two dice for success; each Heavy Drone that assists
    // contributes one die." (15.04)
    expect(vulcanDice(s, at(5, 6), A)).toBe(3);
    // Somebody else's engineers are no help.
    expect(engineeringDice(s, at(5, 6), B)).toBe(0);
  });

  it('lift their own mine for nothing and work at the enemy’s on a 5', () => {
    const build = (owner: string, seed: number) => {
      let s = newGame({ seed });
      const ce = put(s, A, 'CE', at(5, 6));
      s = {
        ...fireFor(ce.state, A),
        mines: [{ id: 'm1', owner, pos: at(5, 6), revealed: true }],
        rng: { seed },
      };
      return { s, ce: ce.id };
    };
    // "Any friendly Sapper in the mined hex can automatically disarm" (15.03.2).
    const own = build(A, seedForBest(1));
    const lifted = run(own.s, { type: 'engineer', by: A, unit: own.ce, task: 'clearMines' });
    expect(mineAt(lifted, at(5, 6))).toBeUndefined();

    // "Successfully disarming an enemy mine requires a roll of 5+" (15.03.4).
    const low = build(B, seedForBest(4));
    const failed = run(low.s, { type: 'engineer', by: A, unit: low.ce, task: 'clearMines' });
    expect(mineAt(failed, at(5, 6))).toBeDefined();
    const high = build(B, seedForBest(5));
    const done = run(high.s, { type: 'engineer', by: A, unit: high.ce, task: 'clearMines' });
    expect(mineAt(done, at(5, 6))).toBeUndefined();
  });

  it('drop the bridge beside them, and mend a road with a Truck to hand', () => {
    const b = emptyBuilder();
    layRoute(b, [at(4, 6), at(5, 6), at(6, 6)], 'road');
    setSide(b, at(5, 6), at(6, 6), 'stream');
    const m: GameMap = { ...flatMap(), terrain: b.terrain, sides: b.sides, routes: b.routes };
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6));
    s = fireFor(ce.state, A);
    expect(engineerTasks(s, m, s.units[ce.id]!).map((t) => t.task)).toContain('demolish');
    const dropped = run(
      s,
      { type: 'engineer', by: A, unit: ce.id, task: 'demolish', toward: at(6, 6) },
      m,
    );
    expect(bridgeStands(dropped, m, at(5, 6), at(6, 6))).toBe(false);

    // "Repair road/bridge stream/build ramp 6", and a Truck has to be there.
    let cut: GameState = {
      ...fireFor(ce.state, A),
      routesCut: [key(at(5, 6))],
      rng: { seed: seedForBest(6) },
    };
    expect(
      applyCommand(cut, { type: 'engineer', by: A, unit: ce.id, task: 'repairRoute' }, m).result.ok,
    ).toBe(false);
    const truck = put(cut, A, 'TK', at(5, 6));
    cut = { ...truck.state, rng: { seed: seedForBest(6) } };
    const mended = run(cut, { type: 'engineer', by: A, unit: ce.id, task: 'repairRoute' }, m);
    expect(mended.routesCut).not.toContain(key(at(5, 6)));
  });

  // "By planting charges in the right spot, a low point may be created in a
  // ridge to allow units to pass through the ridge as if it were not there ...
  // the attempt succeeds on a roll of 5 or greater." (15.03.7)
  it('grade a ridge flat on a 5', () => {
    const b = emptyBuilder();
    setSide(b, at(5, 6), at(6, 6), 'ridge');
    const m: GameMap = { ...flatMap(), terrain: b.terrain, sides: b.sides, routes: b.routes };
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6));
    s = { ...fireFor(ce.state, A), rng: { seed: seedForBest(5) } };
    expect(engineerTasks(s, m, s.units[ce.id]!).map((t) => t.task)).toContain('gradeRidge');
    const graded = run(
      s,
      { type: 'engineer', by: A, unit: ce.id, task: 'gradeRidge', toward: at(6, 6) },
      m,
    );
    expect(sideFeatureBetween(m, at(5, 6), at(6, 6), graded.sideOverrides)).toBeUndefined();
  });

  // "Successfully detonating a 'coup de grace' charge requires a roll of 4, 5
  // or 6. The Combat Engineer squad remains in the hex." (15.03.8)
  it('finish off a weaponless cybertank on a 4', () => {
    let s = newGame({ seed: 1, stackingLimit: 5 });
    const mk = putOgre(s, B, 'MK3', at(5, 6));
    s = mk.state;
    const ogre = s.units[mk.id]!;
    if (ogre.kind !== 'ogre') throw new Error('not an Ogre');
    s = withUnit(s, { ...ogre, weapons: ogre.weapons.map((w) => ({ ...w, destroyed: true })) });
    const ce = put(s, A, 'CE', at(5, 6));
    s = { ...fireFor(ce.state, A), rng: { seed: seedForBest(4) } };
    expect(engineerTasks(s, map, s.units[ce.id]!).map((t) => t.task)).toContain('finishOgre');
    const done = run(s, {
      type: 'engineer',
      by: A,
      unit: ce.id,
      task: 'finishOgre',
      target: mk.id,
    });
    expect(onBoard(done.units[mk.id]!)).toBe(false);
    // The engineers are still standing there.
    expect(onBoard(done.units[ce.id]!)).toBe(true);
  });

  it('will not climb onto a cybertank that can still shoot', () => {
    let s = newGame({ seed: 1, stackingLimit: 5 });
    const mk = putOgre(s, B, 'MK3', at(5, 6));
    s = mk.state;
    const ce = put(s, A, 'CE', at(5, 6));
    s = fireFor(ce.state, A);
    expect(engineerTasks(s, map, s.units[ce.id]!).map((t) => t.task)).not.toContain('finishOgre');
    const out = applyCommand(
      s,
      { type: 'engineer', by: A, unit: ce.id, task: 'finishOgre', target: mk.id },
      map,
    );
    expect(out.result.ok).toBe(false);
  });
});

describe('the Vulcan’s own work (15.04)', () => {
  const seedForBest = (want: number): number => {
    for (let seed = 1; seed < 400; seed++) {
      const probe = { ...newGame({ seed }), rng: { seed } };
      if (rollDie(probe.rng).value === want) return seed;
    }
    throw new Error('no seed');
  };

  const board = (seed: number) => {
    let s = newGame({ seed, stackingLimit: 5 });
    const vulcan = putOgre(s, A, 'VULCAN', at(5, 6));
    s = vulcan.state;
    return { s: { ...fireFor(s, A), rng: { seed } }, vulcan: vulcan.id };
  };

  it('is the only thing that may attempt a Vulcan task', () => {
    let s = newGame({ seed: 1 });
    const ce = put(s, A, 'CE', at(5, 6));
    s = { ...fireFor(ce.state, A), routesCut: [key(at(5, 6))] };
    const out = applyCommand(s, { type: 'engineer', by: A, unit: ce.id, task: 'repairRail' }, map);
    expect(out.result.ok).toBe(false);
    expect(out.result.ok ? '' : out.result.reason).toMatch(/Vulcan/);
  });

  // "Clearing a 'Road Cut' marker on a rail line requires a roll of a 5 or 6."
  it('relays a cut rail line on a 5', () => {
    const b = emptyBuilder();
    layRoute(b, [at(4, 6), at(5, 6), at(6, 6)], 'rail');
    const m: GameMap = { ...flatMap(), terrain: b.terrain, sides: b.sides, routes: b.routes };
    const built = board(seedForBest(5));
    const s = { ...built.s, routesCut: [key(at(5, 6))], rng: { seed: seedForBest(5) } };
    expect(engineerTasks(s, m, s.units[built.vulcan]!).map((t) => t.task)).toContain('repairRail');
    const fixed = run(s, { type: 'engineer', by: A, unit: built.vulcan, task: 'repairRail' }, m);
    expect(fixed.routesCut).not.toContain(key(at(5, 6)));
  });

  // "A Vulcan may attempt to free any unit size 5 or smaller on its own. For
  // every step up in size, one Heavy Drone is required." (15.04.1)
  it('pulls a stuck unit out of the swamp, with a Drone for every size above five', () => {
    const built = board(seedForBest(6));
    let s = built.s;
    const tank = put(s, A, 'HVY', at(5, 6));
    s = { ...tank.state, rng: { seed: seedForBest(6) } };
    s = withUnit(s, { ...s.units[tank.id]!, stuck: true } as GameState['units'][string]);
    const freed = run(s, {
      type: 'engineer',
      by: A,
      unit: built.vulcan,
      task: 'freeStuck',
      target: tank.id,
    });
    expect(freed.units[tank.id]!.stuck).toBe(false);

    // A Mark III is size 7: two Heavy Drones are needed before it may be tried.
    const again = board(seedForBest(6));
    let big = again.s;
    const mk = putOgre(big, A, 'MK3', at(5, 6));
    big = { ...mk.state, rng: { seed: seedForBest(6) } };
    big = withUnit(big, { ...big.units[mk.id]!, stuck: true } as GameState['units'][string]);
    const refused = applyCommand(
      big,
      { type: 'engineer', by: A, unit: again.vulcan, task: 'freeStuck', target: mk.id },
      map,
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? '' : refused.result.reason).toMatch(/Heavy Drone/);
  });

  // "two dice for a Vulcan, one for each Drone. For every 6 that is rolled
  // during the attempt, one tread is repaired." (15.04.6)
  it('relays tread units, one for every six rolled', () => {
    const built = board(3);
    let s = built.s;
    const mk = putOgre(s, A, 'MK3', at(5, 6));
    s = mk.state;
    const hurt = s.units[mk.id]!;
    if (hurt.kind !== 'ogre') throw new Error('not an Ogre');
    s = withUnit(s, { ...hurt, treads: 10 });

    let mended = false;
    for (let seed = 1; seed < 60 && !mended; seed++) {
      const out = applyCommand(
        { ...s, rng: { seed } },
        { type: 'engineer', by: A, unit: built.vulcan, task: 'repairTreads', target: mk.id },
        map,
      );
      expect(out.result.ok).toBe(true);
      const after = out.state.units[mk.id]!;
      if (after.kind === 'ogre' && after.treads > 10) {
        expect(after.treads).toBeLessThanOrEqual(12); // two dice, at most two sixes
        mended = true;
      }
    }
    expect(mended).toBe(true);
  });

  // "On a 5 or 6, the damage is light enough that an attempt to repair it may
  // be made. On any other result ... this weapon is beyond field repair ...
  // Only one die is rolled for each attempt, and a 6 is required." (15.04.5)
  it('writes a weapon off as beyond field repair, or brings it back on a six', () => {
    const built = board(3);
    let s = built.s;
    const mk = putOgre(s, A, 'MK3', at(5, 6));
    s = mk.state;
    const ogre = s.units[mk.id]!;
    if (ogre.kind !== 'ogre') throw new Error('not an Ogre');
    const gun = ogre.weapons.find((w) => w.kind === 'main')!;
    s = withUnit(s, {
      ...ogre,
      weapons: ogre.weapons.map((w) => (w.id === gun.id ? { ...w, destroyed: true } : w)),
    });

    let sawWriteOff = false;
    let sawRepair = false;
    for (let seed = 1; seed < 120 && !(sawWriteOff && sawRepair); seed++) {
      const out = applyCommand(
        { ...s, rng: { seed } },
        {
          type: 'engineer',
          by: A,
          unit: built.vulcan,
          task: 'repairWeapon',
          target: mk.id,
          weapon: gun.id,
        },
        map,
      );
      expect(out.result.ok).toBe(true);
      const after = out.state.units[mk.id]!;
      if (after.kind !== 'ogre') continue;
      const w = after.weapons.find((x) => x.id === gun.id)!;
      if (w.beyondRepair === true) sawWriteOff = true;
      if (!w.destroyed) sawRepair = true;
    }
    expect(sawWriteOff).toBe(true);
    expect(sawRepair).toBe(true);
  });

  // "Destroyed external missiles and missile racks are always too damaged to
  // attempt field repair." (15.04.5)
  it('never tries to rebuild a missile rack', () => {
    const built = board(3);
    let s = built.s;
    const mk = putOgre(s, A, 'MK4', at(5, 6));
    s = mk.state;
    const ogre = s.units[mk.id]!;
    if (ogre.kind !== 'ogre') throw new Error('not an Ogre');
    const rack = ogre.weapons.find((w) => w.kind === 'missileRack')!;
    s = withUnit(s, {
      ...ogre,
      weapons: ogre.weapons.map((w) => (w.id === rack.id ? { ...w, destroyed: true } : w)),
    });
    const out = applyCommand(
      s,
      {
        type: 'engineer',
        by: A,
        unit: built.vulcan,
        task: 'repairWeapon',
        target: mk.id,
        weapon: rack.id,
      },
      map,
    );
    expect(out.result.ok).toBe(false);
  });
});
