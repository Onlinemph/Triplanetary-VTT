/**
 * The complete game state contract.
 *
 * `GameState` is a plain, serialisable, immutable-by-convention value. Nothing
 * in here touches the DOM, `Date`, or `Math.random`: the whole engine is a pure
 * function of (state, command) so that the same command log replays identically
 * on every client and on a server. That is the property multiplayer needs.
 */

import type { Hex } from './hex.js';
import type { RngState } from './rng.js';
import type { UnitClassId } from './units.js';
import type { OgreTypeId, OgreWeaponKind } from './ogres.js';
import type { DamageResult, OddsColumn } from './crt.js';
import type { Terrain } from './terrain.js';

export type PlayerId = string;
export type UnitId = string;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * The phases of one player-turn (4.02).
 *
 * The rulebook lists five steps; four of them are phases a player acts in, and
 * the fifth — "3. Disable check" — is bookkeeping with no decisions in it, so
 * it runs automatically when movement ends. See `movement.ts`.
 */
export type Phase = 'recovery' | 'movement' | 'fire' | 'gevMovement';

export const PHASES: readonly Phase[] = ['recovery', 'movement', 'fire', 'gevMovement'];

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  recovery: 'Recovery',
  movement: 'Movement',
  fire: 'Fire',
  gevMovement: 'GEV second movement',
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Why a unit is face-down.
 *
 * The rules keep these apart and so must we: "It is necessary to keep track of
 * when and how a unit becomes disabled" (4.02). Combat disablement recovers
 * automatically on a schedule; terrain disablement needs a die roll every turn;
 * and a heavy tracked unit stuck in swamp "may not move for the rest of the
 * game" (5.08.3).
 */
export type Disablement = 'none' | 'combat' | 'terrain';

/** A hazard rolled for at the end of the movement phase, not on entry (4.02.3). */
export type PendingHazard = null | 'disable' | 'stuck';

export interface ConventionalUnit {
  readonly kind: 'unit';
  readonly id: UnitId;
  readonly owner: PlayerId;
  readonly classId: UnitClassId;
  readonly pos: Hex;

  /**
   * Infantry squads in this counter, 1-3 (3.02). Always 1 for everything else,
   * so that attack and defence arithmetic can multiply unconditionally.
   */
  readonly squads: number;

  readonly disabled: Disablement;
  /**
   * The player-turn ordinal at which combat disablement happened, so recovery
   * can ask "was this before the last enemy turn?" (4.02.1).
   */
  readonly disabledAt: number;
  /** "Place a 'Stuck' marker on it ... may not move for the rest of the game." */
  readonly stuck: boolean;
  readonly pendingHazard: PendingHazard;

  /** Movement points spent this phase. */
  readonly moveUsed: number;
  /** True once the unit has moved in the second (GEV) movement phase. */
  readonly secondMoveUsed: number;
  /** The unit began this movement phase here; streams need that (5.08.4). */
  readonly phaseStart: Hex;
  /** Stayed on the road for the whole phase, and so earns the bonus (5.07.1). */
  readonly onRouteAllPhase: boolean;
  /** Entered forest/swamp/rubble/town and so gets no second movement phase (5.08.2). */
  readonly movementEnded: boolean;

  readonly firedThisPhase: boolean;
  /**
   * Squads of this counter that have already shot.
   *
   * Infantry are the one exception to "An attack strength may never be divided
   * between targets": "A 2-squad or 3-squad infantry counter may divide its
   * attack strength between targets, because each squad can fire separately"
   * (7.07.1). So the counter is not simply spent or unspent.
   */
  readonly squadsFired: number;
  /** The Heavy Weapons Team's one-shot missile is spent (3.02.2). */
  readonly heavyWeaponFired: boolean;

  /** The vehicle this infantry counter is riding (5.11). */
  readonly ridingOn?: UnitId;
  /** Mounting costs the whole movement phase, and bars dismounting (5.11.3). */
  readonly mountedThisTurn: boolean;

