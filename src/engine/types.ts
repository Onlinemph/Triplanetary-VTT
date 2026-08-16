/**
 * The complete game state contract.
 *
 * `GameState` is a plain, serialisable, immutable-by-convention value. Nothing
 * in here touches the DOM, `Date`, or `Math.random`: the whole engine is a pure
 * function of (state, command) so that the same command log replays identically
 * on every client and on a server. That is the property multiplayer needs.
 */

import type { Hex, HexSide } from './hex.js';
import type { RngState } from './rng.js';
import type { CargoKind, ShipClass } from './ships.js';
import type { DamageResult, OddsColumn, OtherAttackKind } from './crt.js';

export type PlayerId = string;
export type ShipId = string;
export type OrdnanceId = string;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * The five phases of a player-turn (rulebook p. 2). A turn represents one day
 * and contains one player-turn for each player.
 */
export type Phase = 'astrogation' | 'ordnance' | 'movement' | 'combat' | 'resupply';

export const PHASES: readonly Phase[] = [
  'astrogation',
  'ordnance',
  'movement',
  'combat',
  'resupply',
];

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  astrogation: 'Astrogation',
  ordnance: 'Ordnance',
  movement: 'Movement',
  combat: 'Combat',
  resupply: 'Resupply',
};

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------

/**
 * Where a ship physically is.
 *
 * `space` covers everything from drifting to orbiting — orbit is not a distinct
 * mode in Triplanetary, it is simply the emergent result of moving one hex per
 * turn between adjacent gravity hexes, so it is *derived*, never stored.
 */
export type ShipLocation =
  | { readonly kind: 'space' }
  /** Landed on a world, at a specific hexside. Must take off from the same side. */
  | { readonly kind: 'landed'; readonly side: HexSide }
  /** Stopped in an asteroid hex (Ceres, Clandestine, or any belt hex). */
  | { readonly kind: 'asteroidBase'; readonly hex: Hex };

/** Per-subsystem damage, used only when the advanced combat system is enabled. */
export interface AdvancedDamage {
  readonly weapon: number;
  readonly drive: number;
  readonly structure: number;
}

export interface CargoItem {
  readonly kind: CargoKind;
  /** Number of units; mass is `quantity * CARGO[kind].mass`. */
  readonly quantity: number;
}

/** One leg of a ship's plotted course, retained so the map can draw its trail. */
export interface CourseLeg {
  readonly turn: number;
  readonly from: Hex;
  readonly to: Hex;
  /** Fuel points burned on this leg: 0, 1, or 2 (overload). */
  readonly accel: 0 | 1 | 2;
  /** True when the leg ended in a crash, so the renderer can mark it. */
  readonly terminal?: boolean;
}

export interface Ship {
  readonly id: ShipId;
  readonly owner: PlayerId;
  readonly shipClass: ShipClass;
  /** Counter number, purely cosmetic but used by some scenarios (e.g. "101"). */
  readonly number: number;
  readonly name?: string;

  readonly pos: Hex;
  /** Intrinsic velocity: the vector flown last turn. Zero for a stationary ship. */
  readonly velocity: Hex;
  /**
   * Sum of gravity arrows from hexes entered *last* turn. "Gravity takes effect
   * on the turn after an object enters the gravity hex."
   */
  readonly pendingGravity: Hex;
  /**
   * Weak-gravity hexes (Luna, Io) entered last turn whose effect the player may
   * decline. The first of a consecutive run is optional; later ones are not,
   * and those are folded straight into `pendingGravity`.
   */
  readonly optionalGravity: readonly Hex[];

  readonly location: ShipLocation;
  readonly fuel: number;
  readonly cargo: readonly CargoItem[];

  /** Turns of disablement remaining. At >= 6 the ship is destroyed. */
  readonly disabled: number;
  readonly advancedDamage: AdvancedDamage;

  /**
   * Advanced system: which damage track the owner wants worked on first.
   *
   * "A ship recovers from 1 D a turn ... The owner chooses what kind of damage
   * to recover from." A standing order rather than a prompt: the whole fleet
   * repairs at once at the end of the resupply phase, and the choice only ever
   * matters for a hull damaged on more than one track. Unset falls back to the
   * drive, which is the track that decides whether the ship can run away.
   */
  readonly repairPreference?: 'weapon' | 'drive' | 'structure';

