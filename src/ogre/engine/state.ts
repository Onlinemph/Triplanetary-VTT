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
import { key, sideKeyBetween } from './hex.js';
import { type GameMap, terrainAt } from './map.js';
import { createRng } from './rng.js';
import {
  type SideFeature,
  type Terrain,
  baseTerrain,
  defenseMultiplier,
  townFloorsZeroDefense,
} from './terrain.js';
import {
  type UnitClassId,
  HEAVY_WEAPON,
  LASER_DAMAGED_AT,
  MAX_SQUADS_PER_GROUP,
  UNIT_CLASSES,
  isMarine,
  TRAIN_GUN,
  trainTopSpeed,
  superheavyMove,
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
  isPallet,
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
    sideOverrides: {},
    options: { ...DEFAULT_OPTIONS, ...opts.options },
    rng: createRng(opts.seed),
    log: [],
    nextLogId: 1,
    nextUnitSerial: 1,
    overrun: null,
    setup: null,
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
  // A Laser carries its Structure Points from the moment it is placed (12.01).
  ...(UNIT_CLASSES[classId].structurePoints !== undefined
    ? { structurePoints: UNIT_CLASSES[classId].structurePoints }
    : {}),
  // "It is considered a Size 1 unit when set up" (14.01): a drone a scenario
  // puts on the board is emplaced and can fire. One that arrives as cargo is
  // palletised on purpose — see `drone.palletised`.
  ...(classId === 'LAD' ? { droneState: 'ready' as const } : {}),
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

/** Lay a ridge (or any hexside feature) over the map between two hexes. */
export const setSideOverride = (
  state: GameState,
  a: Hex,
  b: Hex,
  f: SideFeature | 'none',
): GameState => {
  const k = sideKeyBetween(a, b);
  if (k === '') return state;
  return { ...state, sideOverrides: { ...(state.sideOverrides ?? {}), [k]: f } };
};

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
export const printedAttack = (u: ConventionalUnit): number => {
  // A Superheavy on its record sheet (13.07) shoots with the guns it has left.
  if (u.sheet) return u.sheet.guns * 3;
  return unitClass(u.classId).attack * (unitClass(u.classId).kind === 'infantry' ? u.squads : 1);
};

/** A Laser emplacement's Structure Points now: its own, or the class's full count. */
export const structurePointsOf = (u: ConventionalUnit): number =>
  u.structurePoints ?? unitClass(u.classId).structurePoints ?? 0;

/** "reduced to 10 SP, it is 'damaged' ... can no longer fire" (12.07). */
export const laserDamaged = (u: ConventionalUnit): boolean => {
  const full = unitClass(u.classId).structurePoints;
  return full !== undefined && structurePointsOf(u) <= LASER_DAMAGED_AT;
};

/**
 * Remember that a Laser spent a shot while it was not its owner's turn.
 *
 * "If a Laser or Laser Tower did not fire at all during the preceding enemy
 * turn, it may make one attack during its own fire phase." (12.06) A Laser's
 * only chance to fire in the enemy's turn is interception — at a Cruise
 * Missile (12.04) or an Ogre missile (12.05) — so the flag is set there and
 * read by `canStillFire` one turn later.
 */
export const markFiredInEnemyTurn = (state: GameState, id: UnitId): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'unit') return state;
  if (unitClass(u.classId).laser === undefined) return state;
  return withUnit(state, { ...u, firedInEnemyTurn: true });
};

/**
 * Forget it again, at the end of the owner's own fire phase: from here on the
 * "preceding enemy turn" is the one about to start.
 */
export const clearLaserWatch = (state: GameState, player: PlayerId): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || u.kind !== 'unit') continue;
    if (u.firedInEnemyTurn !== true) continue;
    next = withUnit(next, { ...u, firedInEnemyTurn: false });
  }
  return next;
};

export const printedDefense = (u: ConventionalUnit): number =>
  unitClass(u.classId).defense * (unitClass(u.classId).kind === 'infantry' ? u.squads : 1);

/**
 * The defence strength an attacker actually has to beat.
 *
 * Terrain is applied here rather than at the call sites so that gunnery,
 * spillover, ram attacks and cruise-missile shockwaves all agree.
 */
