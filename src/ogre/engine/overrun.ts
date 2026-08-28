/**
 * Overrun combat (Section 8).
 *
 * "Overrun combat uses the combat rules described above, but takes place during
 * the movement phase. Units in an overrun may fire multiple times during a
 * turn, rather than the one-shot-per-turn rule of 7.05."
 *
 * Three things make it a different game from the fire phase, and they are the
 * shape of this file:
 *
 *  - **It is a sub-turn with its own initiative.** "The defender has the first
 *    fire round" (8.04) — the only decision in Ogre a non-phasing player makes.
 *    Rounds alternate until one side is gone.
 *  - **Results are brutal.** "treat any D or X result to non-Ogre units as an
 *    X" (7.11.2). Nothing is disabled in an overrun; it is destroyed.
 *  - **Strengths are not the printed ones.** Infantry, Ogre weapons and
 *    Superheavy antipersonnel guns double; disabled units fire at half; a
 *    command post finds a strength of 1 it does not otherwise have (8.02).
 *
 * Ramming and overrunning are alternatives, never both: "Players should decide
 * in advance whether they will use the (fast, simple) Ramming rules ... or the
 * (more realistic and complex) Overrun Combat rules described here. Do not use
 * both!" (6.00) `GameOptions.overrunCombat` is that decision.
 */

import { type Hex, distance, eq } from './hex.js';
import { type GameMap, inBounds, terrainAt } from './map.js';
import { rollDie } from './rng.js';
import { type Odds, describeOdds, oddsFor, resolve } from './crt.js';
import { OGRE_WEAPONS } from './ogres.js';
import { entryCost } from './terrain.js';
import { unitClass } from './units.js';
import {
  type AttackerRef,
  type GameState,
  type OverrunParticipant,
  type OverrunSide,
  type OverrunState,
  type PlayerId,
  type TargetRef,
  type Unit,
  type UnitId,
  isOgre,
  onBoard,
  unitsAt,
} from './types.js';
import {
  attackerStrength,
  defenseOf,
  destroyUnit,
  isFireable,
  log,
  makeUnit,
  movementAllowance,
  ogreDamageValue,
  ogreIsDestroyed,
  printedDefense,
  unitName,
  updateAnyUnit,
  withUnit,
} from './state.js';
import { mobilityOf } from './mobility.js';
import { describeTarget, targetHex } from './combat.js';
import { canRam, resolveRam } from './ram.js';

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

export interface OverrunCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly cost: number;
}

const no = (reason: string): OverrunCheck => ({ ok: false, reason, cost: 0 });

/** Whether this unit may overrun that hex, and what entering it costs. */
export const canOverrun = (
  state: GameState,
  map: GameMap,
  mover: Unit,
  target: Hex,
): OverrunCheck => {
  if (!state.options.overrunCombat)
    return no('this game uses the ramming rules, not overrun (6.00)');
  if (state.overrun) return no('an overrun is already being fought');
  if (state.phase !== 'movement' && state.phase !== 'gevMovement') {
    return no('overruns happen during a movement phase');
  }
  if (!onBoard(mover)) return no('that unit is gone');
  if (mover.kind === 'unit' && mover.disabled !== 'none') {
    return no('a disabled unit cannot start an overrun');
  }
  if (mover.kind === 'unit' && mover.ridingOn) return no('that infantry is riding');
  if (distance(mover.pos, target) !== 1) return no('overrun an adjacent hex');
  if (!inBounds(map, target)) return no('there is nothing off the map to overrun');

  const enemies = unitsAt(state, target).filter((u) => u.owner !== mover.owner);
  if (enemies.length === 0) return no('nothing there to overrun');

  const terrain = terrainAt(map, target, state.terrainOverrides);
  const entry = entryCost(terrain, mobilityOf(mover));
  if (entry.cost === null) return no(entry.reason ?? 'that hex is impassable');

  const allowance = movementAllowance(mover, state.phase);
  // 5.09's minimum move still applies: a unit that has not moved may always
  // take one hex, and an overrun is a hex like any other.
  const affordable = mover.moveUsed + entry.cost <= allowance || mover.moveUsed === 0;
  if (!affordable) return no('not enough movement left to overrun');

  return { ok: true, cost: entry.cost };
};

/**
 * Move in and set the combat up.
 *
 * "all units in that hex (on both sides) are removed to a spot beside the board
 * and all infantry units are divided into 1-squad counters" (8.04) — so a
 * three-squad counter fights, and dies, as three separate units. They are left
 * split afterwards; 5.02.3 lets their owner recombine them on their own
 * movement phase.
 */
