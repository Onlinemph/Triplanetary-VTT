/**
 * Movement: what a unit may enter, what it costs, and what the ground does to
 * it on the way in.
 *
 * Section 5 of the rules is five terrain tables stacked on top of each other,
 * plus three rules that cut across all of them — the road bonus (5.07.1), the
 * minimum move (5.09), and stacking (5.02). Those three are what make movement
 * a path problem rather than a per-hex problem, so the unit of work here is a
 * whole path: `applyMove` takes the sequence of hexes a unit enters and either
 * accepts all of it or none of it.
 */

import { type Hex, distance, eq, key, neighbors, toOffset } from './hex.js';
import {
  type GameMap,
  inBounds,
  isRouteHex,
  routeBetween,
  sideFeatureBetween,
  terrainAt,
} from './map.js';
import { rollDie } from './rng.js';
import { type Route, entryCost, gevWaterlineStops, sideCrossing } from './terrain.js';
import { oddsFor, resolve } from './crt.js';
import { applyDamageToUnit } from './combat.js';
import { unitClass } from './units.js';
import {
  type ConventionalUnit,
  type GameState,
  type Phase,
  type PlayerId,
  type Unit,
  type UnitId,
  isOgre,
  isPallet,
  onBoard,
  passengersOf,
  ridingSomething,
  unitsAt,
} from './types.js';
import {
  apRemaining,
  defenseOf,
  destroyUnit,
  log,
  movementAllowance,
  reduceSquad,
  unitName,
  updateAnyUnit,
  withUnit,
} from './state.js';
import { mobilityOf } from './mobility.js';
import { advanceDrones, pushCheck } from './drone.js';

// ---------------------------------------------------------------------------
// Stacking
// ---------------------------------------------------------------------------

/**
 * How full a hex is, in "vehicles", counting one side only.
 *
 * "up to five vehicles **on each side** may occupy any hex ... Each single
 * squad of infantry counts as 1/3 of a vehicle for stacking purposes; that is,
 * a hex may hold 15 squads of infantry, or 12 squads of infantry and one
 * vehicle" (5.02.2). With a limit of 1 — the original Ogre map — the same
 * arithmetic reproduces 5.02.1 exactly: one vehicle, *or* three squads of
 * infantry, and not both.
 *
 * The limit being per side is what lets an Ogre stand in a hex with the enemy
 * infantry it has just driven over (6.06) or the tank it disabled by ramming
 * (6.08), both of which the rules describe happening in a full hex.
 *
 * "Ogres and CPs count as individual vehicles for stacking. The train and its
 * contents do not count for stacking, nor do buildings."
 */
export const hexLoad = (state: GameState, h: Hex, side?: PlayerId, ignore?: UnitId): number => {
  let load = 0;
  for (const u of Object.values(state.units)) {
    if (!onBoard(u) || u.id === ignore) continue;
    if (side !== undefined && u.owner !== side) continue;
    if (!eq(u.pos, h)) continue;
    if (u.kind === 'unit' && unitClass(u.classId).kind === 'infantry') load += u.squads / 3;
    else load += 1;
  }
  return load;
};

export const wouldOverstack = (
  state: GameState,
  h: Hex,
  mover: Unit,
  carriedSquads = 0,
): boolean => {
  // "The train does not count against stacking limits." (9.02.3)
  if (mover.kind === 'unit' && unitClass(mover.classId).mobility === 'rail') return false;
  const own =
    mover.kind === 'unit' && unitClass(mover.classId).kind === 'infantry'
      ? mover.squads / 3
      : 1 + carriedSquads / 3;
  // Rounded to avoid 1/3 + 1/3 + 1/3 > 1 in binary floating point.
  const load = hexLoad(state, h, mover.owner, mover.id);
  return Math.round((load + own) * 1000) / 1000 > state.options.stackingLimit;
};

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

