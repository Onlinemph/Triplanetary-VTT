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
import type { SideFeature, Terrain } from './terrain.js';

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
  /**
   * The train's speed marker (9.02): the hexes of rail it runs this turn.
   * Changed by one step per turn, before it moves. Present only on a train.
   */
  readonly trainSpeed?: number;
  /** The train's speed has been set this turn; it changes once per turn. */
  readonly trainSpeedSet?: boolean;
  /**
   * The other counter of a two-counter train (9.01), and which end this is.
   * "'Front' and 'back' are always relative to the movement of the train"
   * (9.02), so the half the player drives becomes the front.
   */
  readonly coupledTo?: UnitId;
  readonly trainHalf?: 'front' | 'rear';
  /**
   * 4/2 guns on this counter (9.03.1): "For each armor unit given up, he can
   * put one 4/2 gun on each of the train counters." They fire like squads —
   * separately, at separate targets — so `squadsFired` counts them.
   */
  readonly trainGuns?: number;
  /**
   * A Laser emplacement's Structure Points (12.01, 12.07). Absent means the
   * class's full count. "When a Laser or Laser Tower is reduced to 10 SP, it
   * is 'damaged' ... The Laser can no longer fire, but it is not actually
   * destroyed until it is reduced to 0 SP."
   */
  readonly structurePoints?: number;
  /**
   * The laser shot at something during the enemy's turn, so it may not attack
   * a unit in its own fire phase (12.06). Cleared as its fire phase ends.
   */
  readonly firedInEnemyTurn?: boolean;

  readonly destroyed: boolean;
  readonly destroyedBy?: string;
  /**
   * The edge this unit left by, if it did. "It takes 1 movement to leave the
   * map ... No unit may re-enter the map once it has left." (5.12) A unit that
   * escapes is not destroyed — several scenarios turn on the difference — so it
   * is off the board and out of play, but still its owner's.
   *
   * `'reserve'` is the one non-edge value: a reaction force waiting off the map
   * (Orbital Drop §3.03), entered by the `deployReserve` order. It counts as
   * surviving — a force that never had to fight went home intact — but it is
   * not on the board.
   */
  readonly offMap?: 'north' | 'south' | 'east' | 'west' | 'reserve';
  /**
   * Face down (13.05, 13.06): the enemy sees a counter in the hex and not
   * what it is, until it moves, fires, is fired on or is spotted. See
   * `concealment.ts`.
   */
  readonly concealed?: boolean;
  /**
   * A Light Artillery Drone's deployment (14.01). Absent on everything else,
   * and on a drone that a scenario simply put on the board ready to fire.
   *
   * "Turn 1: Unloading ... Place the LAD pallet in the same hex as the
   * transport. Turn 2: The LAD unpacks itself, sets itself up, and runs
   * diagnostics ... It may be targeted, but may not attack ... Turn 3: The LAD
   * can fire."
   */
  readonly droneState?: DroneState;
  /**
   * Turns of work done towards putting a drone back on its pallet: "It takes a
   * squad of Combat Engineers three turns to re-palletize a LAD, and one
   * further turn to load it onto a Truck. A Vulcan may break down and load an
   * LAD in one turn." (14.01)
   */
  readonly repackProgress?: number;
  /**
   * Stowed aboard a Vulcan (15.02.1): its id, and which of the two cargo areas.
   * The hold "will survive as long as the Ogre does"; the deck is exposed.
   */
  readonly stowedIn?: UnitId;
  readonly stowedOn?: 'internal' | 'top';
  /**
   * A Vulcan is driving this counter (15.02.4, 15.02.5): its id, and whether it
   * has a whole control channel to itself or is one of four ducklings sharing.
   */
  readonly drivenBy?: UnitId;
  readonly control?: 'combat' | 'duckling';
  /**
   * No crew aboard. "Those systems, unaided, will allow an armor unit to move
   * intelligently over short distances, and to attack at half strength"
   * (15.02.4) — but only with a Vulcan in the loop; on its own such a counter
   * does nothing. Scenarios set this; nothing in the rules creates it mid-game.
   */
  readonly crewless?: boolean;
  /** On a Vulcan's tow hitch (15.04.8). */
  readonly towedBy?: UnitId;
  /**
   * A Superheavy's record sheet (13.07), once it has taken damage under that
   * option. Absent means the full sheet; see `engineering.ts`.
   */
  readonly sheet?: {
    readonly guns: number;
    readonly ap: number;
    readonly treads: number;
    /** Down from a hit on the sheet; a second D does nothing more (13.07). */
    readonly disabled?: boolean;
  };
}

/**
 * Where a Light Artillery Drone is in its three-turn deployment (14.01).
 *
 *  - `pallet` — collapsed cargo. "A LAD on a pallet is treated as a D0 unit;
 *    it is destroyed by any attack." It may be carried, hidden in a defensive
 *    setup, pushed a hex a turn by a squad, and is not overrun.
 *  - `unpacking` — the turn it sets itself up. "It may be targeted, but may
 *    not attack."
 *  - `ready` — a drone on its legs. "A LAD that is set up may not be moved."
 */
