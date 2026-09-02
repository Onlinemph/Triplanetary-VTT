/**
 * Combat: declaring an attack, resolving it, and applying what comes out.
 *
 * Section 7 is short but every clause of it bites. Four things in particular
 * are not the general case and are handled explicitly below:
 *
 *  - **Ogres are not counters.** "Any unit firing on an Ogre must specify the
 *    target it is attacking: either one specific weapon or the Ogre's tread
 *    units." (7.13) A D result does nothing to any of it.
 *  - **Treads do not use the odds ladder at all.** "each attack must be made by
 *    an individual unit, and always at 1-to-1 odds ... on a roll of 5 or 6 the
 *    Ogre loses a number of tread units equal to the attack strength of the
 *    attacking unit." (7.13.2)
 *  - **AP weapons are not weapons** against anything but infantry and D0
 *    targets, and may only make one attack per infantry counter per phase
 *    (7.05.1).
 *  - **Every attack on a stack spills over** onto everything else in the hex,
 *    at half strength and one step down the results (7.12).
 */

import { distance, eq, key } from './hex.js';
import { type GameMap, terrainAt } from './map.js';
import { rollDie } from './rng.js';
import {
  type DamageResult,
  type Odds,
  applyToTarget,
  describeOdds,
  oddsFor,
  resolve,
} from './crt.js';
import { OGRE_WEAPONS } from './ogres.js';
import { baseTerrain, degradeTerrain, treadHitRollIn } from './terrain.js';
import { mobilityOf } from './mobility.js';
import { unitClass } from './units.js';
import { laserLineOfSight } from './los.js';
import {
  type AttackResolution,
  type AttackerRef,
  type Building,
  type ConventionalUnit,
  type GameState,
  type OgreUnit,
  type TargetRef,
  type Unit,
  type UnitId,
  canAct,
  isInertOgre,
  isOgre,
  onBoard,
  unitsAt,
} from './types.js';
import {
  attackerRange,
  attackerStrength,
  cutRoute,
  defenseOf,
  destroyUnit,
  isFireable,
  log,
  ogreDamageValue,
  ogreIsDestroyed,
  ogreWeaponDefense,
  printedAttack,
  reduceSquad,
  setTerrainOverride,
  unitName,
  updateAnyUnit,
  withUnit,
} from './state.js';

// ---------------------------------------------------------------------------
// Describing a target
// ---------------------------------------------------------------------------

export const targetHex = (state: GameState, target: TargetRef) => {
  switch (target.kind) {
    case 'unit':
    case 'ogreWeapon':
    case 'ogreTreads':
      return state.units[target.unit]?.pos ?? null;
    case 'building':
      return state.buildings[target.building]?.pos ?? null;
    case 'terrain':
      return target.hex;
  }
};

