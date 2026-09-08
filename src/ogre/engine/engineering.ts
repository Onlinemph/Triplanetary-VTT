/**
 * The last of the optional and advanced rules: the Superheavy's record sheet
 * (13.07), bridges as targets (13.02), the Light Artillery Drone's
 * deployment (14.01) and combat engineering (15).
 *
 * Each is implemented from its shape rather than transcribed, and the
 * numbers are provisional — flagged here and in `docs/OGRE-RULES-MAPPING.md`
 * for correction against the printed text.
 *
 *  - **The Superheavy's record sheet.** With `options.superheavyRecordSheet`
 *    a Superheavy is not destroyed by an X. It carries a sheet of two guns,
 *    two antipersonnel weapons and three tread units; an X takes one of them
 *    (a die says which), a D takes a tread unit. Its attack is 3 a gun, its
 *    movement its tread units, and it is destroyed when it has neither a gun
 *    nor a tread unit left — the same test as an Ogre's.
 *  - **Bridges.** A road or rail crossing a stream may be fired on as a
 *    target of its own, at `BRIDGE.defense`, when terrain damage is in play:
 *    an X drops it, and the crossing is a bare stream again. Combat engineers
 *    drop one next to them without a roll.
 *  - **The Light Artillery Drone.** It rides a vehicle the way infantry does,
 *    one squad's worth of room, and the turn it is set down it is setting up
 *    and may not fire.
 *  - **Combat engineers.** A Combat Engineer counter that has not moved may
 *    spend its whole movement phase on a task: entrench the hex (infantry in
 *    it defend as if in forest), clear the minefield it stands in, or drop a
 *    bridge on a neighbouring hexside.
 */

import {
  type Hex,
  canonicalSide,
  directionTo,
  distance,
  eq,
  key,
  neighbors,
  sideKey,
} from './hex.js';
import { type GameMap, allHexes, isBridge, terrainAt } from './map.js';
import type { DamageResult } from './crt.js';
import { rollDie } from './rng.js';
import {
  type ConventionalUnit,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitId,
  activePlayer,
  onBoard,
} from './types.js';
import { destroyUnit, log, movementAllowance, unitName, updateAnyUnit } from './state.js';
import { unitClass } from './units.js';
import { mineAt, removeMinefield } from './concealment.js';

// ---------------------------------------------------------------------------
// 13.07 The Superheavy's record sheet
// ---------------------------------------------------------------------------

/** What a Superheavy carries on its sheet, as it leaves the factory. Provisional. */
export interface SuperheavySheet {
  readonly guns: number;
  readonly ap: number;
  readonly treads: number;
}

export const SUPERHEAVY_SHEET: SuperheavySheet = { guns: 2, ap: 2, treads: 3 };

/** Attack strength of one Superheavy gun: half the printed 6*. */
export const SUPERHEAVY_GUN = 3;

/** The sheet a Superheavy fights on, or null when the option is off or it is not one. */
export const sheetOf = (state: GameState, u: Unit): SuperheavySheet | null => {
  if (!state.options.superheavyRecordSheet) return null;
  if (u.kind !== 'unit' || u.classId !== 'SHVY') return null;
  return u.sheet ?? SUPERHEAVY_SHEET;
};

/** Destroyed the way an Ogre is: nothing to shoot with and nothing to move on. */
export const sheetSpent = (sheet: SuperheavySheet): boolean => sheet.guns <= 0 && sheet.treads <= 0;

/**
 * A CRT result against a Superheavy on its sheet. An X takes a component —
 * 1-2 a gun, 3-4 a tread unit, 5-6 an antipersonnel weapon, the next kind
 * along when that one is spent — and a D takes a tread unit. Provisional.
 */
