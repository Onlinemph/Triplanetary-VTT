/**
 * Cruise missiles (Section 10).
 *
 * A Missile Crawler "attacks by firing the missile" (3.01) — once, and then
 * it is a Crawler. The missile is a counter of its own: launched in the fire
 * phase at a hex, it flies straight for it, and the only thing that can stop
 * it on the way is a laser with a line of sight (Section 12). When it
 * arrives, everything at ground zero is gone and the hex is a crater, and
 * the blast reaches two hexes out.
 *
 * ## Provisional numbers
 *
 * The *shape* of the section is implemented faithfully: a launch that is the
 * crawler's attack, a flight that lasers intercept, a detonation with a
 * ground zero and a shockwave that falls off with distance, and fratricide
 * between missiles. The numbers in {@link CRUISE_MISSILE} — flight per turn,
 * the missile's defence against interception, the blast strengths by ring —
 * are placeholders chosen to play sensibly against the rest of the CRT, and
 * are flagged for correction against the printed table in
 * docs/RULES-MAPPING.md. Nothing else in the engine depends on them.
 */

import { type Hex, distance, eq, hexLine, key, withinRadius } from './hex.js';
import { type GameMap, inBounds, terrainAt } from './map.js';
import { rollDie } from './rng.js';
import { describeOdds, oddsFor, resolve } from './crt.js';
import { OGRE_WEAPONS } from './ogres.js';
import { baseTerrain, treadHitRollIn } from './terrain.js';
import { unitClass } from './units.js';
import { laserLineOfSight } from './los.js';
import {
  type ConventionalUnit,
  type CruiseMissile,
  type GameState,
  type PlayerId,
  type Unit,
  type UnitId,
  activePlayer,
  canAct,
  isOgre,
  onBoard,
  unitsAt,
} from './types.js';
import {
  addPoints,
  cutRoute,
  defenseOf,
  destroyUnit,
  log,
  ogreDamageValue,
  ogreWeaponDefense,
  setTerrainOverride,
  unitName,
  withUnit,
} from './state.js';
import { applyDamageToUnit, checkOgreDeath } from './combat.js';

export const CRUISE_MISSILE = {
  /** Hexes flown per fire phase. */
  speed: 12,
  /** Defence strength against an intercepting laser. */
  defense: 2,
  /** Blast strength by distance from ground zero; ground zero itself is total. */
  blast: [
    { range: 1, attack: 12 },
    { range: 2, attack: 6 },
  ],
  /** Another missile in flight this close to a detonation is lost with it. */
  fratricide: 2,
} as const;

export const missilesOf = (state: GameState, owner?: PlayerId): CruiseMissile[] =>
  Object.values(state.missiles ?? {}).filter((m) => owner === undefined || m.owner === owner);

/** Why this unit cannot launch at that hex right now, or null when it can. */
export const launchCheck = (
  state: GameState,
  map: GameMap,
  unit: Unit | undefined,
  target: Hex,
): string | null => {
  if (!unit || !onBoard(unit)) return 'no such unit';
  if (unit.kind !== 'unit' || unit.classId !== 'MCRL') {
    return 'only a loaded Missile Crawler can launch a cruise missile';
  }
  if (unit.owner !== activePlayer(state)) return 'not your unit';
  if (state.phase !== 'fire') return 'a cruise missile is launched in the fire phase';
  if (!canAct(unit)) return `${unitName(unit)} is disabled`;
  if (unit.firedThisPhase) return 'that crawler has already fired';
  if (!inBounds(map, target)) return 'aim at a hex on the map';
  if (eq(unit.pos, target)) return 'not at itself';
  return null;
};

export interface MissileOutcome {
  readonly state: GameState;
  readonly ok: boolean;
  readonly reason?: string;
}

/** Fire the crawler's missile at a hex, and fly its first leg at once. */
export const launchMissile = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  target: Hex,
): MissileOutcome => {
  const unit = state.units[unitId];
  const why = launchCheck(state, map, unit, target);
  if (why || !unit || unit.kind !== 'unit') return { state, ok: false, reason: why ?? 'no' };

  // "A Missile Crawler that has fired ... can do no further damage, but is
  // worth victory points to the enemy if destroyed." (3.01)
  let next = withUnit(state, { ...unit, classId: 'CRL', firedThisPhase: true });
  const id = `cm-${next.nextUnitSerial}`;
  const missile: CruiseMissile = {
    id,
    owner: unit.owner,
    pos: unit.pos,
    target,
    launchedTurn: state.turn,
  };
  next = {
    ...next,
    nextUnitSerial: next.nextUnitSerial + 1,
    missiles: { ...(next.missiles ?? {}), [id]: missile },
  };
  next = log(next, 'warn', `${unitName(unit)} launches a cruise missile at ${labelOf(target)}.`, [
    unit.pos,
    target,
  ]);
  return { state: flyMissile(next, map, id), ok: true };
};