export const describeTarget = (state: GameState, target: TargetRef): string => {
  switch (target.kind) {
    case 'unit': {
      const u = state.units[target.unit];
      return u ? unitName(u) : 'a unit';
    }
    case 'ogreWeapon': {
      const u = state.units[target.unit];
      if (!u || !isOgre(u)) return 'an Ogre weapon';
      const w = u.weapons.find((x) => x.id === target.weapon);
      return w ? `${unitName(u)}’s ${OGRE_WEAPONS[w.kind].name.toLowerCase()}` : 'an Ogre weapon';
    }
    case 'ogreTreads': {
      const u = state.units[target.unit];
      return u ? `${unitName(u)}’s treads` : 'Ogre treads';
    }
    case 'building':
      return state.buildings[target.building]?.kind ?? 'a building';
    case 'terrain':
      return 'the hex itself';
  }
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface AttackPreview {
  readonly ok: boolean;
  readonly reason?: string;
  readonly attackStrength: number;
  readonly defenseStrength: number;
  readonly odds: Odds;
  /** Treads are resolved off the ladder, so the interface must say so (7.13.2). */
  readonly treadAttack: boolean;
  /** The die roll that destroys treads: 5, or 6 in a town (7.14.2). */
  readonly treadHitOn: number;
  /** Structure Point damage, when the target is a building (11.04.1). */
  readonly structureDamage?: number;
  readonly summary: string;
}

const denyPreview = (reason: string): AttackPreview => ({
  ok: false,
  reason,
  attackStrength: 0,
  defenseStrength: 0,
  odds: { kind: 'none' },
  treadAttack: false,
  treadHitOn: 5,
  summary: reason,
});

/**
 * Everything the interface needs to show an attack before it is committed, and
 * everything `resolveAttack` needs to run it. One function, so the two can
 * never disagree about legality.
 */
export const previewAttack = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
): AttackPreview => {
  if (attackers.length === 0) return denyPreview('nothing is firing');

  const where = targetHex(state, target);
  if (!where) return denyPreview('no such target');

  const targetUnit =
    target.kind === 'unit' || target.kind === 'ogreWeapon' || target.kind === 'ogreTreads'
      ? state.units[target.unit]
      : undefined;
  if (targetUnit && !onBoard(targetUnit)) return denyPreview('that target is gone');

  // "Any number of units and/or Ogre weapons may combine their attack strengths
  // into an attack on any single target except Ogre treads." (7.06)
  const isTreads = target.kind === 'ogreTreads';
  if (isTreads) {
    const distinct = new Set(attackers.map((a) => a.unit));
    if (distinct.size > 1) {
      return denyPreview('treads are attacked by one unit at a time (7.13.2)');
    }
  }

  let total = 0;
  let anyAp = false;
  let allAp = true;

  // "The Ninja's weapons may not combine fire with other units" (14.02): a
  // stealth cybertank's guns fire alone, or with each other.
  const ninjaGuns = attackers.filter((a) => {
    const u = state.units[a.unit];
    return !!u && isOgre(u) && u.typeId === 'NINJA';
  }).length;
  if (ninjaGuns > 0 && ninjaGuns !== attackers.length) {
    return denyPreview('a Ninja’s weapons do not combine with other units’ fire (14.02)');
  }

  for (const ref of attackers) {
    const u = state.units[ref.unit];
    if (!u || !onBoard(u)) return denyPreview('an attacker is gone');
    if (!canAct(u)) return denyPreview(`${unitName(u)} is disabled and cannot fire`);
    if (isInertOgre(u, state.turn)) {
      return denyPreview(`${unitName(u)} is still assembling and cannot fire`);
    }

    const range = attackerRange(u, ref);
    if (range <= 0) return denyPreview(`${unitName(u)} has no weapon to fire`);
    if (distance(u.pos, where) > range) return denyPreview(`${unitName(u)} is out of range`);

    // The one weapon in the game with a line of sight (Section 12).
    const laser = u.kind === 'unit' ? unitClass(u.classId).laser : undefined;
    if (laser) {
      const blocked = laserLineOfSight(state, map, u.pos, where, laser);
      if (blocked) return denyPreview(blocked);
    }

    const drowned = waterSilences(state, map, u);
    if (drowned) return denyPreview(drowned);

    const spent = spentReason(state, u, ref, target);
    if (spent) return denyPreview(spent);

    const strength = attackerStrength(u, ref);
    if (strength <= 0) return denyPreview(`${unitName(u)} has no attack strength`);

    const ap = isAntipersonnel(u, ref);
    anyAp ||= ap;
    allAp &&= ap;
    total += strength;
  }

  const submerged = submergedTargetPenalty(state, map, target, attackers);
  if (!submerged.ok) return denyPreview(submerged.reason);
  if (submerged.halved) total /= 2;

  // "AP weapons are useless against anything except infantry, targets with a
  // defense of 0, and other targets as designated in scenarios." (7.05.1)
  if (anyAp) {
    const legal = isAntipersonnelTarget(state, map, target);
    if (!legal) return denyPreview('antipersonnel weapons only hurt infantry and D0 targets');
    if (!allAp) return denyPreview('do not mix antipersonnel guns with real guns in one attack');
  }

  // --- Treads ------------------------------------------------------------
  if (isTreads) {
    const ogre = targetUnit as OgreUnit | undefined;
    if (!ogre || !isOgre(ogre)) return denyPreview('that target has no treads');
    if (anyAp) return denyPreview('antipersonnel weapons cannot damage treads');
    const hitOn = treadHitRollIn(terrainAt(map, ogre.pos, state.terrainOverrides));
    return {
      ok: true,
      attackStrength: total,
      defenseStrength: total,
      odds: { kind: 'column', column: '1-1' },
      treadAttack: true,
      treadHitOn: hitOn,
      summary: `1 to 1 on the treads — ${hitOn === 6 ? 'a 6' : 'a 5 or 6'} destroys ${total} tread unit${total === 1 ? '' : 's'}`,
    };
  }

  // --- Buildings ---------------------------------------------------------
  if (target.kind === 'building') {
    const building = state.buildings[target.building];
    if (!building || building.destroyed) return denyPreview('that building is gone');
    if (anyAp) return denyPreview('AP weapons have no effect on buildings');
    const terrain = baseTerrain(terrainAt(map, building.pos, state.terrainOverrides));
    // "Any weapon does damage equal to twice its attack strength ... If a
    // building is in a town or forest, attacks are halved to normal attack
    // strength." (11.04.1)
    const damage = terrain === 'town' || terrain === 'forest' ? total : total * 2;
    return {
      ok: true,
      attackStrength: total,
      defenseStrength: building.structurePoints,
      odds: { kind: 'auto' },
      treadAttack: false,
      treadHitOn: 5,
      structureDamage: damage,
      summary: `${damage} structure points off ${building.structurePoints}`,
    };
  }

  // --- Terrain -----------------------------------------------------------
  if (target.kind === 'terrain') {
    if (!state.options.terrainDamage) return denyPreview('terrain damage is not in play');
    // "Each hex has a defense strength of 4 and may be attacked separately, as
    // though it were a unit." (13.01)
    const odds = oddsFor(total, 4);
    return {
      ok: true,
      attackStrength: total,
      defenseStrength: 4,
      odds,
      treadAttack: false,
      treadHitOn: 5,
      summary: `${describeOdds(odds)} against the hex`,
    };
  }

  // --- Units and Ogre weapons -------------------------------------------
  let defense: number;
  if (target.kind === 'ogreWeapon') {
    const ogre = targetUnit;
    if (!ogre || !isOgre(ogre)) return denyPreview('that is not an Ogre');
    const weapon = ogre.weapons.find((w) => w.id === target.weapon);
    if (!weapon || weapon.destroyed) return denyPreview('that weapon is already gone');
    defense = ogreWeaponDefense(state, map, ogre, weapon);
  } else {
    if (!targetUnit) return denyPreview('no such target');
    if (isOgre(targetUnit)) {
      return denyPreview('name a weapon or the treads — an Ogre is not one target (7.13)');
    }
    defense = defenseOf(state, map, targetUnit);
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
    treadHitOn: 5,
    summary: `${total} against ${defense}: ${describeOdds(odds)}`,
  };
};

