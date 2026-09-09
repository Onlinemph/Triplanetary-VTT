/**
 * What a Vulcan is for (15.02, 15.04.4, 15.04.8).
 *
 * "The Vulcan repair and recovery cybertank was the Combine's solution to the
 * logistic problem of delivering an Ogre quickly." Its fighting rules are
 * ordinary — two secondary batteries, six AP guns, arms at D2, all in
 * `ogres.ts` — and everything that makes it a Vulcan is logistics:
 *
 *  - **Cargo** (15.02.1), inside where it is safe and on top where it is not.
 *  - **Assembly** (15.02.2), a table of turns from a Mark II to a Ninja,
 *    shortened by every extra arm that helps.
 *  - **Drones** (15.02.3–15.02.5): four control channels, which can drive one
 *    crewless vehicle each as a full combat Drone, or shepherd four apiece as
 *    "ducklings" that must stay in the Vulcan's hex or stop dead.
 *  - **Reloading** (15.04.4) and **towing** (15.04.8), which are Vulcan tasks
 *    like the rest of 15.04 and live beside them in `engineering.ts`.
 *
 * The pieces that need somewhere to live — the tables, the arithmetic, and the
 * checks the reducer and the tasks both ask — are here.
 */

import { distance } from './hex.js';
import { type OgreTypeId, ogreType } from './ogres.js';
import { unitClass } from './units.js';
import {
  type ConventionalUnit,
  type GameState,
  type OgreUnit,
  type Unit,
  type UnitId,
  isOgre,
  isPallet,
  onBoard,
} from './types.js';

// ---------------------------------------------------------------------------
// 15.02.1 Cargo capacity
// ---------------------------------------------------------------------------

/**
 * "The Vulcan has enough internal cargo space to carry a dozen Ogre missiles,
 * or two Platoons (or six squads) of battlesuited infantry if they're not
 * claustrophobic, or six LADs on pallets, or an equivalent load ... The
 * Vulcan's top cargo area can carry a unit or units totaling Size 4, or four
 * Platoons (or 12 squads), or 12 LADs on pallets, or two dozen Ogre missiles."
 *
 * Those five lists give one currency. Count in missiles: the hold takes twelve
 * and the deck twenty-four, a squad or a pallet is worth two missiles, and a
 * point of Size is worth six — because Size 4 fills the deck.
 */
export const VULCAN_CARGO = { internal: 12, top: 24 } as const;
export const CARGO_PER_MISSILE = 1;
export const CARGO_PER_SQUAD = 2;
export const CARGO_PER_PALLET = 2;
export const CARGO_PER_SIZE = 6;

export type CargoArea = 'internal' | 'top';

/** What one counter takes up in the Vulcan's cargo currency. */
export const cargoCost = (u: Unit): number => {
  if (isOgre(u)) return ogreType(u.typeId).size * CARGO_PER_SIZE;
  if (isPallet(u)) return CARGO_PER_PALLET;
  const cls = unitClass(u.classId);
  if (cls.kind === 'infantry') return u.squads * CARGO_PER_SQUAD;
  return cls.size * CARGO_PER_SIZE;
};

/** Everything a Vulcan is carrying, by area. */
export const cargoOf = (state: GameState, vulcan: UnitId, area?: CargoArea): ConventionalUnit[] =>
  Object.values(state.units).filter(
    (u): u is ConventionalUnit =>
      u.kind === 'unit' &&
      !u.destroyed &&
      u.stowedIn === vulcan &&
      (area === undefined || (u.stowedOn ?? 'top') === area),
  );

/** Spare Ogre missiles in the hold, which is what 15.04.4 reloads from. */
export const spareMissiles = (state: GameState, vulcan: UnitId): number =>
  state.vulcanMissiles?.[vulcan] ?? 0;

