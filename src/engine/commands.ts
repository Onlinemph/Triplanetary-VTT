/**
 * The command protocol.
 *
 * Every change to the game state is expressed as one of these values. They are
 * plain JSON, they carry the acting player, and they are validated server-side
 * in exactly the same code path as client-side. A game is fully described by
 * its scenario id plus an ordered command log, which is what makes replay,
 * spectating, undo and networked play all the same mechanism.
 */

import type { Hex, HexSide } from './hex.js';
import type { CargoKind, ShipClass } from './ships.js';
import type { OrdnanceKind, PlayerId, ShipId } from './types.js';

export interface CommandBase {
  readonly by: PlayerId;
}

// --- Astrogation -----------------------------------------------------------

/**
 * Commit this turn's course for a ship.
 *
 * `endpoint` must be reachable: the predicted endpoint (position + velocity +
 * accumulated gravity) shifted by at most one hex, or two with an overload
 * manoeuvre. Fuel is charged here.
 */
export interface PlotCourse extends CommandBase {
  readonly type: 'plotCourse';
  readonly ship: ShipId;
  readonly endpoint: Hex;
  readonly overload?: boolean;
}

/** Accept or decline an optional weak-gravity effect (Luna, Io). */
export interface SetOptionalGravity extends CommandBase {
  readonly type: 'setOptionalGravity';
  readonly ship: ShipId;
  readonly hex: Hex;
  readonly accept: boolean;
}

/** Spend one fuel point while in orbit to land on a world's hexside. */
export interface Land extends CommandBase {
  readonly type: 'land';
  readonly ship: ShipId;
  readonly side: HexSide;
}

/** Blast off using boosters — free, but only from a friendly base. */
export interface TakeOff extends CommandBase {
  readonly type: 'takeOff';
  readonly ship: ShipId;
}

/** Declare an attempt to ram an enemy ship sharing a hex on this course. */
export interface DeclareRam extends CommandBase {
  readonly type: 'declareRam';
  readonly ship: ShipId;
  readonly target: ShipId;
}

/** Prospecting: stand still in an asteroid hex to mine, or drop equipment. */
export interface MineOre extends CommandBase {
  readonly type: 'mineOre';
  readonly ship: ShipId;
}

export interface EmplaceEquipment extends CommandBase {
  readonly type: 'emplaceEquipment';
  readonly ship: ShipId;
  readonly kind: Extract<CargoKind, 'automatedMine' | 'robotGuards' | 'orbitalBase'>;
  readonly side?: HexSide;
}

// --- Ordnance --------------------------------------------------------------

export interface LaunchOrdnance extends CommandBase {
  readonly type: 'launchOrdnance';
  readonly ship: ShipId;
  readonly kind: OrdnanceKind;
  /** Torpedoes only, and only on the launch turn: 1-2 hexes of acceleration. */
  readonly aim?: Hex;
}

/**
 * A base firing its own torpedo. Asteroid bases "are capable of launching one
 * torpedo per turn"; an orbital base "may fire one torpedo per turn, providing
 * resupply operations are not in progress". Neither has a hold to draw from —
 * "All bases (planetary, asteroid, and orbital) carry an unlimited supply of
 * fuel, mines, and torpedoes" — so the launcher is the base itself, not a ship.
 */
export interface LaunchBaseTorpedo extends CommandBase {
  readonly type: 'launchBaseTorpedo';
  readonly base: string;
  /** The torpedo's resulting vector: 1-2 hexes from a standing start. */
  readonly aim: Hex;
}

// --- Combat ----------------------------------------------------------------

/**
 * A gunnery attack. Multiple attacking ships may pool their strength, and any
 * combination of ships in a hex may be attacked together.
 */
export interface Attack extends CommandBase {
  readonly type: 'attack';
  readonly attackers: readonly ShipId[];
  readonly targets: readonly ShipId[];
  /** Attack with less than full strength to disable without destroying. */
  readonly strength?: number;
}

/** Return fire, resolved before the triggering attack's damage is applied. */
export interface Counterattack extends CommandBase {
  readonly type: 'counterattack';
  readonly attackers: readonly ShipId[];
  readonly targets: readonly ShipId[];
  readonly strength?: number;
}

/** Decline to return fire. */
export interface DeclineCounterattack extends CommandBase {
  readonly type: 'declineCounterattack';
}

/** Planetary defences fire at 2:1 into the gravity hex above their hexside. */
export interface FirePlanetaryDefence extends CommandBase {
  readonly type: 'firePlanetaryDefence';
  readonly base: string;
  readonly targets: readonly ShipId[];
}

/** Gunfire from orbit that permanently suppresses a world hexside. */
export interface SuppressHexside extends CommandBase {
  readonly type: 'suppressHexside';
  readonly ship: ShipId;
  readonly side: HexSide;
}

export interface DemandSurrender extends CommandBase {
  readonly type: 'demandSurrender';
  readonly ship: ShipId;
  readonly target: ShipId;
}

export interface RespondToSurrender extends CommandBase {
  readonly type: 'respondToSurrender';
  readonly ship: ShipId;
  readonly to: ShipId;
  readonly accept: boolean;
}

// --- Resupply --------------------------------------------------------------

export interface Resupply extends CommandBase {
  readonly type: 'resupply';
  readonly ship: ShipId;
  /** Ordnance loadout to take on; must fit the hold. */
  readonly loadout?: readonly { readonly kind: CargoKind; readonly quantity: number }[];
}

/** Move cargo or fuel between two course-matched ships. */
export interface TransferCargo extends CommandBase {
  readonly type: 'transferCargo';
  readonly from: ShipId;
  readonly to: ShipId;
  readonly kind: CargoKind | 'fuel';
  readonly quantity: number;
}

/** Take goods from a disabled or surrendered enemy. */
export interface Loot extends CommandBase {
  readonly type: 'loot';
  readonly ship: ShipId;
  readonly target: ShipId;
  readonly items: readonly { readonly kind: CargoKind | 'fuel'; readonly quantity: number }[];
}

/** Seize a disabled enemy ship. */
export interface Capture extends CommandBase {
  readonly type: 'capture';
  readonly ship: ShipId;
  readonly target: ShipId;
}

export interface PurchaseShip extends CommandBase {
  readonly type: 'purchaseShip';
  readonly shipClass: ShipClass;
  readonly at: Hex;
  readonly side?: HexSide;
}

// --- Flow ------------------------------------------------------------------

/** Advance to the next phase, or to the next player-turn after resupply. */
export interface EndPhase extends CommandBase {
  readonly type: 'endPhase';
}

export interface ConcedeGame extends CommandBase {
  readonly type: 'concede';
}

export type Command =
  | PlotCourse
  | SetOptionalGravity
  | Land
  | TakeOff
  | DeclareRam
  | MineOre
  | EmplaceEquipment
  | LaunchOrdnance
  | LaunchBaseTorpedo
  | Attack
  | Counterattack
  | DeclineCounterattack
  | FirePlanetaryDefence
  | SuppressHexside
  | DemandSurrender
  | RespondToSurrender
  | Resupply
  | TransferCargo
  | Loot
  | Capture
  | PurchaseShip
  | EndPhase
  | ConcedeGame;

export type CommandType = Command['type'];

/** Result of applying a command. Rejections never mutate state. */
export interface CommandResult {
  readonly ok: boolean;
  readonly reason?: string;
}