// ---------------------------------------------------------------------------
// Eligibility helpers
// ---------------------------------------------------------------------------

/**
 * Whether being in the water stops this unit shooting (7.14.4).
 *
 * "A GEV on water attacks and defends normally. An Ogre or Superheavy
 * submerged in a water hex may not attack ... Infantry in a water hex may not
 * attack ... Exception: Marines may attack while in water."
 */
const waterSilences = (state: GameState, map: GameMap, u: Unit): string | null => {
  if (baseTerrain(terrainAt(map, u.pos, state.terrainOverrides)) !== 'water') return null;
  const mobility = mobilityOf(u);
  if (mobility === 'ogre') return `${unitName(u)} is submerged and cannot fire`;
  if (mobility === 'infantry' && !(u.kind === 'unit' && u.classId === 'MAR')) {
    return `${unitName(u)} cannot fight while swimming`;
  }
  return null;
};

/**
 * A submerged Ogre or Superheavy "may be attacked only by a ram by another such
 * unit, an overrun by Marines, or by (all at half strength) Howitzers, Mobile
 * Howitzers, and Ogre missiles." (7.14.4)
 */
const submergedTargetPenalty = (
  state: GameState,
  map: GameMap,
  target: TargetRef,
  attackers: readonly AttackerRef[],
): { ok: false; reason: string } | { ok: true; halved: boolean } => {
  if (target.kind === 'terrain' || target.kind === 'building') return { ok: true, halved: false };
  const victim = state.units[target.unit];
  if (!victim) return { ok: true, halved: false };
  const submerged =
    mobilityOf(victim) === 'ogre' &&
    baseTerrain(terrainAt(map, victim.pos, state.terrainOverrides)) === 'water';
  if (!submerged) return { ok: true, halved: false };

  for (const ref of attackers) {
    const shooter = state.units[ref.unit];
    if (!shooter) continue;
    const isHowitzer =
      shooter.kind === 'unit' && (shooter.classId === 'HWZ' || shooter.classId === 'MHWZ');
    const weapon =
      shooter.kind === 'ogre' ? shooter.weapons.find((w) => w.id === ref.weapon) : null;
    const isOgreMissile = weapon?.kind === 'missile' || weapon?.kind === 'missileRack';
    if (!isHowitzer && !isOgreMissile) {
      return {
        ok: false,
        reason: 'only howitzers and Ogre missiles reach something submerged (7.14.4)',
      };
    }
  }
  return { ok: true, halved: true };
};

const isAntipersonnel = (u: Unit, ref: AttackerRef): boolean => {
  // A Superheavy's AP guns are the same weapon by another route (3.01).
  if (ref.antipersonnel) return true;
  if (!isOgre(u)) return false;
  const w = u.weapons.find((x) => x.id === ref.weapon);
  return w ? (OGRE_WEAPONS[w.kind].antipersonnelOnly ?? false) : false;
};

const isAntipersonnelTarget = (state: GameState, map: GameMap, target: TargetRef): boolean => {
  if (target.kind !== 'unit') return false;
  const u = state.units[target.unit];
  if (!u || u.kind !== 'unit') return false;
  if (unitClass(u.classId).kind === 'infantry') return true;
  // "and D0 units such as a regular (unarmored) CP" — the printed defence, not
  // the terrain-modified one, since a town does not armour a command post
  // against a machine gun so much as give it somewhere to hide.
  return unitClass(u.classId).defense === 0 && defenseOf(state, map, u) <= 1;
};

/** Why this attacker cannot fire again, if it cannot (7.05, 7.09). */
const spentReason = (
  state: GameState,
  u: Unit,
  ref: AttackerRef,
  target: TargetRef,
): string | null => {
  if (isOgre(u)) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    if (!w) return 'no such weapon';
    if (w.destroyed) return 'that weapon is destroyed';
    if (!isFireable(u, w)) {
      return w.kind === 'missileRack' ? 'no internal missiles left' : 'that missile is spent';
    }
    if (w.fired) return 'that weapon has already fired this turn';

    // "A unit may not fire AP at the same infantry unit more than once per fire
    // phase ... but any number of AP weapons may be used for that single
    // attack." (7.05.1)
    if (OGRE_WEAPONS[w.kind].antipersonnelOnly && target.kind === 'unit') {
      const already = state.scenarioData['_apFiredAt'];
      if (Array.isArray(already) && already.includes(`${u.id}>${target.unit}`)) {
        return 'this Ogre has already swept that infantry with AP this phase';
      }
    }
    return null;
  }

  if (ref.heavyWeapon) {
    return u.heavyWeaponFired ? 'that heavy weapon is spent' : null;
  }
  const cls = unitClass(u.classId);
  if (cls.kind === 'infantry') {
    const want = Math.max(1, Math.min(u.squads, ref.squads ?? u.squads));
    return u.squadsFired + want > u.squads ? 'those squads have already fired' : null;
  }
  return u.firedThisPhase ? 'that unit has already fired this turn' : null;
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface AttackOutcome {
  readonly state: GameState;
  readonly resolution: AttackResolution | null;
  readonly reason?: string;
}