export const cargoUsed = (state: GameState, vulcan: UnitId, area: CargoArea): number => {
  const stowed = cargoOf(state, vulcan, area).reduce((n, u) => n + cargoCost(u), 0);
  // The spare missiles ride in the hold with everything else.
  return area === 'internal' ? stowed + spareMissiles(state, vulcan) * CARGO_PER_MISSILE : stowed;
};

export const cargoLeft = (state: GameState, vulcan: UnitId, area: CargoArea): number =>
  VULCAN_CARGO[area] - cargoUsed(state, vulcan, area);

/** Why this counter cannot be stowed there, or null when it can. */
export const stowCheck = (
  state: GameState,
  vulcan: Unit | undefined,
  cargo: Unit | undefined,
  area: CargoArea,
): string | null => {
  if (!vulcan || !isOgre(vulcan) || vulcan.typeId !== 'VULCAN') return 'that is not a Vulcan';
  if (!onBoard(vulcan)) return 'that Vulcan is gone';
  if (!cargo || !onBoard(cargo)) return 'no such cargo';
  if (isOgre(cargo)) return 'a Vulcan does not carry another cybertank';
  if (cargo.owner !== vulcan.owner) return 'that is not yours to load';
  if (cargo.stowedIn) return 'it is already stowed';
  if (cargo.ridingOn) return 'it is riding something else';
  if (distance(cargo.pos, vulcan.pos) !== 0) return 'it must be in the Vulcan’s hex';
  // "Infantry ... if they're not claustrophobic": the hold takes squads,
  // missiles and pallets, and the deck takes anything.
  if (area === 'internal') {
    const cls = unitClass(cargo.classId);
    if (cls.kind !== 'infantry' && !isPallet(cargo)) {
      return 'the hold takes squads, pallets and missiles; a vehicle goes on the deck';
    }
  }
  if (cargoCost(cargo) > cargoLeft(state, vulcan.id, area)) return 'there is no room';
  return null;
};

/**
 * "Combat units will be exposed to spillover fire from anything that hits the
 * Vulcan. Items on pallets, missiles, and so on will simply be destroyed if the
 * Vulcan is hit." (15.02.1) The hold is the other way about: "This storage
 * space will survive as long as the Ogre does."
 */
export const exposedCargo = (state: GameState, vulcan: UnitId): ConventionalUnit[] =>
  cargoOf(state, vulcan, 'top');

// ---------------------------------------------------------------------------
// 15.02.2 Maintenance and assembly
// ---------------------------------------------------------------------------

/**
 * "To assemble an Ogre from its modular parts: Mark II – 12 turns. Mark III –
 * 30 turns. Mark III-B – 42 turns Mark IV or V – 60 turns Vulcan – 72 turns
 * Ninja – at least 75 turns"
 *
 * The Mark I and Mark VI are not on the list. "Mark VI units were never
 * delivered in modular form"; the Mark I is a Mark II's little brother, and the
 * shortest job on the list is the closest thing the rules give it.
 */
export const ASSEMBLY_TURNS: Readonly<Partial<Record<OgreTypeId, number>>> = {
  MK1: 12,
  MK2: 12,
  MK3: 30,
  MK3B: 42,
  MK4: 60,
  MK5: 60,
  VULCAN: 72,
  NINJA: 75,
};

/** The other jobs 15.02.2 puts a number on, in turns. */
export const VULCAN_JOBS = {
  /** "To secure a damaged armor unit in the field and winch it onto the top cargo area: six turns." */
  winch: 6,
  /** "To unload all palleted cargo from either the top or interior ... six turns." */
  bulkCargo: 6,
  /** "To load or unload a single specified item: one turn." */
  oneItem: 1,
} as const;

/**
 * "These times assume 'two arms' – an undamaged, unassisted Vulcan with its
 * swarm of Light Drones. Reduce time by 1/3 (i.e., a 6-turn job takes 4 turns)
 * if there is one more arm helping ... Halve times if two arms ... are helping."
 *
 * `arms` is the help, not the Vulcan's own two: a Heavy Drone is one arm, and
 * another Vulcan is two.
 */
