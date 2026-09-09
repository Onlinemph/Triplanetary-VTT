/**
 * The sections the engine used to leave out: cruise missiles (10), lasers
 * (12), the train (9), buildings under ram and overrun (11.04), the Ninja's
 * stealth (14.02), and Orbital Drop's asteroid table — each proved against
 * the reducer on a bare board.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { hexLine, key } from '../../src/ogre/engine/hex.js';
import { layRoute } from '../../src/ogre/engine/map.js';
import { terrainAt } from '../../src/ogre/engine/map.js';
import {
  previewAttack,
  previewOrbitalStrike,
  resolveAttack,
} from '../../src/ogre/engine/combat.js';
import { overrunStrength } from '../../src/ogre/engine/overrun.js';
import { advancePhase } from '../../src/ogre/engine/reducer.js';
import {
  blastEffect,
  blastsThisTurn,
  interceptionTarget,
  launchCheck,
  launchMissile,
  trackingBonus,
} from '../../src/ogre/engine/missiles.js';
import { laserLineOfSight } from '../../src/ogre/engine/los.js';
import {
  MAX_TRAIN_GUNS,
  TRAIN_CARGO_PER_HALF,
  TRAIN_GUN,
  armTrain,
  couple,
  destroyTrainCounter,
  gunsLeft,
  trainCargoUsed,
  trainFirepower,
} from '../../src/ogre/engine/train.js';
import { canOverrun } from '../../src/ogre/engine/overrun.js';
import { movementAllowance, defenseOf, laserDamaged } from '../../src/ogre/engine/state.js';
import { reachable, stepInfo } from '../../src/ogre/engine/movement.js';
import { canRam } from '../../src/ogre/engine/ram.js';
import { type Building, type GameState, isOgre } from '../../src/ogre/engine/types.js';
import {
  A,
  B,
  at,
  flatMap,
  inPhase,
  newGame,
  patch,
  put,
  putOgre,
  seedForRolls,
  weaponOf,
} from './helpers.js';
import { makeUnit } from '../../src/ogre/engine/state.js';
import type { UnitClassId } from '../../src/ogre/engine/units.js';

/** A bare counter of a class, for the tables that only read its class. */
const fake = (classId: UnitClassId) => makeUnit(`x-${classId}`, A, classId, at(1, 1));

const withBuilding = (state: GameState, b: Building): GameState => ({
  ...state,
  buildings: { ...state.buildings, [b.id]: b },
});

const fireFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'fire'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

const moveFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'movement'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

// ---------------------------------------------------------------------------
// 10 — Cruise missiles
// ---------------------------------------------------------------------------

