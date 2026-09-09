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
import {
  type GameMap,
  allHexes,
  hasRoute,
  inBounds,
  isBridge,
  isRouteHex,
  routeBetween,
  sideFeatureBetween,
  terrainAt,
} from './map.js';
import { type DamageResult, resolve } from './crt.js';
import { rollDice, rollDie } from './rng.js';
import {
  type ConventionalUnit,
  type GameState,
  type OgreUnit,
  type PlayerId,
  type Unit,
  type UnitId,
  activePlayer,
  canAct,
  isOgre,
  onBoard,
  unitsAt,
} from './types.js';
import { revetmentAt } from './state.js';
import {
  addPoints,
  cutRoute,
  destroyUnit,
  log,
  ogreDamageValue,
  setSideOverride,
  setTerrainOverride,
  unitName,
  updateAnyUnit,
  withUnit,
} from './state.js';
import { baseTerrain } from './terrain.js';
import { unitClass } from './units.js';
import { REPACK_TURNS, isDeployedDrone } from './drone.js';
import { mineAt, minefieldsLeft, minesOf, plantMinefield, removeMinefield } from './concealment.js';
import { OGRE_WEAPONS, ogreType } from './ogres.js';

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

// --- River bridges (13.02.1) -----------------------------------------------

/**
 * A bridge that crosses a whole hex, rather than a hexside.
 *
 * "A bridge which crosses a full hex (such as G1-2013) has a defense strength
 * of 8. A river bridge lies in three hexes – the river hex and the adjoining
 * road hexes – and can be attacked by firing at any of them." (13.02.1)
 *
 * On this engine's maps that shape is unambiguous: a water hex with a road or
 * railway running through it is a river bridge, and its span is that hex plus
 * the route hexes either side of it.
 */
export const riverBridgeSpan = (state: GameState, map: GameMap, centre: Hex): Hex[] | null => {
  if (baseTerrain(terrainAt(map, centre, state.terrainOverrides)) !== 'water') return null;
  if (!isRouteHex(map, centre)) return null;
  const ends = neighbors(centre).filter(
    (n) => inBounds(map, n) && routeBetween(map, centre, n) !== undefined,
  );
  return [centre, ...ends];
};

/** The centre hex of the river bridge `h` belongs to, or null. */
export const riverBridgeAt = (state: GameState, map: GameMap, h: Hex): Hex | null => {
  if (riverBridgeSpan(state, map, h)) return h;
  for (const n of neighbors(h)) {
    if (!inBounds(map, n)) continue;
    const span = riverBridgeSpan(state, map, n);
    if (span?.some((x) => eq(x, h))) return n;
  }
  return null;
};

/** Standing, that is: still water underfoot and the route not yet cut. */
export const riverBridgeStands = (state: GameState, map: GameMap, centre: Hex): boolean =>
  riverBridgeSpan(state, map, centre) !== null && !(state.routesCut ?? []).includes(key(centre));

/**
 * Drop a river bridge (13.02.2).
 *
 * "If a river bridge is destroyed, place a 'Bridge Out' overlay on it. No units
 * can safely cross the river on the destroyed bridge. For movement and defense
 * purposes, all units treat that hex as swamp.
 *
 * When a river bridge is destroyed, any unit on its center hex is also
 * destroyed, except an Ogre. An Ogre falls into the river in that hex. Four
 * dice are rolled; this is the amount of damage done to the Ogre's treads. Each
 * other component of the Ogre immediately suffers a 1-1 attack."
 */
export const demolishRiverBridge = (
  state: GameState,
  map: GameMap,
  centre: Hex,
  credit?: PlayerId,
): GameState => {
  if (!riverBridgeStands(state, map, centre)) return state;
  let next = cutRoute(setTerrainOverride(state, centre, 'swamp'), centre);
  next = log(next, 'warn', `The river bridge at ${key(centre)} goes into the water.`, [centre]);

  for (const u of unitsAt(next, centre)) {
    if (!isOgre(u)) {
      next = destroyUnit(next, u.id, 'went into the river with the bridge', credit);
      next = log(next, 'bad', `${unitName(u)} goes down with the span.`, [centre]);
      continue;
    }
    const dice = rollDice(next.rng, 4);
    next = { ...next, rng: dice.state };
    const lost = Math.min(
      u.treads,
      dice.values.reduce((n, v) => n + v, 0),
    );
    next = withUnit(next, { ...u, treads: u.treads - lost });
    if (credit && lost > 0) next = addPoints(next, credit, lost * ogreDamageValue('tread'));
    next = log(
      next,
      'good',
      `${unitName(u)} falls into the river — four dice, ${String(lost)} tread units.`,
      [centre],
    );
    // "Each other component of the Ogre immediately suffers a 1-1 attack."
    for (const w of (next.units[u.id] as OgreUnit).weapons) {
      if (w.destroyed) continue;
      const die = rollDie(next.rng);
      next = { ...next, rng: die.state };
      if (resolve({ kind: 'column', column: '1-1' }, die.value, 'normal') !== 'X') continue;
      const ogre = next.units[u.id];
      if (!ogre || !isOgre(ogre)) break;
      next = withUnit(next, {
        ...ogre,
        weapons: ogre.weapons.map((x) => (x.id === w.id ? { ...x, destroyed: true } : x)),
        internalMissiles:
          w.kind === 'missileRack' ? Math.max(0, ogre.internalMissiles - 1) : ogre.internalMissiles,
      });
      if (credit) next = addPoints(next, credit, ogreDamageValue(w.kind));
      next = log(
        next,
        'good',
        `The fall costs ${unitName(u)} a ${OGRE_WEAPONS[w.kind].name.toLowerCase()}.`,
        [centre],
      );
    }
  }
  return next;
};