export const beginOverrun = (
  state: GameState,
  map: GameMap,
  moverId: UnitId,
  target: Hex,
): { state: GameState; ok: boolean; reason?: string } => {
  const mover = state.units[moverId];
  if (!mover) return { state, ok: false, reason: 'no such unit' };

  const check = canOverrun(state, map, mover, target);
  if (!check.ok) return { state, ok: false, reason: check.reason };

  const defender = unitsAt(state, target).find((u) => u.owner !== mover.owner)!.owner;

  let next = updateAnyUnit(state, moverId, (u) => ({
    pos: target,
    moveUsed: u.moveUsed + check.cost,
  }));
  for (const rider of Object.values(next.units)) {
    if (rider.kind === 'unit' && onBoard(rider) && rider.ridingOn === moverId) {
      next = updateAnyUnit(next, rider.id, () => ({ pos: target }));
    }
  }

  // Turn sequence step 2(a): units that trigger an overrun roll for terrain
  // *before* the combat, so a bogged-down attacker fights at half strength
  // rather than not at all.
  next = resolveEntryHazard(next, moverId);

  next = splitInfantryIn(next, target);

  const participants: OverrunParticipant[] = unitsAt(next, target).map((u) => ({
    unit: u.id,
    side: u.owner === mover.owner ? 'attacker' : 'defender',
    fired: false,
    weaponsFired: [],
    rammed: false,
    disarmedFor: null,
  }));

  const overrun: OverrunState = {
    hex: target,
    attacker: mover.owner,
    defender,
    step: 'dismount',
    firing: 'defender',
    round: 1,
    participants,
    mover: moverId,
  };

  next = { ...next, overrun };
  return {
    state: log(next, 'warn', `${unitName(mover)} overruns the hex. The defender fires first.`, [
      target,
    ]),
    ok: true,
  };
};

const resolveEntryHazard = (state: GameState, id: UnitId): GameState => {
  const u = state.units[id];
  if (!u || !u.pendingHazard) return state;
  const roll = rollDie(state.rng);
  let next: GameState = { ...state, rng: roll.state };
  const bogged = roll.value <= 2;
  next = updateAnyUnit(next, id, () => ({ pendingHazard: null }));
  if (!bogged) return next;

  if (u.pendingHazard === 'stuck') {
    next = updateAnyUnit(next, id, () => ({ stuck: true }));
    return log(next, 'bad', `${unitName(u)} bogs down as it charges in.`, [u.pos]);
  }
  next = updateAnyUnit(next, id, () => ({ disabled: 'terrain' }));
  return log(next, 'warn', `${unitName(u)} is disabled charging in, and fights at half.`, [u.pos]);
};

const splitInfantryIn = (state: GameState, hex: Hex): GameState => {
  let next = state;
  let serial = next.nextUnitSerial;

  for (const u of unitsAt(state, hex)) {
    if (u.kind !== 'unit' || unitClass(u.classId).kind !== 'infantry') continue;
    if (u.squads <= 1) continue;
    const extra = u.squads - 1;
    next = withUnit(next, { ...u, squads: 1 });
    for (let i = 0; i < extra; i++) {
      const piece = makeUnit(`${u.owner}-sq-${serial++}`, u.owner, u.classId, hex, 1);
      next = withUnit(next, {
        ...piece,
        disabled: u.disabled,
        disabledAt: u.disabledAt,
        ridingOn: u.ridingOn,
        movementEnded: u.movementEnded,
        moveUsed: u.moveUsed,
      });
    }
  }
  return { ...next, nextUnitSerial: serial };
};

// ---------------------------------------------------------------------------
// Strengths and defences (8.02, 8.03)
// ---------------------------------------------------------------------------

/**
 * What one gun contributes to an overrun attack.
 *
 * "Attack strengths of infantry and Ogre weapons, and of the AP weapons of
 * Superheavy Tanks, are doubled in overrun attacks, whether they belong to the
 * attacker or the defender. Disabled units ... may fire at half its printed
 * attack strength (not rounded). Any CP has an attack strength of 1 in an
 * overrun (1/2 if it is disabled). All other units have normal attack
 * strengths." (8.02)
 *
 * The two multipliers compose rather than cancelling, which the rules make a
 * point of: "If a disabled Superheavy is overrun, its AP guns are halved
 * because it's disabled and doubled because it's an overrun, so they fire at
 * normal strength."
 */
