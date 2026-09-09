/**
 * State construction and the small immutable-update helpers every rules module
 * shares. Keeping these in one place means the modules never hand-roll a spread
 * and accidentally drop a field.
 */

import { type Hex, hex, key } from './hex.js';
import { createRng } from './rng.js';
import { SHIP_CLASSES, type CargoKind, type ShipClass } from './ships.js';
import {
  type BaseState,
  type CargoItem,
  type GameOptions,
  type GameState,
  type LogEntry,
  type LogSeverity,
  type Ordnance,
  type Phase,
  type Player,
  type PlayerId,
  type Ship,
  type ShipId,
  DEFAULT_OPTIONS,
} from './types.js';
import { DEFAULT_MAP, type GameMap } from './map.js';

export const ZERO: Hex = hex(0, 0);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export interface ShipSeed {
  readonly id: ShipId;
  readonly owner: PlayerId;
  readonly shipClass: ShipClass;
  readonly pos: Hex;
  readonly number?: number;
  readonly name?: string;
  readonly velocity?: Hex;
  readonly fuel?: number;
  readonly cargo?: readonly CargoItem[];
  readonly location?: Ship['location'];
}

export const makeShip = (seed: ShipSeed): Ship => {
  const def = SHIP_CLASSES[seed.shipClass];
  return {
    id: seed.id,
    owner: seed.owner,
    shipClass: seed.shipClass,
    number: seed.number ?? 1,
    ...(seed.name !== undefined ? { name: seed.name } : {}),
    pos: seed.pos,
    velocity: seed.velocity ?? ZERO,
    pendingGravity: ZERO,
    optionalGravity: [],
    location: seed.location ?? { kind: 'space' },
    fuel: seed.fuel ?? def.fuelCapacity,
    cargo: seed.cargo ?? [],
    disabled: 0,
    advancedDamage: { weapon: 0, drive: 0, structure: 0 },
    overloadAvailable: def.warship,
    heroic: false,
    detectedBy: [],
    surrenderedTo: [],
    plottedAccel: 0,
    acceptedOptionalGravity: [],
    course: [],
    destroyed: false,
    firedThisPhase: false,
    attackedThisPhase: false,
    resuppliedThisTurn: false,
    launchedOrdnanceThisTurn: false,
  };
};

export const makePlayer = (
  id: PlayerId,
  name: string,
  faction: string,
  color: string,
  extra: Partial<Player> = {},
): Player => ({
  id,
  name,
  faction,
  color,
  megacredits: 0,
  points: 0,
  allies: [],
  eliminated: false,
  ...extra,
});

export interface StateSeed {
  readonly scenarioId: string;
  readonly seed: number;
  readonly players: readonly Player[];
  readonly ships: readonly Ship[];
  readonly bases?: readonly BaseState[];
  readonly options?: Partial<GameOptions>;
  readonly scenarioData?: Record<string, unknown>;
  readonly map?: GameMap;
}

/**
 * Build the starting state for a scenario.
 *
 * Planetary and asteroid bases printed on the chart are materialised here so
 * scenarios only have to declare *ownership*, not geography.
 */
export const createInitialState = (seed: StateSeed): GameState => {
  const map = seed.map ?? DEFAULT_MAP;

  const bases: Record<string, BaseState> = {};
  for (const site of map.allPlanetaryBases()) {
    bases[site.id] = {
      id: site.id,
      kind: 'planetary',
      owner: null,
      side: site.side,
      hex: site.side.hex,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: site.hasPlanetaryDefences,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    };
  }
  for (const site of map.allAsteroidBases()) {
    bases[site.id] = {
      id: site.id,
      kind: 'asteroid',
      owner: null,
      hex: site.hex,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: false,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    };
  }
  // Scenario overrides (ownership, extra orbital bases, removed bases).
  for (const b of seed.bases ?? []) bases[b.id] = b;

  const players: Record<PlayerId, Player> = {};
  for (const p of seed.players) players[p.id] = p;

  const ships: Record<ShipId, Ship> = {};
  for (const s of seed.ships) ships[s.id] = s;

  return {
    scenarioId: seed.scenarioId,
    mapId: map.id,
    turn: 1,
    playerOrder: seed.players.map((p) => p.id),
    activePlayerIndex: 0,
    phase: 'astrogation',
    players,
    ships,
    ordnance: {},
    bases,
    clearedAsteroids: [],
    prospected: {},
    devastatedSides: [],
    options: { ...DEFAULT_OPTIONS, ...seed.options },
    rng: createRng(seed.seed),
    log: [],
    nextLogId: 1,
    nextShipNumber: seed.ships.length + 1,
    nextOrdnanceId: 1,
    victory: null,
    scenarioData: seed.scenarioData ?? {},
  };
};

