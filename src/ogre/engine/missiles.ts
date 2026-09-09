/**
 * Cruise missiles (Section 10), as printed.
 *
 * A Missile Crawler "attacks by firing the missile" (3.01) — once, and then it
 * is a Crawler. What happens next takes no time at all in game terms:
 *
 * > "One turn represents 4 minutes. In that time, a Cruise Missile can reach
 * > any point on the map (however big the map is) – unless it is intercepted
 * > ... The missile starts at its crawler and immediately moves one hex at a
 * > time, by any route indicated by its owner, until it is intercepted, or its
 * > owner states that it has reached its target and is exploding ... Once a
 * > Cruise Missile is fired, it is tracked to its destination and its fate
 * > resolved before any more actions occur." (10.02)
 *
 * So there is no missile counter sitting on the board between turns: a launch
 * is traced hex by hex and resolved inside the order that made it.
 *
 * Three things happen along the way, and each is the rulebook's:
 *
 *  - **Interception** (10.03) is a two-dice roll on a table by the firing
 *    unit's type, not an attack on the Combat Results Table. The further the
 *    missile has flown, the easier it is to track.
 *  - **Premature detonation** (10.03.3): a missile that is hit still goes off
 *    where it was hit, on a 6.
 *  - **The blast** (10.04) is a table by unit type and distance. Ground zero
 *    is absolute; outside it, what a hex suffers depends on what is standing
 *    in it and how far away it is, with terrain worth a hex or two of cover.
 *
 * The route is a straight line here, where the rules let the owner draw any
 * route. That matters in exactly one place — fratricide, below — and
 * `launchCheck` refuses a launch rather than quietly flying through a blast.
 */

import { type Hex, distance, eq, hexLine, key, withinRadius } from './hex.js';
import { type GameMap, inBounds, isRouteHex, terrainAt } from './map.js';
import { rollDie } from './rng.js';
import { type Odds, AUTO_KILL, resolve } from './crt.js';
import { OGRE_WEAPONS, type OgreWeaponKind } from './ogres.js';
import { baseTerrain } from './terrain.js';
import { unitClass } from './units.js';
import { laserLineOfSight } from './los.js';
import {
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
  destroyUnit,
  log,
  markFiredInEnemyTurn,
  ogreDamageValue,
  printedDefense,
  structurePointsOf,
  setTerrainOverride,
  unitName,
  withUnit,
} from './state.js';
import { applyDamageToUnit, checkOgreDeath } from './combat.js';
import { revealWithin } from './concealment.js';

export const CRUISE_MISSILE = {
  /**
   * "If a missile explodes, all remaining missiles aimed at that hex, or at any
   * other target within six hexes of the explosion point, are lost ...
   * Furthermore, no Cruise Missile fired later on that turn, whatever target it
   * is aimed at, may pass within six hexes of the explosion site." (10.02.1)
   */
  fratricide: 6,
  /** "On a roll of 1-5, the missile is simply shot down. On a roll of 6, the missile explodes." */
  prematureDetonation: 6,
  /** The distance bonuses of 10.03.2, as [hexes flown, bonus to the roll]. */
  trackingBonus: [
    { beyond: 20, bonus: 3 },
    { beyond: 15, bonus: 2 },
    { beyond: 10, bonus: 1 },
  ],
  /** The furthest the blast table reaches: a town or forest hex at 6. */
  blastReach: 6,
} as const;

// ---------------------------------------------------------------------------
// 10.03.2 Interception
// ---------------------------------------------------------------------------

/**
 * What a gun needs on two dice to bring a cruise missile down, or null when it
 * cannot shoot at one at all.
 *
 *     Any armor unit with attack strength 1 or 2 ............... 12
 *     Any armor unit with attack strength 3 or more ...... 11 or above
 *     Each individual squad (1/1 unit) of infantry ....... 11 or above
 *     Each Ogre main or secondary battery ................ 10 or above
 *     Each Ogre missile ................................... 9 or above
 *     Laser or Laser Tower ................................ 9 or above
 *
 * Antipersonnel guns and a Vulcan's arms are not on the table, so they may not
 * try. Nor may a unit with no attack strength at all.
 */