export type DroneState = 'pallet' | 'unpacking' | 'ready';

/** One targetable component on an Ogre's record sheet. */
export interface OgreWeapon {
  readonly id: string;
  readonly kind: OgreWeaponKind;
  readonly destroyed: boolean;
  /**
   * Looked at by a Vulcan and found past mending (15.04.5): "a notation should
   * be made on the record sheet that this weapon is beyond field repair."
   */
  readonly beyondRepair?: boolean;
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

  /**
   * The turn this Ogre finishes assembling, for one that shipped in modules
   * (Orbital Drop §6, adapting the Vulcan assembly rules, 15.02.2). Until
   * then it is an inert hull: it cannot move, ram or fire, and a D result
   * against any part of it is treated as an X — the unfinished-Ogre rule.
   * Absent means the Ogre arrived assembled.
   */
  readonly activatesOn?: number;
  /** On a Vulcan's tow hitch (15.04.8): a cybertank with no treads left. */
  readonly towedBy?: UnitId;

  readonly destroyed: boolean;
  readonly destroyedBy?: string;
  /**
   * The edge this unit left by, if it did. "It takes 1 movement to leave the
   * map ... No unit may re-enter the map once it has left." (5.12) A unit that
   * escapes is not destroyed — several scenarios turn on the difference — so it
   * is off the board and out of play, but still its owner's.
   */
  readonly offMap?: 'north' | 'south' | 'east' | 'west' | 'reserve';
  /** Face down (13.05): see `ConventionalUnit.concealed`. */
  readonly concealed?: boolean;
}

export type Unit = ConventionalUnit | OgreUnit;

/**
 * A minefield (13.04): laid secretly during the setup, revealed the first
 * time an enemy unit runs onto it, and there until engineers clear it.
 */
export interface Minefield {
  readonly id: string;
  readonly owner: PlayerId;
  readonly pos: Hex;
  readonly revealed: boolean;
  /**
   * Laid on the road or railroad through the hex (13.04). A road mine goes off
   * under anything that enters using the road and does nothing to a unit that
   * comes in across country; a mine off the road goes off on a die roll.
   */
  readonly onRoad?: boolean;
}

export const isOgre = (u: Unit): u is OgreUnit => u.kind === 'ogre';

/** An Ogre still assembling: a stationary target that cannot yet act. */
export const isInertOgre = (u: Unit, turn: number): boolean =>
  isOgre(u) && u.activatesOn !== undefined && turn < u.activatesOn;

/** Whose turn it is to place counters, while the setup lasts. */
export const setupActor = (state: { readonly setup?: SetupState | null }): PlayerId | null => {
  const setup = state.setup;
  if (!setup) return null;
  return setup.order[setup.index] ?? null;
};

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
  | { readonly kind: 'terrain'; readonly hex: Hex }
  /** A bridge (13.02): the crossing between `hex` and its neighbour `toward`. */
  | { readonly kind: 'bridge'; readonly hex: Hex; readonly toward: Hex }
  /**
   * A bridge across a whole hex (13.02.1), named by its centre. It "lies in
   * three hexes – the river hex and the adjoining road hexes – and can be
   * attacked by firing at any of them".
   */
  | { readonly kind: 'riverBridge'; readonly hex: Hex };

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
// Deployment (the setup step every scenario opens with)
// ---------------------------------------------------------------------------

/**
 * "No more than 20 attack strength points may be set up in this area." A
 * sub-zone with a ceiling on the printed attack strength placed inside it.
 */
export interface SetupLimit {
  readonly hexes: readonly string[];
  readonly maxAttack: number;
  readonly label: string;
}

/** Where one side may set up: hex keys, a name for the panel, and any ceilings. */
export interface SetupZone {
  readonly hexes: readonly string[];
  readonly label: string;
  readonly limits?: readonly SetupLimit[];
}

/**
 * Deployment in progress.
 *
 * A scenario builds a *legal* board from its seed, and this is the window in
 * which the players rearrange it: "The defender sets up first", then the
 * attacker chooses where to come on. While it is set, nothing else happens —
 * no phase advances, no unit moves — and only the side whose turn it is to
 * set up may act. `index` walks `order`; when it runs off the end the setup
 * is over and the state's `setup` is cleared.
 */
export interface SetupState {
  readonly order: readonly PlayerId[];
  readonly index: number;
  readonly zones: Readonly<Record<PlayerId, SetupZone>>;
  /** Minefields each side has still to lay (13.04). */
}

// ---------------------------------------------------------------------------
// Cruise missiles in flight (Section 10)
// ---------------------------------------------------------------------------

