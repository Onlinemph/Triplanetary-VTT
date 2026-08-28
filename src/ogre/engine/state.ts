/**
 * State construction and the immutable-update helpers.
 *
 * `GameState` is frozen by convention rather than by `Object.freeze` — freezing
 * every state in a replay is measurable, and the convention has held. Never
 * mutate in place: the renderer, the panels and the undo log all hold
 * references to previous states, and a mutation makes a game's history
 * retroactive.
 */

import type { Hex } from './hex.js';
import { key } from './hex.js';
import { type GameMap, terrainAt } from './map.js';
import { createRng } from './rng.js';
import { type Terrain, baseTerrain, defenseMultiplier, townFloorsZeroDefense } from './terrain.js';
import {
  type UnitClassId,
  HEAVY_WEAPON,
  MAX_SQUADS_PER_GROUP,
  UNIT_CLASSES,
  unitClass,
} from './units.js';
import {
  type OgreTypeId,
  type OgreWeaponKind,
  OGRE_WEAPONS,
  TREAD_VP,
  movementForTreads,
  ogreType,
} from './ogres.js';
import {
  type ConventionalUnit,
  type GameOptions,
  type GameState,
  type LogSeverity,
  type OgreUnit,
  type OgreWeapon,
  type Phase,
  type Player,
  type PlayerId,
  type Unit,
  type UnitId,
  DEFAULT_OPTIONS,
  activePlayer,
  isOgre,
} from './types.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface NewGameOptions {
  readonly scenarioId: string;
  readonly mapId: string;
  readonly seed: number;
  readonly players: readonly Player[];
  readonly options?: Partial<GameOptions>;
  readonly scenarioData?: Record<string, unknown>;
}

export const createGame = (opts: NewGameOptions): GameState => {
  const players: Record<PlayerId, Player> = {};
  for (const p of opts.players) players[p.id] = p;
  return {
    scenarioId: opts.scenarioId,
    mapId: opts.mapId,
    turn: 1,
    playerOrder: opts.players.map((p) => p.id),
    activePlayerIndex: 0,
    // "1. Recovery" is the first phase of every player-turn (4.02), including
    // the first: it is a no-op then, and the shell steps straight past it.
    phase: 'recovery',
    players,
    units: {},
    buildings: {},
    terrainOverrides: {},
    routesCut: [],
    options: { ...DEFAULT_OPTIONS, ...opts.options },
    rng: createRng(opts.seed),
    log: [],
    nextLogId: 1,
    nextUnitSerial: 1,
    overrun: null,
    victory: null,
    scenarioData: opts.scenarioData ?? {},
  };
};

export const makePlayer = (id: PlayerId, name: string, faction: string, color: string): Player => ({
  id,
  name,
  faction,
  color,
  victoryPoints: 0,
  eliminated: false,
});

const freshMovementFields = (pos: Hex) => ({
  moveUsed: 0,
  secondMoveUsed: 0,
  phaseStart: pos,
  onRouteAllPhase: true,
  movementEnded: false,
});

export const makeUnit = (
  id: UnitId,
  owner: PlayerId,
  classId: UnitClassId,
  pos: Hex,
  squads = 1,
): ConventionalUnit => ({
  kind: 'unit',
  id,
  owner,
  classId,
  pos,
  squads:
    UNIT_CLASSES[classId].kind === 'infantry'
      ? Math.max(1, Math.min(MAX_SQUADS_PER_GROUP, squads))
      : 1,
  disabled: 'none',
  disabledAt: -1,
  stuck: false,
  pendingHazard: null,
  ...freshMovementFields(pos),
  firedThisPhase: false,
  squadsFired: 0,
  heavyWeaponFired: false,
  mountedThisTurn: false,
  destroyed: false,
});

