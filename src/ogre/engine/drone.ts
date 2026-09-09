/**
 * The Light Artillery Drone's three turns (14.01).
 *
 * A LAD is a gun on legs with no engine at all — Movement 0 — so the only way
 * it gets anywhere is folded up:
 *
 * > "it can be transported collapsed as a single cargo pallet by a Truck or
 * > Hovertruck, or a Vulcan, and set up quickly. The sequence of it setting up
 * > is as follows:
 * >
 * > • Turn 1: Unloading. It is assumed the transport has its own unloading
 * >   capability. All the transport needs to do is remain in one place for one
 * >   turn. Place the LAD pallet in the same hex as the transport.
 * > • Turn 2: The LAD unpacks itself, sets itself up, and runs diagnostics.
 * >   Replace the pallet counter with the regular LAD counter. It may be
 * >   targeted, but may not attack. The unit that transported it may move away
 * >   normally.
 * > • Turn 3: The LAD can fire."
 *
 * So `droneState` walks `pallet` → `unpacking` → `ready`, one step a turn, and
 * the middle step is a deliberate order rather than a clock: a pallet set down
 * in a defensive setup lies there until its owner decides to open it, which is
 * the whole point of the paragraph about hiding them.
 *
 * The pallet itself is not a combat unit and the rules are careful about it:
 * it is "treated as a D0 unit; it is destroyed by any attack", an overrun
 * "does not take place when a opponent enters a hex with a collapsed LAD", and
 * it can be nudged along the ground — "If a LAD must be moved to terrain that
 * regular cargo haulers cannot reach, any infantry squad can move a LAD pallet
 * one hex per turn." Once it is up, "A LAD that is set up may not be moved."
 *
 * Folding one back up is slow and needs hands: "It takes a squad of Combat
 * Engineers three turns to re-palletize a LAD, and one further turn to load it
 * onto a Truck. A Vulcan may break down and load an LAD in one turn provided it
 * performs no other action that turn." That work is a task in
 * `engineering.ts`; what lives here is the counting.
 */

import { type Hex, distance } from './hex.js';
import { type GameMap, inBounds, terrainAt } from './map.js';
import { entryCost } from './terrain.js';
import { unitClass } from './units.js';
import {
  type ConventionalUnit,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitId,
  activePlayer,
  canAct,
  isPallet,
  onBoard,
  unitsAt,
} from './types.js';
import { log, unitName, withUnit } from './state.js';
import { revealUnit } from './concealment.js';

/** Turns of Combat Engineer work to fold a drone up, and one more to load it. */
export const REPACK_TURNS = 3;

/** Every Light Artillery Drone, whatever state it is in. */
export const isDrone = (u: Unit): u is ConventionalUnit => u.kind === 'unit' && u.classId === 'LAD';

/** A drone on its legs: "It may be targeted, but may not attack" and up. */
export const isDeployedDrone = (u: Unit): boolean =>
  u.kind === 'unit' && (u.droneState === 'unpacking' || u.droneState === 'ready');

/** A drone that has finished its diagnostics. Anything not a drone is "ready". */
export const droneCanFire = (u: Unit): boolean =>
  !isDrone(u) || u.droneState === undefined || u.droneState === 'ready';

/**
 * Fold a drone up for a scenario that means it to arrive as cargo (14.01).
 *
 * `makeUnit` puts an emplaced drone on the board, because that is what a
 * scenario listing a LAD in an order of battle usually means; a builder that
 * wants one on a Truck applies this to it first.
 */
export const palletised = (u: ConventionalUnit): ConventionalUnit => ({
  ...u,
  droneState: 'pallet',
  repackProgress: 0,
});

/**
 * Why this drone cannot start setting itself up right now, or null when it can.
 *
 * "All the transport needs to do is remain in one place for one turn" — so a
 * pallet unloaded this turn is still turn 1's work, and turn 2 is the earliest
 * it can begin.
 */
export const unpackCheck = (state: GameState, unit: Unit | undefined): string | null => {
  if (!unit || !onBoard(unit)) return 'no such unit';
  if (!isDrone(unit)) return 'only a Light Artillery Drone unpacks';
  if (unit.owner !== activePlayer(state)) return 'not your unit';
  if (state.phase !== 'movement') return 'a drone unpacks in the movement phase';
  if (unit.droneState !== 'pallet') return `${unitName(unit)} is already set up`;
  if (unit.ridingOn) return 'unload it first — the transport must stand still for a turn';
  if (unit.movementEnded) return 'it was set down this turn; it unpacks on the next';
  return null;
};