export const overrunStrength = (u: Unit, ref: AttackerRef): number => {
  let strength: number;
  let doubled: boolean;

  if (isOgre(u)) {
    strength = attackerStrength(u, ref);
    doubled = true;
  } else {
    const cls = unitClass(u.classId);
    if (cls.kind === 'structure') {
      // A command post has no attack strength anywhere else in the game.
      strength = 1;
      doubled = false;
    } else if (ref.antipersonnel) {
      strength = cls.ap ?? 0;
      doubled = true;
    } else {
      strength = attackerStrength(u, ref);
      doubled = cls.kind === 'infantry';
    }
  }

  if (doubled) strength *= 2;
  if (u.kind === 'unit' && u.disabled !== 'none') strength /= 2;
  return strength;
};

/**
 * "Defending units in an overrun attack get their normal defensive multipliers,
 * if any, for the terrain in that hex. The attacker in an overrun does not get
 * any bonus; all attacking units defend at their printed strengths." (8.03)
 */
export const overrunDefense = (
  state: GameState,
  map: GameMap,
  u: Unit,
  side: OverrunSide,
): number => {
  if (side === 'defender') return defenseOf(state, map, u);
  if (u.kind !== 'unit') return 0;
  const printed = printedDefense(u);
  // A D0 unit is still automatically destroyed; terrain is what would have
  // floored it to 1, and the attacker does not get terrain.
  return printed;
};

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

const participantOf = (overrun: OverrunState, id: UnitId): OverrunParticipant | undefined =>
  overrun.participants.find((p) => p.unit === id);

export interface OverrunPreview {
  readonly ok: boolean;
  readonly reason?: string;
  readonly attackStrength: number;
  readonly defenseStrength: number;
  readonly odds: Odds;
  readonly treadAttack: boolean;
  readonly summary: string;
}

const denyPreview = (reason: string): OverrunPreview => ({
  ok: false,
  reason,
  attackStrength: 0,
  defenseStrength: 0,
  odds: { kind: 'none' },
  treadAttack: false,
  summary: reason,
});

export const previewOverrunAttack = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
): OverrunPreview => {
  const overrun = state.overrun;
  if (!overrun) return denyPreview('no overrun is being fought');
  if (overrun.step !== 'fire') return denyPreview('the overrun has not started firing yet');
  if (attackers.length === 0) return denyPreview('nothing is firing');

  const targetUnit =
    target.kind === 'terrain' || target.kind === 'building' ? undefined : state.units[target.unit];
  if (!targetUnit || !onBoard(targetUnit)) return denyPreview('no such target');

  const victim = participantOf(overrun, targetUnit.id);
  if (!victim) return denyPreview('that unit is not in this overrun');
  if (victim.side === overrun.firing) return denyPreview('that is one of yours');

  const isTreads = target.kind === 'ogreTreads';
  if (isTreads && new Set(attackers.map((a) => a.unit)).size > 1) {
    return denyPreview('treads are attacked by one unit at a time (7.13.2)');
  }

  let total = 0;
  for (const ref of attackers) {
    const u = state.units[ref.unit];
    if (!u || !onBoard(u)) return denyPreview('an attacker is gone');
    const p = participantOf(overrun, u.id);
    if (!p) return denyPreview(`${unitName(u)} is not in this overrun`);
    if (p.side !== overrun.firing) return denyPreview('it is not that side’s fire round');

    if (isOgre(u)) {
      const w = u.weapons.find((x) => x.id === ref.weapon);
      if (!w) return denyPreview('no such weapon');
      if (!isFireable(u, w)) return denyPreview('that weapon has nothing left to fire');
      if (p.weaponsFired.includes(w.id)) return denyPreview('that weapon has fired this round');
      // "A missile rack can fire only one missile per turn. Once an Ogre uses a
      // missile rack, it may not use it in subsequent fire rounds that turn."
      // (8.05.4) `fired` is the per-turn flag, cleared at the start of a turn.
      if (w.kind === 'missileRack' && w.fired) {
        return denyPreview('that missile rack has already fired this turn');
      }
    } else if (p.fired) {
      return denyPreview(`${unitName(u)} has fired this round`);
    }

    total += overrunStrength(u, ref);
  }

  if (total <= 0) return denyPreview('that has no attack strength');

  if (isTreads) {
    return {
      ok: true,
      attackStrength: total,
      defenseStrength: total,
      odds: { kind: 'column', column: '1-1' },
      treadAttack: true,
      summary: `1 to 1 on the treads — a 5 or 6 costs ${total} tread units`,
    };
  }

  let defense: number;
  if (target.kind === 'ogreWeapon') {
    if (!isOgre(targetUnit)) return denyPreview('that is not an Ogre');
    const weapon = targetUnit.weapons.find((w) => w.id === target.weapon);
    if (!weapon || weapon.destroyed) return denyPreview('that weapon is already gone');
    defense = OGRE_WEAPONS[weapon.kind].defense;
  } else {
    if (isOgre(targetUnit)) return denyPreview('name a weapon or the treads (7.13)');
    defense = overrunDefense(state, map, targetUnit, victim.side);
  }

  const odds = oddsFor(total, defense);
  if (odds.kind === 'none') {
    return denyPreview(`${total} against ${defense} is worse than 1 to 2 — no effect`);
  }
  return {
    ok: true,
    attackStrength: total,
    defenseStrength: defense,
    odds,
    treadAttack: false,
    summary: `${total} against ${defense}: ${describeOdds(odds)}`,
  };
};