export const resolveAttack = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
): AttackOutcome => {
  const preview = previewAttack(state, map, attackers, target);
  if (!preview.ok) return { state, resolution: null, reason: preview.reason };

  const firstAttacker = state.units[attackers[0]!.unit]!;
  const attackerOwner = firstAttacker.owner;

  let next = markAttackersSpent(state, attackers, target);

  // Treads bypass the table entirely.
  if (preview.treadAttack) {
    return resolveTreadAttack(next, map, attackers, target, preview, attackerOwner);
  }

  // Buildings take flat damage and never roll (11.04.1).
  if (target.kind === 'building') {
    return resolveBuildingAttack(next, attackers, target, preview, attackerOwner);
  }

  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };

  // "All attacks against the Ninja are made at −1 to the die roll" (14.02).
  const stealth = targetIsNinja(next, target) ? 1 : 0;
  const roll = Math.max(1, die.value - stealth);

  const immuneToD = targetIgnoresD(next, target);
  const raw = resolve(preview.odds, roll, 'normal');
  // An Ogre still assembling treats any D against it as an X — the
  // unfinished-Ogre rule (15.02.2), applied by Orbital Drop §6.
  const result = raw === 'D' && targetInertOgre(next, target) ? 'X' : applyToTarget(raw, immuneToD);

  const resolution: AttackResolution = {
    attackers,
    target,
    attackStrength: preview.attackStrength,
    defenseStrength: preview.defenseStrength,
    column: preview.odds.kind === 'column' ? preview.odds.column : null,
    automatic: preview.odds.kind === 'auto',
    roll: preview.odds.kind === 'auto' ? 0 : roll,
    result,
  };

  next = log(
    next,
    result === 'X' ? 'good' : result === 'D' ? 'warn' : 'info',
    `${describeOdds(preview.odds)} on ${describeTarget(next, target)}` +
      (preview.odds.kind === 'auto'
        ? ' — automatic'
        : ` — rolled ${die.value}${stealth ? ` (−1 for the Ninja: ${roll})` : ''}`) +
      `: ${resultWord(result)}.`,
    [targetHex(next, target) ?? firstAttacker.pos],
  );

  next = applyResult(next, map, target, result, attackerOwner);
  next = applySpillover(next, map, attackers, target, preview.attackStrength, attackerOwner);
  next = checkOgreDeath(next, target, attackerOwner);

  return { state: next, resolution };
};

const resultWord = (r: DamageResult): string =>
  r === 'X' ? 'destroyed' : r === 'D' ? 'disabled' : 'no effect';

/** Whether the target is (part of) an Ogre that has not finished assembling. */
const targetInertOgre = (state: GameState, target: TargetRef): boolean => {
  if (target.kind !== 'unit' && target.kind !== 'ogreWeapon' && target.kind !== 'ogreTreads') {
    return false;
  }
  const u = state.units[target.unit];
  return !!u && isInertOgre(u, state.turn);
};

/** "A D result does not affect the train or Ogres." (7.11) */
const targetIgnoresD = (state: GameState, target: TargetRef): boolean => {
  if (target.kind === 'ogreWeapon' || target.kind === 'ogreTreads') return true;
  if (target.kind === 'unit') {
    const u = state.units[target.unit];
    return !!u && (isOgre(u) || u.classId === 'TRAIN');
  }
  return false;
};

/** Whether the target is (part of) a Ninja, for its −1 to be hit (14.02). */
const targetIsNinja = (state: GameState, target: TargetRef): boolean => {
  if (target.kind !== 'unit' && target.kind !== 'ogreWeapon' && target.kind !== 'ogreTreads') {
    return false;
  }
  const u = state.units[target.unit];
  return !!u && isOgre(u) && u.typeId === 'NINJA';
};

