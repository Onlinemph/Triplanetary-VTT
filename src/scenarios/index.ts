/**
 * The scenario table.
 *
 * Every scenario printed in the rulebook (pp. 9-13), in the order the book gives
 * them. Each one is a `ScenarioDef`: static briefing data, a pure `build` that
 * turns a seed into a starting `GameState`, and — wherever the rulebook states a
 * condition a machine can check — a pure `checkVictory`.
 *
 * Nothing in here imports the interface, the renderer or the network layer, and
 * nothing reaches for `Math.random`, `Date` or the DOM. A scenario is data.
 */

import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { registerCommandHook, registerTurnHook } from '@engine/reducer.js';
import type { Command, CommandResult } from '@engine/commands.js';
import { SHIP_CLASSES } from '@engine/ships.js';
import type { GameState } from '@engine/types.js';

import { biPlanetary } from './biPlanetary.js';
import { escape } from './escape.js';
import { fleetMutiny } from './fleetMutiny.js';
import { grandTour } from './grandTour.js';
import { interplanetaryWar } from './interplanetaryWar.js';
import { lateral7 } from './lateral7.js';
import { nova } from './nova.js';
import { piracy } from './piracy.js';
import { prospecting } from './prospecting.js';
import { retribution } from './retribution.js';
import type { BuildOptions, PlayerTemplate, ScenarioDef, ScenarioLength } from './types.js';

export type { BuildOptions, PlayerTemplate, ScenarioDef, ScenarioLength };
export * from './helpers.js';
import { combatPointCost } from './helpers.js';

export const SCENARIOS: readonly ScenarioDef[] = [
  biPlanetary,
  grandTour,
  escape,
  lateral7,
  piracy,
  nova,
  retribution,
  fleetMutiny,
  interplanetaryWar,
  prospecting,
];

export {
  biPlanetary,
  grandTour,
  escape,
  lateral7,
  piracy,
  nova,
  retribution,
  fleetMutiny,
  interplanetaryWar,
  prospecting,
};

const BY_ID: ReadonlyMap<string, ScenarioDef> = new Map(SCENARIOS.map((s) => [s.id, s]));

export const scenarioById = (id: string): ScenarioDef | undefined => BY_ID.get(id);

/**
 * Build a scenario's opening position.
 *
 * Throws on an unknown id rather than silently substituting a default: a game
 * built from the wrong scenario is worse than no game at all.
 */
export const buildScenario = (id: string, opts: BuildOptions = {}): GameState => {
  const scenario = scenarioById(id);
  if (!scenario) throw new Error(`unknown scenario "${id}"`);
  return scenario.build(opts);
};

/**
 * Ask a scenario whether anybody has won yet.
 *
 * Scenarios whose victory condition is a judgement call ("the Patrol also wins
 * if he knows he has done a good job") simply have no `checkVictory`, and this
 * returns `null` for them; the condition is printed in `specialRules` instead.
 */
export const checkScenarioVictory = (state: GameState): GameState['victory'] => {
  if (state.victory) return state.victory;
  const scenario = scenarioById(state.scenarioId);
  return scenario?.checkVictory?.(state) ?? null;
};

/**
 * Run the scenario's own end-of-player-turn upkeep.
 *
 * Registered with the engine as `registerTurnHook(applyScenarioTurn)`; scenarios
 * without upkeep simply return the state they were handed.
 */
export const applyScenarioTurn = (state: GameState, map: GameMap = DEFAULT_MAP): GameState => {
  const scenario = scenarioById(state.scenarioId);
  return scenario?.endPlayerTurn?.(state, map) ?? state;
};

/**
 * Route a scenario-only order to the scenario that defines it.
 *
 * `null` means "not an order this scenario has", and the engine refuses it.
 */
export const applyScenarioCommand = (
  state: GameState,
  cmd: Command,
  map: GameMap = DEFAULT_MAP,
): { state: GameState; result: CommandResult } | null =>
  scenarioById(state.scenarioId)?.handleCommand?.(state, cmd, map) ?? null;

// The engine cannot import this table — the scenarios import *it* — so the
// callbacks it needs are handed over as this module loads. Anything that can
// build a scenario has therefore already registered its upkeep and its orders.
registerTurnHook(applyScenarioTurn);
for (const s of SCENARIOS) {
  if (s.handleCommand) registerCommandHook(s.id, applyScenarioCommand);
}

/**
 * A view of the table suitable for a scenario picker.
 *
 * The interface's own `ScenarioDescriptor` wants a single player *number* rather
 * than a range, so this flattens `players` to the scenario's maximum seat count
 * and leaves everything else alone.
 */
export interface ScenarioSummary {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly blurb: string;
  readonly length: string;
  readonly description: string;
  /** Flattened `pointBuy`, ready for a buy screen that cannot import this table. */
  readonly pointBuy?: {
    readonly sides: readonly {
      readonly id: string;
      readonly name: string;
      readonly budget: number;
    }[];
    readonly catalogue: readonly {
      readonly id: string;
      readonly name: string;
      readonly cost: number;
    }[];
  };
}

/**
 * "Ships are acquired on the basis of combat strength points... a liner costs 1
 * point, a transport or tanker costs 1/2 point."
 */
const buyScreenFor = (s: ScenarioDef): ScenarioSummary['pointBuy'] => {
  if (!s.pointBuy) return undefined;
  const seats = s.playerTemplates;
  return {
    sides: Object.entries(s.pointBuy.budgets).map(([id, budget], i) => ({
      id,
      name: seats[i]?.faction ?? id,
      budget,
    })),
    catalogue: s.pointBuy.classes.map((cls) => ({
      id: cls,
      name: SHIP_CLASSES[cls].name,
      cost: combatPointCost(cls),
    })),
  };
};

export const SCENARIO_SUMMARIES: readonly ScenarioSummary[] = SCENARIOS.map((s) => {
  const buy = buyScreenFor(s);
  return {
    id: s.id,
    name: s.name,
    players: s.players.max,
    blurb: s.blurb,
    length: s.length,
    description: s.description,
    ...(buy ? { pointBuy: buy } : {}),
  };
});