export const applySheetDamage = (
  state: GameState,
  id: UnitId,
  result: DamageResult,
  credit: string,
): GameState => {
  const u = state.units[id];
  if (!u || !onBoard(u) || u.kind !== 'unit') return state;
  const sheet = sheetOf(state, u);
  if (!sheet || result === 'NE') return state;

  let next = state;
  let taken: keyof SuperheavySheet;
  if (result === 'D') {
    taken = 'treads';
  } else {
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    const order: (keyof SuperheavySheet)[] =
      die.value <= 2
        ? ['guns', 'treads', 'ap']
        : die.value <= 4
          ? ['treads', 'guns', 'ap']
          : ['ap', 'guns', 'treads'];
    taken = order.find((k) => sheet[k] > 0) ?? 'treads';
  }
  if (sheet[taken] <= 0) {
    return log(next, 'info', `${unitName(u)} shrugs it off: nothing left on that line.`, [u.pos]);
  }
  const after: SuperheavySheet = { ...sheet, [taken]: sheet[taken] - 1 };
  next = updateAnyUnit(next, id, () => ({ sheet: after }));
  const what =
    taken === 'guns' ? 'a gun' : taken === 'ap' ? 'an antipersonnel weapon' : 'a tread unit';
  next = log(next, 'good', `${unitName(u)} loses ${what}.`, [u.pos]);
  if (sheetSpent(after)) {
    next = destroyUnit(next, id, 'shot to pieces', credit);
    next = log(next, 'good', `${unitName(u)} is a wreck: no guns and no treads.`, [u.pos]);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Bridges (13.02)
// ---------------------------------------------------------------------------

/** A bridge's defence as a target. Provisional. */
export const BRIDGE = { defense: 4 } as const;

/** The canonical hexside key of the crossing between two adjacent hexes. */
export const bridgeKey = (hex: Hex, toward: Hex): string | null => {
  const dir = directionTo(hex, toward);
  return dir < 0 ? null : sideKey(canonicalSide(hex, dir));
};

export const bridgesDownOf = (state: GameState): readonly string[] => state.bridgesDown ?? [];

/** Is there a standing bridge between these two hexes? */
export const bridgeStands = (state: GameState, map: GameMap, hex: Hex, toward: Hex): boolean =>
  isBridge(map, hex, toward, bridgesDownOf(state));

/** Drop the bridge: the route across that hexside is gone for the game. */
export const demolishBridge = (state: GameState, hex: Hex, toward: Hex): GameState => {
  const k = bridgeKey(hex, toward);
  if (k === null || bridgesDownOf(state).includes(k)) return state;
  const next: GameState = { ...state, bridgesDown: [...bridgesDownOf(state), k] };
  return log(next, 'warn', `The bridge at ${key(hex)}–${key(toward)} is down.`, [hex, toward]);
};

/** Every standing bridge with an end within `radius` of a hex, for the interface. */
export const bridgesNear = (
  state: GameState,
  map: GameMap,
  from: Hex,
  radius: number,
): { hex: Hex; toward: Hex }[] => {
  const out: { hex: Hex; toward: Hex }[] = [];
  const seen = new Set<string>();
  for (const h of allHexes(map)) {
    if (distance(h, from) > radius) continue;
    for (const n of neighbors(h)) {
      if (!bridgeStands(state, map, h, n)) continue;
      const k = bridgeKey(h, n)!;
      if (seen.has(k)) continue;
      seen.add(k);
      // Name the bridge by its nearer end, so the shot is measured to it.
      const [a, b] = distance(h, from) <= distance(n, from) ? [h, n] : [n, h];
      out.push({ hex: a, toward: b });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// 14.01 The Light Artillery Drone
// ---------------------------------------------------------------------------

/** Whether a counter rides vehicles: infantry, and the drone as one squad's worth. */
export const canRide = (u: Unit): boolean =>
  u.kind === 'unit' && (unitClass(u.classId).kind === 'infantry' || u.classId === 'LAD');

export const isDrone = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'LAD';

// ---------------------------------------------------------------------------
// 15 Combat engineering
// ---------------------------------------------------------------------------

export type EngineerTask = 'entrench' | 'clearMines' | 'demolish';

export const isEngineer = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'CE';

export const entrenchedOf = (state: GameState): readonly string[] => state.entrenched ?? [];

export const entrenchedAt = (state: GameState, h: Hex): boolean =>
  entrenchedOf(state).includes(key(h));

/**
 * What an engineer counter could do from where it stands right now, for the
 * interface and the tests. Empty once it has moved.
 */
export const engineerTasks = (
  state: GameState,
  map: GameMap,
  u: Unit,
): { task: EngineerTask; toward?: Hex; label: string }[] => {
  if (!isEngineer(u) || !onBoard(u) || u.kind !== 'unit') return [];
  if (u.moveUsed > 0 || u.movementEnded || u.disabled !== 'none' || u.ridingOn) return [];
  const out: { task: EngineerTask; toward?: Hex; label: string }[] = [];
  const terrain = terrainAt(map, u.pos, state.terrainOverrides);
  if (!entrenchedAt(state, u.pos) && terrain !== 'water' && terrain !== 'crater') {
    out.push({ task: 'entrench', label: 'Entrench this hex' });
  }
  const mine = mineAt(state, u.pos);
  if (mine && (mine.revealed || mine.owner === u.owner)) {
    out.push({ task: 'clearMines', label: 'Clear the minefield here' });
  }
  for (const n of neighbors(u.pos)) {
    if (bridgeStands(state, map, u.pos, n)) {
      out.push({ task: 'demolish', toward: n, label: `Drop the bridge to ${key(n)}` });
    }
  }
  return out;
};

/**
 * Spend the engineers' whole movement phase on a task. The counter has to be
 * standing where the work is, with its move unspent; afterwards its move is
 * over for the turn.
 */
export const engineer = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  unitId: UnitId,
  task: EngineerTask,
  toward?: Hex,
): { state: GameState; ok: boolean; reason?: string } => {
  if (state.phase !== 'movement')
    return { state, ok: false, reason: 'engineering is movement-phase work' };
  if (activePlayer(state) !== by) return { state, ok: false, reason: 'it is not your turn' };
  const u = state.units[unitId];
  if (!u || !onBoard(u) || u.kind !== 'unit') return { state, ok: false, reason: 'no such unit' };
  if (u.owner !== by) return { state, ok: false, reason: 'not your unit' };
  if (!isEngineer(u)) return { state, ok: false, reason: 'only combat engineers do that' };
  if (u.disabled !== 'none') return { state, ok: false, reason: 'disabled engineers do no work' };
  if (u.ridingOn) return { state, ok: false, reason: 'the engineers must dismount first' };
  if (u.moveUsed > 0 || u.movementEnded) {
    return { state, ok: false, reason: 'the work takes the whole movement phase: they have moved' };
  }

  let next = state;
  switch (task) {
    case 'entrench': {
      const terrain = terrainAt(map, u.pos, state.terrainOverrides);
      if (terrain === 'water' || terrain === 'crater') {
        return { state, ok: false, reason: 'there is nothing to dig in there' };
      }
      if (entrenchedAt(state, u.pos))
        return { state, ok: false, reason: 'that hex is entrenched already' };
      next = { ...next, entrenched: [...entrenchedOf(next), key(u.pos)] };
      next = log(next, 'info', `${unitName(u)} entrench ${key(u.pos)}.`, [u.pos]);
      break;
    }
    case 'clearMines': {
      const mine = mineAt(state, u.pos);
      if (!mine) return { state, ok: false, reason: 'there is no minefield here' };
      if (!mine.revealed && mine.owner !== u.owner) {
        return { state, ok: false, reason: 'nobody knows of a minefield here' };
      }
      next = removeMinefield(next, mine.id);
      next = log(next, 'info', `${unitName(u)} clear the minefield at ${key(u.pos)}.`, [u.pos]);
      break;
    }
    case 'demolish': {
      if (!toward) return { state, ok: false, reason: 'say which bridge' };
      if (distance(u.pos, toward) !== 1)
        return { state, ok: false, reason: 'the bridge must be next to them' };
      if (!bridgeStands(state, map, u.pos, toward)) {
        return { state, ok: false, reason: 'there is no bridge standing there' };
      }
      next = demolishBridge(next, u.pos, toward);
      next = log(next, 'info', `${unitName(u)} blow the bridge.`, [u.pos, toward]);
      break;
    }
  }

  // The whole phase, spent.
  const allowance = movementAllowance(u, state.phase, state.options);
  next = updateAnyUnit(next, unitId, () => ({ moveUsed: allowance, movementEnded: true }));
  return { state: next, ok: true };
};

/** For the record: a conventional unit with the shape the sheet rules need. */
export type SheetUnit = ConventionalUnit;

/** True when two hexes are the same, for callers without `eq` in scope. */
export const sameHex = eq;