export interface StepInfo {
  readonly ok: boolean;
  readonly cost: number;
  readonly reason?: string;
  /** The train ran onto cut track and is lost with the step (9.02.4). */
  readonly derails?: boolean;
  /** The train ran into units standing on the track (9.06). */
  readonly collides?: boolean;
  /** The step is along a road or railroad link (2.03.1), so terrain is ignored. */
  readonly onRoute: boolean;
  /** The road bonus is available for this kind of unit on this kind of route (5.07.3). */
  readonly bonusEligible: boolean;
  /** "It ends its movement for the turn when it enters such a hex." */
  readonly endsMovement: boolean;
  readonly hazard: null | 'disable' | 'stuck';
  /** The crossing is only legal as the unit's first step of the phase (5.08.4). */
  readonly requiresPhaseStart: boolean;
  /** An Ogre or Superheavy walking into infantry (6.06) rather than ramming. */
  readonly reducesInfantry: boolean;
}

const deny = (reason: string): StepInfo => ({
  ok: false,
  cost: 0,
  reason,
  onRoute: false,
  bonusEligible: false,
  endsMovement: false,
  hazard: null,
  requiresPhaseStart: false,
  reducesInfantry: false,
});

/**
 * Which units may take the extra hex, on which kind of route.
 *
 * "The road has the same effect on all mobile units, regardless of type"
 * (5.07) — with two exceptions the rules spell out. A Truck "does not get a
 * road bonus" (5.08.5), and on rails "GEVs and infantry, but no other units,
 * may take the road bonus along rail hexes" (5.07.3).
 */
const bonusEligibleFor = (unit: Unit, route: Route): boolean => {
  const mobility = mobilityOf(unit);
  if (mobility === 'wheeled' || mobility === 'rail') return false;
  if (route === 'rail') return mobility === 'gev' || mobility === 'infantry';
  return true;
};

export const stepInfo = (
  state: GameState,
  map: GameMap,
  unit: Unit,
  from: Hex,
  to: Hex,
): StepInfo => {
  if (distance(from, to) !== 1) return deny('units move one hex at a time');
  if (!inBounds(map, to)) {
    // "It takes 1 movement to leave the map." (5.12)
    return {
      ok: true,
      cost: 1,
      onRoute: false,
      bonusEligible: false,
      endsMovement: true,
      hazard: null,
      requiresPhaseStart: false,
      reducesInfantry: false,
    };
  }

  const mobility = mobilityOf(unit);
  const route = routeBetween(map, from, to, state.routesCut, state.bridgesDown);
  const side = sideFeatureBetween(map, from, to, state.sideOverrides);
  const fromTerrain = terrainAt(map, from, state.terrainOverrides);
  const toTerrain = terrainAt(map, to, state.terrainOverrides);

  // Craters are impassable whatever the route (2.01.2); a road does not pave
  // over a crater.
  if (toTerrain === 'crater') return deny('craters are impassable');

  // "The train moves only along railroad hexes" (9.01): every step is a rail
  // link. Where the rails are there but cut, it does not stop — "If the train
  // moves into a hex where the rails are cut, it is destroyed" (9.02.4).
  if (mobility === 'rail' && route !== 'rail') {
    const laid = routeBetween(map, from, to);
    if (laid !== 'rail') return deny('the train keeps to the rails');
    return {
      ok: true,
      cost: 1,
      onRoute: true,
      bonusEligible: false,
      endsMovement: true,
      hazard: null,
      requiresPhaseStart: false,
      reducesInfantry: false,
      derails: true,
    };
  }

  const crossing = sideCrossing(side, mobility, route !== undefined);
  if (!crossing.allowed) return deny(crossing.reason ?? 'that hexside is impassable');

  const terrainEntry = entryCost(toTerrain, mobility);
  if (route === undefined && terrainEntry.cost === null) {
    return deny(terrainEntry.reason ?? 'that hex is impassable to this unit');
  }

  // --- Enemy occupancy ---------------------------------------------------
  const occupants = unitsAt(state, to).filter((u) => u.owner !== unit.owner);
  let reducesInfantry = false;
  if (occupants.length > 0) {
    const anyArmed = occupants.some((u) => attackStrengthOf(u) > 0);
    const allInfantry = occupants.every(
      (u) => u.kind === 'unit' && unitClass(u.classId).kind === 'infantry',
    );
    const canWalkThroughInfantry =
      allInfantry &&
      ((isOgre(unit) && apRemaining(unit) > 0) ||
        // On its record sheet (13.07) the Superheavy needs an AP weapon left.
        (unit.kind === 'unit' && unit.classId === 'SHVY' && (unit.sheet?.ap ?? 1) > 0));

    if (mobility === 'rail') {
      // "If the train moves onto a unit on the track ..." (9.06) — it does not
      // stop and it does not go round; something gives.
      return {
        ok: true,
        cost: 1,
        onRoute: true,
        bonusEligible: false,
        endsMovement: true,
        hazard: null,
        requiresPhaseStart: false,
        reducesInfantry: false,
        collides: true,
      };
    }
    if (canWalkThroughInfantry) {
      // 6.06: not a ram, and it does not count against the ramming limit.
      reducesInfantry = true;
    } else if (anyArmed) {
      return deny(
        state.options.overrunCombat
          ? 'that hex is held by the enemy — overrun it, or go around'
          : 'that hex is held by the enemy — ram it, or go around',
      );
    }
    // "Units may move through a hex occupied by an enemy unit only if that
    // enemy has no attack strength (for instance, a CP, or the train)." (5.03)
  }

  // --- Cost --------------------------------------------------------------
  // "Units which enter a hex on the road may ignore any movement penalties for
  // the underlying terrain." (2.03.1)
  const cost = route !== undefined ? 1 : terrainEntry.cost!;
  const endsMovement = route !== undefined ? false : terrainEntry.endsMovement;
  const hazard = route !== undefined || terrainEntry.hazard === 'none' ? null : terrainEntry.hazard;

  // A GEV's waterline works exactly like a stream (5.08.2).
  const waterline =
    mobility === 'gev' && route === undefined && gevWaterlineStops(fromTerrain, toTerrain, side);

  return {
    ok: true,
    cost,
    onRoute: route !== undefined,
    bonusEligible: route !== undefined && bonusEligibleFor(unit, route),
    endsMovement,
    hazard,
    requiresPhaseStart: crossing.requiresPhaseStart || waterline,
    reducesInfantry,
  };
};

