/**
 * The general staff: the computer playing the war in Orbital Drop.
 *
 * `staff.ts` decides; `weights.ts` is its temperament; `tuned.ts` what the
 * tuner learned; `simulate.ts` plays whole wars headless for the tuner and
 * the tests. The pilot in `src/ai/index.ts` asks the staff at each phase.
 */

export {
  chooseTarget,
  forceValue,
  holdValue,
  isWar,
  manifestFor,
  overheadHex,
  skyFrozen,
  targetScore,
  warCombatOrder,
  warErrand,
  warOrdnanceOrder,
  warReading,
  warResupplyOrder,
  yardPlans,
  type WarErrand,
} from './staff.js';
export {
  BASE_WAR_WEIGHTS,
  DEFAULT_WAR_WEIGHTS,
  WAR_WEIGHT_KEYS,
  WAR_WEIGHT_SPEC,
  clampWarWeights,
  warFromVector,
  warToVector,
  withWarWeights,
  type WarWeightKey,
  type WarWeights,
} from './weights.js';
export { WAR_TUNED, WAR_TUNED_NOTE } from './tuned.js';
export {
  playWar,
  sameWarWeights,
  scoreWar,
  warWorth,
  type WarResult,
  type WarWeightsFor,
} from './simulate.js';
