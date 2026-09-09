/**
 * The train as Section 9 prints it: two counters, coupled.
 *
 * > "A standard train is made up of two counters, so it takes up two hexes
 * > (this is a long train!). The train's defense strength is always 3. In some
 * > scenarios (9.03.1), the train may have an attack strength; otherwise it may
 * > not attack." (9.01)
 *
 * > "The two train counters are identical, and the train may go either
 * > direction. 'Front' and 'back' are always relative to the movement of the
 * > train." (9.02)
 *
 * So neither counter is the engine: whichever one the player drives becomes the
 * front for that move, and the other follows into the hex it vacates. Reversing
 * is simply ordering the other counter, which the M0/1 rule of 9.02.1 already
 * gates.
 *
 * The pair matters most when something shoots at it:
 *
 * > "Either counter of the train may be attacked. Only an X result affects the
 * > train. If an attack destroys the rear of the train (or either half of a
 * > train standing still), that counter is flipped to the destroyed side, but
 * > the other half of the train is not affected. If an attack destroys the
 * > front of a moving train, the whole train is destroyed ... If a train counter
 * > is destroyed, the rails in those hexes are considered cut." (9.03)
 *
 * A one-counter train is still a legal thing to have — "In an armed-train
 * scenario, the counters may separate. Each is then treated as a one-counter
 * train" (9.00) — so everything here reads `coupledTo` and does the simple
 * thing when it is absent.
 */

import { type Hex, eq, key } from './hex.js';
import { MAX_TRAIN_CARGO_SIZE, TRAIN_CARGO_PER_HALF, TRAIN_GUN, unitClass } from './units.js';
import {
  type ConventionalUnit,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitId,
  isOgre,
  onBoard,
  passengersOf,
  unitsAt,
} from './types.js';
import { cutRoute, destroyUnit, log, unitName, withUnit } from './state.js';

export { MAX_TRAIN_GUNS, TRAIN_CARGO_PER_HALF, TRAIN_GUN } from './units.js';

/**
 * A train counter. Deliberately not a type predicate: narrowing on it would
 * subtract every other conventional counter on the negative branch, which is
 * not what "this one is a train" means.
 */
export const isTrain = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'TRAIN';

/** The counter coupled to this one, if it is still there. */
export const otherHalf = (state: GameState, u: Unit): ConventionalUnit | null => {
  if (u.kind !== 'unit' || !u.coupledTo) return null;
  const other = state.units[u.coupledTo];
  return other && other.kind === 'unit' && onBoard(other) ? other : null;
};

/** Both counters of a train, front first if the roles are set. */
export const trainCounters = (state: GameState, u: Unit): ConventionalUnit[] => {
  if (!isTrain(u) || u.kind !== 'unit') return [];
  const other = otherHalf(state, u);
  if (!other) return [u];
  return u.trainHalf === 'rear' ? [other, u] : [u, other];
};

/**
 * "If an attack destroys the front of a moving train, the whole train is
 * destroyed." (9.03) A train on the M0/1 marker that did not move is standing
 * still, and then either half goes on its own.
 */
export const trainIsMoving = (u: Unit): boolean =>
  u.kind === 'unit' && ((u.trainSpeed ?? 0) > 0 || u.moveUsed > 0);

/** Guns on this counter (9.03.1); zero on an ordinary train. */
export const gunsOn = (u: Unit): number => (u.kind === 'unit' ? (u.trainGuns ?? 0) : 0);

/** "Unless the train is armed (9.03.1), enemy units may enter its hex freely." (9.02.3) */
export const trainIsArmed = (state: GameState, u: Unit): boolean =>
  isTrain(u) && (gunsOn(u) > 0 || gunsOn(otherHalf(state, u) ?? u) > 0);

/** The two counters of a train, or the one that is left, by id. */
export const halvesOf = (state: GameState, id: UnitId): ConventionalUnit[] => {
  const u = state.units[id];
  return u ? trainCounters(state, u) : [];
};

// ---------------------------------------------------------------------------
// Coupling and moving as a pair
// ---------------------------------------------------------------------------

/** Couple two counters into one train, for a scenario builder. */
export const couple = (state: GameState, frontId: UnitId, rearId: UnitId): GameState => {
  const front = state.units[frontId];
  const rear = state.units[rearId];
  if (!front || !rear || front.kind !== 'unit' || rear.kind !== 'unit') return state;
  if (!isTrain(front) || !isTrain(rear)) return state;
  let next = withUnit(state, { ...front, coupledTo: rearId, trainHalf: 'front' as const });
  next = withUnit(next, {
    ...rear,
    coupledTo: frontId,
    trainHalf: 'rear' as const,
    // "Each train gets one marker, placed on or beside the train as
    // convenient" (9.03): both counters read the same number.
    trainSpeed: front.trainSpeed ?? 0,
  });
  return next;
};