/** Build an Ogre's record sheet from its type's starting inventory. */
export const makeOgre = (id: UnitId, owner: PlayerId, typeId: OgreTypeId, pos: Hex): OgreUnit => {
  const type = ogreType(typeId);
  const weapons: OgreWeapon[] = [];
  const order: OgreWeaponKind[] = ['main', 'secondary', 'missileRack', 'missile', 'arm', 'ap'];
  for (const kind of order) {
    const count = type.weapons[kind] ?? 0;
    for (let i = 0; i < count; i++) {
      weapons.push({ id: `${id}:${kind}${i + 1}`, kind, destroyed: false, fired: false });
    }
  }
  return {
    kind: 'ogre',
    id,
    owner,
    typeId,
    pos,
    weapons,
    treads: type.treads,
    internalMissiles: type.internalMissiles,
    ...freshMovementFields(pos),
    ramsThisTurn: 0,
    rammedOgreThisTurn: false,
    stuck: false,
    pendingHazard: null,
    destroyed: false,
  };
};

// ---------------------------------------------------------------------------
// Immutable updates
// ---------------------------------------------------------------------------

export const withUnit = (state: GameState, unit: Unit): GameState => ({
  ...state,
  units: { ...state.units, [unit.id]: unit },
});

export const withUnits = (state: GameState, units: readonly Unit[]): GameState => {
  if (units.length === 0) return state;
  const next = { ...state.units };
  for (const u of units) next[u.id] = u;
  return { ...state, units: next };
};

export const updateUnit = (
  state: GameState,
  id: UnitId,
  patch: (u: ConventionalUnit) => Partial<ConventionalUnit>,
): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'unit') return state;
  return withUnit(state, { ...u, ...patch(u) });
};

export const updateOgre = (
  state: GameState,
  id: UnitId,
  patch: (u: OgreUnit) => Partial<OgreUnit>,
): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'ogre') return state;
  return withUnit(state, { ...u, ...patch(u) });
};

export const updateAnyUnit = (
  state: GameState,
  id: UnitId,
  patch: (u: Unit) => Partial<Unit>,
): GameState => {
  const u = state.units[id];
  if (!u) return state;
  return withUnit(state, { ...u, ...patch(u) } as Unit);
};

export const addPoints = (state: GameState, player: PlayerId, points: number): GameState => {
  const p = state.players[player];
  if (!p || points === 0) return state;
  return {
    ...state,
    players: { ...state.players, [player]: { ...p, victoryPoints: p.victoryPoints + points } },
  };
};

export const log = (
  state: GameState,
  severity: LogSeverity,
  text: string,
  focus?: readonly Hex[],
): GameState => ({
  ...state,
  log: [
    ...state.log,
    {
      id: state.nextLogId,
      turn: state.turn,
      player: activePlayer(state),
      phase: state.phase,
      severity,
      text,
      ...(focus ? { focus } : {}),
    },
  ],
  nextLogId: state.nextLogId + 1,
});

export const setTerrainOverride = (state: GameState, h: Hex, t: Terrain): GameState => ({
  ...state,
  terrainOverrides: { ...state.terrainOverrides, [key(h)]: t },
});

export const cutRoute = (state: GameState, h: Hex): GameState =>
  state.routesCut.includes(key(h)) ? state : { ...state, routesCut: [...state.routesCut, key(h)] };

// ---------------------------------------------------------------------------
// Identity and naming
// ---------------------------------------------------------------------------

export const unitName = (u: Unit): string => {
  if (isOgre(u)) return ogreType(u.typeId).name;
  const cls = unitClass(u.classId);
  return cls.kind === 'infantry' ? `${u.squads}-squad ${cls.name}` : cls.name;
};

export const unitAbbr = (u: Unit): string =>
  isOgre(u) ? ogreType(u.typeId).name.replace('Ogre ', '') : unitClass(u.classId).abbr;

// ---------------------------------------------------------------------------
// Derived combat statistics
// ---------------------------------------------------------------------------

/**
 * A unit's printed attack strength, before any doubling or halving.
 *
 * Infantry multiply by squads — "Each squad is 1 attack strength point" (3.02);
 * everything else has one number on the counter.
 */
export const printedAttack = (u: ConventionalUnit): number =>
  unitClass(u.classId).attack * (unitClass(u.classId).kind === 'infantry' ? u.squads : 1);

export const printedDefense = (u: ConventionalUnit): number =>
  unitClass(u.classId).defense * (unitClass(u.classId).kind === 'infantry' ? u.squads : 1);

/**
 * The defence strength an attacker actually has to beat.
 *
 * Terrain is applied here rather than at the call sites so that gunnery,
 * spillover, ram attacks and cruise-missile shockwaves all agree.
 */