describe('cruise missiles (Section 10)', () => {
  const map = flatMap(16, 12);

  it('launches from a loaded crawler, in the fire phase, and turns it into a Crawler', () => {
    let s = newGame({ seed: 3 });
    const crawler = put(s, A, 'MCRL', at(2, 6));
    s = crawler.state;
    const victim = put(s, B, 'HVY', at(8, 6));
    s = victim.state;

    expect(launchCheck(moveFor(s, A), map, s.units[crawler.id], at(8, 6))).toMatch(/fire phase/);

    const out = applyCommand(
      fireFor(s, A),
      { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(8, 6) },
      map,
    );
    expect(out.result.ok).toBe(true);
    const after = out.state;
    const spent = after.units[crawler.id]!;
    expect(spent.kind === 'unit' ? spent.classId : 'ogre').toBe('CRL');
    // "Remove all units, buildings, etc., in the hex it strikes. Place a
    // crater marker in that hex" (10.04).
    expect(after.units[victim.id]!.destroyed).toBe(true);
    expect(terrainAt(map, at(8, 6), after.terrainOverrides)).toBe('crater');
    // The crawler has fired.
    const again = applyCommand(
      after,
      { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(9, 6) },
      map,
    );
    expect(again.result.ok).toBe(false);
  });

  // "In that time, a Cruise Missile can reach any point on the map (however
  // big the map is) ... Once a Cruise Missile is fired, it is tracked to its
  // destination and its fate resolved before any more actions occur." (10.02)
  it('reaches the far side of the map inside the order that fired it', () => {
    let s = newGame({ seed: 5 });
    const crawler = put(s, A, 'MCRL', at(1, 6));
    s = crawler.state;
    // A Truck: no attack strength, so nothing along the way can shoot at it.
    const far = put(s, B, 'TK', at(16, 6));
    s = far.state;

    const out = applyCommand(
      fireFor(s, A),
      { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(16, 6) },
      map,
    );
    expect(out.result.ok).toBe(true);
    // Fifteen hexes, and it is already down: nothing waits for a later turn.
    expect(out.state.units[far.id]!.destroyed).toBe(true);
    expect(terrainAt(map, at(16, 6), out.state.terrainOverrides)).toBe('crater');
  });

  // "When attacking a Cruise Missile, a unit rolls two dice. The number on the
  // table below, or higher, kills the missile." (10.03.2)
  it('is shot at on two dice by every gun it passes, hardest by a laser', () => {
    expect(interceptionTarget(fake('LSR'))).toBe(9);
    // "Any armor unit with attack strength 3 or more" — a Heavy Tank is 4.
    expect(interceptionTarget(fake('HVY'))).toBe(11);
    // "Any armor unit with attack strength 1 or 2" — a Light Tank is 2.
    expect(interceptionTarget(fake('LT'))).toBe(12);
    expect(interceptionTarget(fake('LGEV'))).toBe(12);
    // "Each individual squad (1/1 unit) of infantry".
    expect(interceptionTarget(fake('INF'))).toBe(11);
    // No attack strength, no shot; and an AP gun is not on the table.
    expect(interceptionTarget(fake('TK'))).toBeNull();
    expect(interceptionTarget(fake('HVY'), 'ap')).toBeNull();
    expect(interceptionTarget(fake('HVY'), 'main')).toBe(10);
    expect(interceptionTarget(fake('HVY'), 'missile')).toBe(9);

    // "the attacking unit receives a bonus if the missile is more than 10
    // hexes from its hex of origin."
    expect(trackingBonus(10)).toBe(0);
    expect(trackingBonus(11)).toBe(1);
    expect(trackingBonus(16)).toBe(2);
    expect(trackingBonus(21)).toBe(3);
  });

  it('is brought down by a laser beside its path, and sometimes goes off where it was hit', () => {
    let s = newGame({ seed: 0 });
    const crawler = put(s, A, 'MCRL', at(2, 6));
    s = crawler.state;
    const laser = put(s, B, 'LSR', at(6, 4));
    s = laser.state;
    const target = put(s, B, 'HVY', at(12, 6));
    s = target.state;

    let sawShotDown = false;
    let sawEarly = false;
    for (let seed = 0; seed < 60 && !(sawShotDown && sawEarly); seed++) {
      const out = applyCommand(
        { ...fireFor(s, A), rng: { seed } },
        { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(12, 6) },
        map,
      );
      expect(out.result.ok).toBe(true);
      expect(out.state.log.some((e) => /tracks the missile/.test(e.text))).toBe(true);
      if (out.state.log.some((e) => /shot down/.test(e.text))) sawShotDown = true;
      // "On a roll of 6, the missile explodes in the hex where it was
      // intercepted" (10.03.3) — short of the target it was aimed at.
      if (out.state.log.some((e) => /goes off where it was hit/.test(e.text))) sawEarly = true;
    }
    expect(sawShotDown).toBe(true);
    expect(sawEarly).toBe(true);

    // Forest between the laser and the path blocks a standard laser.
    const wooded = flatMap(16, 12, { [key(at(6, 5))]: 'forest' });
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 6), 'standard')).toMatch(/blocked/);
    // A tower fires over it, but not into it.
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 6), 'tower')).toBeNull();
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 5), 'tower')).toMatch(/cannot fire into/);
  });

  // The table of 10.04, read straight off the page.
  it('reads the printed blast table by unit type and distance', () => {
    const col = (o: ReturnType<typeof blastEffect>): string =>
      o.kind === 'column' ? o.column : o.kind;
    // Any D0 unit or any GEV: X at 1-2, then 4-1, 2-1, 1-1, nothing at 6.
    expect(col(blastEffect('d0', 2))).toBe('auto');
    expect(col(blastEffect('d0', 3))).toBe('4-1');
    expect(col(blastEffect('d0', 5))).toBe('1-1');
    expect(col(blastEffect('d0', 6))).toBe('none');
    // D3+ armour, the train, a hardened CP: never an automatic kill.
    expect(col(blastEffect('d3', 1))).toBe('4-1');
    expect(col(blastEffect('d3', 3))).toBe('1-1');
    expect(col(blastEffect('d3', 4))).toBe('none');
    // Infantry, a squad at a time.
    expect(col(blastEffect('infantry', 1))).toBe('auto');
    expect(col(blastEffect('infantry', 2))).toBe('2-1');
    // A town or forest hex burns out to three hexes.
    expect(col(blastEffect('townForest', 3))).toBe('auto');
    expect(col(blastEffect('townForest', 7))).toBe('none');
    // An Ogre component, a road and a small building share a row.
    for (const row of ['ogreComponent', 'route', 'buildingSmall'] as const) {
      expect(col(blastEffect(row, 1))).toBe('2-1');
      expect(col(blastEffect(row, 2))).toBe('1-2');
      expect(col(blastEffect(row, 3))).toBe('none');
    }
    expect(col(blastEffect('buildingLarge', 1))).toBe('1-2');
    expect(col(blastEffect('buildingLarge', 2))).toBe('none');
  });

  // "no Cruise Missile fired later on that turn, whatever target it is aimed
  // at, may pass within six hexes of the explosion site." (10.02.1)
  it('refuses a second launch that would fly through this turn’s crater', () => {
    let s = newGame({ seed: 3 });
    const first = put(s, A, 'MCRL', at(2, 6));
    s = first.state;
    const second = put(s, A, 'MCRL', at(2, 8));
    s = second.state;
    const bait = put(s, B, 'HVY', at(9, 6));
    s = bait.state;

    const out = applyCommand(
      fireFor(s, A),
      { type: 'launchCruiseMissile', by: A, unit: first.id, target: at(9, 6) },
      map,
    );
    expect(out.result.ok).toBe(true);
    const refused = applyCommand(
      out.state,
      { type: 'launchCruiseMissile', by: A, unit: second.id, target: at(10, 7) },
      map,
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? '' : refused.result.reason).toMatch(/six hexes/);
    // And the sky is clear again next turn.
    let later = out.state;
    for (let i = 0; i < 8 && later.activePlayerIndex === 0; i++) {
      later = applyCommand(
        later,
        { type: 'endPhase', by: later.playerOrder[later.activePlayerIndex]! },
        map,
      ).state;
    }
    expect(blastsThisTurn(later)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12 — Lasers as guns
// ---------------------------------------------------------------------------

describe('lasers (Section 12)', () => {
  it('fire at any range down a clear line and not through a town', () => {
    let s = newGame({ seed: 1 });
    const laser = put(s, A, 'LSR', at(1, 1));
    s = laser.state;
    const far = put(s, B, 'MSL', at(12, 1));
    s = far.state;
    const clear = previewAttack(fireFor(s, A), flatMap(14, 8), [{ unit: laser.id }], {
      kind: 'unit',
      unit: far.id,
    });
    expect(clear.ok).toBe(true);

    const line = hexLine(at(1, 1), at(12, 1));
    const middle = line[Math.floor(line.length / 2)]!;
    const blocked = previewAttack(
      fireFor(s, A),
      flatMap(14, 8, { [key(middle)]: 'town' }),
      [{ unit: laser.id }],
      { kind: 'unit', unit: far.id },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/blocked/);
  });

  // "Defensively, they are buildings with Structure Points; see Section 11."
  // (12.01) So a shot at one takes SP off a total, and never rolls.
  it('take Structure Points off a total instead of rolling on the table', () => {
    let s = newGame({ seed: 1 });
    const laser = put(s, A, 'LSR', at(3, 3));
    s = laser.state;
    const tank = put(s, B, 'HVY', at(4, 3));
    s = fireFor(tank.state, B);
    const map = flatMap(10, 8);

    const preview = previewAttack(s, map, [{ unit: tank.id }], { kind: 'unit', unit: laser.id });
    expect(preview.ok).toBe(true);
    // 11.04.1: "Any weapon does damage equal to twice its attack strength."
    expect(preview.structureDamage).toBe(8);
    expect(preview.defenseStrength).toBe(20);

    // "If a building is in a town or forest, attacks are halved."
    const inTown = previewAttack(
      s,
      flatMap(10, 8, { [key(at(3, 3))]: 'town' }),
      [{ unit: tank.id }],
      { kind: 'unit', unit: laser.id },
    );
    expect(inTown.structureDamage).toBe(4);
  });

  // "When a Laser or Laser Tower is reduced to 10 SP, it is 'damaged' ... The
  // Laser can no longer fire, but it is not actually destroyed until it is
  // reduced to 0 SP." (12.07)
  it('are damaged at ten Structure Points and destroyed at none', () => {
    let s = newGame({ seed: 1 });
    const laser = put(s, A, 'LSR', at(3, 3));
    s = laser.state;
    const tank = put(s, B, 'HVY', at(4, 3));
    s = fireFor(tank.state, B);
    const map = flatMap(10, 8);

    // Two shots of 8 leave 4 SP: damaged, still standing.
    let out = resolveAttack(s, map, [{ unit: tank.id }], { kind: 'unit', unit: laser.id });
    s = patch(out.state, tank.id, { firedThisPhase: false });
    out = resolveAttack(s, map, [{ unit: tank.id }], { kind: 'unit', unit: laser.id });
    s = out.state;

    const hurt = s.units[laser.id]!;
    expect(hurt.kind === 'unit' && hurt.structurePoints).toBe(4);
    expect(hurt.destroyed).toBe(false);
    expect(hurt.kind === 'unit' && laserDamaged(hurt)).toBe(true);
    expect(s.log.some((e) => /can no longer fire/.test(e.text))).toBe(true);

    // A damaged Laser may not fire, even with a target in the open.
    const shot = previewAttack(fireFor(s, A), map, [{ unit: laser.id }], {
      kind: 'unit',
      unit: tank.id,
    });
    expect(shot.ok).toBe(false);
    expect(shot.reason).toMatch(/damaged/);

    // The next shot takes it to zero.
    s = patch(s, tank.id, { firedThisPhase: false });
    out = resolveAttack(s, map, [{ unit: tank.id }], { kind: 'unit', unit: laser.id });
    expect(out.state.units[laser.id]!.destroyed).toBe(true);
  });

  // "If a Laser or Laser Tower did not fire at all during the preceding enemy
  // turn, it may make one attack during its own fire phase." (12.06)
  it('may not attack a unit after spending the enemy turn tracking a missile', () => {
    let s = newGame({ seed: 1 });
    const laser = put(s, A, 'LSR', at(3, 3));
    s = laser.state;
    const tank = put(s, B, 'HVY', at(6, 3));
    s = fireFor(tank.state, A);
    const map = flatMap(10, 8);
    const target = { kind: 'unit' as const, unit: tank.id };

    expect(previewAttack(s, map, [{ unit: laser.id }], target).ok).toBe(true);

    const watched = patch(s, laser.id, { firedInEnemyTurn: true });
    const refused = previewAttack(watched, map, [{ unit: laser.id }], target);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/tracking a missile/);

    // The flag lasts exactly as long as its own fire phase: ending that phase
    // starts the watch over for the enemy turn about to begin.
    const after = advancePhase(watched, map);
    expect((after.units[laser.id] as { firedInEnemyTurn?: boolean }).firedInEnemyTurn).toBe(false);
  });

  // 12.04 and 12.06 together: the interception is what spends the shot.
  it('spend the shot when they track a cruise missile', () => {
    let s = newGame({ seed: 3 });
    const laser = put(s, A, 'LSR', at(6, 4));
    s = laser.state;
    const crawler = put(s, B, 'MCRL', at(2, 4));
    s = crawler.state;
    const victim = put(s, A, 'HVY', at(12, 4));
    s = fireFor(victim.state, B);
    const map = flatMap(16, 8);

    const out = launchMissile(s, map, crawler.id, at(12, 4));
    expect(out.ok).toBe(true);
    expect(out.state.log.some((e) => /tracks the missile/.test(e.text))).toBe(true);
    const after = out.state.units[laser.id] as { firedInEnemyTurn?: boolean };
    expect(after.firedInEnemyTurn).toBe(true);
  });

  // "To hit an Ogre missile, the Laser must roll a 10 or above on two dice."
  // (12.05)
  it('intercept an Ogre missile on a 10 or better, and nothing else may try', () => {
    const board = flatMap(16, 8);
    const setUp = (seed: number): { state: GameState; laser: string; ogre: string } => {
      let s = newGame({ seed });
      const laser = put(s, A, 'LSR', at(8, 4));
      s = laser.state;
      const ogre = putOgre(s, B, 'MK3', at(4, 4));
      s = ogre.state;
      // An Ogre missile reaches five hexes (7.05.2).
      const mark = put(s, A, 'HVY', at(8, 4));
      s = fireFor(mark.state, B);
      return { state: s, laser: laser.id, ogre: ogre.id };
    };

    const hit = setUp(seedForRolls([5, 5]));
    const missile = weaponOf(hit.state, hit.ogre, 'missile');
    const mark = Object.values(hit.state.units).find(
      (u) => u.owner === A && u.kind === 'unit' && u.classId === 'HVY',
    )!;
    const shot = resolveAttack(hit.state, board, [{ unit: hit.ogre, weapon: missile.id }], {
      kind: 'unit',
      unit: mark.id,
    });
    expect(shot.resolution).toBeNull();
    expect(shot.reason).toMatch(/shot down/);
    expect(shot.state.log.some((e) => /needs 10, rolled 10: shot down/.test(e.text))).toBe(true);
    // The missile is spent all the same, and the target untouched.
    expect(shot.state.units[mark.id]!.destroyed).toBe(false);
    expect(weaponOf(shot.state, hit.ogre, 'missile').fired).toBe(true);
    // And the Laser has spent its own shot (12.06).
    expect((shot.state.units[hit.laser] as { firedInEnemyTurn?: boolean }).firedInEnemyTurn).toBe(
      true,
    );

    // A 9 is not enough.
    const miss = setUp(seedForRolls([4, 5]));
    const missile2 = weaponOf(miss.state, miss.ogre, 'missile');
    const mark2 = Object.values(miss.state.units).find(
      (u) => u.owner === A && u.kind === 'unit' && u.classId === 'HVY',
    )!;
    const through = resolveAttack(miss.state, board, [{ unit: miss.ogre, weapon: missile2.id }], {
      kind: 'unit',
      unit: mark2.id,
    });
    expect(through.resolution).not.toBeNull();
    expect(through.state.log.some((e) => /it flies on/.test(e.text))).toBe(true);
  });

  // "(Missiles from a Missile Tank are too small and fast for a Laser to
  // attack at all.)" (12.05)
  it('cannot touch a Missile Tank’s shot', () => {
    let s = newGame({ seed: seedForRolls([5, 5, 1]) });
    const laser = put(s, A, 'LSR', at(8, 4));
    s = laser.state;
    const msl = put(s, B, 'MSL', at(6, 4));
    s = msl.state;
    const mark = put(s, A, 'LT', at(9, 4));
    s = fireFor(mark.state, B);
    const out = resolveAttack(s, flatMap(16, 8), [{ unit: msl.id }], {
      kind: 'unit',
      unit: mark.id,
    });
    expect(out.resolution).not.toBeNull();
    expect(out.state.log.some((e) => /tracks the Ogre missile/.test(e.text))).toBe(false);
  });

  // "A Laser attack does not give spillover fire on units stacked with the
  // target. If a vehicle is the target, the attack does affect infantry riding
  // on that vehicle." (12.08) The riders are hit by 5.11.2, not by spillover.
  it('give no spillover, except onto infantry riding the target', () => {
    const map = flatMap(12, 8);
    const build = (rider: boolean): { state: GameState; laser: string; inf: string } => {
      // One die roll for the combination (5.11.2): a 6 is no effect at 1-1 on
      // the GEV — it is an X — so use a 4: a D on the GEV at 1-1, and an X on
      // the single squad at 2-1.
      let s = newGame({ seed: seedForRolls([4]), stackingLimit: 5 });
      const laser = put(s, A, 'LSR', at(2, 4));
      s = laser.state;
      const gev = put(s, B, 'GEV', at(6, 4));
      s = gev.state;
      const inf = put(s, B, 'INF', at(6, 4), 1);
      s = inf.state;
      if (rider) s = patch(s, inf.id, { ridingOn: gev.id });
      return { state: fireFor(s, A), laser: laser.id, inf: inf.id };
    };

    const gevOf = (st: GameState): string =>
      Object.values(st.units).find((u) => u.kind === 'unit' && u.classId === 'GEV')!.id;

    // Standing in the same hex: nothing touches the infantry.
    const stacked = build(false);
    const a = resolveAttack(stacked.state, map, [{ unit: stacked.laser }], {
      kind: 'unit',
      unit: gevOf(stacked.state),
    });
    expect(a.state.log.some((e) => /Spillover/.test(e.text))).toBe(false);
    expect(a.state.units[stacked.inf]!.destroyed).toBe(false);

    // Riding it: the same shot is calculated against them too (5.11.2).
    const riding = build(true);
    const b = resolveAttack(riding.state, map, [{ unit: riding.laser }], {
      kind: 'unit',
      unit: gevOf(riding.state),
    });
    expect(b.state.log.some((e) => /Spillover/.test(e.text))).toBe(false);
    expect(b.state.log.some((e) => /riding/.test(e.text))).toBe(true);
    expect(b.state.units[riding.inf]!.destroyed).toBe(true);
  });

  // "A Laser being overrun fires at double strength (4) ... However, a damaged
  // Laser (Section 12.07) does not fire at all." (12.09)
  it('fire at double strength in an overrun, unless they are damaged', () => {
    const laser = makeUnit('l', A, 'LSR', at(1, 1));
    expect(overrunStrength(laser, { unit: 'l' })).toBe(4);
    const damaged = { ...laser, structurePoints: 6 };
    expect(laserDamaged(damaged)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9 — The train
// ---------------------------------------------------------------------------

describe('the train (Section 9)', () => {
  const rails = flatMap(12, 6);
  const line = [at(1, 3), at(2, 3), at(3, 3), at(4, 3), at(5, 3), at(6, 3), at(7, 3)];
  const b = { terrain: {}, sides: {}, routes: {} as Record<string, 'road' | 'rail'> };
  layRoute(b, line, 'rail');
  const map = { ...rails, routes: b.routes };

  // "M4/5, for instance, means that the train will move forward either 4 or 5
  // hexes (as the owning player chooses). On its movement phase, the train
  // must move one of the two distances shown by the counter on it." (9.02)
  it('runs one of the two distances on its marker, and nowhere off the rails', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(1, 3));
    s = {
      ...train.state,
      units: {
        ...train.state.units,
        [train.id]: { ...train.state.units[train.id]!, trainSpeed: 2 } as never,
      },
    };
    const other = put(s, B, 'INF', at(12, 6));
    s = moveFor(other.state, A);

    // The M2/3 marker: two hexes or three, and never one or four.
    const reach = reachable(s, map, s.units[train.id]!);
    const keys = reach.map((r) => key(r.hex));
    expect(keys).toContain(key(at(3, 3)));
    expect(keys).toContain(key(at(4, 3)));
    expect(keys).not.toContain(key(at(2, 3)));
    expect(keys).not.toContain(key(at(5, 3)));
    expect(keys).not.toContain(key(at(2, 2)));
    expect(movementAllowance(s.units[train.id]!, 'movement')).toBe(3);
    // Creeping one hex is refused in so many words.
    const creep = applyCommand(
      s,
      { type: 'moveUnit', by: A, unit: train.id, path: [at(2, 3)] },
      map,
    );
    expect(creep.result.ok).toBe(false);
    expect(creep.result.ok ? '' : creep.result.reason).toMatch(/runs 2 or 3 hexes/);
  });

  // "If the train moves into a hex where the rails are cut, it is destroyed."
  // (9.02.4)
  it('is destroyed when it runs onto cut track', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(1, 3));
    s = {
      ...train.state,
      units: {
        ...train.state.units,
        [train.id]: { ...train.state.units[train.id]!, trainSpeed: 2 } as never,
      },
      routesCut: [key(at(3, 3))],
    };
    const other = put(s, B, 'INF', at(12, 6));
    s = moveFor(other.state, A);
    const out = applyCommand(
      s,
      { type: 'moveUnit', by: A, unit: train.id, path: [at(2, 3), at(3, 3)] },
      map,
    );
    expect(out.result.ok).toBe(true);
    expect(out.state.units[train.id]!.destroyed).toBe(true);
    expect(out.state.log.some((e) => /cut track/.test(e.text))).toBe(true);
  });

  // 9.06: "If the train moves onto a unit on the track ... (a) If the enemy
  // units are armed ... The train is destroyed. ... (b) If the enemy units are
  // unarmed, the train collides with them ... The enemy units are destroyed."
  it('is wrecked by armed units standing on the line, and runs down unarmed ones', () => {
    const board = (guard: 'HVY' | 'TK', speed: number) => {
      let s = newGame({ seed: 2, stackingLimit: 5 });
      const train = put(s, A, 'TRAIN', at(1, 3));
      s = {
        ...train.state,
        units: {
          ...train.state.units,
          [train.id]: { ...train.state.units[train.id]!, trainSpeed: speed } as never,
        },
      };
      const block = put(s, B, guard, at(3, 3));
      s = moveFor(block.state, A);
      return { s, train: train.id, block: block.id };
    };

    // Armed: the guns cut the track in front of it.
    const armed = board('HVY', 2);
    const hit = applyCommand(
      armed.s,
      { type: 'moveUnit', by: A, unit: armed.train, path: [at(2, 3), at(3, 3)] },
      map,
    );
    expect(hit.result.ok).toBe(true);
    expect(hit.state.units[armed.train]!.destroyed).toBe(true);
    expect(hit.state.log.some((e) => /runs into the guns/.test(e.text))).toBe(true);

    // Unarmed: the train goes through it, and takes a collision for its size.
    const soft = board('TK', 2);
    const through = applyCommand(
      soft.s,
      { type: 'moveUnit', by: A, unit: soft.train, path: [at(2, 3), at(3, 3)] },
      map,
    );
    expect(through.result.ok).toBe(true);
    expect(through.state.units[soft.block]!.destroyed).toBe(true);
    expect(through.state.log.some((e) => /ploughs through/.test(e.text))).toBe(true);
  });

  // "If a train counter is in a town hex, its defense strength is doubled.
  // Other terrain does not affect the train's defense." (9.03.2)
  it('doubles its defence in a town and nowhere else', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(4, 3));
    s = train.state;
    expect(defenseOf(s, map, s.units[train.id]!)).toBe(3);
    const town = { ...map, terrain: { ...map.terrain, [key(at(4, 3))]: 'town' as const } };
    expect(defenseOf(s, town, s.units[train.id]!)).toBe(6);
    const wood = { ...map, terrain: { ...map.terrain, [key(at(4, 3))]: 'forest' as const } };
    expect(defenseOf(s, wood, s.units[train.id]!)).toBe(3);
  });

  // "At the end of each turn, the player owning the train may change its speed
  // by one marker faster or slower. That is, if its speed was M2/3, he may
  // change it to M0/1 or to M4/5." (9.02.1)
  it('changes by one marker, once a turn, at the end of the turn', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(1, 3));
    s = {
      ...train.state,
      units: {
        ...train.state.units,
        [train.id]: { ...train.state.units[train.id]!, trainSpeed: 2 } as never,
      },
    };
    const other = put(s, B, 'INF', at(12, 6));
    // Not while it is still running.
    expect(
      applyCommand(
        moveFor(other.state, A),
        {
          type: 'setTrainSpeed',
          by: A,
          unit: train.id,
          change: 1,
        },
        map,
      ).result.ok,
    ).toBe(false);
    s = fireFor(other.state, A);

    const up = applyCommand(s, { type: 'setTrainSpeed', by: A, unit: train.id, change: 1 }, map);
    expect(up.result.ok).toBe(true);
    // M2/3 to M4/5, not to M3.
    expect((up.state.units[train.id] as { trainSpeed?: number }).trainSpeed).toBe(4);
    const twice = applyCommand(
      up.state,
      { type: 'setTrainSpeed', by: A, unit: train.id, change: 1 },
      map,
    );
    expect(twice.result.ok).toBe(false);
  });

  it('shrugs off a D and is derailed by an Ogre’s ram', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, B, 'TRAIN', at(2, 3));
    s = train.state;
    const ogre = putOgre(s, A, 'MK3', at(1, 3));
    s = moveFor(ogre.state, A);
    const check = canRam(s, map, s.units[ogre.id]!, at(2, 3));
    expect(check.ok).toBe(true);
    expect(check.kind).toBe('ogreVsTrain');
    const out = applyCommand(s, { type: 'ram', by: A, unit: ogre.id, target: at(2, 3) }, map);
    expect(out.result.ok).toBe(true);
    expect(out.state.units[train.id]!.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11.04 — Buildings under ram and overrun
// ---------------------------------------------------------------------------

describe('buildings (11.04)', () => {
  const map = flatMap(10, 10);
  const admin: Building = {
    id: 'hq',
    kind: 'admin',
    owner: B,
    pos: at(3, 3),
    structurePoints: 20,
    maxStructurePoints: 20,
    destroyed: false,
  };

  it('take dice of damage from an Ogre’s ram (11.04.3)', () => {
    let s = withBuilding(newGame({ seed: 4 }), admin);
    const ogre = putOgre(s, A, 'MK3', at(2, 3));
    s = ogre.state;
    const other = put(s, B, 'INF', at(9, 9));
    s = moveFor(other.state, A);
    const check = canRam(s, map, s.units[ogre.id]!, at(3, 3));
    expect(check.ok).toBe(true);
    expect(check.kind).toBe('ogreVsBuilding');
    const out = applyCommand(s, { type: 'ram', by: A, unit: ogre.id, target: at(3, 3) }, map);
    expect(out.result.ok).toBe(true);
    expect(out.state.buildings['hq']!.structurePoints).toBeLessThan(20);
    // A Mark III is Size 7: three dice, so at least three points.
    expect(out.state.buildings['hq']!.structurePoints).toBeLessThanOrEqual(17);
    expect(key(out.state.units[ogre.id]!.pos)).toBe(key(at(3, 3)));
  });

  it('are fired on in the fire phase for twice the strength, no roll (11.04.1)', () => {
    let s = withBuilding(newGame({ seed: 4 }), admin);
    const tank = put(s, A, 'HVY', at(4, 3));
    s = tank.state;
    const other = put(s, B, 'INF', at(9, 9));
    s = fireFor(other.state, A);
    const preview = previewAttack(s, map, [{ unit: tank.id }], {
      kind: 'building',
      building: 'hq',
    });
    expect(preview.ok).toBe(true);
    expect(preview.structureDamage).toBe(8);
    const out = applyCommand(
      s,
      {
        type: 'attack',
        by: A,
        attackers: [{ unit: tank.id }],
        target: { kind: 'building', building: 'hq' },
      },
      map,
    );
    expect(out.state.buildings['hq']!.structurePoints).toBe(12);
  });

  it('are a target for the attackers inside an overrun (11.04.2)', () => {
    let s = withBuilding(newGame({ seed: 4, stackingLimit: 5 }), admin);
    s = { ...s, options: { ...s.options, overrunCombat: true } };
    const tank = put(s, A, 'HVY', at(2, 3));
    s = tank.state;
    const guard = put(s, B, 'INF', at(3, 3));
    s = moveFor(guard.state, A);
    let out = applyCommand(s, { type: 'overrun', by: A, unit: tank.id, target: at(3, 3) }, map);
    expect(out.result.ok).toBe(true);
    // Dismount window, then the defender's round, then the attacker's.
    out = applyCommand(out.state, { type: 'endFireRound', by: A }, map);
    out = applyCommand(out.state, { type: 'endFireRound', by: B }, map);
    expect(out.state.overrun?.firing).toBe('attacker');
    const shot = applyCommand(
      out.state,
      {
        type: 'overrunAttack',
        by: A,
        attackers: [{ unit: tank.id }],
        target: { kind: 'building', building: 'hq' },
      },
      map,
    );
    expect(shot.result.ok).toBe(true);
    expect(shot.state.buildings['hq']!.structurePoints).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 14.02 — The Ninja
// ---------------------------------------------------------------------------

describe('the Ninja (14.02)', () => {
  const map = flatMap(10, 10);

  it('does not combine its fire with other units', () => {
    let s = newGame({ seed: 6 });
    const ninja = putOgre(s, A, 'NINJA', at(2, 2));
    s = ninja.state;
    const tank = put(s, A, 'HVY', at(3, 2));
    s = tank.state;
    const victim = put(s, B, 'MSL', at(4, 2));
    s = fireFor(victim.state, A);
    const stealth = s.units[ninja.id]!;
    if (!isOgre(stealth)) throw new Error('not an Ogre');
    const main = stealth.weapons.find((w) => w.kind === 'main')!;
    const mixed = previewAttack(s, map, [{ unit: ninja.id, weapon: main.id }, { unit: tank.id }], {
      kind: 'unit',
      unit: victim.id,
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.reason).toMatch(/Ninja/);
    const alone = previewAttack(s, map, [{ unit: ninja.id, weapon: main.id }], {
      kind: 'unit',
      unit: victim.id,
    });
    expect(alone.ok).toBe(true);
  });

  it('takes one off every die rolled against it', () => {
    let s = newGame({ seed: 6 });
    const ninja = putOgre(s, B, 'NINJA', at(2, 2));
    s = ninja.state;
    const tank = put(s, A, 'HVY', at(3, 2));
    s = fireFor(tank.state, A);
    const stealth = s.units[ninja.id]!;
    if (!isOgre(stealth)) throw new Error('not an Ogre');
    const ap = stealth.weapons.find((w) => w.kind === 'ap')!;
    // 4 against D1 is 4-1: only a 1 misses, and with the stealth modifier a 2
    // rolls as a 1. Look for a log line that says so.
    let saw = false;
    for (let seed = 0; seed < 60 && !saw; seed++) {
      const out = applyCommand(
        { ...s, rng: { seed } },
        {
          type: 'attack',
          by: A,
          attackers: [{ unit: tank.id }],
          target: { kind: 'ogreWeapon', unit: ninja.id, weapon: ap.id },
        },
        map,
      );
      expect(out.result.ok).toBe(true);
      if (out.state.log.some((e) => /−1 for the Ninja/.test(e.text))) saw = true;
    }
    expect(saw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orbital Drop §5 — the asteroid table, and §6.01's preview
// ---------------------------------------------------------------------------

describe('asteroid rules and the strike preview', () => {
  const map = flatMap(10, 10);

  it('grounds hovercraft and speeds everything else in low gravity', () => {
    let s = newGame({ seed: 7 });
    s = { ...s, options: { ...s.options, lowGravity: true, noHover: true } };
    const gev = put(s, A, 'GEV', at(2, 2));
    s = gev.state;
    const tank = put(s, A, 'HVY', at(3, 3));
    s = tank.state;
    const lgev = put(s, B, 'LGEV', at(6, 6));
    s = lgev.state;
    expect(movementAllowance(s.units[gev.id]!, 'movement', s.options)).toBe(0);
    expect(movementAllowance(s.units[tank.id]!, 'movement', s.options)).toBe(4);
    expect(defenseOf(s, map, s.units[lgev.id]!)).toBe(2);
    const ogre = putOgre(s, A, 'MK3', at(5, 5));
    expect(movementAllowance(ogre.state.units[ogre.id]!, 'movement', s.options)).toBe(4);
  });

  it('previews an orbital strike the way it resolves', () => {
    let s = newGame({ seed: 8 });
    s = { ...s, scenarioData: { orbitalStrikes: [3], orbitalStrikeSide: A } };
    const victim = put(s, B, 'HVY', at(4, 4));
    s = fireFor(victim.state, A);
    const p = previewOrbitalStrike(s, map, 0, { kind: 'unit', unit: victim.id });
    expect(p.ok).toBe(true);
    expect(p.odds).toEqual({ kind: 'column', column: '1-1' });
    const treads = previewOrbitalStrike(s, map, 0, { kind: 'ogreTreads', unit: victim.id });
    expect(treads.ok).toBe(false);
    const ogre = putOgre(s, B, 'MK3', at(5, 5));
    const whole = previewOrbitalStrike(ogre.state, map, 0, { kind: 'unit', unit: ogre.id });
    expect(whole.ok).toBe(false);
    expect(isOgre(ogre.state.units[ogre.id]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9.01, 9.03, 9.03.1, 9.07 — the train as two counters
// ---------------------------------------------------------------------------

describe('a train is two counters (9.01)', () => {
  const rails = flatMap(14, 6);
  const line = [
    at(1, 3),
    at(2, 3),
    at(3, 3),
    at(4, 3),
    at(5, 3),
    at(6, 3),
    at(7, 3),
    at(8, 3),
    at(9, 3),
  ];
  const b = { terrain: {}, sides: {}, routes: {} as Record<string, 'road' | 'rail'> };
  layRoute(b, line, 'rail');
  const railMap = { ...rails, routes: b.routes };

  /** A coupled pair with track on both sides of it: rear at `line[2]`, front at `line[3]`. */
  const coupledTrain = (seed = 2, speed = 2): { state: GameState; front: string; rear: string } => {
    let s = newGame({ seed });
    const rear = put(s, A, 'TRAIN', line[2]!);
    s = rear.state;
    const front = put(s, A, 'TRAIN', line[3]!);
    s = patch(front.state, front.id, { trainSpeed: speed });
    s = couple(s, front.id, rear.id);
    const other = put(s, B, 'INF', at(13, 6));
    return { state: other.state, front: front.id, rear: rear.id };
  };

  // "The two train counters are identical, and the train may go either
  // direction. 'Front' and 'back' are always relative to the movement of the
  // train." (9.02)
  it('brings the rear up behind the front, one marker between them', () => {
    const t = coupledTrain();
    const s = moveFor(t.state, A);
    expect((s.units[t.rear] as { trainSpeed?: number }).trainSpeed).toBe(2);

    // The M2/3 marker: three hexes, and the rear ends one behind.
    const next = applyCommand(
      s,
      { type: 'moveUnit', by: A, unit: t.front, path: [at(5, 3), at(6, 3), at(7, 3)] },
      railMap,
    );
    expect(next.result.ok).toBe(true);
    expect(key(next.state.units[t.front]!.pos)).toBe(key(at(7, 3)));
    expect(key(next.state.units[t.rear]!.pos)).toBe(key(at(6, 3)));
    expect((next.state.units[t.rear] as { trainHalf?: string }).trainHalf).toBe('rear');
  });

  // "if it was 0/1, it may either go to 2/3 in the same direction, or 0/1 in
  // the reverse direction (reverse the arrow)." (9.02.1)
  it('only reverses on the slowest marker', () => {
    const rolling = moveFor(coupledTrain(2, 2).state, A);
    const rearId = Object.values(rolling.units).find(
      (u) => u.kind === 'unit' && u.trainHalf === 'rear',
    )!.id;
    const refused = applyCommand(
      rolling,
      { type: 'moveUnit', by: A, unit: rearId, path: [at(2, 3)] },
      railMap,
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? '' : refused.result.reason).toMatch(/only reverses/);

    // Braked to M0/1 it may back up, and the counter that leads becomes front.
    const stopped = moveFor(coupledTrain(2, 0).state, A);
    const rear2 = Object.values(stopped.units).find(
      (u) => u.kind === 'unit' && u.trainHalf === 'rear',
    )!;
    const backed = applyCommand(
      stopped,
      { type: 'moveUnit', by: A, unit: rear2.id, path: [at(2, 3)] },
      railMap,
    );
    expect(backed.result.ok).toBe(true);
    expect((backed.state.units[rear2.id] as { trainHalf?: string }).trainHalf).toBe('front');
  });

  // "If an attack destroys the rear of the train ... that counter is flipped to
  // the destroyed side, but the other half of the train is not affected. If an
  // attack destroys the front of a moving train, the whole train is destroyed
  // ... If a train counter is destroyed, the rails in those hexes are
  // considered cut." (9.03)
  it('loses its rear alone, and the whole train if the front goes at speed', () => {
    const t = coupledTrain();
    const rearGone = destroyTrainCounter(t.state, t.rear, 'shot off');
    expect(rearGone.units[t.rear]!.destroyed).toBe(true);
    expect(rearGone.units[t.front]!.destroyed).toBe(false);
    expect(rearGone.routesCut).toContain(key(line[2]!));
    // The survivor is a one-counter train from here (9.00).
    expect((rearGone.units[t.front] as { coupledTo?: string }).coupledTo).toBeUndefined();

    const frontGone = destroyTrainCounter(t.state, t.front, 'shot off');
    expect(frontGone.units[t.front]!.destroyed).toBe(true);
    expect(frontGone.units[t.rear]!.destroyed).toBe(true);

    // Standing still on M0/1, either half goes on its own.
    const halted = coupledTrain(2, 0);
    const one = destroyTrainCounter(halted.state, halted.front, 'shot off');
    expect(one.units[halted.front]!.destroyed).toBe(true);
    expect(one.units[halted.rear]!.destroyed).toBe(false);
  });

  // "For each armor unit given up, he can put one 4/2 gun on each of the train
  // counters (thus, if he exchanges 4 armor units, the train will have 8
  // attacks, each with a strength of 4 and range of 2, per turn)." (9.03.1)
  it('carries up to four 4/2 guns a counter when a scenario arms it', () => {
    const t = coupledTrain();
    const armed = armTrain(t.state, t.front, MAX_TRAIN_GUNS);
    expect(trainFirepower(armed, armed.units[t.front]!)).toBe(8 * TRAIN_GUN.attack);

    let s = fireFor(armed, A);
    const victim = put(s, B, 'HVY', at(5, 3));
    s = victim.state;
    const one = { unit: t.front, squads: 1 };
    const preview = previewAttack(s, railMap, [one], { kind: 'unit', unit: victim.id });
    expect(preview.ok).toBe(true);
    expect(preview.attackStrength).toBe(TRAIN_GUN.attack);

    // Out of range at three hexes: the guns reach two.
    const far = put(s, B, 'HVY', at(7, 3));
    expect(previewAttack(far.state, railMap, [one], { kind: 'unit', unit: far.id }).reason).toMatch(
      /out of range/,
    );

    // Four separate shots, and then the counter is spent.
    let firing = s;
    for (let i = 0; i < MAX_TRAIN_GUNS; i++) {
      const out = resolveAttack(firing, railMap, [one], { kind: 'unit', unit: victim.id });
      firing = out.state;
      if (out.state.units[victim.id]!.destroyed) break;
    }
    expect(gunsLeft(firing.units[t.front]!)).toBeLessThan(MAX_TRAIN_GUNS);

    // "Unless the train is armed (9.03.1), enemy units may enter its hex
    // freely." An armed one is in the way.
    const enemy = put(moveFor(armed, B), B, 'HVY', at(5, 3));
    const step = stepInfo(enemy.state, railMap, enemy.state.units[enemy.id]!, at(5, 3), line[3]!);
    expect(step.ok).toBe(false);
  });

  // "Only units of Size 3 or below may go on the train. Each half of the train
  // may carry up to 12 'size points' worth of armor (e.g., 4 Heavy Tanks, or
  // 12 squads of infantry)." (9.07)
  it('carries twelve size points a half, and nothing bigger than Size 3', () => {
    const t = coupledTrain();
    let s = moveFor(t.state, A);
    // Four Heavy Tanks (Size 3) fill a half; the fifth is turned away.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tank = put(s, A, 'HVY', line[3]!);
      s = tank.state;
      ids.push(tank.id);
    }
    for (let i = 0; i < 4; i++) {
      const out = applyCommand(
        s,
        { type: 'mount', by: A, unit: ids[i]!, carrier: t.front },
        railMap,
      );
      expect(out.result.ok).toBe(true);
      s = out.state;
    }
    expect(trainCargoUsed(s, t.front)).toBe(TRAIN_CARGO_PER_HALF);
    const full = applyCommand(
      s,
      { type: 'mount', by: A, unit: ids[4]!, carrier: t.front },
      railMap,
    );
    expect(full.result.ok).toBe(false);
    expect(full.result.ok ? '' : full.result.reason).toMatch(/size points/);

    // A Superheavy is Size 5 and does not go on the train at all.
    const big = put(moveFor(t.state, A), A, 'SHVY', line[3]!);
    const refused = applyCommand(
      big.state,
      { type: 'mount', by: A, unit: big.id, carrier: t.front },
      railMap,
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? '' : refused.result.reason).toMatch(/Size 3 or below/);
  });

  // "If an unarmed train ... is overrun by, a unit with a regular combat
  // strength, it is destroyed ... Exception: An overrun onto the rear counter
  // of the train ... destroys only that counter." (9.04)
  it('is run down where it stands when it has no guns', () => {
    const t = coupledTrain();
    let s = { ...t.state, options: { ...t.state.options, overrunCombat: true } };
    const tank = put(s, B, 'HVY', at(3, 2));
    s = moveFor(tank.state, B);
    // No overrun is fought: the train is simply run down (9.04).
    expect(canOverrun(s, railMap, s.units[tank.id]!, line[2]!).ok).toBe(false);
    const out = applyCommand(
      s,
      { type: 'moveUnit', by: B, unit: tank.id, path: [line[2]!] },
      railMap,
    );
    expect(out.result.ok).toBe(true);
    expect(out.state.units[t.rear]!.destroyed).toBe(true);
    expect(out.state.units[t.front]!.destroyed).toBe(false);
  });
});