/**
 * Whether this counter is inside the hex's entrenchment (15.03.5).
 *
 * "A die roll determines how many squads the entrenchments will protect" — so
 * a hex shelters a fixed number of squads, not everybody in it. The counters
 * fill it in id order, which is arbitrary but the same for both players and
 * for every replay.
 */
const shelteredByEntrenchment = (state: GameState, u: ConventionalUnit, where: Hex): boolean => {
  const room = (state.entrenched ?? {})[key(where)] ?? 0;
  if (room <= 0) return false;
  let used = 0;
  for (const other of Object.values(state.units).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (other.kind !== 'unit' || other.destroyed || other.offMap) continue;
    if (other.ridingOn != null) continue;
    if (!(other.pos.q === where.q && other.pos.r === where.r)) continue;
    if (unitClass(other.classId).kind !== 'infantry') continue;
    if (other.id === u.id) return used + u.squads <= room;
    used += other.squads;
  }
  return false;
};

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

  // "A LAD on a pallet is treated as a D0 unit; it is destroyed by any attack.
  // Additionally, LADs on a pallet that are being transported suffer spillover
  // attacks at defense strength 0 if the transport vehicle is attacked."
  // (14.01)
  if (isPallet(u)) return 0;

  const cls = unitClass(u.classId);
  const infantry = cls.kind === 'infantry';
  let base = printedDefense(u);

  // Orbital Drop §5, an asteroid: GEV-type units "sit immobile as D2 targets".
  if (state.options.noHover && cls.mobility === 'gev') base = 2;

  // "In a town hex, and/or undergoing a spillover attack, it has a defense
  // strength of 1" — the Truck's own rule (3.03), generalised by 7.14.2's "A
  // town hex gives a D0 unit a defense of 1".
  if (base === 0) {
    if (townFloorsZeroDefense(terrain) || opts.spillover) base = 1;
    else return 0;
  }

  // Marines "have double defense in water hexes" (3.02.1). Everyone else's
  // defence is unaffected by water (7.14.4).
  if (isMarine(u.classId) && baseTerrain(terrain) === 'water') base *= 2;

  // "If a train counter is in a town hex, its defense strength is doubled.
  // Other terrain does not affect the train's defense." (9.03.2)
  if (cls.mobility === 'rail') {
    return baseTerrain(terrain) === 'town' ? base * 2 : base;
  }

  // "Infantry riding in or on a vehicle receive the terrain defensive bonus
  // that applies to the vehicle, if any, and not the usual bonus for infantry."
  // (5.11.2)
  const treatAsInfantry = infantry && u.ridingOn == null;
  let multiplier = defenseMultiplier(terrain, treatAsInfantry);
  // "Entrenchments double the defense strength of infantry within the
  // entrenchment in clear terrain, and triple the defense strength of infantry
  // within the entrenchment in forest or rubble terrain (this replaces the
  // benefit for the forest or rubble) ... Entrenchments in any terrain other
  // than clear, forest, or rubble offer no benefit. Entrenchments have no
  // effect on vehicles." (15.03.5)
  if (treatAsInfantry && shelteredByEntrenchment(state, u, where)) {
    const ground = baseTerrain(terrain);
    if (ground === 'clear') multiplier = 2;
    else if (ground === 'forest' || ground === 'rubble') multiplier = 3;
  }
  // "Revetments add +1D to the defense strength of a combat unit. This bonus
  // is added after any terrain bonus multiplier." (15.04.7)
  return base * multiplier + (shelteredByRevetment(state, u, where) ? 1 : 0);
};

/**
 * Whether this counter is down in the hex's revetment (15.04.7).
 *
 * "A small revetment can offer protection to a unit size 3 or smaller, whereas
 * a large revetment protects a unit or units up to size 5 ... More than one
 * unit may occupy the revetment as long as the total size is less than the
 * size of the revetment." The counters fill it in id order, as they do an
 * entrenchment, so both players read the same answer.
 */
const shelteredByRevetment = (state: GameState, u: ConventionalUnit, where: Hex): boolean => {
  const room = (state.revetments ?? {})[key(where)] ?? 0;
  if (room <= 0) return false;
  let used = 0;
  for (const other of Object.values(state.units).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (other.kind !== 'unit' || other.destroyed || other.offMap) continue;
    if (other.ridingOn != null) continue;
    if (!(other.pos.q === where.q && other.pos.r === where.r)) continue;
    const size = unitClass(other.classId).size;
    if (other.id === u.id) return used + size <= room;
    used += size;
  }
  return false;
};