const markAttackersSpent = (
  state: GameState,
  attackers: readonly AttackerRef[],
  target: TargetRef,
): GameState => {
  let next = state;
  for (const ref of attackers) {
    const u = next.units[ref.unit];
    if (!u) continue;
    if (isOgre(u)) {
      const weapons = u.weapons.map((w) => (w.id === ref.weapon ? { ...w, fired: true } : w));
      // An external missile that fires is expended, not merely used.
      next = withUnit(next, { ...u, weapons });
      const w = u.weapons.find((x) => x.id === ref.weapon);
      if (w?.kind === 'missileRack') {
        next = withUnit(next, {
          ...(next.units[u.id] as OgreUnit),
          internalMissiles: Math.max(0, u.internalMissiles - 1),
        });
      }
      if (w && OGRE_WEAPONS[w.kind].antipersonnelOnly && target.kind === 'unit') {
        const already = Array.isArray(next.scenarioData['_apFiredAt'])
          ? (next.scenarioData['_apFiredAt'] as string[])
          : [];
        next = {
          ...next,
          scenarioData: {
            ...next.scenarioData,
            _apFiredAt: [...already, `${u.id}>${target.unit}`],
          },
        };
      }
      continue;
    }

    if (ref.heavyWeapon) {
      next = updateAnyUnit(next, u.id, () => ({ heavyWeaponFired: true }));
      continue;
    }
    const cls = unitClass(u.classId);
    if (cls.kind === 'infantry') {
      const want = Math.max(1, Math.min(u.squads, ref.squads ?? u.squads));
      next = updateAnyUnit(next, u.id, (x) => ({
        squadsFired: (x as ConventionalUnit).squadsFired + want,
        firedThisPhase: (x as ConventionalUnit).squadsFired + want >= u.squads,
      }));
    } else {
      next = updateAnyUnit(next, u.id, () => ({ firedThisPhase: true }));
    }
  }
  return next;
};

// ---------------------------------------------------------------------------
// Applying results
// ---------------------------------------------------------------------------

const applyResult = (
  state: GameState,
  map: GameMap,
  target: TargetRef,
  result: DamageResult,
  credit: string,
): GameState => {
  // The resolution mode has already been folded into `result` by the time it
  // reaches here — `resolve(odds, roll, 'spillover')` steps an X down to a D
  // before anything is applied — so this function only ever sees a final
  // outcome and never has to know how it was arrived at.
  if (result === 'NE') return state;

  switch (target.kind) {
    case 'unit':
      return applyToUnit(state, target.unit, result, credit);

    case 'ogreWeapon': {
      // "An X result on the CRT means the target weapon is destroyed. D results
      // do not affect Ogres." (7.13.1)
      if (result !== 'X') return state;
      const ogre = state.units[target.unit];
      if (!ogre || !isOgre(ogre)) return state;
      const weapon = ogre.weapons.find((w) => w.id === target.weapon);
      if (!weapon || weapon.destroyed) return state;

      let next = withUnit(state, {
        ...ogre,
        weapons: ogre.weapons.map((w) => (w.id === weapon.id ? { ...w, destroyed: true } : w)),
        // "Destruction of a missile rack destroys one IM at the same time; this
        // is the only way internal missiles can be destroyed before firing."
        internalMissiles:
          weapon.kind === 'missileRack'
            ? Math.max(0, ogre.internalMissiles - 1)
            : ogre.internalMissiles,
      });
      next = addVictory(next, credit, ogreDamageValue(weapon.kind));
      return log(
        next,
        'good',
        `${unitName(ogre)} loses a ${OGRE_WEAPONS[weapon.kind].name.toLowerCase()}.`,
        [ogre.pos],
      );
    }

    case 'building': {
      return state; // handled by resolveBuildingAttack
    }

    case 'terrain': {
      if (!state.options.terrainDamage) return state;
      const current = terrainAt(map, target.hex, state.terrainOverrides);
      let next = cutRoute(state, target.hex);
      // "If a town or forest hex gets a D result, it is damaged ... another D
      // result, or ... an X result, it is turned to rubble." (13.01)
      const degraded =
        result === 'X' ? degradeTerrain(degradeTerrain(current)) : degradeTerrain(current);
      if (degraded !== current) next = setTerrainOverride(next, target.hex, degraded);
      return log(next, 'warn', `The ground in ${key(target.hex)} is torn up.`, [target.hex]);
    }

    case 'ogreTreads':
      return state; // handled by resolveTreadAttack
  }

  return state;
};

/** A CRT result landing on one conventional unit; exported for the blast rules. */
export const applyDamageToUnit = (
  state: GameState,
  id: UnitId,
  result: DamageResult,
  credit: string,
): GameState => applyToUnit(state, id, result, credit);

const applyToUnit = (
  state: GameState,
  id: UnitId,
  result: DamageResult,
  credit: string,
): GameState => {
  const u = state.units[id];
  if (!u || !onBoard(u)) return state;

  if (isOgre(u)) return state; // 7.13: an Ogre is never targeted as a whole

  if (result === 'X') {
    const next = destroyUnit(state, id, 'destroyed by fire', credit);
    return log(next, 'good', `${unitName(u)} is destroyed.`, [u.pos]);
  }

  const cls = unitClass(u.classId);

  // "An infantry unit is immediately reduced by one squad." (7.11)
  if (cls.kind === 'infantry') {
    const next = reduceSquad(state, id, 'reduced by fire', credit);
    return log(next, 'warn', `${unitName(u)} is reduced by a squad.`, [u.pos]);
  }

  // "A D result has no effect on a hardened CP except to keep it from moving
  // for a turn if it is also mobile, but a second D before it recovers will
  // destroy it." (3.05.2) — the same shape as an armour unit's two Ds.
  if (u.disabled !== 'none') {
    const next = destroyUnit(state, id, 'destroyed while disabled', credit);
    return log(next, 'good', `${unitName(u)} is finished off while disabled.`, [u.pos]);
  }

  const next = withUnit(state, {
    ...u,
    disabled: 'combat',
    disabledAt: state.turn * state.playerOrder.length + state.activePlayerIndex,
  });
  return log(next, 'warn', `${unitName(u)} is disabled.`, [u.pos]);
};