/** A unit's attack strength for the "may I move through it?" test in 5.03. */
const attackStrengthOf = (u: Unit): number => {
  if (isOgre(u)) return u.weapons.some((w) => !w.destroyed) ? 1 : 0;
  return unitClass(u.classId).attack;
};

// ---------------------------------------------------------------------------
// Whole paths
// ---------------------------------------------------------------------------

export interface PathPlan {
  readonly ok: boolean;
  readonly reason?: string;
  readonly totalCost: number;
  /** Allowance actually available, including any road bonus earned (5.07.1). */
  readonly budget: number;
  readonly steps: readonly StepInfo[];
  /**
   * A legal path that is shorter than the train's marker (9.02): physically
   * fine, but not a distance the train may stop at. The search walks through
   * such a hex without offering it, and the reducer refuses it.
   */
  readonly tooShort?: boolean;
  /** True when the unit walks off the board on the last step (5.12). */
  readonly exits: boolean;
  readonly endsMovement: boolean;
  readonly stillOnRoute: boolean;
}

/**
 * Cost and legality of a whole path, without applying it.
 *
 * The road bonus can only be judged here: "Any unit which starts its move on
 * the road, stays on the road for the entire movement phase, and does not ram
 * or overrun, gets a movement bonus of one additional hex" (5.07.1). A unit may
 * issue several move commands in a phase, so the "entire phase" part is carried
 * on the unit as `onRouteAllPhase` and narrowed here, never widened.
 */
