/**
 * The one entry point: `applyCommand` routes a command to the module that owns
 * the rule, and runs the phase machinery between player-turns.
 *
 * Everything about a game's progression is here and nowhere else, so the answer
 * to "when does that happen?" is always a single `switch`.
 */

import type { GameMap } from './map.js';
import type { Command, CommandResult } from './commands.js';
import { fail, ok } from './commands.js';
import { eq } from './hex.js';
import { TRAIN_MAX_SPEED, unitClass } from './units.js';
import {
  type GameState,
  type Phase,
  type VictoryState,
  activePlayer,
  isInertOgre,
  isOgre,
  onBoard,
  passengersOf,
  playerTurnOrdinal,
  setupActor,
} from './types.js';
import { SETUP_COMMANDS, finishSetup, placeUnit } from './setup.js';
import { deployReserveCheck } from './reserves.js';
import { flyMissiles, launchMissile } from './missiles.js';
import {
  apRemaining,
  log,
  makeUnit,
  movementAllowance,
  reduceSquad,
  unitName,
  updateAnyUnit,
  withUnit,
} from './state.js';
import {
  applyMove,
  beginMovementPhase,
  canDismount,
  canMount,
  resolvePendingHazards,
  runRecovery,
  wouldOverstack,
} from './movement.js';
import { unitsAt } from './types.js';
import { resetFireFlags, resolveAttack, resolveOrbitalStrike } from './combat.js';
import { resolveRam } from './ram.js';
import {
  beginOverrun,
  endOverrunRound,
  overrunActor,
  overrunRam,
  resolveOverrunAttack,
} from './overrun.js';

export interface ApplyResult {
  readonly state: GameState;
  readonly result: CommandResult;
}

/** A scenario's victory test, threaded in so the engine need not know scenarios. */
export type VictoryCheck = (state: GameState) => VictoryState | null;

export const applyCommand = (
  state: GameState,
  cmd: Command,
  map: GameMap,
  victoryCheck?: VictoryCheck,
): ApplyResult => {
  if (state.victory) return { state, result: fail('the game is over') };

  // Deployment comes before everything: while the counters are going down,
  // nothing moves, nothing fires, and only the side setting up may act.
  if (state.setup) {
    if (!SETUP_COMMANDS.has(cmd.type)) {
      return { state, result: fail('the counters are still going down — place them and press Ready') };
    }
    const actor = setupActor(state);
    if (cmd.type !== 'resign' && cmd.by !== actor) {
      const name = actor ? (state.players[actor]?.name ?? actor) : 'nobody';
      return { state, result: fail(`it is ${name}’s turn to set up`) };
    }
  } else if (state.overrun) {
    // An overrun suspends the movement phase and hands initiative to whichever
    // side is firing — "The defender has the first fire round" (8.04). It is
    // the one place in Ogre where the non-phasing player acts, so the seat
    // check has to ask the overrun rather than the turn.
    if (!OVERRUN_COMMANDS.has(cmd.type) && cmd.type !== 'resign') {
      return { state, result: fail('finish the overrun first') };
    }
    const actor = overrunActor(state);
    if (cmd.by !== actor && cmd.type !== 'resign') {
      return { state, result: fail('it is not your fire round') };
    }
  } else if (cmd.by !== activePlayer(state) && cmd.type !== 'resign') {
    // Outside an overrun, Ogre is strictly sequential: one player-turn at a
    // time, and there is no reaction fire anywhere in the game.
    return { state, result: fail('it is not your turn') };
  }

  const step = route(state, cmd, map);
  if (!step.result.ok) return step;

  const next = victoryCheck ? { ...step.state, victory: victoryCheck(step.state) } : step.state;
  return { state: next, result: step.result };
};

const OVERRUN_COMMANDS = new Set<Command['type']>([
  'overrunAttack',
  'overrunRam',
  'endFireRound',
  'dismount',
]);