const addVictory = (state: GameState, player: string, points: number): GameState => {
  const p = state.players[player];
  if (!p) return state;
  return {
    ...state,
    players: { ...state.players, [player]: { ...p, victoryPoints: p.victoryPoints + points } },
  };
};

// ---------------------------------------------------------------------------
// Treads
// ---------------------------------------------------------------------------

const resolveTreadAttack = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
  preview: AttackPreview,
  credit: string,
): AttackOutcome => {
  const ogre = state.units[(target as { unit: UnitId }).unit];
  if (!ogre || !isOgre(ogre))
    return { state, resolution: null, reason: 'that target has no treads' };

  const die = rollDie(state.rng);
  let next: GameState = { ...state, rng: die.state };

  const hit = die.value >= preview.treadHitOn;
  const lost = hit ? Math.min(ogre.treads, preview.attackStrength) : 0;

  if (hit) {
    next = withUnit(next, { ...ogre, treads: ogre.treads - lost });
    next = addVictory(next, credit, lost * ogreDamageValue('tread'));
  }

  next = log(
    next,
    hit ? 'good' : 'info',
    `1 to 1 on ${unitName(ogre)}’s treads — rolled ${die.value}: ` +
      (hit ? `${lost} tread unit${lost === 1 ? '' : 's'} destroyed.` : 'no effect.'),
    [ogre.pos],
  );

  next = applySpillover(next, map, attackers, target, preview.attackStrength, credit);
  next = checkOgreDeath(next, target, credit);

  return {
    state: next,
    resolution: {
      attackers,
      target,
      attackStrength: preview.attackStrength,
      defenseStrength: preview.attackStrength,
      column: '1-1',
      automatic: false,
      roll: die.value,
      result: hit ? 'X' : 'NE',
      treadsLost: lost,
    },
  };
};

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

const resolveBuildingAttack = (
  state: GameState,
  attackers: readonly AttackerRef[],
  target: TargetRef,
  preview: AttackPreview,
  credit: string,
): AttackOutcome => {
  const id = (target as { building: string }).building;
  const building = state.buildings[id];
  if (!building) return { state, resolution: null, reason: 'no such building' };

  const damage = preview.structureDamage ?? 0;
  const remaining = Math.max(0, building.structurePoints - damage);
  const next0: Building = { ...building, structurePoints: remaining, destroyed: remaining <= 0 };

  let next: GameState = { ...state, buildings: { ...state.buildings, [id]: next0 } };
  next = log(
    next,
    remaining <= 0 ? 'good' : 'info',
    remaining <= 0
      ? `The ${building.kind} collapses.`
      : `The ${building.kind} takes ${damage} structure points; ${remaining} left.`,
    [building.pos],
  );
  if (remaining <= 0) next = addVictory(next, credit, building.maxStructurePoints);

  return {
    state: next,
    resolution: {
      attackers,
      target,
      attackStrength: preview.attackStrength,
      defenseStrength: building.structurePoints,
      column: null,
      automatic: true,
      roll: 0,
      result: remaining <= 0 ? 'X' : 'NE',
    },
  };
};

// ---------------------------------------------------------------------------
// Spillover
// ---------------------------------------------------------------------------

/**
 * "Each other unit counter in the hex then immediately suffers an attack at
 * half the strength (not rounded) used in the attack on the target; this
 * represents 'spillover' fire and blast effect." (7.12)
 *
 * Exceptions, all from 7.12.2: a unit's own fire does not spill onto it, no
 * spillover is calculated in an overrun, riders are resolved with their vehicle
 * rather than separately, and "Ogres and buildings ignore spillover fire".
 */
