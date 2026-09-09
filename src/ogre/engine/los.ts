/**
 * Line of sight — which exists for exactly one weapon in the game.
 *
 * "There are no limitations for line of sight" (7.02) for everything but the
 * laser: a standard laser "is blocked by raised terrain" between it and its
 * target (12.02), and a laser tower "may fire over intervening terrain, but
 * not into it" (12.03). Both look down the same straight line of hexes.
 */

import { type Hex, hexLine } from './hex.js';
import { type GameMap, terrainAt } from './map.js';
import { TERRAIN_LABELS, blocksLaser, hidesFromLaserTower } from './terrain.js';
import type { GameState } from './types.js';

/** Why a laser at `from` cannot see `to`, or null when the line is clear. */
export const laserLineOfSight = (
  state: GameState,
  map: GameMap,
  from: Hex,
  to: Hex,
  kind: 'standard' | 'tower',
): string | null => {
  const line = hexLine(from, to);
  if (kind === 'tower') {
    const t = terrainAt(map, to, state.terrainOverrides);
    return hidesFromLaserTower(t)
      ? `a laser tower cannot fire into ${TERRAIN_LABELS[t].toLowerCase()} (12.03)`
      : null;
  }
  for (const h of line.slice(1, -1)) {
    const t = terrainAt(map, h, state.terrainOverrides);
    if (blocksLaser(t)) {
      return `the line of fire is blocked by ${TERRAIN_LABELS[t].toLowerCase()} (12.02)`;
    }
  }
  return null;
};
