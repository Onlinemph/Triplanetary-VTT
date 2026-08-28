/**
 * Ramming (Section 6).
 *
 * "Ramming is a standard tactic for Ogres. For other units, ramming is a
 * suicide attack." (6.01) Both halves of that sentence are implemented here,
 * and they are genuinely different procedures: an Ogre rolls to see what it
 * flattens and pays in tread units, while a tank that rams simply dies and
 * takes a tread unit or two with it.
 *
 * Ramming happens *during the movement phase*, interrupting it (4.02), which is
 * why this module both resolves combat and spends movement points.
 */

import { type Hex, distance, eq } from './hex.js';
import { type GameMap, inBounds, terrainAt } from './map.js';
import { rollDice, rollDie } from './rng.js';
import { oddsFor, resolve } from './crt.js';
import {
  movementForTreads,
  ogreRamResult,
  ogreRamsArmorSelfLoss,
  ogreRamsOgreSelfLoss,
  ogreType,
  ramProfileFor,
} from './ogres.js';
import { entryCost } from './terrain.js';
import { unitClass } from './units.js';
import {
  type GameState,
  type OgreUnit,
  type Unit,
  type UnitId,
  isOgre,
  onBoard,
  unitsAt,
} from './types.js';
import {
  addPoints,
  defenseOf,
  destroyUnit,
  log,
  movementAllowance,
  unitName,
  updateAnyUnit,
  victoryValue,
  withUnit,
} from './state.js';
import { mobilityOf } from './mobility.js';
import { checkOgreDeath } from './combat.js';

export interface RamCheck {
  readonly ok: boolean;
  readonly reason?: string;
  /** Movement points the ram costs — the cost of entering the target hex. */
  readonly cost: number;
  readonly victim?: Unit;
  readonly kind?: 'ogreVsArmor' | 'ogreVsOgre' | 'ogreVsCP' | 'armorVsOgre' | 'gevVsUnit';
}

const no = (reason: string): RamCheck => ({ ok: false, reason, cost: 0 });

const isGev = (u: Unit): boolean =>
  u.kind === 'unit' && (u.classId === 'GEV' || u.classId === 'LGEV' || u.classId === 'GEVPC');

/** An Ogre, or the Superheavy that "may ram ... as if it were an Ogre Mark I" (6.07.1). */
const ramsLikeAnOgre = (u: Unit): boolean =>
  isOgre(u) || (u.kind === 'unit' && u.classId === 'SHVY');

const ramSize = (u: Unit): number =>
  isOgre(u) ? ogreType(u.typeId).size : unitClass(u.classId).size;

/**
 * Can this unit ram what is in that hex, and what does it cost?
 *
 * `target` may be the rammer's own hex, which is the "expend one more movement
 * point, stay in that hex, and ram again" case of 6.02.
 */