// ---------------------------------------------------------------------------
// Immutable updates
// ---------------------------------------------------------------------------

export const withShip = (state: GameState, ship: Ship): GameState => ({
  ...state,
  ships: { ...state.ships, [ship.id]: ship },
});

export const withShips = (state: GameState, ships: readonly Ship[]): GameState => {
  if (ships.length === 0) return state;
  const next = { ...state.ships };
  for (const s of ships) next[s.id] = s;
  return { ...state, ships: next };
};

export const updateShip = (
  state: GameState,
  id: ShipId,
  patch: Partial<Ship> | ((s: Ship) => Partial<Ship>),
): GameState => {
  const ship = state.ships[id];
  if (!ship) return state;
  const delta = typeof patch === 'function' ? patch(ship) : patch;
  return withShip(state, { ...ship, ...delta });
};

export const withOrdnance = (state: GameState, o: Ordnance): GameState => ({
  ...state,
  ordnance: { ...state.ordnance, [o.id]: o },
});

export const removeOrdnance = (state: GameState, id: string): GameState => {
  if (!(id in state.ordnance)) return state;
  const next = { ...state.ordnance };
  delete next[id];
  return { ...state, ordnance: next };
};

export const withBase = (state: GameState, base: BaseState): GameState => ({
  ...state,
  bases: { ...state.bases, [base.id]: base },
});

export const withPlayer = (state: GameState, player: Player): GameState => ({
  ...state,
  players: { ...state.players, [player.id]: player },
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface LogOptions {
  readonly severity?: LogSeverity;
  readonly player?: PlayerId | null;
  readonly phase?: Phase;
  readonly focus?: readonly Hex[];
}

export const log = (state: GameState, text: string, opts: LogOptions = {}): GameState => {
  const entry: LogEntry = {
    id: state.nextLogId,
    turn: state.turn,
    player:
      opts.player !== undefined
        ? opts.player
        : (state.playerOrder[state.activePlayerIndex] ?? null),
    phase: opts.phase ?? state.phase,
    severity: opts.severity ?? 'info',
    text,
    ...(opts.focus ? { focus: opts.focus } : {}),
  };
  return { ...state, log: [...state.log, entry], nextLogId: state.nextLogId + 1 };
};

// ---------------------------------------------------------------------------
// Cargo helpers
// ---------------------------------------------------------------------------

export const cargoCount = (ship: Ship, kind: CargoKind): number =>
  ship.cargo.find((c) => c.kind === kind)?.quantity ?? 0;

export const setCargo = (ship: Ship, kind: CargoKind, quantity: number): Ship => {
  const rest = ship.cargo.filter((c) => c.kind !== kind);
  return {
    ...ship,
    cargo: quantity > 0 ? [...rest, { kind, quantity }] : rest,
  };
};

export const addCargo = (ship: Ship, kind: CargoKind, delta: number): Ship =>
  setCargo(ship, kind, Math.max(0, cargoCount(ship, kind) + delta));

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/** Live ships sharing a hex. "Any number of ships may occupy the same hex." */
export const shipsInHex = (state: GameState, h: Hex): Ship[] => {
  const k = key(h);
  return Object.values(state.ships).filter((s) => !s.destroyed && key(s.pos) === k);
};

export const ordnanceInHex = (state: GameState, h: Hex): Ordnance[] => {
  const k = key(h);
  return Object.values(state.ordnance).filter((o) => key(o.pos) === k);
};
