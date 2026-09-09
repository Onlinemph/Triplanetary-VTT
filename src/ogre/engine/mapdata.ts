/**
 * The boards, generated rather than transcribed.
 *
 * This project ships no scan, photograph or trace of a published Ogre map. The
 * two boards below are *original reconstructions in the published style*: the
 * orange map is "devastated, cratered terrain" giving "smaller, faster games"
 * (2.00), and the green map is "undamaged terrain with towns and forests" with
 * the river, roads and rail that make GEVs worth having.
 *
 * They are generated from a fixed seed, so `OGRE_MAP` is the same board on
 * every machine and in every test — but the seed is a parameter, which means a
 * table that wants a fresh battlefield can have one without anybody drawing it.
 *
 * If you own the game and would rather play on the printed board, transcribing
 * it is a matter of filling in the same three records (`terrain`, `sides`,
 * `routes`) by hand; nothing else in the engine cares where a map came from.
 */

import { type Hex, distance, key, neighbors, toOffset } from './hex.js';
import {
  type GameMap,
  type MapBuilder,
  allHexes,
  emptyBuilder,
  hexAt,
  layRoute,
  setSide,
  setTerrain,
} from './map.js';
import { type RngState, createRng, nextFloat, nextInt } from './rng.js';
import type { Terrain } from './terrain.js';

// ---------------------------------------------------------------------------
// Generation helpers
// ---------------------------------------------------------------------------

interface Gen {
  rng: RngState;
}

const chance = (g: Gen, p: number): boolean => {
  const { state, value } = nextFloat(g.rng);
  g.rng = state;
  return value < p;
};

const pick = <T>(g: Gen, items: readonly T[]): T => {
  const { state, value } = nextInt(g.rng, items.length);
  g.rng = state;
  return items[value]!;
};

const between = (g: Gen, lo: number, hi: number): number => {
  const { state, value } = nextInt(g.rng, hi - lo + 1);
  g.rng = state;
  return lo + value;
};

interface Bounds {
  readonly cols: number;
  readonly rows: number;
}

/** Bounds check against a rectangle of printed coordinates, before a map exists. */
const inRect = (bounds: Bounds, h: Hex): boolean => {
  const o = toOffset(h);
  return o.col >= 1 && o.col <= bounds.cols && o.row >= 1 && o.row <= bounds.rows;
};

/** Grow a blob of `size` hexes outward from `seedHex`, staying in bounds. */
const blob = (
  g: Gen,
  seedHex: Hex,
  size: number,
  bounds: Bounds,
  allow: (h: Hex) => boolean,
): Hex[] => {
  const chosen: Hex[] = [];
  const seen = new Set<string>();
  const frontier: Hex[] = [seedHex];
  while (chosen.length < size && frontier.length > 0) {
    const idx = between(g, 0, frontier.length - 1);
    const h = frontier.splice(idx, 1)[0]!;
    const k = key(h);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!inRect(bounds, h) || !allow(h)) continue;
    chosen.push(h);
    for (const n of neighbors(h)) if (!seen.has(key(n))) frontier.push(n);
  }
  return chosen;
};

/**
 * Clear a corridor so the board is always crossable.
 *
 * Craters are impassable to *everything*, including Ogres (2.01.2), so a
 * randomly generated crater field can in principle wall the map in half. This
 * runs a Dijkstra from the south edge to the north with craters priced high,
 * then removes the craters the cheapest route runs through. Repeating it a few
 * times leaves several usable approaches rather than one gauntlet.
 */
const carveCorridor = (b: MapBuilder, cols: number, rows: number, startCol: number): void => {
  const bounds: Bounds = { cols, rows };
  const cost = (h: Hex): number => (b.terrain[key(h)] === 'crater' ? 24 : 1);

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const nodes = new Map<string, Hex>();

  const start = hexAt(startCol, rows);
  dist.set(key(start), 0);
  nodes.set(key(start), start);

  // Small board; a linear scan for the minimum is fast enough and keeps this
  // dependency-free and deterministic.
  const visited = new Set<string>();
  let goal: string | null = null;

  for (;;) {
    let bestKey: string | null = null;
    let bestDist = Infinity;
    for (const [k, d] of dist) {
      if (!visited.has(k) && d < bestDist) {
        bestDist = d;
        bestKey = k;
      }
    }
    if (bestKey === null) break;
    visited.add(bestKey);
    const here = nodes.get(bestKey)!;
    if (toOffset(here).row === 1) {
      goal = bestKey;
      break;
    }
    for (const n of neighbors(here)) {
      if (!inRect(bounds, n)) continue;
      const nk = key(n);
      nodes.set(nk, n);
      const nd = bestDist + cost(n);
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, bestKey);
      }
    }
  }

  if (goal === null) return;
  let cursor: string | undefined = goal;
  while (cursor) {
    delete b.terrain[cursor];
    cursor = prev.get(cursor);
  }
};