export const planPath = (
  state: GameState,
  map: GameMap,
  unit: Unit,
  path: readonly Hex[],
): PathPlan => {
  const phase = state.phase;
  const allowance = movementAllowance(unit, phase, state.options);
  const empty: PathPlan = {
    ok: false,
    totalCost: 0,
    budget: allowance,
    steps: [],
    exits: false,
    endsMovement: false,
    stillOnRoute: unit.onRouteAllPhase,
  };

  if (path.length === 0) return { ...empty, reason: 'no path given' };
  if (allowance <= 0) {
    return { ...empty, reason: unit.stuck ? 'this unit is stuck' : 'this unit cannot move now' };
  }
  if (unit.movementEnded) {
    return { ...empty, reason: 'this unit has already ended its movement for the turn' };
  }

  const carried = unit.kind === 'unit' ? passengersOf(state, unit.id).length : 0;
  const steps: StepInfo[] = [];
  let from = unit.pos;
  let cost = 0;
  let ends = false;
  let exits = false;
  // The bonus needs the unit to have begun the phase on a road (5.07.1).
  let onRoute = unit.onRouteAllPhase && isRouteHex(map, unit.phaseStart);
  let bonusEligible = onRoute;

  for (let i = 0; i < path.length; i++) {
    const to = path[i]!;
    if (ends) return { ...empty, steps, reason: 'this unit had to stop before that hex' };

    const info = stepInfo(state, map, unit, from, to);
    if (!info.ok) return { ...empty, steps, reason: info.reason };

    if (info.requiresPhaseStart && !(unit.moveUsed === 0 && i === 0 && eq(from, unit.phaseStart))) {
      return {
        ...empty,
        steps,
        reason: 'this crossing must be the first step of a movement phase',
      };
    }

    steps.push(info);
    cost += info.cost;
    if (!info.onRoute) onRoute = false;
    if (!info.bonusEligible) bonusEligible = false;
    if (info.endsMovement) ends = true;
    if (!inBounds(map, to)) {
      exits = true;
      ends = true;
    }
    from = to;
  }

  const budget = allowance + (onRoute && bonusEligible ? 1 : 0);
  const spent = unit.moveUsed + cost;

  // "the train must move one of the two distances shown by the counter on it
  // at the beginning of the turn" (9.02) — so it may not creep. Flagged rather
  // than refused here, so the reachability search can walk on past the hex.
  let tooShort = false;
  if (mobilityOf(unit) === 'rail' && !exits) {
    const marker = unit.kind === 'unit' ? (unit.trainSpeed ?? 0) : 0;
    const derailed = steps.some((st) => st.derails === true);
    tooShort = !derailed && marker > 0 && spent < marker;
  }

  // "Regardless of other terrain effects, any unit which is capable of moving
  // at all may move one hex per turn, as long as it is not moving into totally
  // prohibited terrain." (5.09)
  const minimumMove = unit.moveUsed === 0 && path.length === 1;

  if (spent > budget && !minimumMove) {
    return {
      ...empty,
      steps,
      reason: `that path costs ${cost}; only ${budget - unit.moveUsed} left`,
    };
  }

  if (!exits && wouldOverstack(state, path[path.length - 1]!, unit, carried)) {
    return { ...empty, steps, reason: 'that hex is full' };
  }

  return {
    ok: true,
    totalCost: cost,
    budget,
    steps,
    exits,
    endsMovement: ends,
    stillOnRoute: onRoute,
    ...(tooShort ? { tooShort: true } : {}),
  };
};

