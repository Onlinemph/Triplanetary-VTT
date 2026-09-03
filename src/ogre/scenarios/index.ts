/**
 * The scenario table.
 *
 * Adding a scenario is adding a `ScenarioDef` here. No engine change is needed:
 * anything a scenario has to remember rides in `GameState.scenarioData`.
 */

import type { ScenarioDef } from './types.js';
import { MARK_III_ATTACK, MARK_V_ATTACK } from './ogreAttack.js';
import { CROSSING } from './crossing.js';
import { LANDING } from './landing.js';
import { ASSAULT, ASSAULT_ASTEROID, ASSAULT_GREEN } from './assault.js';
import { CUSTOM } from './custom.js';

export type { ScenarioDef, ScenarioBuildOptions } from './types.js';
export { mapOf } from './types.js';
export { MARK_III_ATTACK, MARK_V_ATTACK } from './ogreAttack.js';
export { CROSSING } from './crossing.js';
export { LANDING, DEFAULT_LANDING } from './landing.js';
export {
  ASSAULT,
  ASSAULT_ASTEROID,
  ASSAULT_GREEN,
  DEFAULT_ASSAULT,
  DEFAULT_ASTEROID_ASSAULT,
  assemblyDelay,
} from './assault.js';
export {
  CUSTOM,
  CUSTOM_ID,
  DEFAULT_CUSTOM,
  MAP_LIMITS,
  VICTORY_BLURBS,
  VICTORY_NAMES,
  customMap,
  describeCustom,
  describeForces,
  expandForces,
  forceValue,
  readMapSpec,
  readTerms,
  type CustomMapSpec,
  type CustomTerms,
  type CustomVictory,
  type MapKind,
} from './custom.js';

export const SCENARIOS: readonly ScenarioDef[] = [
  MARK_III_ATTACK,
  MARK_V_ATTACK,
  CROSSING,
  LANDING,
  ASSAULT,
  ASSAULT_GREEN,
  ASSAULT_ASTEROID,
  CUSTOM,
];

export const scenarioById = (id: string): ScenarioDef | undefined =>
  SCENARIOS.find((s) => s.id === id);

export const DEFAULT_SCENARIO = MARK_III_ATTACK;