export const interceptionTarget = (u: Unit, weapon?: OgreWeaponKind): number | null => {
  if (isOgre(u) || weapon !== undefined) {
    switch (weapon) {
      case 'main':
      case 'secondary':
        return 10;
      case 'missile':
      case 'missileRack':
        return 9;
      default:
        return null;
    }
  }
  const cls = unitClass(u.classId);
  if (cls.laser) return 9;
  if (cls.kind === 'infantry') return 11;
  if (cls.attack >= 3) return 11;
  if (cls.attack >= 1) return 12;
  return null;
};

/** "+1 to roll" past ten hexes, "+2" past fifteen, "+3" past twenty. */
export const trackingBonus = (flown: number): number =>
  CRUISE_MISSILE.trackingBonus.find((b) => flown > b.beyond)?.bonus ?? 0;

/** One gun's chance at the missile, once, at the hex it is fired over. */
interface Shot {
  readonly unit: UnitId;
  readonly weapon?: OgreWeaponKind;
  /** Index into the flight path at which the gun takes its shot. */
  readonly at: number;
  readonly needs: number;
  /** Squads firing separately, for infantry: each is its own attempt. */
  readonly attempts: number;
}

/**
 * Every shot the defence gets, and where it takes it.
 *
 * "A unit may fire at the missile at any time while the missile is in range,
 * but no unit may fire more than once against any single Cruise Missile."
 * (10.03.1) The defender chooses when; since the tracking bonus only grows,
 * the last hex a gun can reach is always its best one, so that is where it
 * shoots. Disabled units may not try (10.03).
 */
