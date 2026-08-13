/**
 * The engine's public face.
 *
 * Everything above the rules layer — the renderer, the shell, the network
 * session, the scenario table — imports from here rather than from a dozen
 * individual modules, so a rules module can be split or renamed without a
 * hundred call sites moving with it.
 *
 * Two surfaces are offered, and they cost nothing extra because they are the
 * same bindings twice:
 *
 *  - **Flat.** The contract modules (`hex`, `geometry`, `mapdata`, `map`,
 *    `types`, `commands`, `state`, `crt`, `ships`, `rng`) and the reducer are
 *    re-exported wholesale; their names were designed not to collide. The rules
 *    modules contribute their preview and query helpers by name.
 *  - **Namespaced.** `movement`, `combat`, `ordnance`, `logistics` and
 *    `detection` are also exported as namespaces, which is the escape hatch for
 *    the handful of names two modules both define (`shipLabel`, `canManeuver`,
 *    `ORDNANCE_LIFETIME`) and the way to reach a module's internals when the
 *    curated list below is not enough.
 *
 * Nothing in `src/engine` touches the DOM, `Date` or `Math.random`; every die
 * comes out of the seeded generator carried inside `GameState`. That is what
 * makes a game reproducible from its seed and command log.
 */

// ---------------------------------------------------------------------------
// The fixed contract
// ---------------------------------------------------------------------------

export * from './hex.js';
export * from './geometry.js';
export * from './mapdata.js';
export * from './map.js';
export * from './types.js';
export * from './commands.js';
export * from './state.js';
export * from './crt.js';
export * from './ships.js';
export * from './rng.js';

// ---------------------------------------------------------------------------
// The turn driver
// ---------------------------------------------------------------------------

export {
  type VictoryChecker,
  advancePhase,
  applyCommand,
  legalCommands,
  registerVictoryCheck,
  victoryCheckerFor,
} from './reducer.js';

// ---------------------------------------------------------------------------
// The rules modules, whole
// ---------------------------------------------------------------------------

export * as movement from './movement.js';
export * as combat from './combat.js';
export * as ordnance from './ordnance.js';
export * as logistics from './logistics.js';
export * as detection from './detection.js';

// ---------------------------------------------------------------------------
// Movement and astrogation
// ---------------------------------------------------------------------------

export {
  type MovementData,
  type PlotOption,
  type PlotPreview,
  canManeuver,
  canOverload,
  controllerOf,
  courseThroughCentre,
  denseAsteroidsOnCourse,
  effectiveGravity,
  executeMovementPhase,
  hasScanners,
  isLandingThisTurn,
  isTakingOffThisTurn,
  movementData,
  predictedCourse,
  predictedEndpoint,
  previewPlot,
  ramTarget,
  reachableEndpoints,
  shipLabel,
  shipPath,
} from './movement.js';

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------
//
// `combat.canManeuver` and `combat.shipLabel` are deliberately not re-exported
// flat: movement owns those two names above. Reach them through the `combat`
// namespace if the distinction ever matters (it does not — the two `shipLabel`
// implementations are identical, and `combat.canManeuver` is the damage-only
// half of movement's fuller check).

export {
  ADVANCED_TRACK_LIMIT,
  type AttackMode,
  type AttackPreview,
  PENDING_ATTACK_KEY,
  type PendingAttack,
  type PendingDamage,
  SUPPRESSED_SIDES_KEY,
  applyAdvancedHits,
  applyDamage,
  canFire,
  combatStrength,
  driveDoomed,
  hasPendingAttack,
  immuneToGunfire,
  isDisabled,
  isSideSuppressed,
  pendingCounterattack,
  previewAttack,
  recoverDamage,
  resolvePendingDamage,
  suppressedSides,
  targetGroupIn,
  weaponsUnrepairable,
} from './combat.js';

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

export {
  NUKE_TARGET_ODDS,
  ORDNANCE_LIFETIME,
  ORDNANCE_MASS,
  TORPEDO_BOOST,
  type OrdnanceData,
  ageOrdnance,
  attackableByGuns,
  canCarryOrdnance,
  canLaunch,
  checkOrdnanceAgainstCourse,
  holdMassUsed,
  launcherOf,
  moveOrdnancePhase,
  mustAvoidOwnMine,
  nukeDevastationSide,
  ordnanceData,
  ordnanceEndpoint,
  ordnanceLabel,
  ownMineConflict,
  torpedoAimEndpoints,
  torpedoAimOptions,
} from './ordnance.js';

// ---------------------------------------------------------------------------
// Logistics
// ---------------------------------------------------------------------------
//
// `logistics.ORDNANCE_LIFETIME` is the same five turns the ordnance module
// exports; only one of the two can hold the flat name, and ordnance owns it.

export {
  AUTOMATED_MINE_RATE,
  FUEL_PRICE,
  type LogisticsData,
  MANUAL_MINE_RATE,
  MARKETS,
  type MineSite,
  RESUPPLY_ORDNANCE,
  type ResupplyCheck,
  baseBodyId,
  baseIsFriendly,
  canCarry,
  canResupplyAt,
  cargoMass,
  cargoSpace,
  captureBasesByLanding,
  coursesMatched,
  fuelCapacity,
  guardsAt,
  hasUnlimitedFuel,
  logisticsData,
  matchedShips,
  mineAt,
  prospectingEnabled,
  runProspecting,
  runResupplyPhase,
  surrenderFuelReserve,
} from './logistics.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export {
  type DetectionSource,
  detectionField,
  detectionRangeOfBase,
  detectionRangeOfShip,
  detectionSources,
  hiddenAtClandestine,
  inDetectorRange,
  isDetected,
  updateDetection,
  visibleShips,
} from './detection.js';