/** Apply a validated path, moving the unit and any infantry riding it. */
export const applyMove = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  path: readonly Hex[],
): { state: GameState; plan: PathPlan } => {
  const unit = state.units[unitId];
  if (!unit) {
    return {
      state,
      plan: {
        ok: false,
        reason: 'no such unit',
        totalCost: 0,
        budget: 0,
        steps: [],
        exits: false,
        endsMovement: false,
        stillOnRoute: false,
      },
    };
  }

  const plan = planPath(state, map, unit, path);
  if (!plan.ok) return { state, plan };
  if (plan.tooShort === true) {
    const marker = unit.kind === 'unit' ? (unit.trainSpeed ?? 0) : 0;
    return {
      state,
      plan: {
        ...plan,
        ok: false,
        reason: `the train runs ${String(marker)} or ${String(marker + 1)} hexes, not ${String(plan.totalCost)}`,
      },
    };
  }

  let next = state;
  const dest = path[path.length - 1]!;

  // 6.06 applies once per hex entered, not once per path.
  for (let i = 0; i < path.length; i++) {
    if (!plan.steps[i]!.reducesInfantry) continue;
    const victims = unitsAt(next, path[i]!).filter((u) => u.owner !== unit.owner);
    const victim = victims[0];
    if (victim) {
      next = reduceSquad(next, victim.id, 'crushed by an Ogre', unit.owner);
      next = log(
        next,
        'bad',
        `${unitName(unit)} rolls over ${unitName(victim)}, reducing it by a squad.`,
        [path[i]!],
      );
    }
  }

  const hazard = plan.steps.reduce<null | 'disable' | 'stuck'>((acc, s) => s.hazard ?? acc, null);

  // "The owner of any unit in a rail hex may declare that unit to be on the
  // track ... If the train moves onto a unit on the track" (9.06), the train
  // and whatever is standing there settle it between them.
  const hitAt = plan.steps.findIndex((s) => s.collides === true);
  if (hitAt >= 0) {
    return { state: collide(next, map, unitId, path, hitAt), plan };
  }

  // "If the train moves into a hex where the rails are cut, it is destroyed."
  // (9.02.4) It gets there — the wreck is in the hex — and then it is gone.
  const derailAt = plan.steps.findIndex((s) => s.derails === true);
  if (derailAt >= 0) {
    const wreckAt = path[derailAt]!;
    next = updateAnyUnit(next, unitId, () => ({
      pos: wreckAt,
      moveUsed: unit.moveUsed + derailAt + 1,
      movementEnded: true,
    }));
    for (const rider of passengersOf(next, unitId)) {
      next = updateAnyUnit(next, rider.id, () => ({ pos: wreckAt }));
    }
    next = log(next, 'bad', `${unitName(unit)} runs onto cut track at ${key(wreckAt)}.`, [wreckAt]);
    next = destroyUnit(next, unitId, 'derailed on cut track');
    return { state: next, plan };
  }

  if (plan.exits) {
    const edge = exitEdge(map, unit.pos, dest);
    next = updateAnyUnit(next, unitId, () => ({
      offMap: edge,
      moveUsed: unit.moveUsed + plan.totalCost,
    }));
    for (const rider of passengersOf(next, unitId)) {
      next = updateAnyUnit(next, rider.id, () => ({ offMap: edge }));
    }
    return {
      state: log(next, 'info', `${unitName(unit)} leaves the map by the ${edge} edge.`, [unit.pos]),
      plan,
    };
  }

  next = updateAnyUnit(next, unitId, (u) => ({
    pos: dest,
    moveUsed: u.moveUsed + plan.totalCost,
    onRouteAllPhase: plan.stillOnRoute,
    movementEnded: u.movementEnded || plan.endsMovement,
    pendingHazard: hazard ?? u.pendingHazard,
  }));

  // Riders travel with the vehicle; they have no movement of their own.
  for (const rider of passengersOf(next, unitId)) {
    next = updateAnyUnit(next, rider.id, () => ({ pos: dest }));
  }

  return { state: next, plan };
};

const exitEdge = (map: GameMap, from: Hex, to: Hex): 'north' | 'south' | 'east' | 'west' => {
  const o = toOffset(to);
  if (o.row < 1) return 'north';
  if (o.row > map.rows) return 'south';
  if (o.col < 1) return 'west';
  if (o.col > map.cols) return 'east';
  // Diagonal exits off a corner: name the edge the unit was heading for.
  return toOffset(from).row < map.rows / 2 ? 'north' : 'south';
};

// ---------------------------------------------------------------------------
// Reachability, for the interface
// ---------------------------------------------------------------------------

/**
 * A train meeting units standing on the line (9.06).
 *
 * "(a) If the enemy units are armed, even the weakest armed unit would be able
 * to cut the tracks in front of the train as it approached. The train is
 * destroyed. If the train is moving at speed 5 or better, the wrecked train
 * may still strike the enemy units. Roll a 1-1 attack on every unit except
 * infantry. Otherwise, the enemy units are unaffected. (b) If the enemy units
 * are unarmed, the train collides with them. Roll a single attack on the train
 * with an attack strength equal to the combined Size of the enemy units. The
 * enemy units are destroyed."
 */