export const canRam = (state: GameState, map: GameMap, rammer: Unit, target: Hex): RamCheck => {
  if (!onBoard(rammer)) return no('that unit is gone');
  if (rammer.kind === 'unit' && rammer.disabled !== 'none') return no('a disabled unit cannot ram');
  if (rammer.kind === 'unit' && unitClass(rammer.classId).kind === 'infantry') {
    return no('infantry can never ram or be rammed');
  }
  if (state.phase !== 'movement' && state.phase !== 'gevMovement') {
    return no('ramming happens during the movement phase');
  }

  // "GEV units may not ram on the second movement phase if they attacked on
  // that turn." (6.07.3)
  if (
    state.phase === 'gevMovement' &&
    isGev(rammer) &&
    rammer.kind === 'unit' &&
    rammer.firedThisPhase
  ) {
    return no('a GEV that fired may not ram on its second movement');
  }

  const again = eq(rammer.pos, target);
  if (!again && distance(rammer.pos, target) !== 1) return no('ram an adjacent hex');
  if (!inBounds(map, target)) return no('there is nothing off the map to ram');

  const victims = unitsAt(state, target).filter((u) => u.owner !== rammer.owner);
  const victim = victims.find(
    (u) => !(u.kind === 'unit' && unitClass(u.classId).kind === 'infantry'),
  );
  if (!victim) {
    return no(
      victims.length > 0
        ? 'infantry can never be rammed — drive over them instead'
        : 'nothing there to ram',
    );
  }

  // Cost: entering the hex, or one point to stay and hit it again.
  let cost: number;
  if (again) {
    cost = 1;
  } else {
    const t = terrainAt(map, target, state.terrainOverrides);
    const entry = entryCost(t, mobilityOf(rammer));
    if (entry.cost === null) return no(entry.reason ?? 'that hex is impassable');
    cost = entry.cost;
  }

  const allowance = movementAllowance(rammer, state.phase);
  if (rammer.moveUsed + cost > allowance) return no('not enough movement left to ram');

  // --- Who may ram what --------------------------------------------------
  if (ramsLikeAnOgre(rammer)) {
    if (isOgre(victim)) {
      const ogre = rammer as OgreUnit;
      if (isOgre(rammer) && ogre.rammedOgreThisTurn) return no('one enemy Ogre per turn (6.01.1)');
      if (isOgre(rammer) && ogre.ramsThisTurn > 0) {
        return no('an Ogre rams either two ordinary units or one Ogre, not both');
      }
      return { ok: true, cost, victim, kind: 'ogreVsOgre' };
    }
    if (isOgre(rammer) && rammer.ramsThisTurn >= 2) return no('two rams per turn (6.01.1)');
    const structure = victim.kind === 'unit' && unitClass(victim.classId).kind === 'structure';
    return { ok: true, cost, victim, kind: structure ? 'ogreVsCP' : 'ogreVsArmor' };
  }

  if (isOgre(victim)) return { ok: true, cost, victim, kind: 'armorVsOgre' };

  // "GEVs ... When ramming other units, the GEV is always destroyed." (6.07.3)
  if (isGev(rammer)) return { ok: true, cost, victim, kind: 'gevVsUnit' };

  return no('this unit is too slow or too light to ram anything but an Ogre');
};

export interface RamOutcome {
  readonly state: GameState;
  readonly ok: boolean;
  readonly reason?: string;
}

export const resolveRam = (
  state: GameState,
  map: GameMap,
  rammerId: UnitId,
  target: Hex,
): RamOutcome => {
  const rammer = state.units[rammerId];
  if (!rammer) return { state, ok: false, reason: 'no such unit' };

  const check = canRam(state, map, rammer, target);
  if (!check.ok || !check.victim) return { state, ok: false, reason: check.reason };

  const victim = check.victim;
  let next = updateAnyUnit(state, rammerId, (u) => ({ moveUsed: u.moveUsed + check.cost }));

  switch (check.kind) {
    case 'ogreVsOgre':
      next = ramOgreWithOgre(next, rammerId, victim.id);
      break;
    case 'ogreVsCP':
      next = ramCommandPost(next, map, rammerId, victim.id, target);
      break;
    case 'ogreVsArmor':
      next = ramArmorWithOgre(next, rammerId, victim.id, target);
      break;
    case 'armorVsOgre':
      next = ramOgreWithArmor(next, rammerId, victim.id);
      break;
    case 'gevVsUnit':
      next = ramUnitWithGev(next, map, rammerId, victim.id);
      break;
    default:
      return { state, ok: false, reason: 'that ram is not legal' };
  }

  return { state: next, ok: true };
};

// ---------------------------------------------------------------------------
// An Ogre rams an armour unit (6.02)
// ---------------------------------------------------------------------------