const route = (state: GameState, cmd: Command, map: GameMap): ApplyResult => {
  switch (cmd.type) {
    case 'moveUnit':
      return doMove(state, cmd.unit, cmd.path, map);
    case 'ram':
      return inertGuard(state, cmd.unit) ?? doRam(state, cmd.unit, cmd.target, map);
    case 'reduceInfantry':
      return inertGuard(state, cmd.unit) ?? doReduceInfantry(state, cmd.unit, cmd.target);
    case 'mount':
      return doMount(state, cmd.unit, cmd.carrier);
    case 'dismount':
      return doDismount(state, cmd.unit);
    case 'splitInfantry':
      return doSplit(state, cmd.unit, cmd.squads);
    case 'combineInfantry':
      return doCombine(state, cmd.units);
    case 'overrun':
      return (
        inertGuard(state, cmd.unit) ?? wrap(state, beginOverrun(state, map, cmd.unit, cmd.target))
      );
    case 'overrunAttack':
      return wrap(state, resolveOverrunAttack(state, map, cmd.attackers, cmd.target));
    case 'overrunRam':
      return wrap(state, overrunRam(state, map, cmd.unit, cmd.target));
    case 'endFireRound':
      return wrap(state, endOverrunRound(state, map));
    case 'attack':
      return doAttack(state, cmd.attackers, cmd.target, map);
    case 'endPhase':
      return { state: advancePhase(state, map), result: ok() };
    case 'resign':
      return doResign(state, cmd.by);
    case 'deployReserve':
      return doDeployReserve(state, cmd.unit, cmd.at, map);
    case 'orbitalStrike': {
      if (state.phase !== 'fire') {
        return { state, result: fail('orbital fire arrives in the fire phase') };
      }
      const side = state.scenarioData['orbitalStrikeSide'];
      if (typeof side === 'string' && cmd.by !== side) {
        return { state, result: fail('the fleet overhead is not yours') };
      }
      return wrap(state, resolveOrbitalStrike(state, map, cmd.strike, cmd.target));
    }
    case 'placeUnit':
      return wrap(state, placeUnit(state, map, cmd.unit, cmd.at));
    case 'finishSetup':
      return wrap(state, finishSetup(state));
    case 'launchCruiseMissile':
      return wrap(state, launchMissile(state, map, cmd.unit, cmd.target));
    case 'setTrainSpeed':
      return doSetTrainSpeed(state, cmd.unit, cmd.change);
  }
};

/**
 * Orbital Drop §3.03: the reaction force enters from the defender's map edge,
 * any or all of it, on any turn from the scenario's reaction turn on. A unit
 * arrives with its move spent — the turn went on getting back to the alarm.
 */
