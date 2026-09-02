/**
 * Deployment: the players arrange the board before the first turn.
 *
 * Every scenario's setup text is written as a set of areas and ceilings —
 * "The rest of the defending force must be set up in the North Area", "No
 * more than 20 attack strength points may be set up in this area", "entering
 * anywhere on the south end of the map" — and the scenario builders already
 * produce a *legal* arrangement from the seed. This module is the window in
 * which the players change it: pick up a counter, put it down anywhere in
 * your zone the ceilings allow, and press Ready. The defender goes first, so
 * the attacker chooses where to come on knowing what is waiting.
 *
 * While `state.setup` is set the reducer admits nothing but these two orders
 * (and resignation), so a deployment can never leak into the turn sequence.
 */

import { type Hex, eq, key, parseKey } from './hex.js';
import { type GameMap, inBounds, terrainAt } from './map.js';
import { entryCost } from './terrain.js';
import { OGRE_WEAPONS } from './ogres.js';
import { unitClass } from './units.js';
import {
  type GameState,
  type PlayerId,
  type SetupLimit,
  type SetupZone,
  type Unit,
  type UnitId,
  isOgre,
  onBoard,
  passengersOf,
  setupActor,
  unitsAt,
} from './types.js';
import { log, printedAttack, updateAnyUnit, withUnits } from './state.js';
import { mobilityOf } from './mobility.js';
import { hexLoad } from './movement.js';

/** The orders the reducer admits while the counters are still going down. */
export const SETUP_COMMANDS: ReadonlySet<string> = new Set(['placeUnit', 'finishSetup', 'resign']);

export const zoneOf = (state: GameState, player: PlayerId): SetupZone | undefined =>
  state.setup?.zones[player];

/**
 * The attack strength a counter contributes to a zone ceiling.
 *
 * The ceilings are written in "attack strength points", which for a
 * conventional unit is the number on the counter and for infantry the number
 * of squads. An Ogre has no single number; the sum of its guns' strengths is
 * the honest reading, and it puts a cybertank over any printed ceiling —
 * which is right: the scenarios that set ceilings never let an Ogre inside
 * them.
 */
export const setupStrength = (u: Unit): number => {
  if (isOgre(u)) {
    return u.weapons
      .filter((w) => !w.destroyed && !OGRE_WEAPONS[w.kind].antipersonnelOnly)
      .reduce((n, w) => n + OGRE_WEAPONS[w.kind].attack, 0);
  }
  return printedAttack(u);
};

export interface LimitStatus {
  readonly label: string;
  readonly used: number;
  readonly max: number;
}

/** How full each of a side's ceilings is, for the panel. */
export const limitStatus = (state: GameState, player: PlayerId): LimitStatus[] => {
  const zone = zoneOf(state, player);
  if (!zone?.limits) return [];
  return zone.limits.map((limit) => ({
    label: limit.label,
    used: strengthInside(state, player, limit),
    max: limit.maxAttack,
  }));
};

const strengthInside = (state: GameState, player: PlayerId, limit: SetupLimit): number => {
  const inside = new Set(limit.hexes);
  let total = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !onBoard(u)) continue;
    if (inside.has(key(u.pos))) total += setupStrength(u);
  }
  return total;
};

/** Whether this counter may stand on that hex at all: terrain and enemies. */
const standable = (state: GameState, map: GameMap, unit: Unit, at: Hex): string | null => {
  if (!inBounds(map, at)) return 'that hex is off the map';
  const terrain = terrainAt(map, at, state.terrainOverrides);
  if (terrain === 'crater') return 'no unit may start in a crater';
  const entry = entryCost(terrain, mobilityOf(unit));
  // An immobile unit still has to be *put* somewhere: judge the ground by
  // what a heavy tracked vehicle could reach, which is how a howitzer arrives.
  const fixed = mobilityOf(unit) === 'immobile' || mobilityOf(unit) === 'rail';
  const closed = entry.cost === null && !fixed;
  if (closed) return entry.reason ?? 'this unit cannot be set up there';
  if (fixed && terrain === 'water') return 'this unit cannot be set up there';
  if (unitsAt(state, at).some((u) => u.owner !== unit.owner)) return 'the enemy holds that hex';
  return null;
};

/**
 * Every hex this counter could be put down on right now, for the map to
 * light up. Hexes already full of the player's own counters are included
 * when a swap is possible — on the one-per-hex map that is how two counters
 * change places.
 */
export const legalSetupHexes = (state: GameState, map: GameMap, unit: Unit): Hex[] => {
  const zone = zoneOf(state, unit.owner);
  if (!zone) return [];
  const out: Hex[] = [];
  for (const k of zone.hexes) {
    const h = parseKey(k);
    if (eq(h, unit.pos)) continue;
    if (standable(state, map, unit, h)) continue;
    if (!fits(state, h, unit) && !swapPartner(state, h, unit)) continue;
    out.push(h);
  }
  return out;
};

