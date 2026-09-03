/**
 * The generated boards, as a battle builder relies on them.
 *
 * A fresh board is only worth offering if it can always be fought on: the
 * cratered map must let the attacker reach the far edge whatever the seed and
 * the density, and the green map must give heavy armour a way over the river.
 * These are properties of the generators, not of any one board, so they are
 * checked across a spread of seeds and sizes rather than on the two stock
 * boards alone.
 */

import { describe, expect, it } from 'vitest';
import type { OrderOfBattle } from '../../src/campaign/orders.js';
import { type Hex, key, neighbors, toOffset } from '../../src/ogre/engine/hex.js';
import {
  type GameMap,
  allHexes,
  inBounds,
  routeBetween,
  sideFeatureBetween,
  terrainAt,
} from '../../src/ogre/engine/map.js';
import { buildGevMap, buildOgreMap } from '../../src/ogre/engine/mapdata.js';
import { type Mobility, entryCost, sideCrossing } from '../../src/ogre/engine/terrain.js';
import { CUSTOM, MAP_LIMITS, customMap } from '../../src/ogre/scenarios/index.js';

/** One step, judged the way the movement module judges it, minus the units. */
const canStep = (map: GameMap, mobility: Mobility, from: Hex, to: Hex): boolean => {
  if (!inBounds(map, to)) return false;
  const terrain = terrainAt(map, to);
  if (terrain === 'crater') return false;
  const route = routeBetween(map, from, to);
  const side = sideFeatureBetween(map, from, to);
  if (!sideCrossing(side, mobility, route !== undefined).allowed) return false;
  if (route === undefined && entryCost(terrain, mobility).cost === null) return false;
  return true;
};