const labelOf = (h: Hex): string => {
  // The map label, without dragging the hex module's formatter into the log.
  const col = h.q + 1;
  const row = h.r + ((h.q - (h.q & 1)) >> 1) + 1;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(col)}${pad(row)}`;
};

/** Every missile of this player's still in flight takes its next leg. */
export const flyMissiles = (state: GameState, map: GameMap, owner: PlayerId): GameState => {
  let next = state;
  for (const m of missilesOf(state, owner).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    // A missile flies its first leg the moment it is launched; the legs
    // here are for the ones launched on an earlier turn.
    if (m.launchedTurn === state.turn) continue;
    next = flyMissile(next, map, m.id);
  }
  return next;
};

/**
 * One leg: up to {@link CRUISE_MISSILE.speed} hexes down the line, with every
 * enemy laser that can see a hex it enters taking one shot at it as it
 * passes. Interception costs the laser nothing — it is not the laser's fire
 * phase — and each laser fires once per leg.
 */
const flyMissile = (state: GameState, map: GameMap, id: string): GameState => {
  const missile = state.missiles?.[id];
  if (!missile) return state;

  const line = hexLine(missile.pos, missile.target).slice(1, CRUISE_MISSILE.speed + 1);
  const fired = new Set<UnitId>();
  let next = state;
  let pos = missile.pos;

  for (const h of line) {
    pos = h;
    next = { ...next, missiles: { ...next.missiles, [id]: { ...missile, pos } } };

    for (const laser of lasersOf(next, missile.owner)) {
      if (fired.has(laser.id)) continue;
      const cls = unitClass(laser.classId);
      if (laserLineOfSight(next, map, laser.pos, h, cls.laser ?? 'standard')) continue;
      fired.add(laser.id);

      const odds = oddsFor(cls.attack, CRUISE_MISSILE.defense);
      const die = rollDie(next.rng);
      next = { ...next, rng: die.state };
      const result = resolve(odds, die.value, 'normal');
      next = log(
        next,
        result === 'X' ? 'good' : 'info',
        `${unitName(laser)} tracks the cruise missile over ${labelOf(h)} — ` +
          `${describeOdds(odds)}, rolled ${die.value}: ` +
          (result === 'X' ? 'it breaks up in flight.' : 'it flies on.'),
        [h],
      );
      if (result === 'X') {
        const { [id]: _gone, ...rest } = next.missiles ?? {};
        return { ...next, missiles: rest };
      }
    }

    if (eq(h, missile.target)) return detonate(next, map, id);
  }

  return log(
    next,
    'info',
    `The cruise missile is over ${labelOf(pos)}, ${distance(pos, missile.target)} hexes short; it flies on next turn.`,
    [pos],
  );
};

const lasersOf = (state: GameState, notOwner: PlayerId): ConventionalUnit[] =>
  Object.values(state.units)
    .filter(
      (u): u is ConventionalUnit =>
        u.kind === 'unit' &&
        u.owner !== notOwner &&
        onBoard(u) &&
        canAct(u) &&
        unitClass(u.classId).laser !== undefined,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));

// ---------------------------------------------------------------------------
// Detonation
// ---------------------------------------------------------------------------

/**
 * Ground zero is total: every unit in the hex, cybertanks included, and any
 * building; the hex itself becomes a crater and its roads are gone. The
 * rings outward take a CRT attack each at the ring's strength — an Ogre
 * component by component, the way every attack on an Ogre goes.
 */
const detonate = (state: GameState, map: GameMap, id: string): GameState => {
  const missile = state.missiles?.[id];
  if (!missile) return state;
  const { [id]: _spent, ...rest } = state.missiles ?? {};
  let next: GameState = { ...state, missiles: rest };
  const gz = missile.target;
  const credit = missile.owner;

  next = log(next, 'bad', `The cruise missile detonates over ${labelOf(gz)}.`, [gz]);

  for (const u of Object.values(next.units)
    .filter((u) => onBoard(u) && eq(u.pos, gz))
    .sort((a, b) => (a.id < b.id ? -1 : 1))) {
    next = destroyUnit(
      next,
      u.id,
      'vaporised at ground zero',
      u.owner === credit ? undefined : credit,
    );
    next = log(next, 'good', `${unitName(u)} is gone at ground zero.`, [gz]);
  }
  for (const b of Object.values(next.buildings)) {
    if (b.destroyed || !eq(b.pos, gz)) continue;
    next = {
      ...next,
      buildings: { ...next.buildings, [b.id]: { ...b, structurePoints: 0, destroyed: true } },
    };
    next = log(next, 'good', `The ${b.kind} is levelled.`, [gz]);
  }
  next = setTerrainOverride(next, gz, 'crater');
  next = cutRoute(next, gz);

  for (const ring of CRUISE_MISSILE.blast) {
    const hexes = withinRadius(gz, ring.range).filter((h) => distance(h, gz) === ring.range);
    for (const h of hexes) {
      for (const u of unitsAt(next, h).sort((a, b) => (a.id < b.id ? -1 : 1))) {
        next = blastUnit(next, map, u.id, ring.attack, credit);
      }
      for (const b of Object.values(next.buildings)) {
        if (b.destroyed || !eq(b.pos, h)) continue;
        const terrain = baseTerrain(terrainAt(map, h, next.terrainOverrides));
        const damage = terrain === 'town' || terrain === 'forest' ? ring.attack : ring.attack * 2;
        const remaining = Math.max(0, b.structurePoints - damage);
        next = {
          ...next,
          buildings: {
            ...next.buildings,
            [b.id]: { ...b, structurePoints: remaining, destroyed: remaining <= 0 },
          },
        };
        next = log(
          next,
          remaining <= 0 ? 'good' : 'warn',
          `The blast takes ${damage} structure points off the ${b.kind}` +
            (remaining <= 0 ? '; it collapses.' : `; ${remaining} left.`),
          [h],
        );
      }
    }
  }

  // Fratricide: a nuclear detonation is not a place for another missile.
  for (const other of Object.values(next.missiles ?? {})) {
    if (distance(other.pos, gz) <= CRUISE_MISSILE.fratricide) {
      const { [other.id]: _lost, ...left } = next.missiles ?? {};
      next = { ...next, missiles: left };
      next = log(next, 'warn', `A second cruise missile is caught in the blast and lost.`, [
        other.pos,
      ]);
    }
  }

  return next;
};

/** One unit in a blast ring: an Ogre by the component, anything else by the CRT. */
const blastUnit = (
  state: GameState,
  map: GameMap,
  id: UnitId,
  attack: number,
  credit: PlayerId,
): GameState => {
  const u = state.units[id];
  if (!u || !onBoard(u)) return state;
  const scorer = u.owner === credit ? undefined : credit;
  let next = state;

  if (isOgre(u)) {
    for (const w of u.weapons) {
      if (w.destroyed) continue;
      const ogre = next.units[id];
      if (!ogre || !isOgre(ogre)) break;
      const odds = oddsFor(attack, ogreWeaponDefense(next, map, ogre, w));
      if (odds.kind === 'none') continue;
      const die = rollDie(next.rng);
      next = { ...next, rng: die.state };
      if (resolve(odds, die.value, 'normal') !== 'X') continue;
      next = withUnit(next, {
        ...ogre,
        weapons: ogre.weapons.map((x) => (x.id === w.id ? { ...x, destroyed: true } : x)),
        internalMissiles:
          w.kind === 'missileRack' ? Math.max(0, ogre.internalMissiles - 1) : ogre.internalMissiles,
      });
      if (scorer) next = addPoints(next, scorer, ogreDamageValue(w.kind));
      next = log(
        next,
        'good',
        `The blast strips ${unitName(ogre)} of a ${OGRE_WEAPONS[w.kind].name.toLowerCase()}.`,
        [ogre.pos],
      );
    }
    const ogre = next.units[id];
    if (ogre && isOgre(ogre) && ogre.treads > 0) {
      const die = rollDie(next.rng);
      next = { ...next, rng: die.state };
      if (die.value >= treadHitRollIn(terrainAt(map, ogre.pos, next.terrainOverrides))) {
        const lost = Math.min(ogre.treads, attack);
        next = withUnit(next, { ...ogre, treads: ogre.treads - lost });
        if (scorer) next = addPoints(next, scorer, lost * ogreDamageValue('tread'));
        next = log(next, 'good', `The blast costs ${unitName(ogre)} ${lost} tread units.`, [
          ogre.pos,
        ]);
      }
    }
    return checkOgreDeath(next, { kind: 'ogreTreads', unit: id }, credit);
  }

  const odds = oddsFor(attack, defenseOf(next, map, u));
  if (odds.kind === 'none') return next;
  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };
  const result = resolve(odds, die.value, 'normal');
  if (result === 'NE') return next;
  next = log(next, 'warn', `The shockwave reaches ${unitName(u)} in ${labelOf(u.pos)}.`, [u.pos]);
  return applyDamageToUnit(next, id, result, credit);
};

/** Missiles a player may still launch: their loaded crawlers on the board. */
export const loadedCrawlers = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter(
    (u) => u.kind === 'unit' && u.classId === 'MCRL' && u.owner === player && onBoard(u),
  );

export const missileKey = (m: CruiseMissile): string => key(m.pos);