export const defenseOf = (
  state: GameState,
  map: GameMap,
  u: Unit,
  opts: { spillover?: boolean; hexOverride?: Hex } = {},
): number => {
  const where = opts.hexOverride ?? u.pos;
  const terrain = terrainAt(map, where, state.terrainOverrides);

  if (isOgre(u)) {
    // An Ogre is never a single defence value: attacks name a component
    // (7.13). This is only meaningful for ramming, where the whole machine is
    // the target and only treads are at stake, so report zero and let the
    // ramming rules do their own arithmetic.
    return 0;
  }

  const cls = unitClass(u.classId);
  const infantry = cls.kind === 'infantry';
  let base = printedDefense(u);

  // "In a town hex, and/or undergoing a spillover attack, it has a defense
  // strength of 1" — the Truck's own rule (3.03), generalised by 7.14.2's "A
  // town hex gives a D0 unit a defense of 1".
  if (base === 0) {
    if (townFloorsZeroDefense(terrain) || opts.spillover) base = 1;
    else return 0;
  }

  // Marines "have double defense in water hexes" (3.02.1). Everyone else's
  // defence is unaffected by water (7.14.4).
  if (u.classId === 'MAR' && baseTerrain(terrain) === 'water') base *= 2;

  // "Infantry riding in or on a vehicle receive the terrain defensive bonus
  // that applies to the vehicle, if any, and not the usual bonus for infantry."
  // (5.11.2)
  const treatAsInfantry = infantry && u.ridingOn == null;
  return base * defenseMultiplier(terrain, treatAsInfantry);
};

/** The defence of one Ogre component (7.13.1). */
export const ogreWeaponDefense = (
  state: GameState,
  map: GameMap,
  ogre: OgreUnit,
  weapon: OgreWeapon,
): number => {
  const terrain = terrainAt(map, ogre.pos, state.terrainOverrides);
  // Interpretation: 7.14.2 doubles "the defense strength of all other units" in
  // a town, and an Ogre's components are the only defence strengths an Ogre
  // has. Treads get their own town rule (destroyed only on a 6), which reads as
  // a separate provision *because* treads are not resolved on the odds ladder,
  // not as an exemption for the rest of the machine. Recorded in
  // docs/RULES-MAPPING.md.
  const multiplier = baseTerrain(terrain) === 'town' ? 2 : 1;
  return OGRE_WEAPONS[weapon.kind].defense * multiplier;
};

/**
 * What one attacker contributes to an attack's total strength.
 *
 * `squads` lets a multi-squad infantry counter split its fire, which is the one
 * exception to "An attack strength may never be divided between targets"
 * (7.07.1).
 */
export const attackerStrength = (
  u: Unit,
  ref: {
    weapon?: string;
    squads?: number;
    halfAttack?: boolean;
    heavyWeapon?: boolean;
    antipersonnel?: boolean;
  },
): number => {
  if (isOgre(u)) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    if (!w) return 0;
    return OGRE_WEAPONS[w.kind].attack;
  }
  const cls = unitClass(u.classId);
  if (ref.heavyWeapon) return HEAVY_WEAPON.attack;
  // "The Superheavy also has two antipersonnel weapons. These function exactly
  // like Ogre AP weapons" (3.01) — one attack of strength equal to the number
  // of guns, since "any number of AP weapons may be used for that single
  // attack" (7.05.1).
  if (ref.antipersonnel) return cls.ap ?? 0;
  if (cls.kind === 'infantry') {
    const squads = Math.max(1, Math.min(u.squads, ref.squads ?? u.squads));
    return cls.attack * squads;
  }
  // "A unit with an asterisk after its attack strength may divide that strength
  // into two equal attacks" (7.02).
  if (ref.halfAttack && cls.splitAttack) return cls.attack / 2;
  return cls.attack;
};

export const attackerRange = (u: Unit, ref: { weapon?: string; heavyWeapon?: boolean }): number => {
  if (isOgre(u)) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    return w ? OGRE_WEAPONS[w.kind].range : 0;
  }
  if (ref.heavyWeapon) return HEAVY_WEAPON.range;
  return unitClass(u.classId).range;
};