/** Every standing river bridge whose span comes within `radius`, for the interface. */
export const riverBridgesNear = (
  state: GameState,
  map: GameMap,
  from: Hex,
  radius: number,
): Hex[] =>
  allHexes(map).filter(
    (h) =>
      riverBridgeStands(state, map, h) &&
      riverBridgeSpan(state, map, h)!.some((x) => distance(x, from) <= radius),
  );

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

/**
 * The tasks of Section 15, in two families.
 *
 * "In the world of Ogre, there are two types of tasks that may be performed on
 * the nuclear battlefield: engineering tasks and Vulcan tasks. During a game,
 * either Combat Engineers or Vulcans may perform engineering tasks, whereas
 * only Vulcans and/or their Heavy Drones may perform Vulcan tasks." (15.00)
 */
export type EngineerTask =
  // 15.03 — any Sapper
  | 'entrench'
  | 'layMine'
  | 'clearMines'
  | 'repairRoute'
  | 'gradeRidge'
  | 'finishOgre'
  | 'demolish'
  // 15.04 — Vulcans and their Heavy Drones
  | 'freeStuck'
  | 'repairRail'
  | 'clearDamagedRoad'
  | 'repairWeapon'
  | 'repairTreads'
  | 'revetSmall'
  | 'revetLarge'
  | 'detectMines'
  // 14.01 — folding a Light Artillery Drone back onto its pallet
  | 'repackDrone';

/** The printed roll for each task, from the table beside 15.04.1. */
export const TASK_ROLL: Readonly<Record<EngineerTask, number>> = {
  // "Placing a mine 5+ ... Disarming an enemy mine 5+ ... Digging
  // entrenchments variable ... Repair road/bridge stream/build ramp 6 ...
  // Grading ridges 5+ ... Finishing off an Ogre 4+ or 6"
  entrench: 1,
  layMine: 5,
  clearMines: 5,
  repairRoute: 6,
  gradeRidge: 5,
  finishOgre: 4,
  demolish: 1,
  // 15.04
  freeStuck: 6,
  repairRail: 5,
  clearDamagedRoad: 4,
  repairWeapon: 6,
  repairTreads: 6,
  // 15.04.7 prints no roll of its own; the section's general "if a 6 is rolled
  // on any die, the task is successfully completed" stands in.
  revetSmall: 6,
  revetLarge: 6,
  // 14.01 prints no roll for re-palletizing a drone: it is a matter of turns,
  // not luck. The number is here only to keep the table total.
  repackDrone: 1,
  // 15.03.3: "they need to roll on one die a number greater than the number of
  // hexes they are searching" — one hex at a time here, so a 2 or better.
  detectMines: 2,
};

/** "A small revetment can offer protection to a unit size 3 or smaller." (15.04.7) */
export const REVETMENT = { small: 3, large: 5, defense: 2 } as const;

const VULCAN_TASKS: readonly EngineerTask[] = [
  'freeStuck',
  'repairRail',
  'clearDamagedRoad',
  'repairWeapon',
  'repairTreads',
  'revetSmall',
  'revetLarge',
];

export const isVulcanTask = (task: EngineerTask): boolean => VULCAN_TASKS.includes(task);

/** Combat Engineers, and the Marine Engineers who are "treated for all purposes like" them (15.01.1). */
export const isEngineer = (u: Unit): boolean =>
  u.kind === 'unit' && (u.classId === 'CE' || u.classId === 'ME');
export const isHeavyDrone = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'HDRN';
export const isVulcan = (u: Unit): boolean => isOgre(u) && u.typeId === 'VULCAN';
/** "the term 'Sapper' encompasses human Combat Engineers as well as Vulcans and/or their Heavy Drones." */
export const isSapper = (u: Unit): boolean => isEngineer(u) || isHeavyDrone(u) || isVulcan(u);

// --- Entrenchments ---------------------------------------------------------

export const entrenchedOf = (state: GameState): Readonly<Record<string, number>> =>
  state.entrenched ?? {};