  readonly destroyed: boolean;
  readonly destroyedBy?: string;
  /**
   * The edge this unit left by, if it did. "It takes 1 movement to leave the
   * map ... No unit may re-enter the map once it has left." (5.12) A unit that
   * escapes is not destroyed — several scenarios turn on the difference — so it
   * is off the board and out of play, but still its owner's.
   */
  readonly offMap?: 'north' | 'south' | 'east' | 'west';
}

/** One targetable component on an Ogre's record sheet. */
export interface OgreWeapon {
  readonly id: string;
  readonly kind: OgreWeaponKind;
  readonly destroyed: boolean;
  /**
   * For an external missile: expended. For a missile rack: used this turn.
   * For a battery: fired this fire phase.
   */
  readonly fired: boolean;
}

export interface OgreUnit {
  readonly kind: 'ogre';
  readonly id: UnitId;
  readonly owner: PlayerId;
  readonly typeId: OgreTypeId;
  readonly pos: Hex;

  readonly weapons: readonly OgreWeapon[];
  readonly treads: number;
  /** Fired through a missile rack; cannot be targeted while inside (3.04.2). */
  readonly internalMissiles: number;

  readonly moveUsed: number;
  readonly phaseStart: Hex;
  readonly onRouteAllPhase: boolean;
  readonly movementEnded: boolean;
  /** "An Ogre may either ram up to two non-Ogre units per turn, or one enemy Ogre" (6.01.1). */
  readonly ramsThisTurn: number;
  readonly rammedOgreThisTurn: boolean;
  readonly stuck: boolean;
  readonly pendingHazard: PendingHazard;

  readonly destroyed: boolean;
  readonly destroyedBy?: string;
  /**
   * The edge this unit left by, if it did. "It takes 1 movement to leave the
   * map ... No unit may re-enter the map once it has left." (5.12) A unit that
   * escapes is not destroyed — several scenarios turn on the difference — so it
   * is off the board and out of play, but still its owner's.
   */
  readonly offMap?: 'north' | 'south' | 'east' | 'west';
}

export type Unit = ConventionalUnit | OgreUnit;

export const isOgre = (u: Unit): u is OgreUnit => u.kind === 'ogre';

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingKind = 'admin' | 'strongpoint' | 'reactor' | 'radar' | 'laser' | 'laserTower';

export interface Building {
  readonly id: string;
  readonly kind: BuildingKind;
  readonly owner: PlayerId | null;
  readonly pos: Hex;
  /** "When a building's SPs are reduced to 0, it is destroyed" (11.03). */
  readonly structurePoints: number;
  readonly maxStructurePoints: number;
  readonly destroyed: boolean;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  /** Accent colour used by the renderer for counters. */
  readonly color: string;
  /** "Red counters on black ... Blue counters on white" (3.00). */
  readonly faction: string;
  readonly victoryPoints: number;
  readonly eliminated: boolean;
}

// ---------------------------------------------------------------------------
// Combat records
// ---------------------------------------------------------------------------

/** What an attack was aimed at. Ogres need a component, not just a counter. */
export type TargetRef =
  | { readonly kind: 'unit'; readonly unit: UnitId }
  | { readonly kind: 'ogreWeapon'; readonly unit: UnitId; readonly weapon: string }
  | { readonly kind: 'ogreTreads'; readonly unit: UnitId }
  | { readonly kind: 'building'; readonly building: string }
  | { readonly kind: 'terrain'; readonly hex: Hex };

/** One attacking gun: a whole conventional unit, or one weapon on an Ogre. */
export interface AttackerRef {
  readonly unit: UnitId;
  /** Present when the attacker is an Ogre: which component fires. */
  readonly weapon?: string;
  /** Squads committed, when a multi-squad infantry counter splits its fire (7.07.1). */
  readonly squads?: number;
  /** A Superheavy firing one of its two guns, or a Heavy Weapons Team's missile. */
  readonly halfAttack?: boolean;
  readonly heavyWeapon?: boolean;
  /**
   * Fire this unit's antipersonnel guns rather than its main armament. Only the
   * Superheavy has any: they "function exactly like Ogre AP weapons" (3.01),
   * which means infantry and D0 targets only, and doubled in an overrun.
   */
  readonly antipersonnel?: boolean;
}

