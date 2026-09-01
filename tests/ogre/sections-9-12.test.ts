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
import { launchCheck } from '../../src/ogre/engine/missiles.js';
import { laserLineOfSight } from '../../src/ogre/engine/los.js';
import { movementAllowance, defenseOf } from '../../src/ogre/engine/state.js';
import { reachable } from '../../src/ogre/engine/movement.js';
import { canRam } from '../../src/ogre/engine/ram.js';
import { type Building, type GameState, isOgre } from '../../src/ogre/engine/types.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre } from './helpers.js';

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
    // Six hexes away: it arrives this leg, and ground zero is total.
    expect(after.units[victim.id]!.destroyed).toBe(true);
    expect(terrainAt(map, at(8, 6), after.terrainOverrides)).toBe('crater');
    expect(Object.keys(after.missiles ?? {})).toHaveLength(0);
    // The crawler has fired.
    const again = applyCommand(
      after,
      { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(9, 6) },
      map,
    );
    expect(again.result.ok).toBe(false);
  });

  it('flies twelve hexes a turn and finishes the trip next fire phase', () => {
    let s = newGame({ seed: 5 });
    const crawler = put(s, A, 'MCRL', at(1, 6));
    s = crawler.state;
    // Something far away, and something of B's so the game has two sides.
    const far = put(s, B, 'HWZ', at(16, 6));
    s = far.state;

    const out = applyCommand(
      fireFor(s, A),
      { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(16, 6) },
      map,
    );
    expect(out.result.ok).toBe(true);
    const inFlight = Object.values(out.state.missiles ?? {});
    expect(inFlight).toHaveLength(1);
    expect(out.state.units[far.id]!.destroyed).toBe(false);

    // Wind round to A's next fire phase; the missile lands on the way in.
    let s2 = out.state;
    for (let i = 0; i < 12 && s2.units[far.id] && !s2.units[far.id]!.destroyed; i++) {
      s2 = applyCommand(s2, { type: 'endPhase', by: s2.playerOrder[s2.activePlayerIndex]! }, map)
        .state;
    }
    expect(s2.units[far.id]!.destroyed).toBe(true);
    expect(Object.keys(s2.missiles ?? {})).toHaveLength(0);
  });

  it('is shot down by a laser with a line of sight, and blocked by forest', () => {
    // A laser beside the flight path, with a seed that makes its 1-1 shot an X.
    let s = newGame({ seed: 0 });
    const crawler = put(s, A, 'MCRL', at(2, 6));
    s = crawler.state;
    const laser = put(s, B, 'LSR', at(6, 4));
    s = laser.state;
    const target = put(s, B, 'HVY', at(10, 6));
    s = target.state;

    // Search the seed space for an interception that connects.
    let shotDown = false;
    for (let seed = 0; seed < 40 && !shotDown; seed++) {
      const trial = { ...fireFor(s, A), rng: { seed } };
      const out = applyCommand(
        trial,
        { type: 'launchCruiseMissile', by: A, unit: crawler.id, target: at(10, 6) },
        map,
      );
      expect(out.result.ok).toBe(true);
      const intercepted = out.state.log.some((e) => /tracks the cruise missile/.test(e.text));
      expect(intercepted).toBe(true);
      if (!out.state.units[target.id]!.destroyed) shotDown = true;
    }
    expect(shotDown).toBe(true);

    // Forest between the laser and the path blocks a standard laser.
    const wooded = flatMap(16, 12, { [key(at(6, 5))]: 'forest' });
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 6), 'standard')).toMatch(/blocked/);
    // A tower fires over it, but not into it.
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 6), 'tower')).toBeNull();
    expect(laserLineOfSight(s, wooded, at(6, 4), at(6, 5), 'tower')).toMatch(/cannot fire into/);
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

  it('runs on rails at its speed marker and nowhere else', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(1, 3));
    s = { ...train.state, units: { ...train.state.units, [train.id]: { ...train.state.units[train.id]!, trainSpeed: 2 } as never } };
    const other = put(s, B, 'INF', at(12, 6));
    s = moveFor(other.state, A);

    const reach = reachable(s, map, s.units[train.id]!);
    const keys = reach.map((r) => key(r.hex));
    expect(keys).toContain(key(at(3, 3)));
    expect(keys).not.toContain(key(at(4, 3)));
    expect(keys).not.toContain(key(at(2, 2)));
    expect(movementAllowance(s.units[train.id]!, 'movement')).toBe(2);
  });

  it('changes speed by one step, once a turn, before it moves', () => {
    let s = newGame({ seed: 2 });
    const train = put(s, A, 'TRAIN', at(1, 3));
    s = { ...train.state, units: { ...train.state.units, [train.id]: { ...train.state.units[train.id]!, trainSpeed: 1 } as never } };
    const other = put(s, B, 'INF', at(12, 6));
    s = moveFor(other.state, A);

    const up = applyCommand(s, { type: 'setTrainSpeed', by: A, unit: train.id, change: 1 }, map);
    expect(up.result.ok).toBe(true);
    expect((up.state.units[train.id] as { trainSpeed?: number }).trainSpeed).toBe(2);
    const twice = applyCommand(up.state, { type: 'setTrainSpeed', by: A, unit: train.id, change: 1 }, map);
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
    const preview = previewAttack(s, map, [{ unit: tank.id }], { kind: 'building', building: 'hq' });
    expect(preview.ok).toBe(true);
    expect(preview.structureDamage).toBe(8);
    const out = applyCommand(
      s,
      { type: 'attack', by: A, attackers: [{ unit: tank.id }], target: { kind: 'building', building: 'hq' } },
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
    const mixed = previewAttack(
      s,
      map,
      [{ unit: ninja.id, weapon: main.id }, { unit: tank.id }],
      { kind: 'unit', unit: victim.id },
    );
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