/** The revetment in a hex, and how much it shelters: 0 when there is none. */
export const revetmentAt = (state: GameState, h: Hex): number =>
  (state.revetments ?? {})[key(h)] ?? 0;

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
  // "one 4/2 gun on each of the train counters ... the train will have 8
  // attacks, each with a strength of 4 and range of 2, per turn" (9.03.1). The
  // guns fire separately, like squads, so `ref.squads` picks how many.
  if (cls.mobility === 'rail' && (u.trainGuns ?? 0) > 0) {
    const guns = Math.max(1, Math.min(u.trainGuns!, ref.squads ?? u.trainGuns!));
    return TRAIN_GUN.attack * guns;
  }
  if (ref.heavyWeapon) return HEAVY_WEAPON.attack;
  // "The Superheavy also has two antipersonnel weapons. These function exactly
  // like Ogre AP weapons" (3.01) — one attack of strength equal to the number
  // of guns, since "any number of AP weapons may be used for that single
  // attack" (7.05.1).
  if (ref.antipersonnel) return u.sheet ? u.sheet.ap : (cls.ap ?? 0);
  if (cls.kind === 'infantry') {
    const squads = Math.max(1, Math.min(u.squads, ref.squads ?? u.squads));
    return cls.attack * squads;
  }
  // "A unit with an asterisk after its attack strength may divide that strength
  // into two equal attacks" (7.02).
  if (ref.halfAttack && cls.splitAttack) return printedAttack(u) / 2;
  return printedAttack(u);
};

export const attackerRange = (u: Unit, ref: { weapon?: string; heavyWeapon?: boolean }): number => {
  if (isOgre(u)) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    return w ? OGRE_WEAPONS[w.kind].range : 0;
  }
  if (ref.heavyWeapon) return HEAVY_WEAPON.range;
  const cls = unitClass(u.classId);
  if (cls.mobility === 'rail' && (u.trainGuns ?? 0) > 0) return TRAIN_GUN.range;
  return cls.range;
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
export const movementAllowance = (
  u: Unit,
  phase: Phase,
  options?: Pick<GameOptions, 'lowGravity' | 'noHover'>,
): number => {
  // Orbital Drop §5: on an asteroid, everything that moves gets one more
  // point, and nothing that hovers moves at all.
  const gravityBonus = options?.lowGravity ? 1 : 0;
  if (isOgre(u)) {
    if (u.stuck) return 0;
    if (phase === 'gevMovement') return 0;
    const base = movementForTreads(ogreType(u.typeId), u.treads);
    return base > 0 ? base + gravityBonus : 0;
  }
  if (u.stuck || u.disabled !== 'none') return 0;
  const cls = unitClass(u.classId);
  if (options?.noHover && cls.mobility === 'gev') return 0;
  // A Superheavy on its record sheet (13.07) moves on the move track printed
  // against its tread units: 3, then 2, 1, 0 as they are shot away.
  if (u.sheet && phase === 'movement') {
    const move = superheavyMove(u.sheet.treads);
    return move > 0 ? move + gravityBonus : 0;
  }
  // The train runs at its speed marker, not a printed allowance (9.02).
  // "M4/5, for instance, means that the train will move forward either 4 or 5
  // hexes (as the owning player chooses)." (9.02) The allowance is the faster
  // reading; `planPath` holds it to the slower one as a minimum.
  if (cls.mobility === 'rail') {
    return phase === 'gevMovement' ? 0 : trainTopSpeed(u.trainSpeed ?? 0);
  }
  if (phase === 'gevMovement') return cls.secondMove ?? 0;
  return cls.move > 0 ? cls.move + gravityBonus : 0;
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
    if (rider.destroyed) continue;
    // Cargo goes with its carrier: the Vulcan's hold "will survive as long as
    // the Ogre does" (15.02.1), and no longer.
    if (rider.kind === 'unit' && (rider.ridingOn === id || rider.stowedIn === id)) {
      next = destroyUnit(next, rider.id, `lost with the ${unitName(u)}`, credit);
    } else if (rider.towedBy === id) {
      // A tow rope is not a coffin: the hitch simply lets go (15.04.8).
      next = withUnit(next, { ...rider, towedBy: undefined } as Unit);
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