export interface AttackResolution {
  readonly attackers: readonly AttackerRef[];
  readonly target: TargetRef;
  readonly attackStrength: number;
  readonly defenseStrength: number;
  readonly column: OddsColumn | null;
  /** True when the odds were 5-1 or better and no die was rolled (7.10). */
  readonly automatic: boolean;
  readonly roll: number;
  readonly result: DamageResult;
  /** Tread units destroyed, when the target was an Ogre's treads (7.13.2). */
  readonly treadsLost?: number;
  /** Spillover attacks this one generated on the rest of the hex (7.12). */
  readonly spillover?: readonly AttackResolution[];
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export type LogSeverity = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  readonly id: number;
  readonly turn: number;
  readonly player: PlayerId | null;
  readonly phase: Phase;
  readonly severity: LogSeverity;
  readonly text: string;
  /** Hexes worth flashing on the map when the entry is hovered. */
  readonly focus?: readonly Hex[];
}

// ---------------------------------------------------------------------------
// Overrun combat (Section 8)
// ---------------------------------------------------------------------------

export type OverrunSide = 'attacker' | 'defender';

export interface OverrunParticipant {
  readonly unit: UnitId;
  readonly side: OverrunSide;
  /** A conventional unit fires once per fire round (8.04). */
  readonly fired: boolean;
  /** Ogre weapons that have fired this round; an Ogre fires each of them once. */
  readonly weaponsFired: readonly string[];
  /**
   * Whether this unit has taken its one ram. "A mobile Ogre may ram any one
   * enemy unit (except infantry) at the end of its first fire round" (8.05.2).
   */
  readonly rammed: boolean;
  /**
   * Enemy fire rounds weathered since this Ogre ran out of usable weapons.
   *
   * "If, during overrun combat, an Ogre loses all its weapons that have valid
   * targets in that combat, it is removed from the combat after two further
   * enemy fire rounds and replaced in the hex." (8.05.1) `null` while it still
   * has something to shoot with.
   */
  readonly disarmedFor: number | null;
}

/**
 * An overrun in progress.
 *
 * Overrun combat "takes place during the movement phase" (8.00) and interrupts
 * it: while this is set, the movement phase is suspended, and the *defender*
 * acts first even though it is not their turn. It is the one place in Ogre
 * where the non-phasing player has a decision to make.
 */
export interface OverrunState {
  readonly hex: Hex;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  /**
   * `dismount` is the window in which riders may get off (8.06.1); `fire` is
   * the exchange of fire rounds.
   */
  readonly step: 'dismount' | 'fire';
  /** "The defender has the first fire round." (8.04) */
  readonly firing: OverrunSide;
  readonly round: number;
  readonly participants: readonly OverrunParticipant[];
  /** The unit whose movement was interrupted; its move resumes afterwards (8.08). */
  readonly mover: UnitId;
}

// ---------------------------------------------------------------------------
// Options and victory
// ---------------------------------------------------------------------------

export interface GameOptions {
  /**
   * "Players should decide in advance whether they will use the (fast, simple)
   * Ramming rules here ... or the (more realistic and complex) Overrun Combat
   * rules described in Section 8. Do not use both!" (6.00)
   */
  readonly overrunCombat: boolean;
  /**
   * Vehicles per hex. "In scenarios on the original Ogre map, units may not be
   * stacked" (5.02.1) — that is 1. The G.E.V. maps allow 5 (5.02.2).
   */
  readonly stackingLimit: number;
  /** 13.01: hexes have a defence of 4 and can be shot to rubble. */
  readonly terrainDamage: boolean;
  /** 13.07: a Superheavy takes partial damage on its own record sheet. */
  readonly superheavyRecordSheet: boolean;
  /** Warn before a move that would strand or expose a unit. Interface only. */
  readonly confirmRiskyMoves: boolean;
}