const ramArmorWithOgre = (
  state: GameState,
  rammerId: UnitId,
  victimId: UnitId,
  target: Hex,
): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId]!;
  if (victim.kind !== 'unit') return state;

  const cls = unitClass(victim.classId);
  let next = state;

  // The Superheavy is not disabled or destroyed by a ram; it takes a 1-1 attack.
  if (victim.classId === 'SHVY') {
    const treadLoss = ogreRamsArmorSelfLoss('SHVY');
    next = spendTreads(next, rammerId, treadLoss, victim.owner);
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    const result = resolve({ kind: 'column', column: '1-1' }, die.value, 'normal');
    next = log(
      next,
      'warn',
      `${unitName(rammer)} slams into the Superheavy — 1 to 1, rolled ${die.value}.`,
      [target],
    );
    if (result === 'X') next = destroyUnit(next, victimId, 'rammed', rammer.owner);
    else if (result === 'D') next = disable(next, victimId);
    return afterOgreRam(next, rammerId, target, victimId);
  }

  // "Any immobile armor unit (a Howitzer or any disabled unit) is destroyed if
  // rammed."
  const immobile = cls.mobility === 'immobile' || victim.disabled !== 'none' || victim.stuck;
  const treadLoss = ogreRamsArmorSelfLoss(victim.classId);
  next = spendTreads(next, rammerId, treadLoss, victim.owner);

  if (immobile) {
    next = destroyUnit(next, victimId, 'rammed', rammer.owner);
    next = log(next, 'good', `${unitName(rammer)} crushes ${unitName(victim)}.`, [target]);
    return afterOgreRam(next, rammerId, target, victimId);
  }

  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };
  const result = ogreRamResult(die.value);

  // "Infantry riding armor units are subject to the same die roll as the armor
  // unit ... On a 1-3, it is reduced by one squad; on a 4-6, it is destroyed."
  // (6.02.1) Riders are dismounted into the hex if they survive.
  next = resolveRiders(next, victimId, result === 'X', rammer.owner);

  if (result === 'X') {
    next = destroyUnit(next, victimId, 'rammed', rammer.owner);
    next = log(
      next,
      'good',
      `${unitName(rammer)} rams ${unitName(victim)} flat (rolled ${die.value}).`,
      [target],
    );
  } else {
    next = disable(next, victimId);
    next = log(
      next,
      'warn',
      `${unitName(rammer)} rams ${unitName(victim)} — disabled (rolled ${die.value}).`,
      [target],
    );
  }

  return afterOgreRam(next, rammerId, target, victimId);
};

/**
 * Move the Ogre in, count the ram, and honour 6.04: "if loss of tread units due
 * to the ram reduced the Ogre's movement points, it may move only the reduced
 * number of hexes that turn."
 */
const afterOgreRam = (
  state: GameState,
  rammerId: UnitId,
  target: Hex,
  victimId: UnitId,
): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId];
  const blocked = victim && onBoard(victim) && !eq(rammer.pos, target);

  const next = updateAnyUnit(state, rammerId, (u) => ({
    // The Ogre enters the hex it rammed; a surviving disabled unit shares it
    // with the Ogre, which is exactly the situation 6.08 describes.
    pos: eq(u.pos, target) ? u.pos : target,
    ramsThisTurn: (u as OgreUnit).ramsThisTurn + 1,
  }));

  if (blocked) {
    // Nothing special: the Ogre and the wreck share the hex. Left explicit so
    // the intent is not mistaken for an oversight.
  }
  return next;
};

// ---------------------------------------------------------------------------
// An Ogre rams a Command Post (6.03)
// ---------------------------------------------------------------------------

const ramCommandPost = (
  state: GameState,
  map: GameMap,
  rammerId: UnitId,
  victimId: UnitId,
  target: Hex,
): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId]!;
  // "The Ogre loses a number of tread units equal to the defense strength of
  // the CP. For a standard CP, this is zero!"
  const loss = defenseOf(state, map, victim);
  let next = spendTreads(state, rammerId, loss, victim.owner);
  next = destroyUnit(next, victimId, 'rammed', rammer.owner);
  next = log(
    next,
    'good',
    `${unitName(rammer)} drives straight over the command post` +
      (loss > 0 ? `, losing ${loss} tread units.` : '.'),
    [target],
  );
  return afterOgreRam(next, rammerId, target, victimId);
};

