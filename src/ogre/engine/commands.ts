/**
 * The command union — the complete list of things a player can do.
 *
 * A game *is* its scenario seed plus an ordered list of these. Every one is
 * plain JSON, carries the id of the player issuing it, and is validated by the
 * engine rather than by the interface. Adding a variant here and nowhere else
 * makes the reducer, the transport and the shell all fail to compile until they
 * handle it, which is the point.
 */

import type { Hex } from './hex.js';
import type { AttackerRef, TargetRef, PlayerId, UnitId } from './types.js';

export interface CommandBase {
  /** Who is acting. The seat check on a server compares this to the connection. */
  readonly by: PlayerId;
}

/**
 * Move one unit along a path of hexes it enters, in order.
 *
 * A path rather than a single step, because the road bonus is a property of the
 * whole phase — "Any unit which starts its move on the road, stays on the road
 * for the entire movement phase ... gets a movement bonus of one additional
 * hex" (5.07.1) — and because a stream may only be crossed by a unit that began
 * the phase beside it (5.08.4). Neither can be judged one hex at a time.
 *
 * The path may not enter an enemy-occupied hex: that is a ram, and the player
 * has to say so. The one exception the rules make is an Ogre or Superheavy
 * walking through infantry (6.06), which `moveUnit` performs.
 */
export interface MoveUnitCommand extends CommandBase {
  readonly type: 'moveUnit';
  readonly unit: UnitId;
  readonly path: readonly Hex[];
}

/**
 * Ram the unit in an adjacent hex — or, when `target` is the rammer's own hex,
 * "expend one more movement point, stay in that hex, and ram again" (6.02).
 */
export interface RamCommand extends CommandBase {
  readonly type: 'ram';
  readonly unit: UnitId;
  readonly target: Hex;
}

/**
 * Spend a movement point to reduce the infantry sharing this hex by a squad.
 *
 * "An Ogre does not literally 'ram' infantry, but any Ogre with AP weapons (or
 * a Superheavy Tank) may move into an infantry hex as though the infantry were
 * not there ... may expend a movement point, stay in the same hex, and reduce
 * the infantry again." (6.06)
 */
export interface ReduceInfantryCommand extends CommandBase {
  readonly type: 'reduceInfantry';
  readonly unit: UnitId;
  readonly target: UnitId;
}

/** "To mount a vehicle, an infantry squad must spend its entire movement" (5.11.3). */
export interface MountCommand extends CommandBase {
  readonly type: 'mount';
  readonly unit: UnitId;
  readonly carrier: UnitId;
}

export interface DismountCommand extends CommandBase {
  readonly type: 'dismount';
  readonly unit: UnitId;
}

/**
 * "a larger infantry counter may be built up from smaller counters, or broken
 * down into squads, at any time during the owning player's movement phase"
 * (5.02.3).
 */
export interface SplitInfantryCommand extends CommandBase {
  readonly type: 'splitInfantry';
  readonly unit: UnitId;
  /** Squads to peel off into a new counter in the same hex. */
  readonly squads: number;
}

export interface CombineInfantryCommand extends CommandBase {
  readonly type: 'combineInfantry';
  readonly units: readonly UnitId[];
}

/**
 * Declare and resolve one attack.
 *
 * "a player must always announce what he is attacking, what he is attacking
 * with, and the odds, before rolling the die" (7.08) — so the whole
 * announcement is one command and the die is rolled inside the engine.
 */
export interface AttackCommand extends CommandBase {
  readonly type: 'attack';
  readonly attackers: readonly AttackerRef[];
  readonly target: TargetRef;
}

/**
 * Move into an enemy-occupied hex and fight for it (8.01).
 *
 * The counterpart to `ram`, and mutually exclusive with it: "Players should
 * decide in advance whether they will use the (fast, simple) Ramming rules ...
 * or the (more realistic and complex) Overrun Combat rules ... Do not use
 * both!" (6.00)
 */
export interface OverrunCommand extends CommandBase {
  readonly type: 'overrun';
  readonly unit: UnitId;
  readonly target: Hex;
}

/** Fire one attack inside an overrun. Same shape as `attack`, different rules. */
export interface OverrunAttackCommand extends CommandBase {
  readonly type: 'overrunAttack';
  readonly attackers: readonly AttackerRef[];
  readonly target: TargetRef;
}

/**
 * Ram at the end of this unit's first fire round (8.05.2, 8.05.3) — the only
 * ramming that happens inside an overrun.
 */
export interface OverrunRamCommand extends CommandBase {
  readonly type: 'overrunRam';
  readonly unit: UnitId;
  readonly target: UnitId;
}

/** Finish the firing side's round, or close the dismount window. */
export interface EndFireRoundCommand extends CommandBase {
  readonly type: 'endFireRound';
}

export interface EndPhaseCommand extends CommandBase {
  readonly type: 'endPhase';
}

export interface ResignCommand extends CommandBase {
  readonly type: 'resign';
}

/**
 * Orbital Drop §3.03: bring one reaction-force unit onto the map.
 *
 * The unit already exists in the state with `offMap: 'reserve'`; from the
 * scenario's reaction turn on, its owner may place it on any legal hex of
 * their own map edge during their movement phase. It arrives with its move
 * spent — racing back to the alarm is the whole of that turn's work.
 */
export interface DeployReserveCommand extends CommandBase {
  readonly type: 'deployReserve';
  readonly unit: UnitId;
  readonly at: Hex;
}

/**
 * Orbital Drop §6.01: one fire-support strike from a warship in orbit.
 *
 * Attack strength is the ship's Triplanetary combat strength, resolved as an
 * ordinary CRT attack against any target, at any range. The scenario holds
 * the strikes still owed in `scenarioData.orbitalStrikes`; each command
 * consumes one.
 */
export interface OrbitalStrikeCommand extends CommandBase {
  readonly type: 'orbitalStrike';
  /** Index into the scenario's remaining strike list. */
  readonly strike: number;
  readonly target: TargetRef;
}

export type Command =
  | MoveUnitCommand
  | RamCommand
  | OverrunCommand
  | OverrunAttackCommand
  | OverrunRamCommand
  | EndFireRoundCommand
  | ReduceInfantryCommand
  | MountCommand
  | DismountCommand
  | SplitInfantryCommand
  | CombineInfantryCommand
  | AttackCommand
  | EndPhaseCommand
  | ResignCommand
  | DeployReserveCommand
  | OrbitalStrikeCommand;

export type CommandType = Command['type'];

/**
 * The result of dispatching a command.
 *
 * A rejection is not an exception: illegal moves are ordinary, the interface
 * asks the engine constantly what is legal, and the reason is shown to the
 * player verbatim.
 */
export type CommandResult =
  | { readonly ok: true; readonly message?: string }
  | { readonly ok: false; readonly reason: string };

export const ok = (message?: string): CommandResult =>
  message ? { ok: true, message } : { ok: true };
export const fail = (reason: string): CommandResult => ({ ok: false, reason });

/** Structural check for anything arriving off the wire or out of a save file. */
export const isCommand = (value: unknown): value is Command => {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as { type?: unknown; by?: unknown };
  return typeof c.type === 'string' && typeof c.by === 'string';
};
