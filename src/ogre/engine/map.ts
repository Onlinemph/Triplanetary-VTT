/**
 * The board: what is in each hex, along each hexside, and where the roads run.
 *
 * A `GameMap` is immutable scenery. Everything the *game* does to the ground —
 * a town shot to rubble, a road cut, a crater left by a Cruise Missile — lives
 * in `GameState.terrainOverrides` and `GameState.routesCut`, so that a map can
 * be shared between games and a game can be replayed from its log.
 *
 * Roads and railroads are stored as **links across hexsides**, not as a flag on
 * a hex. That is what the rules mean: a unit is "on the road" when it is
 * "moving from one road hex to another along the line of the road" (5.07), and
 * a road that enters a hex from the north and leaves to the south does not help
 * a unit going east. Storing links also makes a bridge fall out for free — it
 * is a road link across a stream hexside.
 */

import {
  type Hex,
  canonicalSide,
  directionTo,
  fromOffset,
  hex,
  key,
  sideKey,
  toOffset,
} from './hex.js';
import type { Route, SideFeature, Terrain } from './terrain.js';

export interface GameMap {
  readonly id: string;
  readonly name: string;
  /** Bounds in printed (column, row) coordinates, both one-based and inclusive. */
  readonly cols: number;
  readonly rows: number;

  /** Hexes that are not clear. Anything absent is `'clear'`. */
  readonly terrain: Readonly<Record<string, Terrain>>;
  /** Ridges, streams and beaches, by canonical hexside key. */
  readonly sides: Readonly<Record<string, SideFeature>>;
  /** Road and rail links, by canonical hexside key. */
  readonly routes: Readonly<Record<string, Route>>;

  /**
   * The two lines printed on the original Ogre map, as row numbers.
   *
   * "There are four gray arrows on the edges of the Ogre map. They define two
   * lines which divide the map into North, Central, and South areas. Hexes on a
   * line are considered north of that line." (Mark III Attack)
   */
  readonly areaLines?: { readonly north: number; readonly south: number };

  readonly blurb: string;
}

export type MapArea = 'north' | 'central' | 'south';

// ---------------------------------------------------------------------------
// Bounds and enumeration
// ---------------------------------------------------------------------------

export const inBounds = (map: GameMap, h: Hex): boolean => {
  const o = toOffset(h);
  return o.col >= 1 && o.col <= map.cols && o.row >= 1 && o.row <= map.rows;
};

/** Every hex on the map, in reading order (column-major, as the labels run). */
export const allHexes = (map: GameMap): Hex[] => {
  const out: Hex[] = [];
  for (let col = 1; col <= map.cols; col++) {
    for (let row = 1; row <= map.rows; row++) out.push(fromOffset({ col, row }));
  }
  return out;
};

export const areaOf = (map: GameMap, h: Hex): MapArea => {
  if (!map.areaLines) return 'central';
  const { row } = toOffset(h);
  if (row <= map.areaLines.north) return 'north';
  if (row >= map.areaLines.south) return 'south';
  return 'central';
};

/** Rows on the far side of the map from the defender: where an Ogre comes in. */
export const isSouthEdge = (map: GameMap, h: Hex): boolean => toOffset(h).row === map.rows;
export const isNorthEdge = (map: GameMap, h: Hex): boolean => toOffset(h).row === 1;

// ---------------------------------------------------------------------------
// Terrain queries
// ---------------------------------------------------------------------------

/**
 * The terrain in a hex *now*, with any damage the game has done applied.
 *
 * `overrides` is `GameState.terrainOverrides`; passing it is what separates
 * "what the map was printed with" from "what the battle has left".
 */
export const terrainAt = (
  map: GameMap,
  h: Hex,
  overrides?: Readonly<Record<string, Terrain>>,
): Terrain => {
  const k = key(h);
  return overrides?.[k] ?? map.terrain[k] ?? 'clear';
};

export const sideFeatureBetween = (map: GameMap, a: Hex, b: Hex): SideFeature | undefined => {
  const dir = directionTo(a, b);
  if (dir < 0) return undefined;
  return map.sides[sideKey(canonicalSide(a, dir))];
};

/**
 * The road or railroad linking two adjacent hexes, if the link is intact.
 *
 * A cut is recorded against the *hex* — "Any unit may spend its attack against
 * a road or railroad in the same hex, destroying it automatically" (13.01.3) —
 * so a cut in either endpoint breaks the link.
 */
export const routeBetween = (
  map: GameMap,
  a: Hex,
  b: Hex,
  cuts?: readonly string[],
): Route | undefined => {
  const dir = directionTo(a, b);
  if (dir < 0) return undefined;
  const route = map.routes[sideKey(canonicalSide(a, dir))];
  if (!route) return undefined;
  if (cuts && (cuts.includes(key(a)) || cuts.includes(key(b)))) return undefined;
  return route;
};

/** True when any route touches this hex — i.e. it is a road or rail hex. */
export const isRouteHex = (map: GameMap, h: Hex): boolean => {
  for (let dir = 0; dir < 6; dir++) {
    if (map.routes[sideKey(canonicalSide(h, dir))]) return true;
  }
  return false;
};

/**
 * A bridge: a route crossing a stream hexside (2.03.3). Destroying it cuts the
 * route; there is no other way to damage the road on a bridge (5.07).
 */
export const isBridge = (map: GameMap, a: Hex, b: Hex): boolean =>
  sideFeatureBetween(map, a, b) === 'stream' && routeBetween(map, a, b) !== undefined;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface MapBuilder {
  terrain: Record<string, Terrain>;
  sides: Record<string, SideFeature>;
  routes: Record<string, Route>;
}

export const emptyBuilder = (): MapBuilder => ({ terrain: {}, sides: {}, routes: {} });

export const setTerrain = (b: MapBuilder, h: Hex, t: Terrain): void => {
  if (t === 'clear') delete b.terrain[key(h)];
  else b.terrain[key(h)] = t;
};

export const setSide = (b: MapBuilder, a: Hex, toward: Hex, f: SideFeature): void => {
  const dir = directionTo(a, toward);
  if (dir < 0) return;
  b.sides[sideKey(canonicalSide(a, dir))] = f;
};

export const setRoute = (b: MapBuilder, a: Hex, toward: Hex, r: Route): void => {
  const dir = directionTo(a, toward);
  if (dir < 0) return;
  b.routes[sideKey(canonicalSide(a, dir))] = r;
};

/** Lay a route along a run of hexes, linking each to the next. */
export const layRoute = (b: MapBuilder, path: readonly Hex[], r: Route): void => {
  for (let i = 0; i + 1 < path.length; i++) setRoute(b, path[i]!, path[i + 1]!, r);
};

export const hexAt = (col: number, row: number): Hex => fromOffset({ col, row });

/** A straight run of hexes down a column, inclusive. */
export const column = (col: number, fromRow: number, toRow: number): Hex[] => {
  const out: Hex[] = [];
  const step = toRow >= fromRow ? 1 : -1;
  for (let row = fromRow; step > 0 ? row <= toRow : row >= toRow; row += step) {
    out.push(hexAt(col, row));
  }
  return out;
};

export const ORIGIN_HEX = hex(0, 0);
