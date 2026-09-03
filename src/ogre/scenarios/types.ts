/**
 * A scenario is data plus two pure functions.
 *
 * `build(opts)` turns a seed into a starting `GameState`; `checkVictory(state)`
 * reads a state and says whether anyone has won. Both are pure, so a scenario
 * plus a seed plus a command log is a complete, replayable game.
 */

import type { GameMap } from '../engine/map.js';
import type { GameOptions, GameState, VictoryState } from '../engine/types.js';
import type { OrderOfBattle } from '@campaign/orders.js';

export interface ScenarioBuildOptions {
  readonly seed: number;
  readonly options?: Partial<GameOptions>;
  /**
   * Open with a deployment step: the seeded arrangement is the starting
   * point, and each side may rearrange its counters inside its printed
   * setup area before turn 1. Off by default, so a board built for a test
   * or a replay is playable at once.
   */
  readonly setup?: boolean;
  /**
   * The campaign's order of battle, for scenarios that build from a supplied
   * force list rather than a fixed allowance. Scenarios that price their own
   * forces ignore it; the one that reads it (`landing.ts`) falls back to a
   * printed default when it is absent, so a caller that does not care can
   * ignore this entirely.
   */
  readonly order?: OrderOfBattle;
}

export interface ScenarioDef {
  readonly id: string;
  readonly name: string;
  readonly mapId: string;
  readonly players: number;
  /** One line for the picker. */
  readonly blurb: string;
  /** The full briefing, shown in the help panel. */
  readonly briefing: string;
  /** Victory conditions, in the order the rulebook lists them. */
  readonly victoryConditions: readonly string[];
  readonly map: GameMap;
  /**
   * The board a particular game of this scenario is played on, when it is
   * not always `map`: a custom battle names its own, generated from the
   * order in `scenarioData`. Read it through `mapOf`, never `map` directly.
   */
  mapFor?(state: GameState): GameMap;
  build(opts: ScenarioBuildOptions): GameState;
  checkVictory(state: GameState): VictoryState | null;
}

/** The board this game is on: the scenario's own, or the one it built for this game. */
export const mapOf = (def: ScenarioDef, state: GameState): GameMap =>
  def.mapFor?.(state) ?? def.map;