export const withHelp = (turns: number, arms: number): number => {
  if (arms >= 2) return Math.ceil(turns / 2);
  if (arms === 1) return Math.ceil((turns * 2) / 3);
  return turns;
};

/** Turns to build a cybertank of this type, with `arms` of help (15.02.2). */
export const assemblyTurns = (typeId: OgreTypeId, arms = 0): number | null => {
  const base = ASSEMBLY_TURNS[typeId];
  return base === undefined ? null : withHelp(base, arms);
};

// ---------------------------------------------------------------------------
// 15.02.4, 15.02.5 Drone control
// ---------------------------------------------------------------------------

/** "A Vulcan may control up to four Heavy Drones at once" (15.02). */
export const CONTROL_CHANNELS = 4;
/** "it may have up to four units of any type in each Drone control channel" (15.02.5). */
export const DUCKLINGS_PER_CHANNEL = 4;
/** "So a Vulcan might be followed by up to 16 'ducklings'". */
export const MAX_DUCKLINGS = CONTROL_CHANNELS * DUCKLINGS_PER_CHANNEL;

export type ControlLevel = 'combat' | 'duckling';

/** Everything a Vulcan is driving, at either level. */
export const controlledBy = (
  state: GameState,
  vulcan: UnitId,
  level?: ControlLevel,
): ConventionalUnit[] =>
  Object.values(state.units).filter(
    (u): u is ConventionalUnit =>
      u.kind === 'unit' &&
      onBoard(u) &&
      u.drivenBy === vulcan &&
      (level === undefined || u.control === level),
  );

/**
 * Channels a Vulcan has spent.
 *
 * "Each such unit takes one of the Vulcan's four Heavy-Drone slots" (15.02.4)
 * for a full combat Drone; ducklings share, four to a channel (15.02.5).
 */
export const channelsUsed = (state: GameState, vulcan: UnitId): number =>
  controlledBy(state, vulcan, 'combat').length +
  Math.ceil(controlledBy(state, vulcan, 'duckling').length / DUCKLINGS_PER_CHANNEL);

/** Why this Vulcan cannot take that unit under control, or null when it can. */
export const controlCheck = (
  state: GameState,
  vulcan: Unit | undefined,
  unit: Unit | undefined,
  level: ControlLevel,
): string | null => {
  if (!vulcan || !isOgre(vulcan) || vulcan.typeId !== 'VULCAN') return 'that is not a Vulcan';
  if (!onBoard(vulcan)) return 'that Vulcan is gone';
  if (!unit || !onBoard(unit)) return 'no such unit';
  if (isOgre(unit)) return 'a cybertank drives itself';
  if (unit.owner !== vulcan.owner) return 'that is not yours to drive';
  if (unit.drivenBy === vulcan.id && unit.control === level) return 'already on that channel';
  // "all within one hex of the Vulcan"
  if (distance(unit.pos, vulcan.pos) > 1) return 'it must be within a hex of the Vulcan';

  const combat = controlledBy(state, vulcan.id, 'combat').filter((u) => u.id !== unit.id).length;
  const ducks = controlledBy(state, vulcan.id, 'duckling').filter((u) => u.id !== unit.id).length;
  const used = combat + Math.ceil(ducks / DUCKLINGS_PER_CHANNEL);
  if (level === 'combat') {
    if (used + 1 > CONTROL_CHANNELS) return 'all four control channels are spoken for';
  } else {
    const after = combat + Math.ceil((ducks + 1) / DUCKLINGS_PER_CHANNEL);
    if (after > CONTROL_CHANNELS) return 'all sixteen duckling slots are taken';
  }
  return null;
};

/** The Vulcan driving this unit, if one is and is still in range. */
export const driverOf = (state: GameState, u: Unit): OgreUnit | null => {
  if (u.kind !== 'unit' || !u.drivenBy) return null;
  const v = state.units[u.drivenBy];
  if (!v || !isOgre(v) || !onBoard(v)) return null;
  return v;
};