// ---------------------------------------------------------------------------
// Ogre versus Ogre (6.05)
// ---------------------------------------------------------------------------

const ramOgreWithOgre = (state: GameState, rammerId: UnitId, victimId: UnitId): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId]!;
  const attackerSize = ramSize(rammer);
  const targetSize = ramSize(victim);

  // The ramming Ogre pays first, and stops where it stood.
  const selfLoss = ogreRamsOgreSelfLoss(attackerSize, targetSize);
  let next = spendTreads(state, rammerId, selfLoss, victim.owner);

  const profile = ramProfileFor(attackerSize);
  const dice = profile.diceToOgre ?? 1;
  const roll = rollDice(next.rng, dice);
  next = { ...next, rng: roll.state };
  const damage = roll.values.reduce((a, b) => a + b, 0);

  next = spendTreads(next, victimId, damage, rammer.owner);
  next = log(
    next,
    'good',
    `${unitName(rammer)} rams ${unitName(victim)}: ${dice} dice for ${damage} tread units ` +
      `(and ${selfLoss} of its own).`,
    [victim.pos],
  );

  // "The ramming Ogre immediately ends its movement for that turn in the last
  // hex it occupied before ramming."
  next = updateAnyUnit(next, rammerId, (u) => ({
    movementEnded: true,
    ramsThisTurn: (u as OgreUnit).ramsThisTurn + 1,
    rammedOgreThisTurn: true,
  }));

  next = checkOgreDeath(next, { kind: 'ogreTreads', unit: victimId }, rammer.owner);
  next = checkOgreDeath(next, { kind: 'ogreTreads', unit: rammerId }, victim.owner);
  return next;
};

// ---------------------------------------------------------------------------
// Conventional armour rams an Ogre (6.07.2)
// ---------------------------------------------------------------------------

const ramOgreWithArmor = (state: GameState, rammerId: UnitId, victimId: UnitId): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId]!;
  if (rammer.kind !== 'unit') return state;

  const profile = ramProfileFor(unitClass(rammer.classId).size, rammer.classId);
  let treads = profile.treadsToOgre ?? 1;

  // A Superheavy "may ram Ogres or other vehicles as if it were an Ogre Mark
  // I", so it rolls a die rather than doing flat damage — and takes a 1-1
  // attack for its trouble (6.07.1).
  if (rammer.classId === 'SHVY') {
    const roll = rollDice(state.rng, ramProfileFor(5).diceToOgre ?? 1);
    treads = roll.values.reduce((a, b) => a + b, 0);
    state = { ...state, rng: roll.state };
  }

  let next = spendTreads(state, victimId, treads, rammer.owner);
  next = log(
    next,
    'warn',
    `${unitName(rammer)} throws itself at ${unitName(victim)} for ${treads} tread unit${treads === 1 ? '' : 's'}.`,
    [victim.pos],
  );

  if (rammer.classId === 'SHVY') {
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    const result = resolve({ kind: 'column', column: '1-1' }, die.value, 'normal');
    if (result === 'X')
      next = destroyUnit(next, rammerId, 'destroyed ramming an Ogre', victim.owner);
    else if (result === 'D') next = disable(next, rammerId);
  } else {
    // "The armor unit is destroyed." Riders choose to dismount; those that do
    // not are destroyed with it (6.07.2).
    next = destroyUnit(next, rammerId, 'destroyed ramming an Ogre', victim.owner);
  }

  return checkOgreDeath(next, { kind: 'ogreTreads', unit: victimId }, rammer.owner);
};

// ---------------------------------------------------------------------------
// A GEV rams something that is not an Ogre (6.07.3)
// ---------------------------------------------------------------------------