/** Squads an entrenchment here can shelter; 0 when the hex is not dug in. */
export const entrenchmentAt = (state: GameState, h: Hex): number =>
  entrenchedOf(state)[key(h)] ?? 0;

export const entrenchedAt = (state: GameState, h: Hex): boolean => entrenchmentAt(state, h) > 0;

// --- Dice pools ------------------------------------------------------------

/**
 * The dice a hex musters for an engineering task (15.03).
 *
 * "Each squad of engineers allows one extra die to be rolled. A Heavy Drone
 * gives two dice; a Vulcan with two arms gives four." A single squad is one
 * die, so the count is simply the sum.
 */
export const engineeringDice = (state: GameState, at: Hex, owner: PlayerId): number => {
  let dice = 0;
  for (const u of unitsAt(state, at)) {
    if (u.owner !== owner || !canAct(u)) continue;
    if (isEngineer(u) && u.kind === 'unit') dice += u.squads;
    else if (isHeavyDrone(u)) dice += 2;
    else if (isVulcan(u)) dice += 4;
  }
  return dice;
};

/**
 * The dice for a Vulcan task (15.04): "A Vulcan rolls two dice for success;
 * each Heavy Drone that assists contributes one die."
 */
export const vulcanDice = (state: GameState, at: Hex, owner: PlayerId): number => {
  let dice = 0;
  for (const u of unitsAt(state, at)) {
    if (u.owner !== owner || !canAct(u)) continue;
    if (isVulcan(u)) dice += 2;
    else if (isHeavyDrone(u)) dice += 1;
  }
  return dice;
};

const heavyDronesAt = (state: GameState, at: Hex, owner: PlayerId): number =>
  unitsAt(state, at).filter((u) => u.owner === owner && isHeavyDrone(u) && canAct(u)).length;

const vulcanAt = (state: GameState, at: Hex, owner: PlayerId): boolean =>
  unitsAt(state, at).some((u) => u.owner === owner && isVulcan(u) && canAct(u));

/** Roll the pool; the best die decides, since any one of them may carry it. */
const rollPool = (state: GameState, dice: number): { state: GameState; best: number } => {
  let next = state;
  let best = 0;
  for (let i = 0; i < Math.max(1, dice); i++) {
    const d = rollDie(next.rng);
    next = { ...next, rng: d.state };
    if (d.value > best) best = d.value;
  }
  return { state: next, best };
};

// --- Once a turn -----------------------------------------------------------

const triedKey = (task: EngineerTask, at: Hex): string => `${task}:${key(at)}`;

export const taskTried = (state: GameState, task: EngineerTask, at: Hex): boolean =>
  (state.tasksTried ?? []).includes(triedKey(task, at));

/** Cleared as each player-turn opens. */
export const clearTasks = (state: GameState): GameState =>
  (state.tasksTried?.length ?? 0) === 0 ? state : { ...state, tasksTried: [] };

// --- What is on offer ------------------------------------------------------

export interface TaskOffer {
  readonly task: EngineerTask;
  readonly toward?: Hex;
  readonly target?: UnitId;
  readonly weapon?: string;
  readonly label: string;
}

/**
 * What this Sapper could attempt from where it stands, for the interface and
 * the tests. Empty once it has fired or moved.
 */
