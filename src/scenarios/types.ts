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

import type { Command, CommandResult } from '@engine/commands.js';
import type { GameMap } from '@engine/map.js';
import type { ShipClass } from '@engine/ships.js';
import type { GameOptions, GameState, VictoryState } from '@engine/types.js';
import type { OrderOfBattle } from '@campaign/orders.js';

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
  /**
   * Fleets bought with combat strength points, by player id.
   *
   * The p. 9 point system is a *setup* rule — "Both the EastBloc and the
   * WestBloc players select fleets of 50 combat points each" — so the choice has
   * to arrive with the build, not as a command inside the game. A scenario that
   * prices its opening fleet in points advertises the budget through
   * `pointBuy`; anything it is not given falls back to a printed default, so a
   * caller that does not care can ignore this entirely.
   */
  readonly fleets?: Readonly<Record<string, readonly ShipClass[]>>;
  /**
   * The campaign's order of battle, for scenarios that build from a supplied
   * force list rather than a fixed allowance. Scenarios that price their own
   * fleets ignore it; the one that reads it (`contestedTransfer.ts`) falls
   * back to a printed default when it is absent, so a caller that does not
   * care can ignore this entirely.
   */
  readonly order?: OrderOfBattle;
}

/** A scenario's opening point-buy: who has a budget, and how much. */
export interface PointBuy {
  /** Budget per player id, in combat strength points. */
  readonly budgets: Readonly<Record<string, number>>;
  /** Hulls this scenario will sell at setup. */
  readonly classes: readonly ShipClass[];
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
  /**
   * Orders that exist only in this scenario.
   *
   * Three of the printed scenarios ask for something no general rule covers —
   * announcing a cargo's destination and delivering it (Piracy), mustering the
   * Freedom Fleet (Retribution). Return `null` for any command this scenario
   * does not own, and the engine will refuse it.
   */
  handleCommand?(
    state: GameState,
    cmd: Command,
    map: GameMap,
  ): { state: GameState; result: CommandResult } | null;
  /**
   * The opening fleets this scenario prices in combat strength points, if any.
   *
   * Present only for scenarios that say so — Nova's "fleets of 50 combat points
   * each". A setup screen reads it, offers the catalogue, and hands the result
   * back through `BuildOptions.fleets`.
   */
  readonly pointBuy?: PointBuy;
  /** Rules that apply only to this scenario, quoted for the help panel. */
  readonly specialRules?: readonly string[];
}