export interface DroneOutcome {
  readonly state: GameState;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * "The LAD unpacks itself, sets itself up, and runs diagnostics. Replace the
 * pallet counter with the regular LAD counter. It may be targeted, but may not
 * attack."
 *
 * And it stops being a secret: "The opponent will not detect a collapsed LAD
 * until it starts to set up."
 */
export const unpackDrone = (state: GameState, unitId: UnitId): DroneOutcome => {
  const unit = state.units[unitId];
  const why = unpackCheck(state, unit);
  if (why || !unit || unit.kind !== 'unit') return { state, ok: false, reason: why ?? 'no' };

  let next = withUnit(state, {
    ...unit,
    droneState: 'unpacking' as const,
    movementEnded: true,
    firedThisPhase: true,
    repackProgress: 0,
  });
  next = revealUnit(next, unitId, ' It is setting up.');
  return {
    state: log(next, 'info', `${unitName(unit)} unpacks and runs its diagnostics.`, [unit.pos]),
    ok: true,
  };
};

/**
 * Turn 3 arrives: every drone of this player's that spent a turn unpacking can
 * fire from now on. Run from the recovery phase, with the rest of the clocks.
 */
export const advanceDrones = (state: GameState, player: PlayerId): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !onBoard(u) || !isDrone(u)) continue;
    if (u.droneState !== 'unpacking') continue;
    next = withUnit(next, { ...u, droneState: 'ready' as const });
    next = log(next, 'good', `${unitName(u)} is set up and ready to fire.`, [u.pos]);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Pushing a pallet
// ---------------------------------------------------------------------------

/**
 * "If a LAD must be moved to terrain that regular cargo haulers cannot reach,
 * any infantry squad can move a LAD pallet one hex per turn."
 *
 * One hex, by hand, and it costs the squad its own movement — the pallet does
 * not walk itself, and there is nothing in the rule about carrying it two.
 */
export const pushers = (state: GameState, pallet: Unit): ConventionalUnit[] =>
  unitsAt(state, pallet.pos).filter(
    (u): u is ConventionalUnit =>
      u.kind === 'unit' &&
      u.owner === pallet.owner &&
      u.id !== pallet.id &&
      unitClass(u.classId).kind === 'infantry' &&
      canAct(u) &&
      !u.ridingOn &&
      u.moveUsed === 0 &&
      !u.movementEnded,
  );

/** Why this pallet cannot be carried to `to` by hand, or null when it can. */
export const pushCheck = (
  state: GameState,
  map: GameMap,
  unit: Unit | undefined,
  to: Hex,
): string | null => {
  if (!unit || !onBoard(unit)) return 'no such unit';
  if (!isPallet(unit)) return 'only a collapsed drone is carried by hand';
  if (unit.owner !== activePlayer(state)) return 'not your unit';
  if (state.phase !== 'movement') return 'a pallet is carried in the movement phase';
  if (unit.kind === 'unit' && unit.ridingOn) return 'it is aboard a transport';
  if (unit.movementEnded) return 'it has been moved this turn';
  if (!inBounds(map, to)) return 'off the map';
  if (distance(unit.pos, to) !== 1) return 'one hex per turn (14.01)';
  // Carried by hand, so it goes where the squad goes.
  const ground = entryCost(terrainAt(map, to, state.terrainOverrides), 'infantry');
  if (ground.cost === null) {
    return `a squad cannot carry it in there — ${ground.reason ?? 'impassable'}`;
  }
  if (pushers(state, unit).length === 0) {
    return 'no infantry squad in the hex with movement left to carry it';
  }
  return null;
};

/** Carry the pallet one hex, spending the squad that carries it. */
export const pushPallet = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  to: Hex,
): DroneOutcome => {
  const unit = state.units[unitId];
  const why = pushCheck(state, map, unit, to);
  if (why || !unit || unit.kind !== 'unit') return { state, ok: false, reason: why ?? 'no' };

  const squad = pushers(state, unit)[0]!;
  let next = withUnit(state, { ...unit, pos: to, movementEnded: true, phaseStart: unit.pos });
  next = withUnit(next, { ...squad, pos: to, moveUsed: 1, movementEnded: true });
  return {
    state: log(next, 'info', `${unitName(squad)} carries ${unitName(unit)} one hex.`, [to]),
    ok: true,
  };
};