  /** "Warships may perform one overload maneuver between maintenance stopovers." */
  readonly overloadAvailable: boolean;
  /** "A ship may not become heroic more than once." */
  readonly heroic: boolean;

  /** Players who have detected this ship. Detection, once made, persists. */
  readonly detectedBy: readonly PlayerId[];

  /** Set when captured; the ship must reach a base friendly to the captor. */
  readonly capturedBy?: PlayerId;
  /**
   * The individual ships this one has surrendered to. "Surrender is a binding
   * bargain. Both parties agree not to attack the other specific ship" — so the
   * pact is recorded per ship, not per fleet.
   */
  readonly surrenderedTo: readonly ShipId[];

  /** Plotted endpoint for this turn, set during the astrogation phase. */
  readonly plottedEndpoint?: Hex;
  /** Fuel committed to this turn's plot. */
  readonly plottedAccel: 0 | 1 | 2;
  /** Which optional weak-gravity hexes the player chose to accept this turn. */
  readonly acceptedOptionalGravity: readonly string[];

  readonly course: readonly CourseLeg[];
  readonly destroyed: boolean;
  /** How the ship was lost, for the log and after-action report. */
  readonly destroyedBy?: string;

  /** Flags set during a player-turn and cleared at its end. */
  readonly firedThisPhase: boolean;
  readonly attackedThisPhase: boolean;
  readonly resuppliedThisTurn: boolean;
  readonly launchedOrdnanceThisTurn: boolean;
}

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

export type OrdnanceKind = 'mine' | 'torpedo' | 'nuke';

export interface Ordnance {
  readonly id: OrdnanceId;
  readonly owner: PlayerId;
  readonly kind: OrdnanceKind;
  readonly pos: Hex;
  readonly velocity: Hex;
  readonly pendingGravity: Hex;
  /**
   * Turns of life remaining. All three kinds "remain active for five turns,
   * after which they self-destruct."
   */
  readonly turnsRemaining: number;
  readonly launchedTurn: number;
  readonly course: readonly CourseLeg[];
  /** A torpedo may accelerate 1-2 hexes on its launch turn, and only then. */
  readonly canAccelerate: boolean;
}

// ---------------------------------------------------------------------------
// Bases and worlds
// ---------------------------------------------------------------------------

export type BaseKind = 'planetary' | 'asteroid' | 'orbital';

export interface BaseState {
  readonly id: string;
  readonly kind: BaseKind;
  readonly owner: PlayerId | null;
  /** Planetary bases sit on a hexside; asteroid and orbital bases sit in a hex. */
  readonly side?: HexSide;
  readonly hex: Hex;
  readonly destroyed: boolean;
  /** Suppressed by gunfire from orbit (Fleet Mutiny). Suppression is permanent. */
  readonly suppressed: boolean;
  /** Planetary defences fire at 2:1 into the gravity hex above the base. */
  readonly hasPlanetaryDefences: boolean;
  readonly firedThisTurn: boolean;
  /**
   * Asteroid and orbital bases "are capable of launching one torpedo per turn";
   * tracked apart from `firedThisTurn` because the ordnance phase comes before
   * the combat phase, where planetary-defence fire is booked.
   */
  readonly launchedThisTurn: boolean;
  readonly resuppliedThisTurn: boolean;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  /** Accent colour used by the renderer for counters and course arrows. */
  readonly color: string;
  /** Faction label from the scenario, e.g. "Pilgrims", "Enforcers", "Pirates". */
  readonly faction: string;
  readonly megacredits: number;
  readonly points: number;
  /** Players this one treats as allies (Nova lets blocs share bases). */
  readonly allies: readonly PlayerId[];
  readonly eliminated: boolean;
}

// ---------------------------------------------------------------------------
// Combat records
// ---------------------------------------------------------------------------

export interface AttackModifiers {
  readonly range: number;
  readonly relativeVelocity: number;
  readonly heroic: boolean;
  /** Total applied to the die roll. */
  readonly total: number;
}

