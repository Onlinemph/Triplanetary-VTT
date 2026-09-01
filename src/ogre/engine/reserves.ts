/**
 * Off-map reserves (Orbital Drop §3.03).
 *
 * "Up to half the purchased garrison ... does not set up on the map. It
 * enters from the defender's map edge beginning on ground turn 5, any or all
 * of it, on any turn from then on." A unit in reserve exists in the state
 * with `offMap: 'reserve'`; these are the questions the reducer and the
 * interface ask about it.
 */

import { type Hex, toOffset } from './hex.js';
import { type GameMap, allHexes, terrainAt } from './map.js';
import { entryCost } from './terrain.js';
import { type GameState, type PlayerId, type Unit, unitsAt } from './types.js';
import { mobilityOf } from './mobility.js';
import { wouldOverstack } from './movement.js';

export type MapEdge = 'north' | 'south' | 'east' | 'west';

/** The units a player still has waiting off the map. */
export const reservesOf = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter(
    (u) => u.owner === player && !u.destroyed && u.offMap === 'reserve',
  );

/** The first turn reserves may enter, from the scenario's data (5 by default). */
export const reactionTurn = (state: GameState): number => {
  const raw = state.scenarioData['reactionTurn'];
  return typeof raw === 'number' ? raw : 5;
};

/** The edge the reserves come in on; east unless the scenario says otherwise. */
export const reserveEdge = (state: GameState): MapEdge => {
  const raw = state.scenarioData['reserveEdge'];
  return raw === 'north' || raw === 'south' || raw === 'west' ? raw : 'east';
};

const onEdge = (map: GameMap, h: Hex, edge: MapEdge): boolean => {
  const o = toOffset(h);
  switch (edge) {
    case 'north':
      return o.row === 1;
    case 'south':
      return o.row === map.rows;
    case 'west':
      return o.col === 1;
    case 'east':
      return o.col === map.cols;
  }
};

/** Why this unit cannot enter at that hex right now, or null when it can. */
export const deployReserveCheck = (
  state: GameState,
  map: GameMap,
  unit: Unit,
  at: Hex,
): string | null => {
  if (state.phase !== 'movement') return 'reserves enter in the movement phase';
  if (unit.destroyed || unit.offMap !== 'reserve') return 'that unit is not waiting in reserve';
  const turn = reactionTurn(state);
  if (state.turn < turn) return `the reaction force enters from turn ${turn}`;
  if (!onEdge(map, at, reserveEdge(state))) return 'reserves enter on your own map edge';
  const terrain = terrainAt(map, at, state.terrainOverrides);
  if (terrain === 'crater' || terrain === 'water') return 'nothing enters there';
  if (entryCost(terrain, mobilityOf(unit)).cost === null) return 'this unit cannot enter there';
  if (unitsAt(state, at).some((u) => u.owner !== unit.owner)) return 'that hex is held by the enemy';
  if (wouldOverstack(state, at, unit)) return 'that hex is full';
  return null;
};

/** Every hex this reserve could enter at, for the map to light up. */
export const reserveEntryHexes = (state: GameState, map: GameMap, unit: Unit): Hex[] =>
  allHexes(map).filter((h) => deployReserveCheck(state, map, unit, h) === null);