export const DEFAULT_OPTIONS: GameOptions = {
  overrunCombat: false,
  stackingLimit: 1,
  terrainDamage: false,
  superheavyRecordSheet: false,
  confirmRiskyMoves: true,
};

export type VictoryLevel = 'complete' | 'standard' | 'marginal';

export interface VictoryState {
  readonly winners: readonly PlayerId[];
  readonly level: VictoryLevel;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface GameState {
  readonly scenarioId: string;
  readonly mapId: string;
  readonly turn: number;
  readonly playerOrder: readonly PlayerId[];
  readonly activePlayerIndex: number;
  readonly phase: Phase;

  readonly players: Readonly<Record<PlayerId, Player>>;
  readonly units: Readonly<Record<UnitId, Unit>>;
  readonly buildings: Readonly<Record<string, Building>>;

  /**
   * Terrain the game has changed under the map: damaged towns, rubble, and the
   * craters a Cruise Missile leaves (2.00.3, 13.01). Keyed by hex.
   */
  readonly terrainOverrides: Readonly<Record<string, Terrain>>;
  /** Hexes whose road and rail have been cut (13.01.3). */
  readonly routesCut: readonly string[];

  readonly options: GameOptions;
  readonly rng: RngState;
  readonly log: readonly LogEntry[];
  readonly nextLogId: number;
  readonly nextUnitSerial: number;

  /** Set while an overrun is being fought; the movement phase is suspended. */
  readonly overrun: OverrunState | null;

  readonly victory: VictoryState | null;
  /** Free-form per-scenario bookkeeping (entry edges, objectives, timers). */
  readonly scenarioData: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

export const activePlayer = (state: GameState): PlayerId =>
  state.playerOrder[state.activePlayerIndex]!;

/**
 * A monotonically increasing index over player-turns.
 *
 * Recovery timing is written in the rules as "before the last enemy turn"
 * (4.02.1), which is a statement about ordering rather than about the turn
 * number, so disablement records this rather than `turn`.
 */
export const playerTurnOrdinal = (state: GameState): number =>
  state.turn * state.playerOrder.length + state.activePlayerIndex;

/** Still in play: on the board, undestroyed. */
export const onBoard = (u: Unit): boolean => !u.destroyed && !u.offMap;

/** Not destroyed — includes units that escaped off an edge. */
export const surviving = (u: Unit): boolean => !u.destroyed;

export const liveUnits = (state: GameState): Unit[] => Object.values(state.units).filter(onBoard);

export const unitsOf = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter((u) => u.owner === player && onBoard(u));

export const unitsAt = (state: GameState, hex: Hex): Unit[] =>
  Object.values(state.units).filter(
    (u) => onBoard(u) && u.pos.q === hex.q && u.pos.r === hex.r && !ridingSomething(u),
  );

/** Infantry riding a vehicle are in the vehicle's hex but are not *in* the hex. */
export const ridingSomething = (u: Unit): boolean => u.kind === 'unit' && u.ridingOn != null;

export const passengersOf = (state: GameState, carrier: UnitId): ConventionalUnit[] =>
  Object.values(state.units).filter(
    (u): u is ConventionalUnit => u.kind === 'unit' && onBoard(u) && u.ridingOn === carrier,
  );

/** Two players are hostile unless they are the same player. */
export const areEnemies = (a: PlayerId, b: PlayerId): boolean => a !== b;

/** A disabled or stuck unit "cannot fire or move" (7.11) — but still defends. */
export const canAct = (u: Unit): boolean =>
  u.kind === 'ogre' ? onBoard(u) : onBoard(u) && u.disabled === 'none';