export const engineerTasks = (state: GameState, map: GameMap, u: Unit): TaskOffer[] => {
  if (!isSapper(u) || !onBoard(u)) return [];
  if (u.kind === 'unit' && (u.firedThisPhase || u.disabled !== 'none' || u.ridingOn)) return [];
  if (u.kind === 'unit' && u.moveUsed > 0) return [];
  if (isOgre(u) && u.moveUsed > 0) return [];
  const out: TaskOffer[] = [];
  const here = u.pos;
  const owner = u.owner;
  const ground = baseTerrain(terrainAt(map, here, state.terrainOverrides));
  const raw = terrainAt(map, here, state.terrainOverrides);
  const cut = (state.routesCut ?? []).includes(key(here));

  // 15.03.5: "Sappers may protect infantry in clear, forest, or rubble terrain."
  const diggable = ground === 'clear' || ground === 'forest' || ground === 'rubble';
  if (!entrenchedAt(state, here) && diggable) {
    out.push({ task: 'entrench', label: 'Dig entrenchments' });
  }
  // 15.03.1
  if (minefieldsLeft(state, owner) > 0 && !mineAt(state, here)) {
    out.push({ task: 'layMine', label: 'Plant a mine' });
  }
  // 15.03.3: sweep one neighbouring hex for mines.
  for (const n of neighbors(here)) {
    if (!inBounds(map, n)) continue;
    const known = mineAt(state, n);
    if (known && (known.revealed || known.owner === owner)) continue;
    out.push({ task: 'detectMines', toward: n, label: `Sweep ${key(n)} for mines` });
  }
  // 15.03.2 and 15.03.4
  const mine = mineAt(state, here);
  if (mine && (mine.revealed || mine.owner === owner)) {
    out.push({
      task: 'clearMines',
      label: mine.owner === owner ? 'Lift our own mine' : 'Disarm the mine',
    });
  }
  // 15.03.6: a road cut in one spot, mended. Not damaged or rubbled ground.
  if (cut && isRouteHex(map, here) && raw !== 'damagedTown' && raw !== 'damagedForest') {
    out.push({ task: 'repairRoute', label: 'Mend the road here' });
  }
  // 15.03.7
  for (const n of neighbors(here)) {
    if (sideFeatureBetween(map, here, n, state.sideOverrides) === 'ridge') {
      out.push({ task: 'gradeRidge', toward: n, label: `Grade the ridge toward ${key(n)}` });
    }
  }
  // 15.03.8: an Ogre with nothing left to shoot with, in this hex.
  for (const e of unitsAt(state, here)) {
    if (e.owner === owner || !isOgre(e)) continue;
    const live = e.weapons.filter((w) => !w.destroyed);
    if (live.length === 0) {
      out.push({ task: 'finishOgre', target: e.id, label: `Finish off ${e.typeId}` });
    } else if (live.every((w) => w.kind === 'ap') && (isVulcan(u) || isHeavyDrone(u))) {
      out.push({ task: 'finishOgre', target: e.id, label: `Plant an execution charge` });
    }
  }
  // 13.02: the bridge you are standing on.
  for (const n of neighbors(here)) {
    if (bridgeStands(state, map, here, n)) {
      out.push({ task: 'demolish', toward: n, label: `Drop the bridge to ${key(n)}` });
    }
  }
  // 13.02.1: a bridge across a whole hex, from anywhere on its span.
  const river = riverBridgeAt(state, map, here);
  if (river && riverBridgeStands(state, map, river)) {
    out.push({ task: 'demolish', toward: river, label: 'Drop the river bridge' });
  }
  // 14.01: a drone standing here, to be folded back onto its pallet.
  for (const friend of unitsAt(state, here)) {
    if (friend.owner !== owner || !isDeployedDrone(friend)) continue;
    const doneSoFar = friend.kind === 'unit' ? (friend.repackProgress ?? 0) : 0;
    out.push({
      task: 'repackDrone',
      target: friend.id,
      label: isVulcan(u)
        ? 'Break the drone down and load it'
        : `Re-palletize the drone (${String(doneSoFar)} of ${String(REPACK_TURNS)} turns)`,
    });
  }

  // --- 15.04, for the Vulcan and its Drones ---------------------------------
  if (!isVulcan(u) && !isHeavyDrone(u)) return out;

  // 15.04.7: a prepared position. "Entrenchments may not be built within a
  // revetment", and nor the other way about.
  if (revetmentAt(state, here) === 0 && !entrenchedAt(state, here) && ground !== 'water') {
    out.push({ task: 'revetSmall', label: 'Dig a small revetment' });
    out.push({ task: 'revetLarge', label: 'Dig a large revetment' });
  }
  if (cut && isRouteHex(map, here)) {
    // 15.04.2 rail, 15.04.3 roads cut by damaged terrain.
    if (hasRoute(map, here, 'rail') && raw !== 'damagedTown' && raw !== 'damagedForest') {
      out.push({ task: 'repairRail', label: 'Relay the rail' });
    }
    if (raw === 'damagedTown' || raw === 'damagedForest') {
      out.push({ task: 'clearDamagedRoad', label: 'Clear the road through the wreckage' });
    }
  }
  for (const friend of unitsAt(state, here)) {
    if (friend.owner !== owner || friend.id === u.id) continue;
    // 15.04.1
    if (friend.stuck)
      out.push({ task: 'freeStuck', target: friend.id, label: 'Pull it out of the swamp' });
    if (!isOgre(friend)) continue;
    // 15.04.5 and 15.04.6
    if (friend.treads < ogreType(friend.typeId).treads) {
      out.push({ task: 'repairTreads', target: friend.id, label: 'Repair treads in the field' });
    }
    for (const w of friend.weapons) {
      if (!w.destroyed || w.beyondRepair === true) continue;
      // "Destroyed external missiles and missile racks are always too damaged
      // to attempt field repair." (15.04.5)
      if (w.kind === 'missile' || w.kind === 'missileRack') continue;
      out.push({
        task: 'repairWeapon',
        target: friend.id,
        weapon: w.id,
        label: 'Attempt a field repair',
      });
      break;
    }
  }
  return out;
};

// --- Doing the work --------------------------------------------------------

export interface TaskOptions {
  readonly toward?: Hex;
  readonly target?: UnitId;
  readonly weapon?: string;
  /** 13.04's choice, for `layMine`. */
  readonly onRoad?: boolean;
}