export interface AttackResolution {
  readonly attackers: readonly ShipId[];
  readonly targets: readonly ShipId[];
  readonly attackStrength: number;
  readonly defenceStrength: number;
  readonly column: OddsColumn | null;
  readonly roll: number;
  readonly modifiers: AttackModifiers;
  readonly modifiedRoll: number;
  readonly result: DamageResult;
  /** Populated instead of `result` when the advanced system is enabled. */
  readonly hits?: readonly {
    readonly target: ShipId;
    readonly weapon: number;
    readonly drive: number;
    readonly structure: number;
  }[];
  readonly kind: 'gun' | 'planetaryDefence' | OtherAttackKind;
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
// Options and victory
// ---------------------------------------------------------------------------

export interface GameOptions {
  /** Rulebook p. 16: per-subsystem damage instead of a single disablement track. */
  readonly advancedCombat: boolean;
  /** Rulebook p. 15 variant: every planetary base has an orbital base overhead. */
  readonly orbitalBasesVariant: boolean;
  /** Hide undetected enemy ships from the current player's view. */
  readonly fogOfWar: boolean;
  /** Nukes are only available when the scenario says so. */
  readonly nukesAllowed: boolean;
  /** Warn before committing a plot that crashes, or that leaves the map. */
  readonly confirmFatalPlots: boolean;
}

export const DEFAULT_OPTIONS: GameOptions = {
  advancedCombat: false,
  orbitalBasesVariant: false,
  fogOfWar: false,
  nukesAllowed: false,
  confirmFatalPlots: true,
};

export type VictoryLevel = 'decisive' | 'marginal' | 'moral';

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
  /** Game turns are days, numbered from 1. */
  readonly turn: number;
  readonly playerOrder: readonly PlayerId[];
  readonly activePlayerIndex: number;
  readonly phase: Phase;

  readonly players: Readonly<Record<PlayerId, Player>>;
  readonly ships: Readonly<Record<ShipId, Ship>>;
  readonly ordnance: Readonly<Record<OrdnanceId, Ordnance>>;
  readonly bases: Readonly<Record<string, BaseState>>;

  /** Asteroid hexes cleared by nuke detonations become clear space. */
  readonly clearedAsteroids: readonly string[];
  /** Prospecting: hexes surveyed for ore, and what was found. */
  readonly prospected: Readonly<Record<string, 'ore' | 'barren'>>;
  /** Devastated world hexsides (nuke strikes). */
  readonly devastatedSides: readonly string[];

  readonly options: GameOptions;
  readonly rng: RngState;
  readonly log: readonly LogEntry[];
  readonly nextLogId: number;
  readonly nextShipNumber: number;
  readonly nextOrdnanceId: number;

  readonly victory: VictoryState | null;
  /** Free-form per-scenario bookkeeping (delivery cycles, patrol circuits, ...). */
  readonly scenarioData: Readonly<Record<string, unknown>>;
}

export const activePlayer = (state: GameState): PlayerId =>
  state.playerOrder[state.activePlayerIndex]!;

export const shipsOf = (state: GameState, player: PlayerId): Ship[] =>
  Object.values(state.ships).filter((s) => s.owner === player && !s.destroyed);

export const liveShips = (state: GameState): Ship[] =>
  Object.values(state.ships).filter((s) => !s.destroyed);

/**
 * Who flies this ship. "A captured ship must be returned to a base friendly to
 * the captor before it may be used for any other mission" — so until then the
 * captor, not the original owner, gives it orders.
 *
 * This lives here, beside `areAllied`, rather than in `movement.ts` where it was
 * first needed: it is a property of a ship, every rules module has to agree on
 * it, and combat cannot import movement without a cycle. Allegiance decided two
 * different ways in two different modules is exactly the bug this placement
 * prevents.
 */
export const controllerOf = (ship: Ship): PlayerId => ship.capturedBy ?? ship.owner;

/** Two players are hostile unless they are the same player or declared allies. */
export const areAllied = (state: GameState, a: PlayerId, b: PlayerId): boolean => {
  if (a === b) return true;
  const pa = state.players[a];
  return pa ? pa.allies.includes(b) : false;
};
