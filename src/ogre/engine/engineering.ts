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
import { destroyUnit, log, unitName, updateAnyUnit } from './state.js';
import { baseTerrain } from './terrain.js';
import { unitClass } from './units.js';
import { mineAt, removeMinefield } from './concealment.js';

// ---------------------------------------------------------------------------
// 13.07 The Superheavy's record sheet
// ---------------------------------------------------------------------------

/**
 * What a Superheavy carries on its record sheet, printed with 13.07:
 *
 *     2 CANNONS         ATK 3   RNG 3
 *     2 ANTIPERSONNEL   ATK 1   RNG 1
 *     18 TREAD UNITS
 *     MOVE STARTS AT 3, then 2, 1, 0
 */
export interface SuperheavySheet {
  readonly guns: number;
  readonly ap: number;
  readonly treads: number;
  /** Disabled by a hit on the sheet, and recovering (13.07 disables on most X results). */
  readonly disabled?: boolean;
}

export const SUPERHEAVY_SHEET: SuperheavySheet = { guns: 2, ap: 2, treads: 18 };

/** "2 CANNONS ATK 3 RNG 3" — the printed 6* is two guns of 3. */
export const SUPERHEAVY_GUN = 3;

export { superheavyMove } from './units.js';

/** The sheet a Superheavy fights on, or null when the option is off or it is not one. */
export const sheetOf = (state: GameState, u: Unit): SuperheavySheet | null => {
  if (!state.options.superheavyRecordSheet) return null;
  if (u.kind !== 'unit' || u.classId !== 'SHVY') return null;
  return u.sheet ?? SUPERHEAVY_SHEET;
};

/** Nothing to shoot with and nothing to move on. */
export const sheetSpent = (sheet: SuperheavySheet): boolean => sheet.guns <= 0 && sheet.treads <= 0;

