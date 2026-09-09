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
import { previewAttack, previewOrbitalStrike } from '../../src/ogre/engine/combat.js';
import {
  blastEffect,
  blastsThisTurn,
  interceptionTarget,
  launchCheck,
  trackingBonus,
} from '../../src/ogre/engine/missiles.js';
import { laserLineOfSight } from '../../src/ogre/engine/los.js';
import { movementAllowance, defenseOf } from '../../src/ogre/engine/state.js';
import { reachable } from '../../src/ogre/engine/movement.js';
import { canRam } from '../../src/ogre/engine/ram.js';
import { type Building, type GameState, isOgre } from '../../src/ogre/engine/types.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre } from './helpers.js';
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