export const resolveOverrunAttack = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
): { state: GameState; ok: boolean; reason?: string } => {
  const preview = previewOverrunAttack(state, map, attackers, target);
  if (!preview.ok) return { state, ok: false, reason: preview.reason };

  const overrun = state.overrun!;
  const shooter = state.units[attackers[0]!.unit]!;
  let next = markFired(state, attackers);

  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };

  const victimId = (target as { unit: UnitId }).unit;
  const victim = next.units[victimId]!;

  // Treads never touch the odds ladder, in an overrun as anywhere else.
  if (preview.treadAttack) {
    const hit = die.value >= 5;
    if (hit && isOgre(victim)) {
      const lost = Math.min(victim.treads, preview.attackStrength);
      next = withUnit(next, { ...victim, treads: victim.treads - lost });
      next = log(
        next,
        'good',
        `Point-blank fire strips ${lost} tread units off ${unitName(victim)} (rolled ${die.value}).`,
        [overrun.hex],
      );
    } else {
      next = log(next, 'info', `The treads hold (rolled ${die.value}).`, [overrun.hex]);
    }
    return { state: reapOverrun(next, map), ok: true };
  }

  // "treat any D or X result to non-Ogre units as an X. Only a true X affects
  // an Ogre, though." (7.11.2)
  const raw = resolve(preview.odds, die.value, 'normal');
  const targetsAnOgre = target.kind === 'ogreWeapon' || isOgre(victim);
  const result = targetsAnOgre ? raw : resolve(preview.odds, die.value, 'overrun');

  next = log(
    next,
    result === 'NE' ? 'info' : 'good',
    `${unitName(shooter)} fires on ${describeTarget(next, target)} at ` +
      `${describeOdds(preview.odds)} — rolled ${die.value}: ${result === 'NE' ? 'no effect' : 'destroyed'}.`,
    [targetHex(next, target) ?? overrun.hex],
  );

  if (result === 'X') {
    if (target.kind === 'ogreWeapon' && isOgre(victim)) {
      const weapon = victim.weapons.find((w) => w.id === target.weapon)!;
      next = withUnit(next, {
        ...victim,
        weapons: victim.weapons.map((w) => (w.id === weapon.id ? { ...w, destroyed: true } : w)),
        internalMissiles:
          weapon.kind === 'missileRack'
            ? Math.max(0, victim.internalMissiles - 1)
            : victim.internalMissiles,
      });
      next = addPointsFor(next, shooter.owner, ogreDamageValue(weapon.kind));
    } else {
      // No spillover: "no spillover fire is calculated in an overrun" (7.12.2).
      next = destroyUnit(next, victimId, 'destroyed in an overrun', shooter.owner);
    }
  }

  return { state: reapOverrun(next, map), ok: true };
};

const addPointsFor = (state: GameState, player: PlayerId, points: number): GameState => {
  const p = state.players[player];
  if (!p || points === 0) return state;
  return {
    ...state,
    players: { ...state.players, [player]: { ...p, victoryPoints: p.victoryPoints + points } },
  };
};