/**
 * A CRT result against a Superheavy fighting on its record sheet (13.07).
 *
 * "D results have their normal effect, but a second D has no further result;
 * D results don't combine into an X."
 *
 * On any X, roll one die:
 *
 *     1, 2  One main gun and one AP gun are lost. Unit is disabled. If both
 *           main guns were already gone, unit is destroyed.
 *     3     Tread damage. Roll 1 die and mark off that many treads. Disabled.
 *     4     Major tread damage. Roll 2 dice and mark off that many. Disabled.
 *     5     Mobility kill; mark off all treads. Unit is disabled.
 *     6     Unit is destroyed, as with a normal X result.
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

  // A D disables it, and a second D while it is still down does nothing more.
  if (result === 'D') {
    if (sheet.disabled) {
      return log(state, 'info', `${unitName(u)} is already down; the second D does nothing.`, [
        u.pos,
      ]);
    }
    const next = updateAnyUnit(state, id, () => ({
      sheet: { ...sheet, disabled: true },
      disabled: 'combat' as const,
      disabledAt: state.turn,
    }));
    return log(next, 'good', `${unitName(u)} is disabled.`, [u.pos]);
  }

  const die = rollDie(state.rng);
  let next: GameState = { ...state, rng: die.state };
  const wreck = (why: string): GameState => {
    const gone = destroyUnit(next, id, why, credit);
    return log(gone, 'good', `${unitName(u)} ${why}.`, [u.pos]);
  };

  if (die.value === 6) return wreck('is destroyed outright');

  let after: SuperheavySheet;
  let what: string;
  if (die.value <= 2) {
    if (sheet.guns <= 0) return wreck('has nothing left to lose but itself');
    after = { ...sheet, guns: sheet.guns - 1, ap: Math.max(0, sheet.ap - 1) };
    what = 'loses a cannon and an antipersonnel gun';
  } else if (die.value === 5) {
    after = { ...sheet, treads: 0 };
    what = 'takes a mobility kill: every tread unit gone';
  } else {
    const first = rollDie(next.rng);
    next = { ...next, rng: first.state };
    let lost = first.value;
    if (die.value === 4) {
      const second = rollDie(next.rng);
      next = { ...next, rng: second.state };
      lost += second.value;
    }
    after = { ...sheet, treads: Math.max(0, sheet.treads - lost) };
    what = `loses ${String(lost)} tread unit${lost === 1 ? '' : 's'}`;
  }

  after = { ...after, disabled: true };
  next = updateAnyUnit(next, id, () => ({
    sheet: after,
    disabled: 'combat' as const,
    disabledAt: next.turn,
  }));
  next = log(next, 'good', `${unitName(u)} ${what}, and is disabled.`, [u.pos]);
  if (sheetSpent(after)) {
    next = destroyUnit(next, id, 'shot to pieces', credit);
    next = log(next, 'good', `${unitName(u)} is a wreck: no cannon and no treads.`, [u.pos]);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Bridges (13.02)
// ---------------------------------------------------------------------------

/** A bridge's defence as a target. Provisional. */
export const BRIDGE = {
  /** "there is a stream bridge with a defense strength of D6" (13.02). */
  defense: 6,
  /** "A bridge which crosses a full hex ... has a defense strength of 8" (13.02.1). */
  riverDefense: 8,
} as const;

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
  if (u.firedThisPhase || u.disabled !== 'none' || u.ridingOn) return [];
  const out: { task: EngineerTask; toward?: Hex; label: string }[] = [];
  const ground = baseTerrain(terrainAt(map, u.pos, state.terrainOverrides));
  // "Sappers may protect infantry in clear, forest, or rubble terrain through
  // entrenching ... Entrenchments in any terrain other than clear, forest, or
  // rubble offer no benefit." (15.03.5)
  const diggable = ground === 'clear' || ground === 'forest' || ground === 'rubble';
  if (!entrenchedAt(state, u.pos) && diggable) {
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
 * An engineering task, in place of the squad's shot.
 *
 * "To attempt to perform an engineering task, one or more Combat Engineer
 * squads and/or Vulcans must start their turn in the hex they wish to perform
 * the task, and stay in that hex for the duration of that turn ... Attempting
 * a task counts as that squad's 'attack' for that turn, and is made during the
 * Fire Phase." (15.03) So the engineers stand where the work is and spend
 * their fire on it.
 *
 * Only the tasks a single squad can finish in a turn are here. The rulebook's
 * dice pools — extra squads and Drones each add a die, a Vulcan four — are not
 * modelled: one squad, one attempt.
 */
export const engineer = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  unitId: UnitId,
  task: EngineerTask,
  toward?: Hex,
): { state: GameState; ok: boolean; reason?: string } => {
  if (state.phase !== 'fire')
    return { state, ok: false, reason: 'engineering is done in the fire phase (15.03)' };
  if (activePlayer(state) !== by) return { state, ok: false, reason: 'it is not your turn' };
  const u = state.units[unitId];
  if (!u || !onBoard(u) || u.kind !== 'unit') return { state, ok: false, reason: 'no such unit' };
  if (u.owner !== by) return { state, ok: false, reason: 'not your unit' };
  if (!isEngineer(u)) return { state, ok: false, reason: 'only combat engineers do that' };
  if (u.disabled !== 'none') return { state, ok: false, reason: 'disabled engineers do no work' };
  if (u.ridingOn) return { state, ok: false, reason: 'the engineers must dismount first' };
  if (u.firedThisPhase) {
    return { state, ok: false, reason: 'the work is their attack for the turn: they have fired' };
  }
  if (u.moveUsed > 0) {
    return { state, ok: false, reason: 'they must start the turn in the hex and stay in it' };
  }

  let next = state;
  switch (task) {
    case 'entrench': {
      const ground = baseTerrain(terrainAt(map, u.pos, state.terrainOverrides));
      if (ground !== 'clear' && ground !== 'forest' && ground !== 'rubble') {
        return {
          state,
          ok: false,
          reason: 'entrenchments only help in clear, forest or rubble (15.03.5)',
        };
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

  // The task was their attack for the turn (15.03).
  next = updateAnyUnit(next, unitId, () => ({ firedThisPhase: true, squadsFired: u.squads }));
  return { state: next, ok: true };
};

/** For the record: a conventional unit with the shape the sheet rules need. */
export type SheetUnit = ConventionalUnit;

/** True when two hexes are the same, for callers without `eq` in scope. */
export const sameHex = eq;