/**
 * Bring the rear counter up behind the front (9.02).
 *
 * The rear ends in the last hex the front passed through, which for a one-hex
 * move is where the front started. Whatever it was carrying comes with it.
 */
export const followWithRear = (
  state: GameState,
  frontId: UnitId,
  path: readonly Hex[],
  from: Hex,
): GameState => {
  const front = state.units[frontId];
  if (!front || front.kind !== 'unit' || !isTrain(front)) return state;
  const rear = otherHalf(state, front);
  if (!rear || path.length === 0) return state;

  const behind = path.length >= 2 ? path[path.length - 2]! : from;
  if (eq(rear.pos, behind)) return state;

  let next = withUnit(state, {
    ...rear,
    pos: behind,
    trainHalf: 'rear' as const,
    movementEnded: true,
  });
  // Whichever counter was driven is the front from now on (9.02).
  next = withUnit(next, {
    ...(next.units[frontId] as ConventionalUnit),
    trainHalf: 'front' as const,
  });
  for (const rider of passengersOf(next, rear.id)) {
    next = withUnit(next, { ...rider, pos: behind });
  }
  return next;
};

/**
 * The rear is not driven; it is dragged. Ordering it instead of the front is
 * how a train reverses, and that only makes it the new front (9.02).
 */
export const trainMoveCheck = (state: GameState, u: Unit): string | null => {
  if (u.kind !== 'unit' || !isTrain(u)) return null;
  const other = otherHalf(state, u);
  if (!other) return null;
  // "if it was 0/1, it may either go to 2/3 in the same direction, or 0/1 in
  // the reverse direction" (9.02.1): reversing needs the slowest marker.
  const marker = markerOf(state, u);
  if (u.trainHalf === 'rear' && marker > 0) {
    return 'a train only reverses on the M0/1 marker (9.02.1)';
  }
  return null;
};

/**
 * The marker a counter runs on. Both halves carry the same number, but a
 * counter that somehow lost it reads its partner's.
 */
export const markerOf = (state: GameState, u: Unit): number => {
  if (u.kind !== 'unit') return 0;
  return u.trainSpeed ?? otherHalf(state, u)?.trainSpeed ?? 0;
};

// ---------------------------------------------------------------------------
// 9.03 Attacks on the train
// ---------------------------------------------------------------------------

/**
 * Take a train counter off the board (9.03).
 *
 * "If an attack destroys the rear of the train (or either half of a train
 * standing still), that counter is flipped to the destroyed side, but the other
 * half of the train is not affected. If an attack destroys the front of a
 * moving train, the whole train is destroyed ... If a train counter is
 * destroyed, the rails in those hexes are considered cut."
 */
export const destroyTrainCounter = (
  state: GameState,
  id: UnitId,
  cause: string,
  credit?: PlayerId,
): GameState => {
  const hit = state.units[id];
  if (!hit || hit.kind !== 'unit' || !isTrain(hit) || hit.destroyed) return state;

  const wholeTrain = hit.trainHalf === 'front' && trainIsMoving(hit);
  const going = wholeTrain ? trainCounters(state, hit) : [hit];

  let next = state;
  for (const counter of going) {
    if (counter.destroyed) continue;
    next = destroyUnit(next, counter.id, cause, credit);
    // "If a train counter is destroyed, the rails in those hexes are considered
    // cut; this may matter for victory points."
    next = cutRoute(next, counter.pos);
  }
  // The survivor is a one-counter train from here (9.00).
  const partner = otherHalf(next, hit);
  if (partner && !wholeTrain) {
    next = withUnit(next, {
      ...partner,
      coupledTo: undefined,
      trainHalf: undefined,
      // "Each train gets one marker": the survivor keeps or inherits it.
      trainSpeed: partner.trainSpeed ?? hit.trainSpeed ?? 0,
    });
    next = log(next, 'warn', `The ${hit.trainHalf ?? 'train'} counter is a wreck on the line.`, [
      hit.pos,
    ]);
  } else if (wholeTrain) {
    next = log(next, 'bad', `${unitName(hit)} is destroyed: the front went at speed.`, [hit.pos]);
  }
  return next;
};

/**
 * "If an unarmed train overruns, or is overrun by, a unit with a regular combat
 * strength, it is destroyed. Even a disabled unit can destroy the train if it
 * is in the same hex. Exception: An overrun onto the rear counter of the train,
 * or either counter if the train is standing still, destroys only that counter.
 *
 * If the train is armed, treat the overrun (or overrunning) hex of the train
 * just like any other unit in resolving overrun combat." (9.04)
 */