const applySpillover = (
  state: GameState,
  map: GameMap,
  attackers: readonly AttackerRef[],
  target: TargetRef,
  strength: number,
  credit: string,
): GameState => {
  const where = targetHex(state, target);
  if (!where) return state;

  const half = strength / 2;
  if (half <= 0) return state;

  const attackerIds = new Set(attackers.map((a) => a.unit));
  const targetId = target.kind === 'unit' ? target.unit : null;

  let next = state;
  for (const other of unitsAt(state, where)) {
    if (other.id === targetId) continue;
    if (attackerIds.has(other.id)) continue;
    if (isOgre(other)) continue;

    const defense = defenseOf(next, map, other, { spillover: true });
    const odds = oddsFor(half, defense);
    if (odds.kind === 'none') continue;

    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    const result = resolve(odds, die.value, 'spillover');
    if (result === 'NE') continue;

    next = log(next, 'warn', `Spillover catches ${unitName(other)}.`, [other.pos]);
    next = applyToUnit(next, other.id, result, credit);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Ogre death
// ---------------------------------------------------------------------------

/**
 * "An Ogre is not destroyed until all its fireable weapons and tread units are
 * gone." (7.13.3)
 */
export const checkOgreDeath = (state: GameState, target: TargetRef, credit: string): GameState => {
  if (target.kind !== 'ogreWeapon' && target.kind !== 'ogreTreads' && target.kind !== 'unit') {
    return state;
  }
  const u = state.units[target.unit];
  if (!u || !isOgre(u) || !onBoard(u)) return state;
  if (!ogreIsDestroyed(u)) return state;

  const next = destroyUnit(state, u.id, 'stripped of weapons and treads', credit);
  return log(next, 'good', `${unitName(u)} is a wreck: no weapons, no treads.`, [u.pos]);
};

// ---------------------------------------------------------------------------
// Fire-phase bookkeeping
// ---------------------------------------------------------------------------

/** Clear the once-per-turn flags for a player at the start of their turn. */
export const resetFireFlags = (state: GameState, player: string): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !onBoard(u)) continue;
    if (isOgre(u)) {
      next = withUnit(next, {
        ...u,
        weapons: u.weapons.map((w) =>
          // An expended external missile stays expended; everything else is
          // ready again. "Each Ogre missile is a one-shot weapon." (7.05.2)
          w.kind === 'missile' && w.fired ? w : { ...w, fired: false },
        ),
      });
    } else {
      next = updateAnyUnit(next, u.id, () => ({ firedThisPhase: false, squadsFired: 0 }));
    }
  }
  const { _apFiredAt: _drop, ...rest } = next.scenarioData;
  return { ...next, scenarioData: rest };
};

/** Attackers with something still to fire, for the interface's target picker. */
export const canStillFire = (state: GameState, u: Unit): boolean => {
  if (!canAct(u)) return false;
  if (isOgre(u)) return u.weapons.some((w) => isFireable(u, w) && !w.fired);
  const cls = unitClass(u.classId);
  if (cls.attack <= 0) return false;
  if (cls.kind === 'infantry') return u.squadsFired < u.squads;
  return !u.firedThisPhase;
};

/** Enemy units this one could legally shoot at right now, by hex. */
export const targetsInRange = (state: GameState, u: Unit): Unit[] => {
  const range = isOgre(u)
    ? Math.max(
        0,
        ...u.weapons.filter((w) => isFireable(u, w)).map((w) => OGRE_WEAPONS[w.kind].range),
      )
    : unitClass(u.classId).range;
  return Object.values(state.units).filter(
    (t) => onBoard(t) && t.owner !== u.owner && distance(u.pos, t.pos) <= range,
  );
};

/** True when two units share a hex, which 6.08 treats as adjacency for fire. */
export const inSameHex = (a: Unit, b: Unit): boolean => eq(a.pos, b.pos);

/** A conventional unit's printed strength, exported for the interface. */
export const strengthOf = (u: ConventionalUnit): number => printedAttack(u);

// ---------------------------------------------------------------------------
// Orbital fire support (Orbital Drop §6.01)
// ---------------------------------------------------------------------------

/** The strike strengths a scenario still owes, from `scenarioData`. */
export const orbitalStrikesLeft = (state: GameState): readonly number[] => {
  const raw = state.scenarioData['orbitalStrikes'];
  return Array.isArray(raw) ? (raw as number[]).filter((n) => typeof n === 'number') : [];
};

export interface StrikePreview {
  readonly ok: boolean;
  readonly reason?: string;
  readonly strength: number;
  readonly defense: number;
  readonly odds: Odds;
  /** Structure Points the strike would take off a building. */
  readonly structureDamage?: number;
  readonly summary: string;
}

const denyStrike = (reason: string): StrikePreview => ({
  ok: false,
  reason,
  strength: 0,
  defense: 0,
  odds: { kind: 'none' },
  summary: reason,
});

/** What one orbital strike would do to a target — the interface's read. */
export const previewOrbitalStrike = (
  state: GameState,
  map: GameMap,
  strikeIndex: number,
  target: TargetRef,
): StrikePreview => {
  const strength = orbitalStrikesLeft(state)[strikeIndex];
  if (strength === undefined) return denyStrike('no such strike left in orbit');
  if (target.kind === 'ogreTreads') return denyStrike('orbital fire cannot pick out treads');
  if (target.kind === 'terrain') return denyStrike('orbital fire wants a target, not a hex');

  // The fleet is there to take the base, not to flatten it: orbital fire
  // supports the force on the ground, and the base — a post or the Admin
  // building — falls to that force or not at all. (An interpretation: the
  // supplement says "any target", and read literally that ends an asteroid
  // assault on turn 1 with one shot at a D0 post.)
  if (target.kind === 'building') {
    return denyStrike('the base is what the drop is for; the fleet does not bombard it');
  }
  const targetUnit = state.units[target.unit];
  if (!targetUnit || !onBoard(targetUnit)) return denyStrike('that target is gone');
  let defense: number;
  if (target.kind === 'ogreWeapon') {
    if (!isOgre(targetUnit)) return denyStrike('that is not an Ogre');
    const weapon = targetUnit.weapons.find((w) => w.id === target.weapon);
    if (!weapon || weapon.destroyed) return denyStrike('that weapon is already gone');
    defense = ogreWeaponDefense(state, map, targetUnit, weapon);
  } else {
    if (isOgre(targetUnit)) return denyStrike('name a weapon — an Ogre is not one target (7.13)');
    if (targetUnit.classId === 'CP') {
      return denyStrike('the base is what the drop is for; the fleet does not bombard it');
    }
    defense = defenseOf(state, map, targetUnit);
  }
  const odds = oddsFor(strength, defense);
  if (odds.kind === 'none') {
    return denyStrike(`${strength} against ${defense} is worse than 1 to 2`);
  }
  return {
    ok: true,
    strength,
    defense,
    odds,
    summary: `${strength} against ${defense}: ${describeOdds(odds)}`,
  };
};