// ---------------------------------------------------------------------------
// The cratered map
// ---------------------------------------------------------------------------

export interface OgreMapOptions {
  readonly seed?: number;
  readonly cols?: number;
  readonly rows?: number;
  /** Roughly what fraction of the board is cratered. */
  readonly craterDensity?: number;
}

/**
 * The orange board: a plain, ruined plateau with nothing on it but bomb
 * craters — which are the only terrain in the basic game, and the only terrain
 * that is flatly impassable.
 */
export const buildOgreMap = (opts: OgreMapOptions = {}): GameMap => {
  const cols = opts.cols ?? 21;
  const rows = opts.rows ?? 21;
  const density = opts.craterDensity ?? 0.13;
  const g: Gen = { rng: createRng(opts.seed ?? 0x0917) };
  const b = emptyBuilder();

  const target = Math.round(cols * rows * density);
  const bounds: Bounds = { cols, rows };

  // Craters come from strikes, so they come in clusters rather than static.
  // Leave the southern entry row and the northern edge clear: the Ogre has to
  // be able to come on, and the defender has to be able to place a CP.
  const openRow = (h: Hex): boolean => {
    const row = toOffset(h).row;
    return row > 1 && row < rows;
  };

  let placed = 0;
  let guard = 0;
  while (placed < target && guard++ < 500) {
    const centre = hexAt(between(g, 1, cols), between(g, 2, rows - 1));
    const size = between(g, 1, 3);
    for (const h of blob(g, centre, size, bounds, openRow)) {
      if (b.terrain[key(h)] === 'crater') continue;
      setTerrain(b, h, 'crater');
      placed++;
    }
  }

  // Three corridors, spread across the board, so the Ogre has choices and the
  // defender cannot rely on one chokepoint being the only way through.
  carveCorridor(b, cols, rows, Math.max(1, Math.round(cols * 0.2)));
  carveCorridor(b, cols, rows, Math.round(cols * 0.5));
  carveCorridor(b, cols, rows, Math.min(cols, Math.round(cols * 0.8)));

  return {
    id: 'ogre',
    name: 'Ogre map',
    cols,
    rows,
    terrain: b.terrain,
    sides: b.sides,
    routes: b.routes,
    areaLines: { north: 8, south: 17 },
    blurb:
      'Devastated, cratered terrain — the original board, and the fastest game. ' +
      'Craters are impassable to everything, an Ogre included, but fire passes over them.',
  };
};

// ---------------------------------------------------------------------------
// The green (G.E.V.) map
// ---------------------------------------------------------------------------

export interface GevMapOptions {
  readonly seed?: number;
  readonly cols?: number;
  readonly rows?: number;
}

/**
 * The green board: undamaged country, where terrain finally matters.
 *
 * Towns and forests protect; swamp strands heavy armour; a river splits the map
 * and gives GEVs a highway everything else has to bridge. The generator lays
 * the river first because everything else — the bridges, the roads that use
 * them, the swamp on the banks — is placed relative to it.
 */