const markFired = (state: GameState, attackers: readonly AttackerRef[]): GameState => {
  const overrun = state.overrun!;
  let next = state;
  const participants = overrun.participants.map((p) => {
    const refs = attackers.filter((a) => a.unit === p.unit);
    if (refs.length === 0) return p;
    const weapons = refs.map((r) => r.weapon).filter((w): w is string => !!w);
    return {
      ...p,
      fired: weapons.length === 0 ? true : p.fired,
      weaponsFired: [...p.weaponsFired, ...weapons],
    };
  });

  // A missile rack is spent for the whole turn, not just the round (8.05.4).
  for (const ref of attackers) {
    const u = next.units[ref.unit];
    if (!u || !isOgre(u) || !ref.weapon) continue;
    const w = u.weapons.find((x) => x.id === ref.weapon);
    if (!w) continue;
    if (w.kind === 'missileRack') {
      next = withUnit(next, {
        ...u,
        weapons: u.weapons.map((x) => (x.id === w.id ? { ...x, fired: true } : x)),
        internalMissiles: Math.max(0, u.internalMissiles - 1),
      });
    } else if (w.kind === 'missile') {
      next = withUnit(next, {
        ...u,
        weapons: u.weapons.map((x) => (x.id === w.id ? { ...x, fired: true } : x)),
      });
    }
  }

  return { ...next, overrun: { ...overrun, participants } };
};

// ---------------------------------------------------------------------------
// Ramming inside an overrun (8.05.2, 8.05.3)
// ---------------------------------------------------------------------------

export const overrunRam = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  targetId: UnitId,
): { state: GameState; ok: boolean; reason?: string } => {
  const overrun = state.overrun;
  if (!overrun) return { state, ok: false, reason: 'no overrun is being fought' };

  const p = participantOf(overrun, unitId);
  const victim = participantOf(overrun, targetId);
  if (!p || !victim) return { state, ok: false, reason: 'both must be in this overrun' };
  if (p.side !== overrun.firing) return { state, ok: false, reason: 'not your fire round' };
  if (p.rammed) return { state, ok: false, reason: 'that unit has already rammed' };
  // "at the end of its first fire round" — so it has to have fired, or at least
  // had the chance, and only once per overrun.
  if (overrun.round > 1)
    return { state, ok: false, reason: 'ramming happens in the first fire round' };

  const rammer = state.units[unitId];
  const target = state.units[targetId];
  if (!rammer || !target) return { state, ok: false, reason: 'no such unit' };
  if (target.kind === 'unit' && unitClass(target.classId).kind === 'infantry') {
    return { state, ok: false, reason: 'infantry can never be rammed (6.07)' };
  }

  // The ram itself is the ordinary one; only the timing is special. `canRam`
  // refuses when the game is set to overrun combat, so the check is done here
  // and the resolution is reused.
  const check = canRam(
    { ...state, options: { ...state.options, overrunCombat: false } },
    map,
    rammer,
    target.pos,
  );
  if (!check.ok) return { state, ok: false, reason: check.reason };

  const outcome = resolveRam(
    { ...state, options: { ...state.options, overrunCombat: false } },
    map,
    unitId,
    target.pos,
  );
  if (!outcome.ok) return { state, ok: false, reason: outcome.reason };

  const marked: GameState = {
    ...outcome.state,
    options: state.options,
    overrun: {
      ...overrun,
      participants: overrun.participants.map((x) =>
        x.unit === unitId ? { ...x, rammed: true } : x,
      ),
    },
  };
  return { state: reapOverrun(marked, map), ok: true };
};

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * End the firing side's round.
 *
 * Also the point at which 8.05.1's countdown ticks: an Ogre with nothing left
 * to shoot at leaves the combat "after two further enemy fire rounds".
 */
export const endOverrunRound = (
  state: GameState,
  map: GameMap,
): { state: GameState; ok: boolean; reason?: string } => {
  const overrun = state.overrun;
  if (!overrun) return { state, ok: false, reason: 'no overrun is being fought' };

  if (overrun.step === 'dismount') {
    return {
      state: { ...state, overrun: { ...overrun, step: 'fire' } },
      ok: true,
    };
  }

  const nextSide: OverrunSide = overrun.firing === 'defender' ? 'attacker' : 'defender';
  const round = nextSide === 'defender' ? overrun.round + 1 : overrun.round;

  const participants = overrun.participants.map((p) => {
    // The side about to fire gets its weapons back.
    const refreshed = p.side === nextSide ? { ...p, fired: false, weaponsFired: [] } : p;
    // The countdown ticks for an Ogre on the side that has just been fired at.
    if (refreshed.disarmedFor !== null && refreshed.side !== overrun.firing) {
      return { ...refreshed, disarmedFor: refreshed.disarmedFor + 1 };
    }
    return refreshed;
  });

  const advanced: GameState = {
    ...state,
    overrun: { ...overrun, firing: nextSide, round, participants },
  };
  return { state: reapOverrun(advanced, map), ok: true };
};