/**
 * A cruise missile between launch and detonation. It lives outside `units`
 * because it is not a counter anybody moves or shoots at with ordinary fire:
 * it flies its own leg each of its owner's fire phases, lasers in line of
 * sight take their interception shots as it passes, and it either arrives or
 * is knocked down.
 */
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
  /** 13.04: minefields each side with a setup area may lay, secretly, while setting up. */
  readonly minefields?: number;
  /** 13.05: every counter is face down once the counters are down, until revealed. */
  readonly camouflage?: boolean;
  /** 13.06: dummy counters per side — face down, nothing at all, gone when revealed. */
  readonly dummies?: number;
  /** Warn before a move that would strand or expose a unit. Interface only. */
  readonly confirmRiskyMoves: boolean;
  /**
   * Orbital Drop §5, asteroid bases: "Low gravity: all other units get +1
   * movement point." Everything that moves at all gets one more.
   */
  readonly lowGravity?: boolean;
  /**
   * Orbital Drop §5, asteroid bases: "No GEV-type units function (nothing to
   * hover on) ... they sit immobile as D2 targets."
   */
  readonly noHover?: boolean;
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
  /**
   * Hexside features the game has laid over the map — the ridge overlays an
   * Orbital Drop attacker places on a dead world (its §5). Keyed by canonical
   * hexside, like `GameMap.sides`, and read in preference to it.
   */
  /**
   * Hexsides changed in play, by canonical key. `'none'` is a hexside graded
   * flat by engineers (15.03.7): "a low point may be created in a ridge to
   * allow units to pass through the ridge as if it were not there."
   */
  readonly sideOverrides?: Readonly<Record<string, SideFeature | 'none'>>;

  readonly options: GameOptions;
  readonly rng: RngState;
  readonly log: readonly LogEntry[];
  readonly nextLogId: number;
  readonly nextUnitSerial: number;

  /** Set while an overrun is being fought; the movement phase is suspended. */
  readonly overrun: OverrunState | null;
  /** Set while the sides are still placing their counters; nothing else moves. */
  readonly setup?: SetupState | null;
  /** Cruise missiles in flight, by id. */
  /**
   * Hexes a cruise missile has gone off in during this player-turn, for
   * fratricide (10.02.1). Cleared as each turn opens. A missile itself is
   * never in this state: it is fired and resolved inside one order (10.02).
   */
  readonly missileBlasts?: readonly string[];
  /** Minefields on the map (13.04), laid and hidden; see `concealment.ts`. */
  readonly mines?: readonly Minefield[];
  /** Bridges dropped (13.02, 15), by canonical hexside key; see `engineering.ts`. */
  readonly bridgesDown?: readonly string[];
  /**
   * Entrenchments (15.03.5), by hex key, holding the squads each protects:
   * one on a die of 1-4, two on a 5, three on a 6.
   */
  readonly entrenched?: Readonly<Record<string, number>>;
  /** Minefields each side has left to lay (13.04, 15.03.1), by player. */
  readonly minesLeft?: Readonly<Record<string, number>>;
  /**
   * Revetments dug by a Vulcan (15.04.7), by hex key, holding the size they
   * shelter: 3 for a small one, 5 for a large. "Revetments add +1D to the
   * defense strength of a combat unit. This bonus is added after any terrain
   * bonus multiplier."
   */
  readonly revetments?: Readonly<Record<string, number>>;
  /**
   * Engineering tasks attempted this player-turn, as `task:hex`: "the specific
   * task may be attempted only once per turn regardless of how many Sappers
   * participate" (15.03). Cleared as each turn opens.
   */
  readonly tasksTried?: readonly string[];
  /**
   * Spare Ogre missiles in a Vulcan's hold (15.02.1, 15.04.4), by Vulcan id:
   * "If a Vulcan is carrying spare missiles, that Vulcan or an accompanying
   * Heavy Drone may reload either internal or external missile launchers."
   */
  readonly vulcanMissiles?: Readonly<Record<string, number>>;

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

/**
 * A collapsed Light Artillery Drone: cargo, not a combat unit (14.01).
 *
 * "A LAD on a pallet is treated as a D0 unit; it is destroyed by any attack"
 * and "An overrun does not take place when a opponent enters a hex with a
 * collapsed LAD, as the LAD is not a functioning combat unit at that time."
 */
export const isPallet = (u: Unit): boolean => u.kind === 'unit' && u.droneState === 'pallet';

/**
 * Infantry riding a vehicle are in the vehicle's hex but are not *in* the hex —
 * and neither is cargo in a Vulcan's hold or on its deck (15.02.1).
 */
export const ridingSomething = (u: Unit): boolean =>
  u.kind === 'unit' && (u.ridingOn != null || u.stowedIn != null);

export const passengersOf = (state: GameState, carrier: UnitId): ConventionalUnit[] =>
  Object.values(state.units).filter(
    (u): u is ConventionalUnit => u.kind === 'unit' && onBoard(u) && u.ridingOn === carrier,
  );

/** Two players are hostile unless they are the same player. */
export const areEnemies = (a: PlayerId, b: PlayerId): boolean => a !== b;

/** A disabled or stuck unit "cannot fire or move" (7.11) — but still defends. */
export const canAct = (u: Unit): boolean =>
  u.kind === 'ogre' ? onBoard(u) : onBoard(u) && u.disabled === 'none';