export const runDownUnarmedTrains = (
  state: GameState,
  hex: Hex,
  mover: Unit,
): { state: GameState; anyLeft: boolean } => {
  let next = state;
  let anyLeft = false;
  for (const u of unitsAt(state, hex)) {
    if (u.owner === mover.owner) continue;
    if (!isTrain(u)) {
      anyLeft = true;
      continue;
    }
    if (trainIsArmed(next, u)) {
      anyLeft = true;
      continue;
    }
    next = log(
      next,
      'bad',
      `${unitName(mover)} runs the train down in ${key(hex)} — no guns aboard (9.04).`,
      [hex],
    );
    next = destroyTrainCounter(next, u.id, 'run down in an overrun', mover.owner);
  }
  return { state: next, anyLeft };
};

// ---------------------------------------------------------------------------
// 9.07 Reinforcements from the train
// ---------------------------------------------------------------------------

/** What one counter costs of a train half's twelve size points (9.07). */
export const trainCargoCost = (u: Unit): number => {
  if (isOgre(u)) return Infinity;
  const cls = unitClass(u.classId);
  // "12 squads of infantry" fill a half, so a squad is one size point.
  return cls.kind === 'infantry' ? u.squads : cls.size;
};

/** Everything riding one counter of the train. */
export const trainCargo = (state: GameState, half: UnitId): ConventionalUnit[] =>
  passengersOf(state, half);

export const trainCargoUsed = (state: GameState, half: UnitId): number =>
  trainCargo(state, half).reduce((n, u) => n + trainCargoCost(u), 0);

/**
 * Why this counter cannot go aboard that half of the train, or null (9.07).
 *
 * "Only units of Size 3 or below may go on the train. Each half of the train
 * may carry up to 12 'size points' worth of armor ... If GEV-PCs are carried,
 * the Size of any infantry riding them does not count."
 */
export const boardTrainCheck = (
  state: GameState,
  half: Unit | undefined,
  cargo: Unit | undefined,
): string | null => {
  if (!half || half.kind !== 'unit' || !isTrain(half) || !onBoard(half)) {
    return 'no such train counter';
  }
  if (!cargo || !onBoard(cargo)) return 'no such unit';
  if (isOgre(cargo)) return 'a cybertank does not take the train';
  if (cargo.owner !== half.owner) return 'that is not yours to load';
  if (cargo.ridingOn) return 'it is already aboard something';
  if (!eq(cargo.pos, half.pos)) return 'it must be in the same hex';
  const cls = unitClass(cargo.classId);
  if (cls.kind !== 'infantry' && cls.size > MAX_TRAIN_CARGO_SIZE) {
    return `only units of Size ${String(MAX_TRAIN_CARGO_SIZE)} or below go on the train (9.07)`;
  }
  const cost = trainCargoCost(cargo);
  if (trainCargoUsed(state, half.id) + cost > TRAIN_CARGO_PER_HALF) {
    return `that half is carrying its ${String(TRAIN_CARGO_PER_HALF)} size points already`;
  }
  return null;
};

// ---------------------------------------------------------------------------
// 9.03.1 Armed trains
// ---------------------------------------------------------------------------

/**
 * Put `guns` 4/2 guns on each counter of a train, for a scenario builder.
 *
 * "For each armor unit given up, he can put one 4/2 gun on each of the train
 * counters (thus, if he exchanges 4 armor units, the train will have 8
 * attacks, each with a strength of 4 and range of 2, per turn)."
 */
export const armTrain = (state: GameState, id: UnitId, guns: number): GameState => {
  let next = state;
  for (const counter of trainCounters(state, state.units[id] ?? ({} as Unit))) {
    next = withUnit(next, { ...counter, trainGuns: Math.max(0, Math.floor(guns)) });
  }
  return next;
};

/** The guns a counter has left to fire this phase (9.03.1). */
export const gunsLeft = (u: Unit): number =>
  u.kind === 'unit' ? Math.max(0, gunsOn(u) - u.squadsFired) : 0;

/** A whole train's firepower, for a scenario's briefing. */
export const trainFirepower = (state: GameState, u: Unit): number =>
  trainCounters(state, u).reduce((n, c) => n + gunsOn(c) * TRAIN_GUN.attack, 0);

/** The hexes a train's counters stand in, for the interface. */
export const trainHexes = (state: GameState, u: Unit): string[] =>
  trainCounters(state, u).map((c) => key(c.pos));
