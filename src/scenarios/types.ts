/**
 * The scenario contract.
 *
 * A scenario is data plus two pure functions: `build`, which turns a seed into a
 * starting `GameState`, and `checkVictory`, which reads a state and says whether
 * anybody has won. Neither touches the DOM, `Date` or `Math.random` — every
 * randomised setup decision is threaded through `GameState.rng`, so the same
 * seed always lays out the same board.
 *
 * Some of the rulebook's victory conditions are judgements rather than
 * mechanisms ("the Patrol also wins if he knows he has done a good job").
 * Those return `null` from `checkVictory` and are spelled out in
 * `description`/`specialRules` instead, so the interface can show the condition
 * and let the players call it.
 */

import type { GameMap } from '@engine/map.js';
import type { GameOptions, GameState, VictoryState } from '@engine/types.js';

/** Rulebook shorthand for how long a scenario runs. */
export type ScenarioLength = 'short' | 'medium' | 'long';

/**
 * A seat at the table. `faction` is the rulebook's own name for the side,
 * `color` is the counter colour it names, and `name` is the default player name
 * shown before anybody types their own.
 */
export interface PlayerTemplate {
  readonly faction: string;
  readonly color: string;
  readonly name: string;
}

export interface BuildOptions {
  /** Seeds `GameState.rng`; the same seed reproduces the same setup exactly. */
  readonly seed?: number;
  /** Player names in seat order; blanks fall back to the template's default. */
  readonly playerNames?: readonly string[];
  readonly options?: Partial<GameOptions>;
}

export interface ScenarioDef {
  readonly id: string;
  readonly name: string;
  /** One line for the scenario list. */
  readonly blurb: string;
  /** The full briefing, close to the rulebook's own words. */
  readonly description: string;
  readonly players: { readonly min: number; readonly max: number };
  readonly length: ScenarioLength;
  readonly playerTemplates: readonly PlayerTemplate[];
  build(opts: BuildOptions): GameState;
  /** `null` while the game is undecided, or when victory is a judgement call. */
  checkVictory?(state: GameState): VictoryState | null;
  /**
   * The scenario's own upkeep, run as each player-turn closes: base income,
   * reinforcements, points scored. Pure, and any die must come from `state.rng`.
   */
  endPlayerTurn?(state: GameState, map: GameMap): GameState;
  /** Rules that apply only to this scenario, quoted for the help panel. */
  readonly specialRules?: readonly string[];
}