/**
 * Attempt one task, in place of the Sapper's shot.
 *
 * "To attempt to perform an engineering task, one or more Combat Engineer
 * squads and/or Vulcans must start their turn in the hex they wish to perform
 * the task, and stay in that hex for the duration of that turn. Tasks are
 * assigned a number that must be rolled on one die for success ... There is no
 * limit as to the number of Sappers that may help to perform any specific task
 * on a turn, but each Sapper may make only one attempt per turn, and the
 * specific task may be attempted only once per turn regardless of how many
 * Sappers participate ... Attempting a task counts as that squad's 'attack'
 * for that turn, and is made during the Fire Phase." (15.03)
 */
export const engineer = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  unitId: UnitId,
  task: EngineerTask,
  toward?: Hex,
  opts: TaskOptions = {},
): { state: GameState; ok: boolean; reason?: string } => {
  if (state.phase !== 'fire')
    return { state, ok: false, reason: 'engineering is done in the fire phase (15.03)' };
  if (activePlayer(state) !== by) return { state, ok: false, reason: 'it is not your turn' };
  const u = state.units[unitId];
  if (!u || !onBoard(u)) return { state, ok: false, reason: 'no such unit' };
  if (u.owner !== by) return { state, ok: false, reason: 'not your unit' };
  if (!isSapper(u)) return { state, ok: false, reason: 'only Sappers do engineering work (15.00)' };
  if (u.kind === 'unit' && u.disabled !== 'none')
    return { state, ok: false, reason: 'disabled engineers do no work' };
  if (u.kind === 'unit' && u.ridingOn)
    return { state, ok: false, reason: 'the engineers must dismount first' };
  if (u.kind === 'unit' && u.firedThisPhase)
    return { state, ok: false, reason: 'the work is their attack for the turn: they have fired' };
  if (u.moveUsed > 0)
    return { state, ok: false, reason: 'they must start the turn in the hex and stay in it' };
  if (isVulcanTask(task) && !isVulcan(u) && !isHeavyDrone(u)) {
    return { state, ok: false, reason: 'only a Vulcan or its Heavy Drones can do that (15.04)' };
  }
  if (taskTried(state, task, u.pos)) {
    return { state, ok: false, reason: 'that work has already been tried here this turn (15.03)' };
  }

  const here = u.pos;
  const where = toward ?? opts.toward;
  const dice = isVulcanTask(task) ? vulcanDice(state, here, by) : engineeringDice(state, here, by);

  const done = (s: GameState): GameState => {
    let out: GameState = { ...s, tasksTried: [...(s.tasksTried ?? []), triedKey(task, here)] };
    if (u.kind === 'unit') {
      out = updateAnyUnit(out, unitId, () => ({ firedThisPhase: true, squadsFired: u.squads }));
    }
    return out;
  };
  const refuse = (reason: string) => ({ state, ok: false, reason });

  switch (task) {
    // --- 15.03 ------------------------------------------------------------
    case 'entrench': {
      const ground = baseTerrain(terrainAt(map, here, state.terrainOverrides));
      if (ground !== 'clear' && ground !== 'forest' && ground !== 'rubble') {
        return refuse('entrenchments only help in clear, forest or rubble (15.03.5)');
      }
      if (entrenchedAt(state, here)) return refuse('that hex is entrenched already');
      // "Entrenchments may not be built within a revetment." (15.03.5)
      if (revetmentAt(state, here) > 0) return refuse('there is a revetment here already');
      const roll = rollPool(state, dice);
      // "On a roll of a 1-4, one squad-equivalent ... protect one squad ... a
      // roll of a 5 ... two squads, and a roll of a 6 a 3-squad entrenchment."
      const squads = roll.best >= 6 ? 3 : roll.best === 5 ? 2 : 1;
      let next: GameState = {
        ...roll.state,
        entrenched: { ...entrenchedOf(roll.state), [key(here)]: squads },
      };
      next = log(
        next,
        'good',
        `${unitName(u)} dig in at ${key(here)} — rolled ${roll.best}: cover for ${squads} squad${squads === 1 ? '' : 's'}.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'layMine': {
      if (minefieldsLeft(state, by) <= 0) return refuse('no mines left in this scenario');
      if (mineAt(state, here)) return refuse('there is a mine here already');
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL.layMine) {
        return {
          state: done(
            log(roll.state, 'info', `${unitName(u)} fail to seat the mine — rolled ${roll.best}.`, [
              here,
            ]),
          ),
          ok: true,
        };
      }
      const next = log(
        plantMinefield(roll.state, map, by, here, opts.onRoad),
        'good',
        `${unitName(u)} plant a mine.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'clearMines': {
      const mine = mineAt(state, here);
      if (!mine) return refuse('there is no minefield here');
      // "Any friendly Sapper in the mined hex can automatically disarm
      // successfully placed mines without requiring a roll." (15.03.2)
      if (mine.owner === by) {
        const next = log(
          removeMinefield(state, mine.id),
          'info',
          `${unitName(u)} lift their own mine.`,
          [here],
        );
        return { state: done(next), ok: true };
      }
      if (!mine.revealed) return refuse('nobody knows of a minefield here');
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL.clearMines) {
        return {
          state: done(
            log(
              roll.state,
              'info',
              `${unitName(u)} work at the mine — rolled ${roll.best}: another turn of it.`,
              [here],
            ),
          ),
          ok: true,
        };
      }
      const next = log(
        removeMinefield(roll.state, mine.id),
        'good',
        `${unitName(u)} disarm the mine — rolled ${roll.best}.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'repairRoute':
    case 'repairRail':
    case 'clearDamagedRoad': {
      if (!(state.routesCut ?? []).includes(key(here))) return refuse('the road here is not cut');
      const raw = terrainAt(map, here, state.terrainOverrides);
      const wrecked = raw === 'damagedTown' || raw === 'damagedForest';
      if (baseTerrain(raw) === 'rubble') return refuse('rubble is beyond repair (15.04.3)');
      if (task === 'clearDamagedRoad') {
        if (!wrecked) return refuse('nothing here is blocked by damaged terrain');
        // "Clearing damaged terrain requires either a Vulcan or at least two
        // Heavy Drones." (15.04.3)
        if (!vulcanAt(state, here, by) && heavyDronesAt(state, here, by) < 2) {
          return refuse('that needs a Vulcan, or two Heavy Drones');
        }
      } else if (wrecked) {
        return refuse('the damage here is too extensive; a Vulcan must clear it (15.03.6)');
      }
      if (task === 'repairRoute') {
        // "A player picking one or more Combat Engineer squads may choose a
        // Truck or Hovertruck per squad with the needed gear ... Vulcans and
        // Heavy Drones have these tools and supplies automatically." (15.03.6)
        const hasKit =
          vulcanAt(state, here, by) ||
          heavyDronesAt(state, here, by) > 0 ||
          unitsAt(state, here).some(
            (t) =>
              t.owner === by && t.kind === 'unit' && (t.classId === 'TK' || t.classId === 'HT'),
          );
        if (!hasKit) return refuse('a supply Truck has to be here with them (15.03.6)');
      }
      const roll = rollPool(state, dice);
      const needs = TASK_ROLL[task];
      if (roll.best < needs) {
        return {
          state: done(
            log(roll.state, 'info', `The work goes on at ${key(here)} — rolled ${roll.best}.`, [
              here,
            ]),
          ),
          ok: true,
        };
      }
      const next = log(
        { ...roll.state, routesCut: (roll.state.routesCut ?? []).filter((k) => k !== key(here)) },
        'good',
        `${unitName(u)} put the ${hasRoute(map, here, 'rail') ? 'line' : 'road'} through ${key(here)} back in service.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'gradeRidge': {
      if (!where) return refuse('say which ridge');
      if (sideFeatureBetween(map, here, where, state.sideOverrides) !== 'ridge') {
        return refuse('there is no ridge on that side');
      }
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL.gradeRidge) {
        return {
          state: done(
            log(roll.state, 'info', `The charges do not take — rolled ${roll.best}.`, [here]),
          ),
          ok: true,
        };
      }
      const next = log(
        setSideOverride(roll.state, here, where, 'none'),
        'good',
        `${unitName(u)} blow a gap in the ridge at ${key(here)}.`,
        [here, where],
      );
      return { state: done(next), ok: true };
    }

    case 'finishOgre': {
      const targetId = opts.target;
      const ogre = targetId ? state.units[targetId] : undefined;
      if (!ogre || !isOgre(ogre) || !onBoard(ogre)) return refuse('no cybertank here to finish');
      if (!eq(ogre.pos, here)) return refuse('they have to climb onto it');
      if (ogre.owner === by) return refuse('that is your own cybertank');
      const live = ogre.weapons.filter((w) => !w.destroyed);
      let needs = TASK_ROLL.finishOgre;
      if (live.length > 0) {
        if (!live.every((w) => w.kind === 'ap')) return refuse('it can still shoot back');
        if (!isVulcan(u) && !isHeavyDrone(u)) {
          return refuse('an execution charge on an armed Ogre is a Vulcan’s work (15.03.8)');
        }
        // "a roll of 4+ to succeed if the Ogre is immobile, or a 6 to succeed
        // if the Ogre can still move".
        needs = ogre.treads > 0 ? 6 : 4;
      }
      const roll = rollPool(state, dice);
      if (roll.best < needs) {
        return {
          state: done(
            log(
              roll.state,
              'info',
              `The charge does not fire — rolled ${roll.best}, needed ${needs}.`,
              [here],
            ),
          ),
          ok: true,
        };
      }
      let next = log(
        roll.state,
        'good',
        `${unitName(u)} blow ${unitName(ogre)} apart at close quarters.`,
        [here],
      );
      next = destroyUnit(next, ogre.id, 'coup de grâce', by);
      return { state: done(next), ok: true };
    }

    case 'demolish': {
      if (!where) return refuse('say which bridge');
      // A bridge across a whole hex is named by its centre, which the sappers
      // may be standing on (13.02.1).
      if (riverBridgeStands(state, map, where) && riverBridgeAt(state, map, here) !== null) {
        const next = log(
          demolishRiverBridge(state, map, where, by),
          'good',
          `${unitName(u)} blow the river bridge.`,
          [where],
        );
        return { state: done(next), ok: true };
      }
      if (distance(here, where) !== 1) return refuse('the bridge must be next to them');
      if (!bridgeStands(state, map, here, where))
        return refuse('there is no bridge standing there');
      const next = log(
        demolishBridge(state, here, where),
        'good',
        `${unitName(u)} blow the bridge.`,
        [here, where],
      );
      return { state: done(next), ok: true };
    }

    // --- 14.01 ------------------------------------------------------------
    case 'repackDrone': {
      const targetId = opts.target;
      const drone = targetId ? state.units[targetId] : undefined;
      if (!drone || !onBoard(drone) || !isDeployedDrone(drone)) {
        return refuse('there is no drone standing here to fold up');
      }
      if (!eq(drone.pos, here)) return refuse('it is not in this hex');
      if (drone.owner !== by) return refuse('that is not your drone');
      if (drone.kind !== 'unit') return refuse('that is not a drone');

      // "A Vulcan may break down and load an LAD in one turn provided it
      // performs no other action that turn." (14.01)
      const inOne = isVulcan(u);
      const soFar = inOne ? REPACK_TURNS : (drone.repackProgress ?? 0) + 1;
      if (soFar < REPACK_TURNS) {
        const next = log(
          state,
          'info',
          `${unitName(u)} work on ${unitName(drone)} — ${String(soFar)} of ` +
            `${String(REPACK_TURNS)} turns to re-palletize it.`,
          [here],
        );
        return {
          state: done(updateAnyUnit(next, drone.id, () => ({ repackProgress: soFar }))),
          ok: true,
        };
      }

      let next = updateAnyUnit(state, drone.id, () => ({
        droneState: 'pallet' as const,
        repackProgress: 0,
        // It has been taken apart; it is nobody's gun this turn.
        firedThisPhase: true,
      }));
      next = log(
        next,
        'good',
        inOne
          ? `${unitName(u)} breaks ${unitName(drone)} down onto its pallet in one turn.`
          : `${unitName(u)} finish re-palletizing ${unitName(drone)}. One more turn to load it.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    // --- 15.04 ------------------------------------------------------------
    case 'freeStuck': {
      const targetId = opts.target;
      const stuck = targetId ? state.units[targetId] : undefined;
      if (!stuck || !onBoard(stuck) || !stuck.stuck) return refuse('nothing stuck here');
      if (!eq(stuck.pos, here)) return refuse('it is not in this hex');
      if (!vulcanAt(state, here, by)) {
        return refuse('Heavy Drones may not free a unit on their own (15.04.1)');
      }
      if (isVulcan(stuck)) return refuse('a Vulcan may not free itself (15.04.1)');
      // "A Vulcan may attempt to free any unit size 5 or smaller on its own.
      // For every step up in size, one Heavy Drone is required."
      const size = isOgre(stuck) ? ogreType(stuck.typeId).size : unitClass(stuck.classId).size;
      const needDrones = Math.max(0, size - 5);
      if (heavyDronesAt(state, here, by) < needDrones) {
        return refuse(
          `a size ${String(size)} unit needs ${String(needDrones)} Heavy Drone${needDrones === 1 ? '' : 's'} to help (15.04.1)`,
        );
      }
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL.freeStuck) {
        return {
          state: done(log(roll.state, 'info', `It will not shift — rolled ${roll.best}.`, [here])),
          ok: true,
        };
      }
      let next = updateAnyUnit(roll.state, stuck.id, () => ({ stuck: false }));
      next = log(next, 'good', `${unitName(u)} winch ${unitName(stuck)} out of the swamp.`, [here]);
      return { state: done(next), ok: true };
    }

    case 'repairWeapon': {
      if (!isVulcan(u))
        return refuse('field repair of a weapon is the Vulcan’s own work (15.04.5)');
      const targetId = opts.target;
      const ogre = targetId ? state.units[targetId] : undefined;
      if (!ogre || !isOgre(ogre) || !eq(ogre.pos, here))
        return refuse('no cybertank here to work on');
      const w = ogre.weapons.find((x) => x.id === opts.weapon);
      if (!w || !w.destroyed) return refuse('that weapon is not damaged');
      if (w.beyondRepair === true) return refuse('that one is beyond field repair');
      if (w.kind === 'missile' || w.kind === 'missileRack') {
        return refuse('destroyed missiles and racks are always beyond field repair (15.04.5)');
      }
      // "Whenever an attempt is made to repair a weapon that was destroyed,
      // roll one die. On a 5 or 6, the damage is light enough that an attempt
      // ... may be made. On any other result, a notation should be made on the
      // record sheet that this weapon is beyond field repair."
      const look = rollDie(state.rng);
      let next: GameState = { ...state, rng: look.state };
      if (look.value < 5) {
        next = withUnit(next, {
          ...ogre,
          weapons: ogre.weapons.map((x) => (x.id === w.id ? { ...x, beyondRepair: true } : x)),
        });
        next = log(
          next,
          'info',
          `The mounting is wrecked — rolled ${look.value}: beyond field repair.`,
          [here],
        );
        return { state: done(next), ok: true };
      }
      // "Only one die is rolled for each attempt, and a 6 is required."
      const fix = rollDie(next.rng);
      next = { ...next, rng: fix.state };
      if (fix.value < TASK_ROLL.repairWeapon) {
        next = log(next, 'info', `The repair fails — rolled ${fix.value}.`, [here]);
        return { state: done(next), ok: true };
      }
      const live = next.units[ogre.id];
      if (live && isOgre(live)) {
        next = withUnit(next, {
          ...live,
          weapons: live.weapons.map((x) =>
            x.id === w.id ? { ...x, destroyed: false, fired: false } : x,
          ),
        });
      }
      next = log(
        next,
        'good',
        `${unitName(u)} bring a ${OGRE_WEAPONS[w.kind].name.toLowerCase()} back on line.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'detectMines': {
      if (!where) return refuse('say which hex to sweep');
      if (distance(here, where) !== 1) return refuse('they sweep the hexes around them');
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL.detectMines) {
        return {
          state: done(
            log(roll.state, 'info', `The sweep of ${key(where)} turns up nothing.`, [where]),
          ),
          ok: true,
        };
      }
      const found = mineAt(roll.state, where);
      if (!found || found.owner === by) {
        return {
          state: done(log(roll.state, 'info', `${key(where)} is clear.`, [where])),
          ok: true,
        };
      }
      const next = log(
        {
          ...roll.state,
          mines: minesOf(roll.state).map((m) => (m.id === found.id ? { ...m, revealed: true } : m)),
        },
        'good',
        `${unitName(u)} sweep ${key(where)} and find a minefield.`,
        [where],
      );
      return { state: done(next), ok: true };
    }

    case 'revetSmall':
    case 'revetLarge': {
      if (revetmentAt(state, here) > 0) return refuse('there is a revetment here already');
      if (entrenchedAt(state, here))
        return refuse('the hex is entrenched; a revetment needs open ground');
      if (baseTerrain(terrainAt(map, here, state.terrainOverrides)) === 'water') {
        return refuse('there is nothing to dig into there');
      }
      const size = task === 'revetLarge' ? REVETMENT.large : REVETMENT.small;
      const roll = rollPool(state, dice);
      if (roll.best < TASK_ROLL[task]) {
        return {
          state: done(
            log(roll.state, 'info', `The digging goes on — rolled ${roll.best}.`, [here]),
          ),
          ok: true,
        };
      }
      let next: GameState = {
        ...roll.state,
        revetments: { ...(roll.state.revetments ?? {}), [key(here)]: size },
      };
      next = log(
        next,
        'good',
        `${unitName(u)} dig a ${task === 'revetLarge' ? 'large' : 'small'} revetment at ${key(here)}.`,
        [here],
      );
      return { state: done(next), ok: true };
    }

    case 'repairTreads': {
      const targetId = opts.target;
      const ogre = targetId ? state.units[targetId] : undefined;
      if (!ogre || !isOgre(ogre) || !eq(ogre.pos, here))
        return refuse('no cybertank here to work on');
      const full = ogreType(ogre.typeId).treads;
      if (ogre.treads >= full) return refuse('its treads are whole');
      // "two dice for a Vulcan, one for each Drone. For every 6 that is rolled
      // during the attempt, one tread is repaired." (15.04.6)
      let next = state;
      let mended = 0;
      for (let i = 0; i < Math.max(1, dice); i++) {
        const d = rollDie(next.rng);
        next = { ...next, rng: d.state };
        if (d.value >= TASK_ROLL.repairTreads) mended += 1;
      }
      if (mended === 0) {
        return {
          state: done(log(next, 'info', 'A turn of work, and nothing to show for it.', [here])),
          ok: true,
        };
      }
      const put = Math.min(mended, full - ogre.treads);
      next = updateAnyUnit(next, ogre.id, () => ({ treads: ogre.treads + put }));
      next = log(
        next,
        'good',
        `${unitName(u)} relay ${String(put)} tread unit${put === 1 ? '' : 's'}.`,
        [here],
      );
      return { state: done(next), ok: true };
    }
  }
};

/** For the record: a conventional unit with the shape the sheet rules need. */
export type SheetUnit = ConventionalUnit;

/** True when two hexes are the same, for callers without `eq` in scope. */
export const sameHex = eq;