const doDeployReserve = (
  state: GameState,
  unitId: string,
  at: { q: number; r: number },
  map: GameMap,
): ApplyResult => {
  const unit = state.units[unitId];
  if (!unit) return { state, result: fail('that unit is not waiting in reserve') };
  if (unit.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  const why = deployReserveCheck(state, map, unit, at);
  if (why) return { state, result: fail(why) };

  const next = withUnit(state, {
    ...unit,
    offMap: undefined,
    pos: at,
    phaseStart: at,
    moveUsed: movementAllowance(unit, 'movement', state.options),
    movementEnded: true,
  });
  return {
    state: log(next, 'warn', `${unitName(unit)} races back from dispersal.`, [at]),
    result: ok(),
  };
};

/**
 * The train's speed marker moves one step a turn, before the train does
 * (9.02): a driver who sees cut track ahead has as many turns to brake as
 * the marker has steps.
 */
const doSetTrainSpeed = (state: GameState, unitId: string, change: 1 | -1): ApplyResult => {
  if (state.phase !== 'movement') return { state, result: fail('set the speed before moving') };
  const unit = state.units[unitId];
  if (!unit || unit.kind !== 'unit' || unit.classId !== 'TRAIN' || !onBoard(unit)) {
    return { state, result: fail('that is not a train') };
  }
  if (unit.owner !== activePlayer(state)) return { state, result: fail('not your train') };
  if (unit.moveUsed > 0) return { state, result: fail('the speed is set before the train moves') };
  if (unit.trainSpeedSet) return { state, result: fail('the speed changes once a turn (9.02)') };
  const speed = Math.max(0, Math.min(TRAIN_MAX_SPEED, (unit.trainSpeed ?? 0) + change));
  if (speed === (unit.trainSpeed ?? 0)) {
    return { state, result: fail(change > 0 ? 'the train is at full speed' : 'the train is stopped') };
  }
  const next = withUnit(state, { ...unit, trainSpeed: speed, trainSpeedSet: true });
  return {
    state: log(next, 'info', `The train ${change > 0 ? 'opens up' : 'brakes'} to speed ${speed}.`, [
      unit.pos,
    ]),
    result: ok(),
  };
};

/** An Ogre still assembling can do nothing at all; `null` means "carry on". */
const inertGuard = (state: GameState, unitId: string): ApplyResult | null => {
  const unit = state.units[unitId];
  if (unit && isInertOgre(unit, state.turn)) {
    return { state, result: fail(`${unitName(unit)} is still assembling`) };
  }
  return null;
};

/** Adapt the `{state, ok, reason}` shape the combat modules return. */
const wrap = (
  before: GameState,
  outcome: { state: GameState; ok: boolean; reason?: string },
): ApplyResult =>
  outcome.ok
    ? { state: outcome.state, result: ok() }
    : { state: before, result: fail(outcome.reason ?? 'not legal') };

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

const inMovementPhase = (phase: Phase): boolean => phase === 'movement' || phase === 'gevMovement';

const doMove = (
  state: GameState,
  unitId: string,
  path: readonly { q: number; r: number }[],
  map: GameMap,
): ApplyResult => {
  if (!inMovementPhase(state.phase)) return { state, result: fail('not a movement phase') };
  const unit = state.units[unitId];
  if (!unit || !onBoard(unit)) return { state, result: fail('no such unit') };
  if (unit.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  if (isInertOgre(unit, state.turn)) {
    return { state, result: fail(`${unitName(unit)} is still assembling`) };
  }
  if (unit.kind === 'unit' && unit.ridingOn) {
    return { state, result: fail('that infantry is riding; dismount first') };
  }
  if (state.phase === 'gevMovement') {
    const cls = unit.kind === 'unit' ? unitClass(unit.classId) : null;
    if (!cls || cls.secondMove == null) {
      return { state, result: fail('only GEV-type units move again after combat') };
    }
  }

  const { state: next, plan } = applyMove(state, map, unitId, path);
  return plan.ok
    ? { state: next, result: ok() }
    : { state, result: fail(plan.reason ?? 'illegal move') };
};

const doRam = (
  state: GameState,
  unitId: string,
  target: { q: number; r: number },
  map: GameMap,
): ApplyResult => {
  if (!inMovementPhase(state.phase)) return { state, result: fail('ramming happens while moving') };
  if (state.options.overrunCombat) {
    return { state, result: fail('this game uses overrun combat, not ramming (6.00)') };
  }
  const unit = state.units[unitId];
  if (!unit || !onBoard(unit)) return { state, result: fail('no such unit') };
  if (unit.owner !== activePlayer(state)) return { state, result: fail('not your unit') };

  const outcome = resolveRam(state, map, unitId, target);
  return outcome.ok
    ? { state: outcome.state, result: ok() }
    : { state, result: fail(outcome.reason ?? 'that ram is not legal') };
};

/**
 * "An Ogre/SHVY in a hex with infantry may expend a movement point, stay in the
 * same hex, and reduce the infantry again." (6.06)
 */
const doReduceInfantry = (state: GameState, unitId: string, targetId: string): ApplyResult => {
  if (!inMovementPhase(state.phase)) return { state, result: fail('not a movement phase') };
  const unit = state.units[unitId];
  const target = state.units[targetId];
  if (!unit || !onBoard(unit)) return { state, result: fail('no such unit') };
  if (!target || !onBoard(target)) return { state, result: fail('no such target') };
  if (unit.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  if (!eq(unit.pos, target.pos)) return { state, result: fail('not in the same hex') };
  if (target.kind !== 'unit' || unitClass(target.classId).kind !== 'infantry') {
    return { state, result: fail('that is not infantry') };
  }
  if (target.owner === unit.owner) return { state, result: fail('those are your own troops') };

  const hasAp = isOgre(unit)
    ? apRemaining(unit) > 0
    : unit.kind === 'unit' && unit.classId === 'SHVY';
  if (!hasAp) return { state, result: fail('no antipersonnel weapons left') };

  if (unit.moveUsed + 1 > movementAllowance(unit, state.phase, state.options)) {
    return { state, result: fail('no movement point left to spend') };
  }

  let next = updateAnyUnit(state, unitId, (u) => ({ moveUsed: u.moveUsed + 1 }));
  next = reduceSquad(next, targetId, 'crushed by an Ogre', unit.owner);
  next = log(next, 'bad', `${unitName(unit)} grinds another squad into the ground.`, [unit.pos]);
  return { state: next, result: ok() };
};

// ---------------------------------------------------------------------------
// Passengers
// ---------------------------------------------------------------------------

const doMount = (state: GameState, unitId: string, carrierId: string): ApplyResult => {
  if (state.phase !== 'movement') return { state, result: fail('mount during the movement phase') };
  const rider = state.units[unitId];
  const carrier = state.units[carrierId];
  if (!rider || !carrier || !onBoard(rider) || !onBoard(carrier)) {
    return { state, result: fail('no such unit') };
  }
  if (rider.owner !== activePlayer(state)) return { state, result: fail('not your unit') };

  const check = canMount(state, rider, carrier);
  if (!check.ok) return { state, result: fail(check.reason ?? 'cannot mount') };

  const next = updateAnyUnit(state, unitId, () => ({
    ridingOn: carrierId,
    mountedThisTurn: true,
    // "an infantry squad must spend its entire movement for the turn" (5.11.3)
    movementEnded: true,
  }));
  return {
    state: log(next, 'info', `${unitName(rider)} climbs aboard ${unitName(carrier)}.`, [rider.pos]),
    result: ok(),
  };
};

const doDismount = (state: GameState, unitId: string): ApplyResult => {
  if (!inMovementPhase(state.phase)) return { state, result: fail('not a movement phase') };
  const rider = state.units[unitId];
  if (!rider || !onBoard(rider)) return { state, result: fail('no such unit') };

  // "Infantry riding on vehicles may dismount at the beginning of the overrun.
  // They cannot remount after the combat." (8.06.1) That window belongs to
  // whoever owns the rider, not to the phasing player.
  if (state.overrun) {
    if (state.overrun.step !== 'dismount') {
      return { state, result: fail('the dismount window has closed') };
    }
    if (rider.owner !== overrunActor(state)) return { state, result: fail('not your unit') };
    const next = updateAnyUnit(state, unitId, () => ({ ridingOn: undefined, movementEnded: true }));
    return { state: log(next, 'info', `${unitName(rider)} bails out.`, [rider.pos]), result: ok() };
  }

  if (rider.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  if (state.phase === 'gevMovement') {
    return {
      state,
      result: fail('infantry may not dismount during the second movement phase (5.11.3)'),
    };
  }

  const check = canDismount(rider);
  if (!check.ok) return { state, result: fail(check.reason ?? 'cannot dismount') };
  if (wouldOverstack(state, rider.pos, rider)) return { state, result: fail('that hex is full') };

  const next = updateAnyUnit(state, unitId, () => ({
    ridingOn: undefined,
    // "may not move 'on its own' on the turn it dismounts" (5.11.3)
    movementEnded: true,
  }));
  return { state: log(next, 'info', `${unitName(rider)} drops off.`, [rider.pos]), result: ok() };
};

// ---------------------------------------------------------------------------
// Infantry bookkeeping (5.02.3)
// ---------------------------------------------------------------------------

const doSplit = (state: GameState, unitId: string, squads: number): ApplyResult => {
  if (state.phase !== 'movement') {
    return { state, result: fail('infantry regroup during their own movement phase') };
  }
  const u = state.units[unitId];
  if (!u || u.kind !== 'unit' || !onBoard(u)) return { state, result: fail('no such unit') };
  if (u.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  if (unitClass(u.classId).kind !== 'infantry') return { state, result: fail('not infantry') };
  if (squads < 1 || squads >= u.squads) return { state, result: fail('split off 1 or 2 squads') };

  const id = `${u.owner}-inf-${state.nextUnitSerial}`;
  const piece = makeUnit(id, u.owner, u.classId, u.pos, squads);
  let next = withUnit(state, { ...u, squads: u.squads - squads });
  next = withUnit(next, {
    ...piece,
    moveUsed: u.moveUsed,
    phaseStart: u.phaseStart,
    onRouteAllPhase: u.onRouteAllPhase,
  });
  next = { ...next, nextUnitSerial: next.nextUnitSerial + 1 };

  if (wouldOverstack(next, u.pos, piece)) {
    return { state, result: fail('that hex cannot hold another counter') };
  }
  return { state: next, result: ok() };
};

const doCombine = (state: GameState, ids: readonly string[]): ApplyResult => {
  if (state.phase !== 'movement') {
    return { state, result: fail('infantry regroup during their own movement phase') };
  }
  if (ids.length < 2) return { state, result: fail('name at least two counters') };

  const units = ids.map((id) => state.units[id]);
  const first = units[0];
  if (!first || first.kind !== 'unit') return { state, result: fail('no such unit') };
  if (first.owner !== activePlayer(state)) return { state, result: fail('not your unit') };

  let total = 0;
  for (const u of units) {
    if (!u || u.kind !== 'unit' || !onBoard(u)) return { state, result: fail('no such unit') };
    if (unitClass(u.classId).kind !== 'infantry') return { state, result: fail('not infantry') };
    if (u.classId !== first.classId) return { state, result: fail('only like squads combine') };
    if (!eq(u.pos, first.pos)) return { state, result: fail('they are not in the same hex') };
    if (u.ridingOn !== first.ridingOn) return { state, result: fail('mount status differs') };
    total += u.squads;
  }
  if (total > 3) return { state, result: fail('three squads to a counter (3.02)') };

  let next = withUnit(state, {
    ...first,
    squads: total,
    // The merged counter is as spent as its most-spent component.
    moveUsed: Math.max(...units.map((u) => u!.moveUsed)),
    squadsFired: Math.max(...units.map((u) => (u!.kind === 'unit' ? u!.squadsFired : 0))),
  });
  for (const u of units.slice(1)) {
    next = withUnit(next, { ...u!, destroyed: true, destroyedBy: 'merged' });
  }
  return { state: next, result: ok() };
};

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

const doAttack = (
  state: GameState,
  attackers: Parameters<typeof resolveAttack>[2],
  target: Parameters<typeof resolveAttack>[3],
  map: GameMap,
): ApplyResult => {
  if (state.phase !== 'fire') {
    return { state, result: fail('the fire phase comes after movement (7.01)') };
  }
  for (const ref of attackers) {
    const u = state.units[ref.unit];
    if (!u) return { state, result: fail('no such attacker') };
    if (u.owner !== activePlayer(state)) return { state, result: fail('not your unit') };
  }

  const outcome = resolveAttack(state, map, attackers, target);
  return outcome.resolution
    ? { state: outcome.state, result: ok() }
    : { state, result: fail(outcome.reason ?? 'that attack is not legal') };
};

const doResign = (state: GameState, by: string): ApplyResult => {
  const winners = state.playerOrder.filter((p) => p !== by);
  const next: GameState = {
    ...state,
    victory: { winners, level: 'standard', reason: `${state.players[by]?.name ?? by} resigned.` },
  };
  return { state: log(next, 'bad', `${state.players[by]?.name ?? by} resigns.`), result: ok() };
};

// ---------------------------------------------------------------------------
// The turn sequence (4.02)
// ---------------------------------------------------------------------------

/**
 *   1. Recovery
 *   2. Movement phase
 *   3. Disable check      — bookkeeping; folded into the end of movement
 *   4. Fire phase
 *   5. Second (GEV) movement phase
 */
export const advancePhase = (state: GameState, map: GameMap): GameState => {
  const player = activePlayer(state);

  switch (state.phase) {
    case 'recovery':
      return beginMovementPhase({ ...state, phase: 'movement' }, map, player, 'movement');

    case 'movement': {
      // Step 3 of the sequence happens here, before anybody shoots.
      const settled = resolvePendingHazards(state, player);
      // Cruise missiles still in the air take their next leg as the fire
      // phase opens (10.03), before any new launch.
      return flyMissiles({ ...settled, phase: 'fire' }, map, player);
    }

    case 'fire':
      return beginMovementPhase({ ...state, phase: 'gevMovement' }, map, player, 'gevMovement');

    case 'gevMovement': {
      const settled = resolvePendingHazards(state, player);
      return startNextPlayerTurn(settled, map);
    }
  }
};

const startNextPlayerTurn = (state: GameState, _map: GameMap): GameState => {
  const nextIndex = (state.activePlayerIndex + 1) % state.playerOrder.length;
  const wrapped = nextIndex === 0;
  let next: GameState = {
    ...state,
    activePlayerIndex: nextIndex,
    turn: wrapped ? state.turn + 1 : state.turn,
    phase: 'recovery',
  };

  const player = activePlayer(next);
  next = resetFireFlags(next, player);
  next = runRecovery(next, player, playerTurnOrdinal(next));
  next = log(next, 'info', `${next.players[player]?.name ?? player} takes the turn.`);
  return next;
};

/** Enemy units sharing a hex with one of yours — the 6.08 situation. */
export const contestedHexes = (state: GameState): string[] => {
  const out: string[] = [];
  for (const u of Object.values(state.units)) {
    if (!onBoard(u)) continue;
    const others = unitsAt(state, u.pos).filter((o) => o.owner !== u.owner);
    if (others.length > 0) out.push(u.id);
  }
  return out;
};

/** Passengers, re-exported so the shell need not import two modules. */
export { passengersOf };