/**
 * "They must either stay within a hex of the Vulcan or stop moving completely,
 * in which case they are considered disabled." (15.02.5)
 *
 * A duckling that has wandered is out of contact; a combat Drone has a whole
 * channel to itself and "can ... operate normally with no crew at all"
 * (15.02.4), so it only needs its Vulcan alive.
 */
export const outOfContact = (state: GameState, u: Unit): boolean => {
  if (u.kind !== 'unit' || !u.drivenBy) return false;
  const v = driverOf(state, u);
  if (!v) return true;
  return u.control === 'duckling' ? distance(u.pos, v.pos) > 1 : false;
};

/**
 * A crewless vehicle only fights because something is driving it.
 *
 * "Humans are used for crew not because they are better, but because they are
 * far cheaper than combat-capable AI systems!" (15.02.4) A crewless counter
 * with no Vulcan on it does nothing at all; one on a combat channel works
 * normally; one following as a duckling "fight[s] at half strength" (15.02.5).
 */
export const crewlessPenalty = (state: GameState, u: Unit): 'none' | 'half' | 'inert' => {
  if (u.kind !== 'unit' || u.crewless !== true) return 'none';
  if (outOfContact(state, u)) return 'inert';
  if (u.control === 'combat') return 'none';
  if (u.control === 'duckling') return 'half';
  return 'inert';
};

// ---------------------------------------------------------------------------
// 15.04.8 Towing
// ---------------------------------------------------------------------------

/**
 * "The Vulcan's movement is decreased based upon the size of the vehicle it
 * attempts to tow.
 *
 *     Vehicle Size   Movement Modifier
 *     5 or less       0
 *     6 or 7         -1
 *     8              -2
 *     9              -3"
 */
export const towingPenalty = (size: number): number => {
  if (size <= 5) return 0;
  if (size <= 7) return 1;
  if (size === 8) return 2;
  return 3;
};

/** The unit a Vulcan has on its hitch, if any. */
export const towedBy = (state: GameState, vulcan: UnitId): Unit | null =>
  Object.values(state.units).find((u) => onBoard(u) && u.towedBy === vulcan) ?? null;

/** How much slower a unit is for what it is dragging (15.04.8). */
export const towingCost = (state: GameState, u: Unit): number => {
  const load = towedBy(state, u.id);
  if (!load) return 0;
  const size = isOgre(load) ? ogreType(load.typeId).size : unitClass(load.classId).size;
  return towingPenalty(size);
};

/**
 * Why this Vulcan cannot hitch that vehicle up, or null when it can.
 *
 * "A Vulcan can tow disabled or immobile vehicles ... A Vulcan may only tow one
 * vehicle at a time." (15.04.8)
 */
export const towCheck = (
  state: GameState,
  vulcan: Unit | undefined,
  load: Unit | undefined,
): string | null => {
  if (!vulcan || !isOgre(vulcan) || vulcan.typeId !== 'VULCAN') return 'that is not a Vulcan';
  if (!load || !onBoard(load)) return 'no such vehicle';
  if (load.id === vulcan.id) return 'not itself';
  if (distance(load.pos, vulcan.pos) !== 0) return 'it must be in the Vulcan’s hex';
  if (towedBy(state, vulcan.id)) return 'it is already towing something';
  if (load.towedBy) return 'something else has it on the hitch';
  if (load.kind === 'unit' && unitClass(load.classId).kind === 'infantry') {
    return 'infantry walk';
  }
  // "A Vulcan can tow disabled or immobile vehicles."
  const immobile =
    load.stuck ||
    (load.kind === 'unit' && (load.disabled !== 'none' || unitClass(load.classId).move === 0)) ||
    (isOgre(load) && load.treads === 0);
  if (!immobile) return 'that vehicle can drive itself';
  return null;
};