const collide = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  path: readonly Hex[],
  at: number,
): GameState => {
  const train = state.units[unitId];
  const where = path[at]!;
  if (!train) return state;
  const standing = unitsAt(state, where).filter((u) => u.owner !== train.owner);
  const armed = standing.some((u) => u.kind === 'unit' && unitClass(u.classId).attack > 0);
  const marker = train.kind === 'unit' ? (train.trainSpeed ?? 0) : 0;
  let next = state;

  if (armed) {
    next = log(
      next,
      'bad',
      `${unitName(train)} runs into the guns at ${key(where)} and the track goes with it.`,
      [where],
    );
    // "If the train is moving at speed 5 or better, the wrecked train may
    // still strike the enemy units."
    if (marker + 1 >= 5) {
      for (const victim of standing) {
        if (victim.kind === 'unit' && unitClass(victim.classId).kind === 'infantry') continue;
        next = trainWreckAttack(next, map, victim.id, 1, train.owner);
      }
    }
    return destroyUnit(next, unitId, 'wrecked on the guns', standing[0]?.owner);
  }

  // Unarmed: the train goes through them, and pays for it.
  const combinedSize = standing.reduce(
    (n, u) => n + (u.kind === 'unit' ? unitClass(u.classId).size : 0),
    0,
  );
  for (const victim of standing) {
    next = destroyUnit(next, victim.id, 'run down by the train', train.owner);
  }
  next = log(
    next,
    'warn',
    `${unitName(train)} ploughs through ${key(where)} — a strength ${String(combinedSize)} collision.`,
    [where],
  );
  const hitBy = standing[0]?.owner;
  if (combinedSize > 0 && hitBy !== undefined) {
    next = trainWreckAttack(next, map, unitId, combinedSize, hitBy);
  }
  const alive = next.units[unitId];
  if (alive && onBoard(alive)) {
    next = updateAnyUnit(next, unitId, () => ({ pos: where, movementEnded: true }));
    for (const rider of passengersOf(next, unitId)) {
      next = updateAnyUnit(next, rider.id, () => ({ pos: where }));
    }
  }
  return next;
};

/** One collision attack, resolved on the Combat Results Table like any other. */
const trainWreckAttack = (
  state: GameState,
  map: GameMap,
  victimId: UnitId,
  strength: number,
  credit: PlayerId,
): GameState => {
  const victim = state.units[victimId];
  if (!victim || !onBoard(victim)) return state;
  const odds = oddsFor(strength, defenseOf(state, map, victim));
  if (odds.kind === 'none') return state;
  const die = rollDie(state.rng);
  let next: GameState = { ...state, rng: die.state };
  const result = odds.kind === 'auto' ? 'X' : resolve(odds, die.value, 'normal');
  if (result === 'NE') return next;
  next = log(
    next,
    'bad',
    `The collision ${result === 'X' ? 'wrecks' : 'shakes'} ${unitName(victim)}.`,
    [victim.pos],
  );
  return applyDamageToUnit(next, victimId, result, credit);
};

export interface Reach {
  readonly hex: Hex;
  readonly cost: number;
  readonly path: readonly Hex[];
  readonly endsMovement: boolean;
  readonly hazard: null | 'disable' | 'stuck';
  /** A hex a train may run through but not stop in (9.02). */
  readonly tooShort?: boolean;
  /** Entering means a collision on the line (9.06), not an ordinary move. */
  readonly collides?: boolean;
}

/**
 * Every hex this unit can still reach this phase, with the cheapest path to it.
 *
 * The interface asks the engine rather than reimplementing the terrain tables;
 * this is the only place the two could ever disagree, and it does not, because
 * it walks the same {@link stepInfo}.
 */