/** Whether some hex satisfying `goal` is reachable from any of `starts`. */
const reaches = (
  map: GameMap,
  mobility: Mobility,
  starts: readonly Hex[],
  goal: (h: Hex) => boolean,
): boolean => {
  const seen = new Set<string>();
  const queue: Hex[] = [];
  for (const s of starts) {
    if (terrainAt(map, s) === 'crater') continue;
    if (entryCost(terrainAt(map, s), mobility).cost === null) continue;
    seen.add(key(s));
    queue.push(s);
  }
  while (queue.length > 0) {
    const h = queue.shift()!;
    if (goal(h)) return true;
    for (const n of neighbors(h)) {
      const k = key(n);
      if (seen.has(k) || !canStep(map, mobility, h, n)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return false;
};

const row = (map: GameMap, r: number): Hex[] => allHexes(map).filter((h) => toOffset(h).row === r);
const col = (map: GameMap, c: number): Hex[] => allHexes(map).filter((h) => toOffset(h).col === c);

const SEEDS = [1, 2, 3, 7, 42, 99, 1234, 0xbeef, 2 ** 31 - 1];
const SIZES: [number, number][] = [
  [MAP_LIMITS.cols.min, MAP_LIMITS.rows.min],
  [21, 21],
  [15, 30],
  [30, 15],
  [MAP_LIMITS.cols.max, MAP_LIMITS.rows.max],
];

describe('the cratered map generator', () => {
  it('is a pure function of its options', () => {
    const a = buildOgreMap({ seed: 5, cols: 18, rows: 24, craterDensity: 0.2 });
    const b = buildOgreMap({ seed: 5, cols: 18, rows: 24, craterDensity: 0.2 });
    expect(a).toEqual(b);
    expect(buildOgreMap({ seed: 6, cols: 18, rows: 24, craterDensity: 0.2 })).not.toEqual(a);
  });

  it('always leaves a heavy tank a way from the south edge to the north, however dense the craters', () => {
    for (const seed of SEEDS) {
      for (const [cols, rows] of SIZES) {
        for (const craterDensity of [0.13, MAP_LIMITS.craterDensity.max]) {
          const map = buildOgreMap({ seed, cols, rows, craterDensity });
          const through = reaches(
            map,
            'heavyTracked',
            row(map, rows),
            (h) => toOffset(h).row === 1,
          );
          expect(through, `seed ${seed}, ${cols}x${rows}, density ${craterDensity}`).toBe(true);
        }
      }
    }
  });

  it('keeps the entry row and the far row clear, so a force can come on and a post can stand', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const map = buildOgreMap({ seed, cols: 21, rows: 21, craterDensity: 0.3 });
      expect(row(map, 21).every((h) => terrainAt(map, h) !== 'crater')).toBe(true);
      expect(row(map, 1).every((h) => terrainAt(map, h) !== 'crater')).toBe(true);
    }
  });

  it('craters roughly the share of the board it was asked for', () => {
    const map = buildOgreMap({ seed: 11, cols: 30, rows: 30, craterDensity: 0.2 });
    const craters = allHexes(map).filter((h) => terrainAt(map, h) === 'crater').length;
    // The corridors carve some back out, so a little under the target.
    expect(craters).toBeGreaterThan(30 * 30 * 0.12);
    expect(craters).toBeLessThanOrEqual(30 * 30 * 0.2);
  });
});

describe('the green map generator', () => {
  it('always gives heavy armour a way from the western strip to the eastern two thirds', () => {
    for (const seed of SEEDS) {
      for (const [cols, rows] of SIZES) {
        const map = buildGevMap({ seed, cols, rows });
        const strip = Math.max(2, Math.round(cols / 5));
        const line = Math.round(cols / 3);
        const starts = allHexes(map).filter((h) => toOffset(h).col <= strip);
        const across = reaches(map, 'heavyTracked', starts, (h) => toOffset(h).col >= line);
        expect(across, `seed ${seed}, ${cols}x${rows}`).toBe(true);
        // And the light tanks, which are the ones the river actually stops.
        expect(reaches(map, 'lightTracked', starts, (h) => toOffset(h).col >= line)).toBe(true);
      }
    }
  });

  it('runs a river top to bottom with at least one bridge over it', () => {
    for (const seed of SEEDS) {
      const map = buildGevMap({ seed });
      const water = allHexes(map).filter((h) => terrainAt(map, h) === 'water');
      const rows = new Set(water.map((h) => toOffset(h).row));
      expect(rows.size).toBe(map.rows);
      // A bridge: a route link into a water hex.
      const bridges = water.filter((h) =>
        neighbors(h).some((n) => inBounds(map, n) && routeBetween(map, h, n) !== undefined),
      );
      expect(bridges.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('lets a GEV cross the river anywhere, bridge or no bridge', () => {
    const map = buildGevMap({ seed: 3 });
    const starts = col(map, 1);
    expect(reaches(map, 'gev', starts, (h) => toOffset(h).col === map.cols)).toBe(true);
  });
});

describe('a custom battle on a generated board', () => {
  it('builds at the smallest and the largest board the builder allows', () => {
    for (const kind of ['ogre', 'gev'] as const) {
      for (const [cols, rows] of [SIZES[0]!, SIZES[SIZES.length - 1]!]) {
        const spec = {
          kind,
          seed: 8,
          cols,
          rows,
          ...(kind === 'ogre' ? { craterDensity: 0.3 } : {}),
        };
        const order: OrderOfBattle = {
          battleId: 'x',
          seed: 8,
          scenarioId: 'custom',
          sides: [
            { player: 'a', faction: 'A', forces: { MK3: 1, HVY: 3, GEV: 3, INF: 9 } },
            { player: 'b', faction: 'B', forces: { HVY: 4, MSL: 2, HWZ: 2, INF: 12 } },
          ],
          terms: { map: spec, victory: 'command-post' },
        };
        const state = CUSTOM.build({ order, seed: 0, setup: true });
        const map = customMap(spec);
        expect(map.cols).toBe(cols);
        expect(state.mapId).toBe(map.id);
        const onBoard = Object.values(state.units).filter((u) => !u.destroyed);
        expect(onBoard.length).toBeGreaterThan(20);
        for (const u of onBoard) expect(inBounds(map, u.pos)).toBe(true);
        // Both setup zones have room to spare for rearranging.
        const zones = state.setup!.zones;
        expect(zones['a']!.hexes.length).toBeGreaterThan(20);
        expect(zones['b']!.hexes.length).toBeGreaterThan(20);
      }
    }
  });
});