export const buildGevMap = (opts: GevMapOptions = {}): GameMap => {
  const cols = opts.cols ?? 28;
  const rows = opts.rows ?? 20;
  const g: Gen = { rng: createRng(opts.seed ?? 0x0918) };
  const b = emptyBuilder();
  const bounds: Bounds = { cols, rows };

  const free = (h: Hex): boolean => !b.terrain[key(h)];

  // --- The river: a wandering column of water from top to bottom.
  const riverCols: number[] = [];
  let riverCol = between(g, Math.round(cols * 0.35), Math.round(cols * 0.6));
  for (let row = 1; row <= rows; row++) {
    riverCols.push(riverCol);
    setTerrain(b, hexAt(riverCol, row), 'water');
    if (chance(g, 0.42)) riverCol += chance(g, 0.5) ? 1 : -1;
    riverCol = Math.max(3, Math.min(cols - 2, riverCol));
  }

  // --- Swamp on the banks, in patches rather than a stripe.
  for (let row = 1; row <= rows; row++) {
    if (!chance(g, 0.35)) continue;
    const side = chance(g, 0.5) ? -1 : 1;
    const seedHex = hexAt(Math.max(1, Math.min(cols, riverCols[row - 1]! + side)), row);
    for (const h of blob(g, seedHex, between(g, 1, 4), bounds, free)) setTerrain(b, h, 'swamp');
  }

  // --- Forests: several stands, largest away from the river.
  for (let i = 0; i < 9; i++) {
    const centre = hexAt(between(g, 1, cols), between(g, 1, rows));
    if (Math.abs(toOffset(centre).col - riverCols[toOffset(centre).row - 1]!) < 2) continue;
    for (const h of blob(g, centre, between(g, 3, 9), bounds, free)) setTerrain(b, h, 'forest');
  }

  // --- Towns: compact, and remembered so the roads can join them up.
  const townCentres: Hex[] = [];
  for (let i = 0; i < 5; i++) {
    const centre = hexAt(between(g, 2, cols - 1), between(g, 2, rows - 1));
    if (b.terrain[key(centre)] === 'water') continue;
    if (townCentres.some((t) => distance(t, centre) < 5)) continue;
    townCentres.push(centre);
    for (const h of blob(
      g,
      centre,
      between(g, 2, 5),
      bounds,
      (x) => b.terrain[key(x)] !== 'water',
    )) {
      setTerrain(b, h, 'town');
    }
  }

  // --- Streams: short runs of hexside, away from the river.
  for (let i = 0; i < 26; i++) {
    let h = hexAt(between(g, 2, cols - 1), between(g, 2, rows - 1));
    if (b.terrain[key(h)] === 'water') continue;
    const run = between(g, 2, 5);
    for (let step = 0; step < run; step++) {
      const ns = neighbors(h).filter((n) => inRect(bounds, n) && b.terrain[key(n)] !== 'water');
      if (ns.length === 0) break;
      const n = pick(g, ns);
      setSide(b, h, n, 'stream');
      h = n;
    }
  }

  // --- Ridges: a few short spines of debris, which only Ogres and infantry cross.
  for (let i = 0; i < 6; i++) {
    let h = hexAt(between(g, 2, cols - 1), between(g, 2, rows - 1));
    const run = between(g, 2, 4);
    for (let step = 0; step < run; step++) {
      const ns = neighbors(h).filter((n) => inRect(bounds, n));
      if (ns.length === 0) break;
      const n = pick(g, ns);
      setSide(b, h, n, 'ridge');
      h = n;
    }
  }

  // --- Roads: join the towns in a chain, and run one highway across the river.
  const roadPath = (from: Hex, to: Hex): Hex[] => {
    const path: Hex[] = [from];
    let cur = from;
    let guard = 0;
    while (!(cur.q === to.q && cur.r === to.r) && guard++ < 200) {
      const ns = neighbors(cur).filter((n) => inRect(bounds, n));
      if (ns.length === 0) break;
      ns.sort((a, c) => distance(a, to) - distance(c, to));
      cur = ns[0]!;
      path.push(cur);
    }
    return path;
  };

  for (let i = 0; i + 1 < townCentres.length; i++) {
    layRoute(b, roadPath(townCentres[i]!, townCentres[i + 1]!), 'road');
  }
  layRoute(b, roadPath(hexAt(1, Math.round(rows / 2)), hexAt(cols, Math.round(rows / 2))), 'road');

  // A railroad along a row, which GEVs and infantry may use as a road (2.03.2).
  const railRow = between(g, 3, rows - 3);
  const rail: Hex[] = [];
  for (let col = 1; col <= cols; col++) rail.push(hexAt(col, railRow));
  layRoute(b, rail, 'rail');

  // Where a route crosses the water it is a bridge; the water underneath stays.
  return {
    id: 'gev',
    name: 'G.E.V. map',
    cols,
    rows,
    terrain: b.terrain,
    sides: b.sides,
    routes: b.routes,
    blurb:
      'Undamaged country: towns and forests that protect, swamp that strands heavy armour, ' +
      'and a river that only GEVs, infantry, Ogres and Superheavies can cross away from a bridge.',
  };
};

// ---------------------------------------------------------------------------
// The canonical boards
// ---------------------------------------------------------------------------

/** The board the basic scenarios are played on. */
export const OGRE_MAP: GameMap = buildOgreMap({ seed: 0x0917 });

/** The larger green board. */
export const GEV_MAP: GameMap = buildGevMap({ seed: 0x0918 });

export const MAPS: Readonly<Record<string, GameMap>> = {
  ogre: OGRE_MAP,
  gev: GEV_MAP,
};

/** Every terrain type actually present, for the map legend. */
export const terrainsUsed = (map: GameMap): Terrain[] => {
  const seen = new Set<Terrain>(['clear']);
  for (const h of allHexes(map)) seen.add(map.terrain[key(h)] ?? 'clear');
  return [...seen];
};