/**
 * One strike from a warship in orbit: "attack strength equal to its
 * Triplanetary combat strength, any target, any range, resolved normally on
 * the CRT." No range, no line of sight, no spent-weapon bookkeeping — the gun
 * is not on the map. The strike list in `scenarioData` is the magazine: each
 * resolution removes the strike it spent.
 */
export const resolveOrbitalStrike = (
  state: GameState,
  map: GameMap,
  strikeIndex: number,
  target: TargetRef,
): { state: GameState; ok: boolean; reason?: string } => {
  const strikes = orbitalStrikesLeft(state);
  const strength = strikes[strikeIndex];
  if (strength === undefined) return { state, ok: false, reason: 'no such strike left in orbit' };
  if (target.kind === 'ogreTreads') {
    return { state, ok: false, reason: 'orbital fire cannot pick out treads — name a weapon' };
  }
  if (target.kind === 'terrain') {
    return { state, ok: false, reason: 'orbital fire wants a target, not a hex' };
  }

  const where = targetHex(state, target);
  if (!where) return { state, ok: false, reason: 'no such target' };

  const spend = (s: GameState): GameState => ({
    ...s,
    scenarioData: {
      ...s.scenarioData,
      orbitalStrikes: strikes.filter((_, i) => i !== strikeIndex),
    },
  });

  // "The defender's base counts as a building for these attacks."
  if (target.kind === 'building') {
    const building = state.buildings[target.building];
    if (!building || building.destroyed) return { state, ok: false, reason: 'that target is gone' };
    const terrain = baseTerrain(terrainAt(map, building.pos, state.terrainOverrides));
    const damage = terrain === 'town' || terrain === 'forest' ? strength : strength * 2;
    const remaining = Math.max(0, building.structurePoints - damage);
    let next = spend(state);
    next = {
      ...next,
      buildings: {
        ...next.buildings,
        [target.building]: {
          ...building,
          structurePoints: remaining,
          destroyed: remaining <= 0,
        },
      },
    };
    next = log(
      next,
      remaining <= 0 ? 'good' : 'warn',
      `Orbital strike (${strength}) hits the ${building.kind}: ` +
        (remaining <= 0 ? 'it collapses.' : `${damage} structure points; ${remaining} left.`),
      [where],
    );
    return { state: next, ok: true };
  }

  const targetUnit = state.units[target.unit];
  if (!targetUnit || !onBoard(targetUnit))
    return { state, ok: false, reason: 'that target is gone' };

  let defense: number;
  if (target.kind === 'ogreWeapon') {
    if (!isOgre(targetUnit)) return { state, ok: false, reason: 'that is not an Ogre' };
    const weapon = targetUnit.weapons.find((w) => w.id === target.weapon);
    if (!weapon || weapon.destroyed) {
      return { state, ok: false, reason: 'that weapon is already gone' };
    }
    defense = ogreWeaponDefense(state, map, targetUnit, weapon);
  } else {
    if (isOgre(targetUnit)) {
      return { state, ok: false, reason: 'name a weapon — an Ogre is not one target (7.13)' };
    }
    defense = defenseOf(state, map, targetUnit);
  }

  const odds = oddsFor(strength, defense);
  if (odds.kind === 'none') {
    return { state, ok: false, reason: `${strength} against ${defense} is worse than 1 to 2` };
  }

  let next = spend(state);
  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };
  const raw = odds.kind === 'auto' ? 'X' : resolve(odds, die.value, 'normal');
  const result =
    raw === 'D' && targetInertOgre(next, target)
      ? 'X'
      : applyToTarget(raw, targetIgnoresD(next, target));

  next = log(
    next,
    result === 'X' ? 'good' : result === 'D' ? 'warn' : 'info',
    `Orbital strike (${strength}): ${describeOdds(odds)} on ${describeTarget(next, target)}` +
      (odds.kind === 'auto' ? ' — automatic' : ` — rolled ${die.value}`) +
      `: ${result === 'X' ? 'destroyed' : result === 'D' ? 'disabled' : 'no effect'}.`,
    [where],
  );
  next = applyResult(next, map, target, result, 'orbit');
  next = checkOgreDeath(next, target, 'orbit');
  return { state: next, ok: true };
};