const shotsAgainst = (
  state: GameState,
  map: GameMap,
  owner: PlayerId,
  path: readonly Hex[],
): Shot[] => {
  const out: Shot[] = [];
  const defenders = Object.values(state.units)
    .filter((u) => u.owner !== owner && onBoard(u) && canAct(u))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const u of defenders) {
    const guns: { weapon?: OgreWeaponKind; needs: number; range: number; attempts: number }[] = [];
    if (isOgre(u)) {
      // "Ogres and Superheavy Tanks may fire once with each weapon they have,
      // except that Missile Racks may still be used only once per turn."
      const racksUsed = new Set<string>();
      for (const w of u.weapons) {
        if (w.destroyed) continue;
        const needs = interceptionTarget(u, w.kind);
        if (needs === null) continue;
        if (w.kind === 'missileRack') {
          if (racksUsed.has('rack')) continue;
          racksUsed.add('rack');
        }
        guns.push({ weapon: w.kind, needs, range: OGRE_WEAPONS[w.kind].range, attempts: 1 });
      }
    } else {
      const needs = interceptionTarget(u);
      if (needs === null) continue;
      const cls = unitClass(u.classId);
      guns.push({
        needs,
        range: cls.range,
        // "Each individual squad (1/1 unit) of infantry" gets its own attempt.
        attempts: cls.kind === 'infantry' ? u.squads : 1,
      });
    }
    if (guns.length === 0) continue;

    for (const gun of guns) {
      let best = -1;
      for (let i = 0; i < path.length; i++) {
        const h = path[i]!;
        if (distance(u.pos, h) > gun.range) continue;
        // A laser needs its line, and a tower may always shoot at a missile:
        // "the missile flies over terrain rather than hiding within it" (12.03).
        if (u.kind === 'unit') {
          const cls = unitClass(u.classId);
          if (cls.laser === 'standard' && laserLineOfSight(state, map, u.pos, h, 'standard')) {
            continue;
          }
        }
        best = i;
      }
      if (best >= 0) {
        out.push({
          unit: u.id,
          ...(gun.weapon !== undefined ? { weapon: gun.weapon } : {}),
          at: best,
          needs: gun.needs,
          attempts: gun.attempts,
        });
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

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

  // 10.02.1: nothing may fly near this turn's craters, and nothing may be
  // aimed at a hex already inside one.
  for (const k of blastsThisTurn(state)) {
    const site = parseHexKey(k);
    if (distance(target, site) <= CRUISE_MISSILE.fratricide) {
      return `${labelOf(target)} is within six hexes of this turn's detonation at ${labelOf(site)} — the missile would be knocked down (10.02.1)`;
    }
    if (hexLine(unit.pos, target).some((h) => distance(h, site) <= CRUISE_MISSILE.fratricide)) {
      return `the flight would pass within six hexes of this turn's detonation at ${labelOf(site)} (10.02.1)`;
    }
  }
  return null;
};

export interface MissileOutcome {
  readonly state: GameState;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Fire the crawler's missile, and resolve the whole flight before returning.
 *
 * "Once a Cruise Missile is fired, it is tracked to its destination and its
 * fate resolved before any more actions occur." (10.02)
 */
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
  next = log(next, 'warn', `${unitName(unit)} launches a cruise missile at ${labelOf(target)}.`, [
    unit.pos,
    target,
  ]);

  const origin = unit.pos;
  const path = hexLine(origin, target).slice(1);
  const shots = shotsAgainst(next, map, unit.owner, path);

  for (let i = 0; i < path.length; i++) {
    const here = path[i]!;
    const flown = distance(origin, here);
    for (const shot of shots.filter((s) => s.at === i)) {
      const gun = next.units[shot.unit];
      if (!gun || !onBoard(gun) || !canAct(gun)) continue;
      for (let n = 0; n < shot.attempts; n++) {
        const a = rollDie(next.rng);
        const b = rollDie(a.state);
        next = { ...next, rng: b.state };
        // A Laser that shoots at a missile has spent the turn's shot (12.06).
        next = markFiredInEnemyTurn(next, gun.id);
        const bonus = trackingBonus(flown);
        const total = a.value + b.value + bonus;
        const hit = total >= shot.needs;
        next = log(
          next,
          hit ? 'good' : 'info',
          `${unitName(gun)} tracks the missile over ${labelOf(here)} — needs ${shot.needs}, ` +
            `rolled ${a.value + b.value}${bonus > 0 ? ` + ${bonus}` : ''} = ${total}: ` +
            (hit ? 'hit.' : 'it flies on.'),
          [here],
        );
        if (!hit) continue;

        // 10.03.3: hit, and on a 6 it goes off where it was hit.
        const early = rollDie(next.rng);
        next = { ...next, rng: early.state };
        if (early.value >= CRUISE_MISSILE.prematureDetonation) {
          next = log(next, 'bad', `The warhead goes off where it was hit — rolled 6.`, [here]);
          return { state: detonate(next, map, here, unit.owner), ok: true };
        }
        next = log(next, 'good', `The missile is shot down over ${labelOf(here)}.`, [here]);
        return { state: next, ok: true };
      }
    }
  }

  return { state: detonate(next, map, target, unit.owner), ok: true };
};

// ---------------------------------------------------------------------------
// 10.04 Detonation
// ---------------------------------------------------------------------------

/**
 * What one thing suffers at one distance from the explosion (10.04).
 *
 *     UNIT TYPE                      X    4-1  2-1  1-1  1-2  NE
 *     Any D0 unit or any GEV        1-2   3    4    5    –    6+
 *     D1 armor unit, hardened CP    1-2   –    3    4    5    6+
 *     D2 armor unit, hardened CP    1     2    3    4    –    5+
 *     D3+ armor unit, train, HCP    –     1    2    3    –    4+
 *     Infantry (each squad)         1     –    2    3    –    4+
 *     Town or forest hex            1-3   4    5    6    –    7+
 *     Road, railroad, or bridge     –     –    1    –    2    3+
 *     Ogre (each component)         –     –    1    –    2    3+
 *     Building (20 or fewer SP)     –     –    1    –    2    3+
 *     Building (21-50 SP)           –     –    –    1    –    2+
 *     Building (over 50 SP)         –     –    –    –    1    2+
 */
export type BlastRow =
  | 'd0'
  | 'd1'
  | 'd2'
  | 'd3'
  | 'infantry'
  | 'townForest'
  | 'route'
  | 'ogreComponent'
  | 'buildingSmall'
  | 'buildingMedium'
  | 'buildingLarge';

const column = (c: '4-1' | '2-1' | '1-1' | '1-2'): Odds => ({ kind: 'column', column: c });
const NOTHING: Odds = { kind: 'none' };

export const blastEffect = (row: BlastRow, hexes: number): Odds => {
  const at = (table: readonly [number, Odds][]): Odds =>
    table.find(([within]) => hexes <= within)?.[1] ?? NOTHING;
  switch (row) {
    case 'd0':
      return at([
        [2, AUTO_KILL],
        [3, column('4-1')],
        [4, column('2-1')],
        [5, column('1-1')],
      ]);
    case 'd1':
      return at([
        [2, AUTO_KILL],
        [3, column('2-1')],
        [4, column('1-1')],
        [5, column('1-2')],
      ]);
    case 'd2':
      return at([
        [1, AUTO_KILL],
        [2, column('4-1')],
        [3, column('2-1')],
        [4, column('1-1')],
      ]);
    case 'd3':
      return at([
        [1, column('4-1')],
        [2, column('2-1')],
        [3, column('1-1')],
      ]);
    case 'infantry':
      return at([
        [1, AUTO_KILL],
        [2, column('2-1')],
        [3, column('1-1')],
      ]);
    case 'townForest':
      return at([
        [3, AUTO_KILL],
        [4, column('4-1')],
        [5, column('2-1')],
        [6, column('1-1')],
      ]);
    case 'route':
    case 'ogreComponent':
    case 'buildingSmall':
      return at([
        [1, column('2-1')],
        [2, column('1-2')],
      ]);
    case 'buildingMedium':
      return at([[1, column('1-1')]]);
    case 'buildingLarge':
      return at([[1, column('1-2')]]);
  }
};

/** Which row of the building rows a Structure Point total reads. */
export const buildingRow = (sp: number): BlastRow =>
  sp > 50 ? 'buildingLarge' : sp > 20 ? 'buildingMedium' : 'buildingSmall';

/** Which row of the table a conventional unit reads. */
const rowFor = (u: Unit): BlastRow => {
  if (u.kind !== 'unit') return 'ogreComponent';
  const cls = unitClass(u.classId);
  // "Defensively, they are buildings with Structure Points" (12.01): a Laser
  // reads the building rows, not the armour ones.
  if (cls.structurePoints !== undefined) return buildingRow(structurePointsOf(u));
  if (cls.kind === 'infantry') return 'infantry';
  // "Any D0 unit or any GEV" — a hovercraft is fragile whatever its counter says.
  if (cls.mobility === 'gev' || cls.defense === 0) return 'd0';
  const d = printedDefense(u);
  if (d <= 1) return 'd1';
  if (d === 2) return 'd2';
  return 'd3';
};

/**
 * How far away a thing counts as being.
 *
 * "Terrain may protect units outside the explosion hex. If a unit is in forest
 * or swamp, treat it as being one hex farther from the explosion. If it is in
 * a town hex, or underwater, treat it as being two hexes farther away.
 * Infantry in a rubble hex is also treated as being two hexes farther away."
 */
const effectiveDistance = (state: GameState, map: GameMap, u: Unit, gz: Hex): number => {
  const raw = distance(u.pos, gz);
  const terrain = baseTerrain(terrainAt(map, u.pos, state.terrainOverrides));
  const infantry = u.kind === 'unit' && unitClass(u.classId).kind === 'infantry';
  if (terrain === 'forest' || terrain === 'swamp') return raw + 1;
  if (terrain === 'town' || terrain === 'water') return raw + 2;
  if (terrain === 'rubble' && infantry) return raw + 2;
  return raw;
};

/** A single roll on the table; true when it came up X. */
const blastRoll = (state: GameState, odds: Odds): { state: GameState; result: string } => {
  if (odds.kind === 'none') return { state, result: 'NE' };
  if (odds.kind === 'auto') return { state, result: 'X' };
  const die = rollDie(state.rng);
  return {
    state: { ...state, rng: die.state },
    result: resolve(odds, die.value, 'normal'),
  };
};

/**
 * The explosion.
 *
 * "This devastates an area over a kilometer across. Remove all units,
 * buildings, etc., in the hex it strikes. Place a crater marker in that hex,
 * unless it is in a lake or river." Then everything within reach reads the
 * table above.
 */
const detonate = (state: GameState, map: GameMap, gz: Hex, credit: PlayerId): GameState => {
  let next = log(state, 'bad', `The cruise missile detonates over ${labelOf(gz)}.`, [gz]);
  next = revealWithin(next, gz, CRUISE_MISSILE.blastReach);
  next = noteBlast(next, gz);

  // Ground zero: everything, whatever it is.
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
  // "Place a crater marker in that hex, unless it is in a lake or river."
  if (baseTerrain(terrainAt(map, gz, next.terrainOverrides)) !== 'water') {
    next = setTerrainOverride(next, gz, 'crater');
  }
  next = cutRoute(next, gz);

  // Everything else, by the table.
  const around = withinRadius(gz, CRUISE_MISSILE.blastReach).filter((h) => !eq(h, gz));
  for (const h of around.sort(
    (a, b) => distance(a, gz) - distance(b, gz) || key(a).localeCompare(key(b)),
  )) {
    if (!inBounds(map, h)) continue;
    const away = distance(h, gz);

    for (const u of unitsAt(next, h).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      next = blastUnit(next, map, u.id, gz, credit);
    }

    for (const b of Object.values(next.buildings)) {
      if (b.destroyed || !eq(b.pos, h)) continue;
      const odds = blastEffect(buildingRow(b.structurePoints), away);
      if (odds.kind === 'none') continue;
      // "divide the total number of SPs ... by 5. Round up, and roll that many
      // separate attacks. Each X destroys 5 SPs."
      let left = b.structurePoints;
      const rolls = Math.ceil(b.structurePoints / 5);
      for (let i = 0; i < rolls && left > 0; i++) {
        const r = blastRoll(next, odds);
        next = r.state;
        if (r.result === 'X') left = Math.max(0, left - 5);
      }
      if (left === b.structurePoints) continue;
      next = {
        ...next,
        buildings: {
          ...next.buildings,
          [b.id]: { ...b, structurePoints: left, destroyed: left <= 0 },
        },
      };
      next = log(
        next,
        left <= 0 ? 'good' : 'warn',
        `The blast takes ${b.structurePoints - left} structure points off the ${b.kind}` +
          (left <= 0 ? '; it collapses.' : `; ${left} left.`),
        [h],
      );
    }

    // "Town or forest hex" — the ground itself.
    const terrain = baseTerrain(terrainAt(map, h, next.terrainOverrides));
    if (terrain === 'town' || terrain === 'forest') {
      const r = blastRoll(next, blastEffect('townForest', away));
      next = r.state;
      if (r.result === 'X') {
        next = setTerrainOverride(next, h, 'rubble');
        next = cutRoute(next, h);
        next = log(next, 'warn', `${labelOf(h)} is burned down to rubble.`, [h]);
      }
    }

    // "Road, railroad, or bridge".
    if (isRouteHex(map, h) && !(next.routesCut ?? []).includes(key(h))) {
      const r = blastRoll(next, blastEffect('route', away));
      next = r.state;
      if (r.result === 'X') {
        next = cutRoute(next, h);
        next = log(next, 'warn', `The road through ${labelOf(h)} is torn up.`, [h]);
      }
    }
  }

  return next;
};

/** One unit outside ground zero: an Ogre component by component, anything else once. */
const blastUnit = (
  state: GameState,
  map: GameMap,
  id: UnitId,
  gz: Hex,
  credit: PlayerId,
): GameState => {
  const u = state.units[id];
  if (!u || !onBoard(u)) return state;
  const scorer = u.owner === credit ? undefined : credit;
  const away = effectiveDistance(state, map, u, gz);
  let next = state;

  if (isOgre(u)) {
    const odds = blastEffect('ogreComponent', away);
    if (odds.kind === 'none') return next;
    for (const w of u.weapons) {
      if (w.destroyed) continue;
      const ogre = next.units[id];
      if (!ogre || !isOgre(ogre)) break;
      const r = blastRoll(next, odds);
      next = r.state;
      if (r.result !== 'X') continue;
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
    // "When ... Ogre treads are the target, divide the total number of ...
    // tread units by 5. Round up, and roll that many separate attacks. Each X
    // destroys 5 ... treads."
    const ogre = next.units[id];
    if (ogre && isOgre(ogre) && ogre.treads > 0) {
      const rolls = Math.ceil(ogre.treads / 5);
      let lost = 0;
      for (let i = 0; i < rolls; i++) {
        const r = blastRoll(next, odds);
        next = r.state;
        if (r.result === 'X') lost += 5;
      }
      if (lost > 0) {
        const taken = Math.min(ogre.treads, lost);
        next = withUnit(next, { ...ogre, treads: ogre.treads - taken });
        if (scorer) next = addPoints(next, scorer, taken * ogreDamageValue('tread'));
        next = log(next, 'good', `The blast costs ${unitName(ogre)} ${taken} tread units.`, [
          ogre.pos,
        ]);
      }
    }
    return checkOgreDeath(next, { kind: 'ogreTreads', unit: id }, credit);
  }

  const odds = blastEffect(rowFor(u), away);
  if (odds.kind === 'none') return next;

  // A Laser takes it as a building does: "divide the total number of SPs ... by
  // 5. Round up, and roll that many separate attacks. Each X destroys 5 SPs."
  if (u.kind === 'unit' && unitClass(u.classId).structurePoints !== undefined) {
    const before = structurePointsOf(u);
    let left = before;
    const tries = Math.ceil(before / 5);
    for (let i = 0; i < tries && left > 0; i++) {
      const r = blastRoll(next, odds);
      next = r.state;
      if (r.result === 'X') left = Math.max(0, left - 5);
    }
    if (left === before) return next;
    next = withUnit(next, { ...u, structurePoints: left });
    next = log(
      next,
      left <= 0 ? 'good' : 'warn',
      left <= 0
        ? `The shockwave brings ${unitName(u)} down.`
        : `The shockwave takes ${String(before - left)} structure points off ${unitName(u)}; ` +
            `${String(left)} left.`,
      [u.pos],
    );
    if (left <= 0) next = destroyUnit(next, id, 'flattened by a cruise missile', credit);
    return next;
  }

  // "Infantry (each squad)" — a counter is rolled for a squad at a time.
  const rolls = u.kind === 'unit' && unitClass(u.classId).kind === 'infantry' ? u.squads : 1;
  for (let i = 0; i < rolls; i++) {
    const alive = next.units[id];
    if (!alive || !onBoard(alive)) break;
    const r = blastRoll(next, odds);
    next = r.state;
    if (r.result === 'NE') continue;
    next = log(next, 'warn', `The shockwave reaches ${unitName(alive)} in ${labelOf(alive.pos)}.`, [
      alive.pos,
    ]);
    next = applyDamageToUnit(next, id, r.result as 'D' | 'X', credit);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Fratricide bookkeeping
// ---------------------------------------------------------------------------

/** Hexes a cruise missile has gone off in during this player-turn (10.02.1). */
export const blastsThisTurn = (state: GameState): readonly string[] => state.missileBlasts ?? [];

const noteBlast = (state: GameState, gz: Hex): GameState => ({
  ...state,
  missileBlasts: [...blastsThisTurn(state), key(gz)],
});

/** Cleared as each player-turn opens: the sky is clear again. */
export const clearBlasts = (state: GameState): GameState =>
  (state.missileBlasts?.length ?? 0) === 0 ? state : { ...state, missileBlasts: [] };

const parseHexKey = (k: string): Hex => {
  const comma = k.indexOf(',');
  return { q: Number(k.slice(0, comma)), r: Number(k.slice(comma + 1)) };
};

const labelOf = (h: Hex): string => {
  // The map label, without dragging the hex module's formatter into the log.
  const col = h.q + 1;
  const row = h.r + ((h.q - (h.q & 1)) >> 1) + 1;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(col)}${pad(row)}`;
};

/** Missiles a player may still launch: their loaded crawlers on the board. */
export const loadedCrawlers = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter(
    (u) => u.kind === 'unit' && u.classId === 'MCRL' && u.owner === player && onBoard(u),
  );