export const reachable = (state: GameState, map: GameMap, unit: Unit): Reach[] => {
  // "any infantry squad can move a LAD pallet one hex per turn" (14.01): a
  // pallet has no movement of its own, so its neighbours are its whole reach.
  if (isPallet(unit)) {
    return neighbors(unit.pos)
      .filter((n) => pushCheck(state, map, unit, n) === null)
      .map((n) => ({ hex: n, cost: 1, path: [n], endsMovement: true, hazard: null }));
  }

  const allowance = movementAllowance(unit, state.phase, state.options);
  if (allowance <= 0 || unit.movementEnded) return [];

  const best = new Map<string, Reach>();
  const start: Reach = { hex: unit.pos, cost: 0, path: [], endsMovement: false, hazard: null };
  best.set(key(unit.pos), start);

  const queue: Reach[] = [start];
  while (queue.length > 0) {
    // Cheapest-first, so the first path found to a hex is the cheapest.
    queue.sort((a, b) => a.cost - b.cost);
    const here = queue.shift()!;
    if (here.endsMovement) continue;

    for (const n of neighbors(here.hex)) {
      if (!inBounds(map, n)) continue;
      const info = stepInfo(state, map, unit, here.hex, n);
      if (!info.ok) continue;
      if (info.requiresPhaseStart && !(unit.moveUsed === 0 && here.path.length === 0)) continue;

      const path = [...here.path, n];
      const plan = planPath(state, map, unit, path);
      if (!plan.ok) continue;

      // A train may pass through a hex it is not allowed to stop in (9.02):
      // keep searching from it, but do not offer it as a destination.
      const entry: Reach = {
        hex: n,
        cost: here.cost + info.cost,
        path,
        endsMovement: here.endsMovement || info.endsMovement,
        hazard: info.hazard ?? here.hazard,
        ...(plan.tooShort === true ? { tooShort: true } : {}),
        ...(info.collides === true ? { collides: true } : {}),
      };
      const prev = best.get(key(n));
      if (!prev || entry.cost < prev.cost) {
        best.set(key(n), entry);
        queue.push(entry);
      }
    }
  }

  best.delete(key(unit.pos));
  // A hex the mover may pass through but not stop in is not a destination.
  return [...best.values()].filter((r) => r.tooShort !== true);
};

// ---------------------------------------------------------------------------
// Phase machinery
// ---------------------------------------------------------------------------

/** Reset the per-phase movement bookkeeping for one player's units. */
export const beginMovementPhase = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  phase: Phase,
): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !onBoard(u)) continue;
    // "Move any or all GEVs again, except for those which are disabled or those
    // which entered town or swamp/rubble/forest on the first movement phase."
    // (4.02.5) — `movementEnded` carries that across from the first phase.
    const movementEnded = phase === 'gevMovement' ? u.movementEnded : false;
    next = updateAnyUnit(next, u.id, () => ({
      moveUsed: 0,
      phaseStart: u.pos,
      onRouteAllPhase: isRouteHex(map, u.pos),
      movementEnded,
      ...(phase === 'movement' ? { ramsThisTurn: 0, rammedOgreThisTurn: false } : {}),
      // "may not ... mount and dismount on the same turn" (5.11.3) is about
      // one turn: a rider that mounted last turn may get off this one.
      ...(phase === 'movement' && u.kind === 'unit' ? { mountedThisTurn: false } : {}),
      ...(phase === 'movement' && u.kind === 'unit' && u.trainSpeed !== undefined
        ? { trainSpeedSet: false }
        : {}),
    }));
  }
  return next;
};

/**
 * Step 3 of the turn sequence: "Roll for each armor unit which entered swamp or
 * rubble, and each GEV which entered swamp/rubble/forest, to check whether it
 * is stuck or disabled, as appropriate for the terrain." (4.02)
 *
 * The roll is deferred to the end of the movement phase rather than made on
 * entry, which matters: a player commits every unit's move before learning
 * which of them bogged down.
 */
export const resolvePendingHazards = (state: GameState, player: PlayerId): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !onBoard(u) || !u.pendingHazard) continue;
    const roll = rollDie(next.rng);
    next = { ...next, rng: roll.state };
    const bogged = roll.value <= 2;

    if (!bogged) {
      next = updateAnyUnit(next, u.id, () => ({ pendingHazard: null }));
      continue;
    }

    if (u.pendingHazard === 'stuck') {
      next = updateAnyUnit(next, u.id, () => ({ pendingHazard: null, stuck: true }));
      next = log(next, 'bad', `${unitName(u)} is stuck fast in the swamp (rolled ${roll.value}).`, [
        u.pos,
      ]);
    } else {
      next = updateAnyUnit(next, u.id, () => ({ pendingHazard: null }));
      next = withUnit(next, {
        ...(next.units[u.id] as ConventionalUnit),
        disabled: 'terrain',
      });
      next = log(next, 'warn', `${unitName(u)} bogs down and is disabled (rolled ${roll.value}).`, [
        u.pos,
      ]);
    }
  }
  return next;
};