const ownLoad = (unit: Unit): number =>
  unit.kind === 'unit' && unitClass(unit.classId).kind === 'infantry' ? unit.squads / 3 : 1;

const fits = (state: GameState, at: Hex, unit: Unit): boolean => {
  const load = hexLoad(state, at, unit.owner, unit.id);
  return Math.round((load + ownLoad(unit)) * 1000) / 1000 <= state.options.stackingLimit;
};

/**
 * On a one-vehicle-per-hex board, dropping a counter on a friend swaps them.
 * Only ever one candidate: the hex holds exactly one own counter, which is
 * not riding anything.
 */
const swapPartner = (state: GameState, at: Hex, unit: Unit): Unit | null => {
  if (state.options.stackingLimit !== 1) return null;
  const here = unitsAt(state, at).filter((u) => u.owner === unit.owner && u.id !== unit.id);
  if (here.length !== 1) return null;
  return here[0]!;
};

export interface SetupOutcome {
  readonly state: GameState;
  readonly ok: boolean;
  readonly reason?: string;
}

/** Put one counter down. Riders travel with their vehicle. */
export const placeUnit = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  at: Hex,
): SetupOutcome => {
  if (!state.setup) return { state, ok: false, reason: 'the counters are already down' };
  const actor = setupActor(state);
  const unit = state.units[unitId];
  if (!unit || !onBoard(unit)) return { state, ok: false, reason: 'no such counter' };
  if (unit.owner !== actor) return { state, ok: false, reason: 'not your counter' };
  if (unit.kind === 'unit' && unit.ridingOn) {
    return { state, ok: false, reason: 'that infantry is aboard a vehicle; move the vehicle' };
  }

  const zone = zoneOf(state, unit.owner);
  if (!zone) return { state, ok: false, reason: 'this side has nowhere to set up' };
  if (!zone.hexes.includes(key(at))) {
    return { state, ok: false, reason: `set up inside ${zone.label}` };
  }
  if (eq(at, unit.pos)) return { state, ok: true };

  const blocked = standable(state, map, unit, at);
  if (blocked) return { state, ok: false, reason: blocked };

  let partner: Unit | null = null;
  if (!fits(state, at, unit)) {
    partner = swapPartner(state, at, unit);
    if (!partner) return { state, ok: false, reason: 'that hex is full' };
  }

  const from = unit.pos;
  const moved: Unit[] = [{ ...unit, pos: at, phaseStart: at } as Unit];
  for (const rider of passengersOf(state, unit.id))
    moved.push({ ...rider, pos: at, phaseStart: at });
  if (partner) {
    moved.push({ ...partner, pos: from, phaseStart: from } as Unit);
    for (const rider of passengersOf(state, partner.id)) {
      moved.push({ ...rider, pos: from, phaseStart: from });
    }
  }
  const next = withUnits(state, moved);

  // Ceilings are judged on the result, so a swap that keeps the total under
  // the line is fine and one that breaks it is refused whole.
  for (const limit of zone.limits ?? []) {
    const used = strengthInside(next, unit.owner, limit);
    if (used > limit.maxAttack) {
      return {
        state,
        ok: false,
        reason: `no more than ${limit.maxAttack} attack strength points in ${limit.label} (${used} would be there)`,
      };
    }
  }
  return { state: next, ok: true };
};

/** This side is set; hand the counters to the next, or start the game. */
export const finishSetup = (state: GameState): SetupOutcome => {
  const setup = state.setup;
  if (!setup) return { state, ok: false, reason: 'the counters are already down' };
  const actor = setupActor(state);
  if (actor === null) return { state, ok: false, reason: 'nobody is setting up' };

  const name = state.players[actor]?.name ?? actor;
  const index = setup.index + 1;
  if (index < setup.order.length) {
    const nextActor = setup.order[index]!;
    const nextName = state.players[nextActor]?.name ?? nextActor;
    const next: GameState = { ...state, setup: { ...setup, index } };
    return {
      state: log(next, 'info', `${name} is set. ${nextName} sets up.`),
      ok: true,
    };
  }

  // Deployment over: the board is what the scenario built plus whatever the
  // players changed, and turn 1 begins exactly as it always did.
  let next: GameState = { ...state, setup: null };
  // Nothing has moved yet, but a swapped counter's phase-start hex must be
  // where it now stands, not where the seed put it.
  for (const u of Object.values(next.units)) {
    if (onBoard(u) && !eq(u.phaseStart, u.pos)) {
      next = updateAnyUnit(next, u.id, () => ({ phaseStart: u.pos }));
    }
  }
  return {
    state: log(next, 'info', `${name} is set. The counters are down; the battle begins.`),
    ok: true,
  };
};