// ---------------------------------------------------------------------------
// Movement allowance
// ---------------------------------------------------------------------------

/**
 * Movement points for this phase, before the road bonus.
 *
 * An Ogre's allowance is not printed: it is read off the tread track, and it is
 * re-read *during* movement, which is why 6.04 has to say so explicitly.
 */
export const movementAllowance = (u: Unit, phase: Phase): number => {
  if (isOgre(u)) {
    if (u.stuck) return 0;
    return phase === 'gevMovement' ? 0 : movementForTreads(ogreType(u.typeId), u.treads);
  }
  if (u.stuck || u.disabled !== 'none') return 0;
  const cls = unitClass(u.classId);
  if (phase === 'gevMovement') return cls.secondMove ?? 0;
  return cls.move;
};

export const isGevClass = (u: Unit): boolean =>
  u.kind === 'unit' && unitClass(u.classId).secondMove != null;

// ---------------------------------------------------------------------------
// Losses and scoring
// ---------------------------------------------------------------------------

/** Victory points an enemy earns for destroying this unit (1.08, 1.09). */
export const victoryValue = (u: Unit): number => {
  if (isOgre(u)) return ogreType(u.typeId).vp;
  const cls = unitClass(u.classId);
  return cls.kind === 'infantry' ? cls.vp * u.squads : cls.vp;
};

/** Victory points for damage short of destruction (1.09.1). */
export const ogreDamageValue = (kind: OgreWeaponKind | 'tread'): number =>
  kind === 'tread' ? TREAD_VP : OGRE_WEAPONS[kind].vp;

/**
 * Destroy a unit, award the points, and take its passengers with it.
 *
 * Infantry riding a vehicle that dies die with it unless a rule dismounts them
 * first; 5.11.2 resolves the vehicle and its riders as separate attacks, so the
 * only riders removed here are the ones still aboard when the carrier is gone.
 */
export const destroyUnit = (
  state: GameState,
  id: UnitId,
  cause: string,
  credit?: PlayerId,
): GameState => {
  const u = state.units[id];
  if (!u || u.destroyed) return state;

  let next = withUnit(state, { ...u, destroyed: true, destroyedBy: cause } as Unit);
  if (credit) next = addPoints(next, credit, victoryValue(u));

  for (const rider of Object.values(next.units)) {
    if (rider.kind === 'unit' && !rider.destroyed && rider.ridingOn === id) {
      next = destroyUnit(next, rider.id, `lost with the ${unitName(u)}`, credit);
    }
  }
  return next;
};

/** Reduce an infantry counter by one squad, destroying it at zero (7.11). */
export const reduceSquad = (
  state: GameState,
  id: UnitId,
  cause: string,
  credit?: PlayerId,
): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'unit' || u.destroyed) return state;
  if (u.squads <= 1) return destroyUnit(state, id, cause, credit);
  const next = withUnit(state, { ...u, squads: u.squads - 1 });
  return credit ? addPoints(next, credit, unitClass(u.classId).vp) : next;
};

/**
 * "An Ogre is not destroyed until all its fireable weapons and tread units are
 * gone. Any remaining unfireable internal missiles are then considered
 * destroyed." (7.13.3)
 */
export const ogreIsDestroyed = (u: OgreUnit): boolean =>
  u.treads <= 0 && !u.weapons.some((w) => !w.destroyed && isFireable(u, w));

/**
 * Whether a component can still shoot.
 *
 * A spent external missile is gone. A missile rack is only a weapon while the
 * Ogre still has internal missiles: "If all missile racks are destroyed,
 * remaining IM do not count as destroyed, but cannot be fired" (3.04.2) — and
 * the converse, a rack with an empty magazine, is equally inert.
 */
export const isFireable = (u: OgreUnit, w: OgreWeapon): boolean => {
  if (w.destroyed) return false;
  if (w.kind === 'missile') return !w.fired;
  if (w.kind === 'missileRack') return u.internalMissiles > 0;
  return true;
};

/** Antipersonnel weapons still aboard — what lets an Ogre walk through infantry (6.06). */
export const apRemaining = (u: OgreUnit): number =>
  u.weapons.filter((w) => w.kind === 'ap' && !w.destroyed).length;