/**
 * Tidy up after anything that might have ended the combat: remove the dead,
 * start or finish the disarmed-Ogre countdown, and close the overrun when one
 * side has nothing left in the hex.
 */
const reapOverrun = (state: GameState, map: GameMap): GameState => {
  const overrun = state.overrun;
  if (!overrun) return state;

  let participants = overrun.participants.filter((p) => {
    const u = state.units[p.unit];
    return !!u && onBoard(u);
  });

  // 8.05.1: an Ogre that has run out of weapons with valid targets starts a
  // two-round countdown, then withdraws from the combat and stays in the hex.
  const leaving: UnitId[] = [];
  participants = participants.map((p) => {
    const u = state.units[p.unit];
    if (!u || !isOgre(u)) return p;
    const armed = u.weapons.some((w) => isFireable(u, w) && !w.destroyed);
    if (!armed && p.disarmedFor === null) return { ...p, disarmedFor: 0 };
    if (!armed && p.disarmedFor !== null && p.disarmedFor >= 2) leaving.push(p.unit);
    return p;
  });
  participants = participants.filter((p) => !leaving.includes(p.unit));

  let next: GameState = { ...state, overrun: { ...overrun, participants } };
  for (const id of leaving) {
    const u = next.units[id];
    if (u)
      next = log(next, 'info', `${unitName(u)} disengages, and stays in the hex.`, [overrun.hex]);
  }

  const attackersLeft = participants.some((p) => p.side === 'attacker');
  const defendersLeft = participants.some((p) => p.side === 'defender');
  if (attackersLeft && defendersLeft) return next;

  return finishOverrun(next, map, attackersLeft ? 'attacker' : defendersLeft ? 'defender' : null);
};

/**
 * "Return all surviving units to the contested hex. The attacker's movement
 * phase continues." (8.08)
 *
 * Nothing has to be moved back, because nothing ever left: the units stayed in
 * the hex throughout and the "spot beside the board" is a convenience for
 * physical play, not a location.
 */
const finishOverrun = (state: GameState, map: GameMap, winner: OverrunSide | null): GameState => {
  const overrun = state.overrun!;
  let next: GameState = { ...state, overrun: null };

  const word =
    winner === 'attacker'
      ? 'The attackers hold the hex.'
      : winner === 'defender'
        ? 'The overrun is thrown back.'
        : 'Nothing is left standing in the hex.';
  next = log(next, winner === 'attacker' ? 'good' : 'bad', word, [overrun.hex]);

  // An Ogre that has lost every weapon and every tread is a wreck, whether or
  // not anything is left to shoot it.
  for (const p of overrun.participants) {
    const u = next.units[p.unit];
    if (u && isOgre(u) && onBoard(u) && ogreIsDestroyed(u)) {
      next = destroyUnit(next, u.id, 'stripped in an overrun');
    }
  }
  void map;
  return next;
};

// ---------------------------------------------------------------------------
// Reads for the interface
// ---------------------------------------------------------------------------

export const overrunUnits = (state: GameState, side: OverrunSide): Unit[] => {
  const overrun = state.overrun;
  if (!overrun) return [];
  return overrun.participants
    .filter((p) => p.side === side)
    .map((p) => state.units[p.unit])
    .filter((u): u is Unit => !!u && onBoard(u));
};

/** Which player is entitled to act right now — not necessarily the phasing one. */
export const overrunActor = (state: GameState): PlayerId | null => {
  const overrun = state.overrun;
  if (!overrun) return null;
  if (overrun.step === 'dismount') return overrun.attacker;
  return overrun.firing === 'attacker' ? overrun.attacker : overrun.defender;
};

export const overrunHasFired = (state: GameState, id: UnitId): boolean => {
  const p = state.overrun ? participantOf(state.overrun, id) : undefined;
  return p ? p.fired : false;
};

export const inOverrunAt = (state: GameState, hex: Hex): boolean =>
  !!state.overrun && eq(state.overrun.hex, hex);
