/**
 * Reading a finished battle back into the campaign's vocabulary.
 *
 * This is the space half of the campaign design's first build item: "A
 * `BattleResult` reader for each engine — small, pure, testable." Everything
 * it reports is derived from `GameState` — survivors by hull, freight still
 * aboard them, and what actually got down on the target world.
 *
 * Two translations happen here and nowhere else:
 *
 *  - **Victory levels.** Triplanetary speaks `decisive | marginal | moral`;
 *    the boundary speaks `complete | standard | marginal`. Both are ordered
 *    triples, so the map is by rank, not by name — a Triplanetary "marginal"
 *    is the middle result and crosses as `standard`.
 *  - **Delivery.** The campaign wants "surviving cargo capacity ... converted
 *    into an Ogre order of battle", and the authoritative count is read off
 *    the board — freight aboard the attacker's ships that are down on the
 *    target world — rather than off the players' point tallies, which are a
 *    scoreboard updated at turn end and can lag the landing that decides the
 *    battle.
 */

import { cargoCount } from '@engine/state.js';
import type { GameMap } from '@engine/map.js';
import { type GameState, type VictoryLevel, controllerOf } from '@engine/types.js';
import { isAtAsteroidBase, isLandedOn } from '@scenarios/helpers.js';
import { type BattleResult, orderOf } from './orders.js';

/** Rank-for-rank: decisive→complete, marginal→standard, moral→marginal. */
const LEVELS: Readonly<Record<VictoryLevel, BattleResult['level']>> = {
  decisive: 'complete',
  marginal: 'standard',
  moral: 'marginal',
};

/**
 * Freight lots a player has landed on the named world: aboard ships that are
 * down there, not destroyed, and still under that player's control. "Down"
 * covers both kinds of ground the chart offers — a hexside landing on a
 * world, or a stop in an asteroid base's hex, which is how Ceres is landed on.
 */
export const deliveredLots = (
  state: GameState,
  map: GameMap,
  player: string,
  bodyId: string,
): number => {
  let lots = 0;
  for (const ship of Object.values(state.ships)) {
    if (ship.destroyed || controllerOf(ship) !== player) continue;
    if (!isLandedOn(map, ship, bodyId) && !isAtAsteroidBase(map, ship, bodyId)) continue;
    lots += cargoCount(ship, 'freight');
  }
  return lots;
};

/**
 * Count what a player still has, in the same vocabulary an `OrderOfBattle`
 * speaks: hulls by `ShipClass`, plus `freight` for the lots still aboard
 * them. Counted by controller rather than owner — a prize that changed hands
 * walked away with its captor.
 */
const survivorsOf = (state: GameState, player: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const ship of Object.values(state.ships)) {
    if (ship.destroyed || controllerOf(ship) !== player) continue;
    out[ship.shipClass] = (out[ship.shipClass] ?? 0) + 1;
    const freight = cargoCount(ship, 'freight');
    if (freight > 0) out['freight'] = (out['freight'] ?? 0) + freight;
  }
  return out;
};

/**
 * The battle's result, or `null` while it is still undecided.
 *
 * The state must have been built from an `OrderOfBattle` (the contested
 * transfer scenario stows it in `scenarioData`); a state that was not is a
 * programming error, not a battle that ended strangely, so it throws rather
 * than inventing a battle id.
 */
export const readBattleResult = (
  state: GameState,
  map: GameMap,
  log: readonly unknown[],
): BattleResult | null => {
  const order = orderOf(state.scenarioData);
  if (!order) throw new Error('this game was not built from an order of battle');
  if (!state.victory) return null;

  const attacker = order.sides[0]!.player;
  const target = order.terms['target'];

  const survivors: Record<string, Readonly<Record<string, number>>> = {};
  const victoryPoints: Record<string, number> = {};
  for (const side of order.sides) {
    survivors[side.player] = survivorsOf(state, side.player);
    victoryPoints[side.player] = state.players[side.player]?.points ?? 0;
  }
  if (typeof target === 'string') {
    victoryPoints[attacker] = deliveredLots(state, map, attacker, target);
  }

  return {
    battleId: order.battleId,
    winners: state.victory.winners,
    level: LEVELS[state.victory.level],
    survivors,
    victoryPoints,
    replay: { seed: order.seed, log },
  };
};