/**
 * Phase 1: "Recovery."
 *
 * (a) "All the player's units which were disabled before the last enemy turn by
 * ramming or enemy fire now recover automatically."
 *
 * (b) "Roll one die for each of his units disabled by forest, rubble, or swamp,
 * regardless of how long it has been disabled ... On a roll of 1 or 2, the unit
 * remains disabled. On a 3 to 6, the unit recovers."
 *
 * The ordinal test in (a) is exactly what 7.11 spells out at length: a unit
 * disabled on an enemy turn sits out its own next turn as well, while one
 * disabled on its own turn by ramming is back for the next.
 */
export const runRecovery = (state: GameState, player: PlayerId, ordinal: number): GameState => {
  // "Turn 3: The LAD can fire." (14.01)
  let next = advanceDrones(state, player);
  for (const u of Object.values(state.units)) {
    if (u.kind !== 'unit' || u.owner !== player || !onBoard(u)) continue;

    if (u.disabled === 'combat') {
      if (u.disabledAt <= ordinal - 2) {
        next = updateAnyUnit(next, u.id, () => ({ disabled: 'none', disabledAt: -1 }));
        next = log(next, 'good', `${unitName(u)} recovers and is back in action.`, [u.pos]);
      }
      continue;
    }

    if (u.disabled === 'terrain') {
      const roll = rollDie(next.rng);
      next = { ...next, rng: roll.state };
      if (roll.value >= 3) {
        next = updateAnyUnit(next, u.id, () => ({ disabled: 'none', disabledAt: -1 }));
        next = log(next, 'good', `${unitName(u)} works itself free (rolled ${roll.value}).`, [
          u.pos,
        ]);
      }
    }
  }
  return next;
};

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * "To mount a vehicle, an infantry squad must spend its entire movement for the
 * turn. The vehicle may either start in the infantry's starting hex or pass
 * through it." (5.11.3)
 */
export const canMount = (
  state: GameState,
  rider: Unit,
  carrier: Unit,
): { ok: boolean; reason?: string } => {
  // Infantry ride (5.11); so does the Light Artillery Drone, palletised, as
  // one squad's worth of room (14.01).
  if (
    rider.kind !== 'unit' ||
    (unitClass(rider.classId).kind !== 'infantry' && rider.classId !== 'LAD')
  ) {
    return { ok: false, reason: 'only infantry and the drone ride' };
  }
  // "it can be transported collapsed as a single cargo pallet" — and only
  // collapsed. "A LAD that is set up may not be moved." (14.01)
  if (rider.classId === 'LAD' && rider.droneState !== 'pallet') {
    return { ok: false, reason: 'a drone that is set up may not be moved (14.01)' };
  }
  if (ridingSomething(rider)) return { ok: false, reason: 'already aboard something' };
  if (carrier.kind !== 'unit') return { ok: false, reason: 'Ogres do not give lifts' };
  const capacity = unitClass(carrier.classId).carries ?? 0;
  if (capacity === 0)
    return { ok: false, reason: `a ${unitClass(carrier.classId).name} carries nobody` };
  if (rider.owner !== carrier.owner) return { ok: false, reason: 'that is not your vehicle' };
  if (!eq(rider.pos, carrier.pos)) return { ok: false, reason: 'the vehicle is not in this hex' };
  const aboard = passengersOf(state, carrier.id).reduce((n, p) => n + p.squads, 0);
  if (aboard + rider.squads > capacity) return { ok: false, reason: 'no room aboard' };
  if (rider.moveUsed > 0) return { ok: false, reason: 'mounting costs the whole movement phase' };
  return { ok: true };
};

/**
 * "The infantry may dismount in any hex of the vehicle's movement on any turn
 * thereafter, but may not move 'on its own' on the turn it dismounts, or mount
 * and dismount on the same turn." (5.11.3)
 */
export const canDismount = (rider: Unit): { ok: boolean; reason?: string } => {
  if (rider.kind !== 'unit' || !rider.ridingOn) return { ok: false, reason: 'not aboard anything' };
  if (rider.mountedThisTurn) return { ok: false, reason: 'mounted this turn already' };
  return { ok: true };
};