const ramUnitWithGev = (
  state: GameState,
  map: GameMap,
  rammerId: UnitId,
  victimId: UnitId,
): GameState => {
  const rammer = state.units[rammerId]!;
  const victim = state.units[victimId]!;
  if (rammer.kind !== 'unit') return state;

  // "The other unit suffers an attack of twice the GEV's normal attack strength
  // (it is assumed the GEV is firing its weapons as it rams)."
  const riders = Object.values(state.units).filter(
    (u) => u.kind === 'unit' && !u.destroyed && u.ridingOn === rammerId,
  );
  const riderStrength = riders.reduce(
    (n, r) => n + (r.kind === 'unit' ? unitClass(r.classId).attack * r.squads : 0),
    0,
  );
  const strength = unitClass(rammer.classId).attack * 2 + riderStrength;
  const defense = defenseOf(state, map, victim);
  const odds = oddsFor(strength, defense);

  let next = state;
  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };
  const result = odds.kind === 'none' ? 'NE' : resolve(odds, die.value, 'normal');

  next = log(
    next,
    'warn',
    `${unitName(rammer)} rams ${unitName(victim)} at ${strength} against ${defense} — rolled ${die.value}.`,
    [victim.pos],
  );

  if (result === 'X') next = destroyUnit(next, victimId, 'rammed by a GEV', rammer.owner);
  else if (result === 'D') next = disable(next, victimId);

  // "the GEV is always destroyed."
  return destroyUnit(next, rammerId, 'destroyed ramming', victim.owner);
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Take tread units off an Ogre, and award the points for them (1.09.1). */
const spendTreads = (
  state: GameState,
  ogreId: UnitId,
  amount: number,
  credit?: string,
): GameState => {
  const u = state.units[ogreId];
  if (!u || !isOgre(u) || amount <= 0) return state;
  const lost = Math.min(u.treads, amount);
  let next = withUnit(state, { ...u, treads: u.treads - lost });
  if (credit) next = addPoints(next, credit, lost);
  return next;
};

const disable = (state: GameState, id: UnitId): GameState => {
  const u = state.units[id];
  if (!u || u.kind !== 'unit') return state;
  if (u.disabled !== 'none') return destroyUnit(state, id, 'destroyed while disabled');
  return withUnit(state, {
    ...u,
    disabled: 'combat',
    disabledAt: state.turn * state.playerOrder.length + state.activePlayerIndex,
  });
};

/**
 * "Infantry riding armor units are subject to the same die roll as the armor
 * unit ... Any infantry riding externally that survive the ram are
 * automatically dismounted into the same hex." (6.02.1)
 */
const resolveRiders = (
  state: GameState,
  carrierId: UnitId,
  destroyed: boolean,
  credit: string,
): GameState => {
  let next = state;
  for (const rider of Object.values(state.units)) {
    if (rider.kind !== 'unit' || rider.destroyed || rider.ridingOn !== carrierId) continue;
    if (destroyed) {
      next = destroyUnit(next, rider.id, 'lost with its transport', credit);
    } else {
      const points = unitClass(rider.classId).vp;
      next = updateAnyUnit(next, rider.id, (u) => ({
        squads: Math.max(0, (u as { squads: number }).squads - 1),
        ridingOn: undefined,
      }));
      const after = next.units[rider.id];
      if (after && after.kind === 'unit' && after.squads <= 0) {
        next = destroyUnit(next, rider.id, 'crushed', credit);
      } else {
        next = addPoints(next, credit, points);
      }
    }
  }
  return next;
};

/** Movement an Ogre has left right now, after any treads lost this phase (6.04). */
export const remainingOgreMovement = (u: OgreUnit): number =>
  Math.max(0, movementForTreads(ogreType(u.typeId), u.treads) - u.moveUsed);

/** Victory points an enemy scores for wrecking this unit; re-exported for the shell. */
export { victoryValue };
