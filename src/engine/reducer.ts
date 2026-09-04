/**
 * The turn driver: the one door every change to a game goes through.
 *
 * `applyCommand` is a pure function of `(state, command, map)`. It decides three
 * things and then delegates:
 *
 *   1. **Whose turn is it?** "Each turn represents one day. A turn includes one
 *      player-turn for each player." Only the phasing player may act — with the
 *      three exceptions the rules themselves create: return fire ("Ships which
 *      are attacked may return fire ... during the combat phase"), declining it,
 *      and answering a demand for surrender. Those belong to the player being
 *      shot at, in the *enemy's* player-turn.
 *   2. **Is the order legal in this phase?** The five phases (p. 2) are a strict
 *      sequence, and each command has its home in one of them.
 *   3. **What does the rulebook say?** Nothing. The rules modules answer that;
 *      this file only routes to them and never second-guesses their verdicts.
 *
 * `advancePhase` runs the automatic half of the sequence of play — the work the
 * rulebook describes without anybody ordering it: ships and ordnance moving,
 * detectors sweeping, damage recovering, the turn rolling over.
 *
 * ## Invariants
 *
 * - No command ever throws. An illegal order returns the state it was handed,
 *   byte-identical, plus a reason. That is what lets `GameSession` treat the
 *   command log as authoritative and replay it: a rejected command is simply not
 *   in the log.
 * - No `Date`, no `Math.random`, no DOM. Every die comes out of `state.rng`.
 * - Rejections are cheap and total: a client that guesses wrong about legality
 *   costs the table nothing.
 */

import type { Command, CommandResult, CommandType } from './commands.js';
import { isZero, sub } from './hex.js';
import { isCommercial } from './ships.js';
import { DEFAULT_MAP, type GameMap } from './map.js';
import { log, updateShip } from './state.js';
import {
  type GameState,
  type OrdnanceId,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipId,
  type VictoryState,
  PHASE_LABELS,
  areAllied,
  controllerOf,
} from './types.js';

import {
  canManeuver,
  declareRam,
  executeMovementPhase,
  land,
  resolveAstrogationHazards,
  plotCourse,
  setOptionalGravity,
  shipLabel,
  takeOff,
} from './movement.js';
import {
  canFire,
  chooseRepair,
  declineCounterattack,
  repairableTracks,
  firePlanetaryDefence,
  pendingCounterattack,
  resolveAttack,
  resolveCounterattack,
  resolvePendingDamage,
  suppressHexside,
} from './combat.js';
import {
  attackNuke,
  canLaunch,
  checkOrdnanceAgainstCourse,
  chooseDevastatedSide,
  pendingDevastation,
  resolvePendingDevastation,
  firePlanetaryDefenceAtNuke,
  canLaunchBaseTorpedo,
  launchBaseTorpedo,
  launchOrdnance,
  moveOrdnancePhase,
  ownMineConflict,
} from './ordnance.js';
import {
  canResupplyAt,
  capture,
  demandSurrender,
  emplaceEquipment,
  loadCargo,
  logisticsData,
  loot,
  matchedShips,
  mineOre,
  equipmentCatalogue,
  prospectingEnabled,
  purchaseEquipment,
  purchaseShip,
  sellCargo,
  respondToSurrender,
  resupply,
  runResupplyPhase,
  transferCargo,
} from './logistics.js';
import { updateDetection } from './detection.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Outcome = { state: GameState; result: CommandResult };

const ok: CommandResult = { ok: true };

const reject = (state: GameState, reason: string): Outcome => ({
  state,
  result: { ok: false, reason },
});

const liveShipsOf = (state: GameState, player: PlayerId): Ship[] =>
  Object.values(state.ships).filter((s) => !s.destroyed && controllerOf(s) === player);

const seatOf = (state: GameState): PlayerId | undefined =>
  state.playerOrder[state.activePlayerIndex];

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

/**
 * A scenario's victory condition, as a pure predicate over the state.
 *
 * The engine cannot import `src/scenarios` — the scenarios import *it* — so the
 * table is handed in from outside instead. The registry is set once, at start
 * up, by whoever composes the app (`registerVictoryCheck(checkScenarioVictory)`
 * is the usual call); `applyCommand` stays pure with respect to a fixed
 * registry, which is all replay determinism requires.
 */
export type VictoryChecker = (state: GameState) => VictoryState | null;

const scenarioCheckers = new Map<string, VictoryChecker>();
let defaultChecker: VictoryChecker | null = null;

/**
 * Register a victory checker. With one argument it becomes the fallback used for
 * every scenario; with two, it is bound to that scenario id and takes precedence
 * over the fallback. Passing `null` clears.
 */
export function registerVictoryCheck(check: VictoryChecker | null): void;
export function registerVictoryCheck(scenarioId: string, check: VictoryChecker | null): void;
export function registerVictoryCheck(
  a: string | VictoryChecker | null,
  b?: VictoryChecker | null,
): void {
  if (typeof a === 'string') {
    if (b) scenarioCheckers.set(a, b);
    else scenarioCheckers.delete(a);
    return;
  }
  defaultChecker = a;
}

/** The checker that would run for this scenario id, if any. */
export const victoryCheckerFor = (scenarioId: string): VictoryChecker | null =>
  scenarioCheckers.get(scenarioId) ?? defaultChecker;

/**
 * The scenario's own upkeep, run as each player-turn closes.
 *
 * A handful of scenarios have machinery that ticks on its own rather than being
 * ordered by anybody — "Each base generates MCr 0.1 per turn", "A corvette does
 * not appear until the previous one has accomplished its mission or been
 * destroyed", "The Patrol earns points equal to the combat strength of destroyed
 * pirate ships". None of it belongs in the general rules, and the engine cannot
 * import the scenario table, so it arrives through the same registry the victory
 * checkers use. Hooks must be pure and must take any die they need from
 * `state.rng`, or replays stop matching.
 */
export type TurnHook = (state: GameState, map: GameMap) => GameState;

const scenarioHooks = new Map<string, TurnHook>();
let defaultHook: TurnHook | null = null;

export function registerTurnHook(hook: TurnHook | null): void;
export function registerTurnHook(scenarioId: string, hook: TurnHook | null): void;
export function registerTurnHook(a: string | TurnHook | null, b?: TurnHook | null): void {
  if (typeof a === 'string') {
    if (b) scenarioHooks.set(a, b);
    else scenarioHooks.delete(a);
    return;
  }
  defaultHook = a;
}

/** The upkeep hook that would run for this scenario id, if any. */
export const turnHookFor = (scenarioId: string): TurnHook | null =>
  scenarioHooks.get(scenarioId) ?? defaultHook;

/**
 * Orders that exist only inside one scenario.
 *
 * Three of the printed scenarios ask a player to do something no general rule
 * describes: announcing a cargo's destination on take-off and delivering it
 * (Piracy), and mustering the Freedom Fleet (Retribution). The engine cannot
 * import the scenario table — the dependency runs the other way — so these
 * arrive through the same registry the victory checkers and upkeep hooks use.
 *
 * A handler returns `null` for a command it does not own, and the reducer then
 * refuses it: an order with no scenario behind it is a client bug, not a rule.
 */
export type ScenarioCommandHook = (state: GameState, cmd: Command, map: GameMap) => Outcome | null;

const scenarioCommandHooks = new Map<string, ScenarioCommandHook>();

export function registerCommandHook(scenarioId: string, hook: ScenarioCommandHook | null): void {
  if (hook) scenarioCommandHooks.set(scenarioId, hook);
  else scenarioCommandHooks.delete(scenarioId);
}

export const commandHookFor = (scenarioId: string): ScenarioCommandHook | null =>
  scenarioCommandHooks.get(scenarioId) ?? null;

/** Route a scenario-only order, or explain that this scenario has no such order. */
const scenarioCommand = (state: GameState, cmd: Command, map: GameMap): Outcome => {
  const handled = commandHookFor(state.scenarioId)?.(state, cmd, map);
  return handled ?? reject(state, `${cmd.type} is not an order in this scenario`);
};

const describeWinners = (state: GameState, v: VictoryState): string => {
  if (v.winners.length === 0) return 'The game ends in a draw';
  const names = v.winners.map((id) => state.players[id]?.name ?? id).join(' and ');
  return `${names} win${v.winners.length === 1 ? 's' : ''} a ${v.level} victory`;
};

/**
 * Ask the scenario whether anybody has won, after every accepted command.
 *
 * Victory is sticky: once set it is never recomputed, so a condition that is
 * momentarily true (a ship sitting on a delivery hex) cannot be undone by the
 * next command.
 */
const checkVictory = (state: GameState): GameState => {
  if (state.victory) return state;
  const checker = victoryCheckerFor(state.scenarioId);
  if (!checker) return state;
  const v = checker(state);
  if (!v) return state;
  const s: GameState = { ...state, victory: v };
  return log(s, `${describeWinners(s, v)} — ${v.reason}`, {
    severity: 'good',
    player: null,
  });
};

// ---------------------------------------------------------------------------
// Phase legality
// ---------------------------------------------------------------------------

const ANY = 'any' as const;

/**
 * Which phases each order belongs to (rulebook p. 2).
 *
 * Three entries are wider than the phase list suggests, and each widening is
 * forced by a rule:
 *
 *  - `plotCourse` and `setOptionalGravity` are also legal in the **ordnance**
 *    phase, because "When a mine is launched, it assumes the vector of its
 *    launching ship. That ship must execute an immediate course change to insure
 *    that it does not remain in the same hex as the mine." The launch happens in
 *    phase 2, so the course change has to be possible in phase 2.
 *  - `declareRam` likewise: a ship that has just laid a mine and re-plotted may
 *    find itself lined up on an enemy. "Ramming takes place during the movement
 *    phase", but the declaration precedes it.
 *  - `mineOre` is listed for the movement phase too — "Mining ... takes one turn,
 *    and takes place in the movement phase, instead of movement" — while being
 *    declared during astrogation like any other course decision.
 */
const COMMAND_PHASES: Readonly<Record<CommandType, readonly Phase[] | typeof ANY>> = {
  // 1. Astrogation.
  plotCourse: ['astrogation', 'ordnance'],
  setOptionalGravity: ['astrogation', 'ordnance'],
  land: ['astrogation'],
  takeOff: ['astrogation'],
  declareRam: ['astrogation', 'ordnance'],
  mineOre: ['astrogation', 'movement'],
  emplaceEquipment: ['astrogation'],
  // 2. Ordnance.
  launchOrdnance: ['ordnance'],
  launchBaseTorpedo: ['ordnance'],
  // 3. Movement is automatic — see `advancePhase`.
  // 4. Combat.
  attack: ['combat'],
  counterattack: ['combat'],
  declineCounterattack: ['combat'],
  firePlanetaryDefence: ['combat'],
  suppressHexside: ['combat'],
  demandSurrender: ['combat'],
  respondToSurrender: ['combat'],
  // 5. Resupply. "Spaceships may refuel, resupply, load and unload cargo, loot
  // captured ships, or rescue, as appropriate" — the shop and the market are
  // both things a ship does while stopped at a base, so they belong here with
  // the rest of the stopover.
  resupply: ['resupply'],
  transferCargo: ['resupply'],
  loot: ['resupply'],
  capture: ['resupply'],
  purchaseShip: ['resupply'],
  purchaseEquipment: ['resupply'],
  sellCargo: ['resupply'],
  loadCargo: ['resupply'],
  deliverCargo: ['resupply'],
  // Piracy: "Merchant ships must announce their destination when they take off"
  // — the same phase the take-off itself is ordered in.
  announceDestination: ['astrogation'],
  // A standing order, not an action: legal whenever its owner has the floor.
  chooseRepair: ANY,
  // Answered the moment the question is asked, which is inside the movement
  // phase where the warhead arrives.
  chooseDevastatedSide: ANY,
  // Retribution's Freedom Fleet musters between days.
  convertFleet: ['resupply'],
  // Orbital Drop. Ground forces and garrisons are bought at the stopover with
  // everything else; an invasion is declared in the ordnance phase (§4.01);
  // the landing itself, and a lift-off from a failed one, are astrogation
  // decisions like any other landing; the ground battle's verdict arrives
  // whenever the battle ends.
  purchaseGround: ['resupply'],
  purchaseGarrison: ['resupply'],
  declareInvasion: ['ordnance'],
  resolveGroundBattle: ANY,
  repairOgre: ['resupply'],
  // Flow.
  endPhase: ANY,
  concede: ANY,
};

/** The phase a command is *primarily* at home in — what the UI advertises. */
const primaryPhase = (type: CommandType): Phase | null => {
  const phases = COMMAND_PHASES[type];
  return phases === ANY ? null : (phases[0] ?? null);
};

const legalInPhase = (type: CommandType, phase: Phase): boolean => {
  const phases = COMMAND_PHASES[type];
  return phases === ANY || phases.includes(phase);
};

/**
 * The orders that belong to a player who is *not* phasing.
 *
 * "Ships which are attacked may return fire against any or all of their
 * attackers during the combat phase" — the defender acts inside the attacker's
 * player-turn, and a surrender is answered by the ship being asked. Naming the
 * hexside a nuke devastated is the same shape of thing: "the suffering player
 * makes the choice", and the sufferer is by definition not the one who fired.
 */
const RESPONDER_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  'counterattack',
  'declineCounterattack',
  'respondToSurrender',
  'chooseDevastatedSide',
  // Orbital Drop: the ground battle's verdict arrives when the battle ends,
  // whichever seat happens to hold the frozen sky.
  'resolveGroundBattle',
]);

// ---------------------------------------------------------------------------
// Automatic phase work
// ---------------------------------------------------------------------------

/**
 * Head the log with the phase that is opening, *before* the work that phase does
 * is logged underneath it. The state's phase must already have been advanced —
 * `log` stamps entries with `state.phase`.
 */
const announce = (state: GameState): GameState =>
  log(state, `${PHASE_LABELS[state.phase]} phase.`, { severity: 'info' });

const NEXT_PHASE: Readonly<Record<Phase, Phase>> = {
  astrogation: 'ordnance',
  ordnance: 'movement',
  movement: 'combat',
  combat: 'resupply',
  resupply: 'astrogation',
};

/**
 * Fly every piece of ordnance against the courses the phasing player's ships
 * have just flown.
 *
 * The leg each ship flew is recoverable from the state itself: after the move,
 * `pos - velocity` is exactly where the leg began. That is more robust than
 * reading the traced path back out of the movement side table, which a landed or
 * unmoved ship never writes.
 *
 * "A mine detonates when the course of a ship (or ordnance) passes through any
 * portion of the hex occupied by the mine" — this is the ship-flies-past-mine
 * half; `moveOrdnancePhase` is the mine-flies-past-ship half, and runs after,
 * because "Spaceships move along their plotted courses to their new plotted
 * positions. Mines, torpedoes, and nukes launched by the phasing player ... also
 * move at this time."
 */
const checkCoursesAgainstOrdnance = (state: GameState, map: GameMap): GameState => {
  const player = seatOf(state);
  if (player === undefined) return state;
  let s = state;
  // Sorted ids keep the die rolls reproducible across replays.
  for (const id of Object.keys(state.ships).sort()) {
    const ship = s.ships[id];
    if (!ship || ship.destroyed) continue;
    if (controllerOf(ship) !== player) continue;
    if (Object.keys(s.ordnance).length === 0) break;
    s = checkOrdnanceAgainstCourse(s, id, sub(ship.pos, ship.velocity), ship.pos, map);
  }
  return s;
};

/**
 * "3. Movement Phase. Spaceships move along their plotted courses to their new
 * plotted positions. Mines, torpedoes, and nukes launched by the phasing player
 * (on this or previous turns) also move at this time. If ordnance encounters a
 * target, it explodes during this phase."
 *
 * Detectors sweep last, once every counter is in its final hex: "All ships and
 * bases have detectors which enable them to determine the position of other
 * ships."
 */
const enterMovement = (state: GameState, map: GameMap): GameState => {
  let s = announce({ ...state, phase: 'movement' });
  s = executeMovementPhase(s, map);
  s = checkCoursesAgainstOrdnance(s, map);
  s = moveOrdnancePhase(s, map);
  s = updateDetection(s, map);
  return s;
};

/**
 * "No ship may attack or be attacked more than once per combat phase" — so the
 * per-phase flags are cleared for *everyone* as the phase opens, not just for the
 * phasing player: an enemy ship shot at in the last player-turn is a fresh target
 * in this one. A base likewise fires once per its owner's combat phase.
 *
 * `firedThisPhase` deliberately survives from the previous player-turn until this
 * moment, because the detection sweep in the movement phase reads it: a ship that
 * has fired has given its position away.
 */
const enterCombat = (state: GameState): GameState => {
  // A nuke that struck a world on an unclear bearing has been waiting on its
  // victim since the movement phase. The choice belongs to them, but it cannot
  // outlive the phase the warhead landed in — the same safety net `enterResupply`
  // is for an unanswered counterattack.
  let s = announce({ ...resolvePendingDevastation(state), phase: 'combat' });
  // "If astrogation hazards were encountered during the movement phase, their
  // effects are rolled for during this phase."
  s = resolveAstrogationHazards(s);
  for (const ship of Object.values(state.ships)) {
    if (!ship.firedThisPhase && !ship.attackedThisPhase) continue;
    s = updateShip(s, ship.id, { firedThisPhase: false, attackedThisPhase: false });
  }
  const bases = { ...s.bases };
  let touched = false;
  for (const base of Object.values(bases)) {
    if (!base.firedThisTurn) continue;
    bases[base.id] = { ...base, firedThisTurn: false };
    touched = true;
  }
  return touched ? { ...s, bases } : s;
};

/**
 * Leaving the combat phase. Any damage still parked awaiting a counterattack is
 * applied now: the defender's chance to "return fire ... during the combat phase"
 * ends with the phase. Declining explicitly is the tidy path; this is the safety
 * net that guarantees no game can wedge on an unanswered prompt.
 */
const enterResupply = (state: GameState): GameState =>
  announce({ ...resolvePendingDamage(state), phase: 'resupply' });

/**
 * Flags that live for exactly one player-turn.
 *
 * `resuppliedThisTurn` is cleared here rather than carried further because the
 * rule is scoped to the player-turn: "No ship may fire its guns or launch
 * ordnance during a player-turn in which it resupplies." Returning fire inside
 * the *enemy's* player-turn is a different player-turn, and the rules do not
 * forbid it. `launchedOrdnanceThisTurn` enforces "Each ship may release only one
 * item per turn", and a ship gets exactly one ordnance phase per turn, so the
 * two scopes coincide.
 */
const clearPerTurnFlags = (state: GameState): GameState => {
  let s = state;
  for (const ship of Object.values(state.ships)) {
    if (!ship.resuppliedThisTurn && !ship.launchedOrdnanceThisTurn) continue;
    s = updateShip(s, ship.id, {
      resuppliedThisTurn: false,
      launchedOrdnanceThisTurn: false,
    });
  }
  const bases = { ...s.bases };
  let touched = false;
  for (const base of Object.values(bases)) {
    if (!base.resuppliedThisTurn && !base.launchedThisTurn) continue;
    // "It may fire one torpedo per turn" — a base's turn, like a ship's, is its
    // owner's player-turn.
    bases[base.id] = { ...base, resuppliedThisTurn: false, launchedThisTurn: false };
    touched = true;
  }
  return touched ? { ...s, bases } : s;
};

/**
 * Which seat plays next, and whether that starts a new day.
 *
 * "At the end of the resupply phase, the next player turn begins. At the end of
 * the complete set of player turns, a new game turn begins." Eliminated players
 * are skipped; the loop is bounded by the seat count so an all-eliminated table
 * cannot spin.
 */
const nextSeat = (state: GameState): { index: number; turn: number } => {
  const n = state.playerOrder.length;
  if (n === 0) return { index: state.activePlayerIndex, turn: state.turn };
  let index = state.activePlayerIndex;
  let turn = state.turn;
  for (let i = 0; i < n; i += 1) {
    index += 1;
    if (index >= n) {
      index = 0;
      turn += 1;
    }
    const id = state.playerOrder[index];
    const player = id === undefined ? undefined : state.players[id];
    if (player && !player.eliminated) break;
  }
  return { index, turn };
};

/**
 * "5. Resupply Phase. Spaceships may refuel, resupply, load and unload cargo,
 * loot captured ships, or rescue, as appropriate. Damage is recovered."
 *
 * The player-driven half has already arrived as commands; `runResupplyPhase`
 * runs everything that happens on its own and ends with repairs, which "recover
 * at the end of the Resupply phase".
 */
const endPlayerTurn = (state: GameState, map: GameMap): GameState => {
  let s = resolvePendingDamage(state);
  s = runResupplyPhase(s, map);
  // The scenario's own upkeep — base income, reinforcements, points — runs on
  // the closing player-turn, before the flags that scope it are cleared.
  s = turnHookFor(s.scenarioId)?.(s, map) ?? s;
  s = clearPerTurnFlags(s);

  const { index, turn } = nextSeat(s);
  const newDay = turn !== s.turn;
  s = { ...s, activePlayerIndex: index, turn, phase: 'astrogation' };

  const seat = seatOf(s);
  const name = seat === undefined ? 'nobody' : (s.players[seat]?.name ?? seat);
  if (newDay) {
    s = log(s, `Day ${turn} begins. ${name} has the initiative.`, {
      severity: 'info',
      phase: 'astrogation',
    });
  } else {
    s = log(s, `${name}'s player-turn begins.`, { severity: 'info', phase: 'astrogation' });
  }
  return s;
};

/**
 * Advance one phase, running whatever the rulebook does automatically at that
 * boundary. Exported so a headless driver (tests, an AI, a replay tool) can run
 * a turn without synthesising `endPhase` commands.
 */
export function advancePhase(state: GameState, map: GameMap): GameState {
  switch (state.phase) {
    case 'astrogation':
      // Nothing happens between phases 1 and 2: the courses are simply plotted.
      return announce({ ...state, phase: NEXT_PHASE.astrogation });
    case 'ordnance':
      // Launches have already been resolved as commands.
      return enterMovement(state, map);
    case 'movement':
      return enterCombat(state);
    case 'combat':
      return enterResupply(state);
    case 'resupply':
      return endPlayerTurn(state, map);
  }
}

// ---------------------------------------------------------------------------
// endPhase
// ---------------------------------------------------------------------------

/**
 * "When a mine is launched, it assumes the vector of its launching ship. That
 * ship must execute an immediate course change to insure that it does not remain
 * in the same hex as the mine."
 *
 * Enforced as the ordnance phase closes, which is the last moment a course change
 * is still possible. A ship that *cannot* change course — no fuel, or a drive it
 * cannot use — is let through instead of deadlocking the game; its own mine will
 * greet it in the movement phase, which is the natural consequence rather than a
 * special rule.
 */
const blockedByOwnMine = (state: GameState, map: GameMap): string | null => {
  const player = seatOf(state);
  if (player === undefined) return null;
  for (const id of Object.keys(state.ships).sort()) {
    const ship = state.ships[id];
    if (!ship || ship.destroyed) continue;
    if (controllerOf(ship) !== player) continue;
    if (!ownMineConflict(state, ship, map)) continue;
    if (!canManeuver(state, ship) || ship.fuel < 1) continue;
    return `${shipLabel(ship)} must change course: its own mine shares the plotted endpoint`;
  }
  return null;
};

const endPhase = (state: GameState, map: GameMap): Outcome => {
  if (state.phase === 'ordnance') {
    const blocked = blockedByOwnMine(state, map);
    if (blocked) return reject(state, blocked);
  }
  return { state: advancePhase(state, map), result: ok };
};

// ---------------------------------------------------------------------------
// concede
// ---------------------------------------------------------------------------

const concede = (state: GameState, by: PlayerId): Outcome => {
  const player = state.players[by];
  if (!player) return reject(state, 'no such player');
  if (player.eliminated) return reject(state, 'you have already withdrawn');

  let s: GameState = {
    ...state,
    players: { ...state.players, [by]: { ...player, eliminated: true } },
  };
  s = log(s, `${player.name} concedes.`, { severity: 'bad', player: by });

  const survivors = s.playerOrder.filter((id) => !s.players[id]?.eliminated);
  if (survivors.length === 1) {
    const v: VictoryState = {
      winners: survivors,
      level: 'decisive',
      reason: `${player.name} conceded`,
    };
    s = { ...s, victory: v };
    s = log(s, `${describeWinners(s, v)} — ${v.reason}.`, { severity: 'good', player: null });
    return { state: s, result: ok };
  }

  // The seat has to move on: an eliminated player cannot plot a course. No phase
  // work runs — the conceding player's turn is abandoned, not completed.
  if (seatOf(s) === by) {
    const { index, turn } = nextSeat(s);
    s = { ...resolvePendingDamage(s), activePlayerIndex: index, turn, phase: 'astrogation' };
    const seat = seatOf(s);
    s = log(s, `${seat === undefined ? 'nobody' : (s.players[seat]?.name ?? seat)} takes over.`, {
      phase: 'astrogation',
    });
  }
  return { state: s, result: ok };
};

// ---------------------------------------------------------------------------
// Attacks aimed at ordnance
// ---------------------------------------------------------------------------

/**
 * "Guns and planetary defenses may attack nukes at odds of 2:1 (with
 * modifications for range and relative velocity). A 'disabled' nuke is
 * destroyed."
 *
 * `Attack.targets` is typed as ship ids, but ship ids and ordnance ids share a
 * namespace of plain strings, so an attack naming a live piece of ordnance and no
 * ship is routed to the nuke rules instead of the gunfire table. Without this the
 * only way to stop a nuke would be to get out of its way.
 */
const nukeTargetIn = (state: GameState, targets: readonly string[]): OrdnanceId | null => {
  if (targets.length !== 1) return null;
  const id = targets[0];
  if (id === undefined) return null;
  if (state.ships[id]) return null;
  return state.ordnance[id] ? id : null;
};

// ---------------------------------------------------------------------------
// applyCommand
// ---------------------------------------------------------------------------

/**
 * Everything a rules module might reasonably need is already validated by the
 * module itself; this dispatch only routes. The `try` is a belt-and-braces
 * guarantee of the "never throws" contract — a bug in a rules module degrades to
 * a rejected command rather than a lost game.
 */
const dispatch = (state: GameState, cmd: Command, map: GameMap): Outcome => {
  switch (cmd.type) {
    // --- Astrogation ---
    case 'plotCourse':
      return plotCourse(state, cmd, map);
    case 'setOptionalGravity':
      return setOptionalGravity(state, cmd, map);
    case 'land':
      return land(state, cmd, map);
    case 'takeOff':
      return takeOff(state, cmd, map);
    case 'declareRam':
      return declareRam(state, cmd, map);
    case 'mineOre':
      return mineOre(state, cmd, map);
    case 'emplaceEquipment':
      return emplaceEquipment(state, cmd, map);

    // --- Ordnance ---
    case 'launchOrdnance':
      return launchOrdnance(state, cmd, map);
    case 'launchBaseTorpedo':
      return launchBaseTorpedo(state, cmd, map);

    // --- Combat ---
    case 'attack': {
      const nuke = nukeTargetIn(state, cmd.targets);
      if (nuke) return attackNuke(state, cmd.attackers, nuke, map);
      return resolveAttack(state, cmd, map);
    }
    case 'counterattack':
      return resolveCounterattack(state, cmd, map);
    case 'declineCounterattack':
      return declineCounterattack(state);
    case 'firePlanetaryDefence': {
      const nuke = nukeTargetIn(state, cmd.targets);
      if (nuke) return firePlanetaryDefenceAtNuke(state, cmd.base, nuke, map);
      return firePlanetaryDefence(state, cmd, map);
    }
    case 'suppressHexside':
      return suppressHexside(state, cmd, map);
    case 'demandSurrender':
      return demandSurrender(state, cmd, map);
    case 'respondToSurrender':
      return respondToSurrender(state, cmd, map);

    // --- Resupply ---
    case 'resupply':
      return resupply(state, cmd, map);
    case 'transferCargo':
      return transferCargo(state, cmd, map);
    case 'loot':
      return loot(state, cmd, map);
    case 'capture':
      return capture(state, cmd, map);
    case 'purchaseShip':
      return purchaseShip(state, cmd, map);
    case 'purchaseEquipment':
      return purchaseEquipment(state, cmd.ship, cmd.kind, cmd.quantity, map);
    case 'sellCargo':
      return sellCargo(state, cmd.ship, [cmd.kind], map, cmd.quantity);
    case 'loadCargo':
      return loadCargo(state, cmd.ship, cmd.kind, cmd.quantity, map);

    // --- Damage control ---
    case 'chooseRepair':
      return chooseRepair(state, cmd);
    case 'chooseDevastatedSide':
      return chooseDevastatedSide(state, cmd, map);

    // --- Scenario-only orders ---
    case 'announceDestination':
    case 'deliverCargo':
    case 'convertFleet':
    case 'purchaseGround':
    case 'purchaseGarrison':
    case 'declareInvasion':
    case 'resolveGroundBattle':
    case 'repairOgre':
      return scenarioCommand(state, cmd, map);

    // --- Flow ---
    case 'endPhase':
      return endPhase(state, map);
    case 'concede':
      return concede(state, cmd.by);
  }
};

/** May this player speak for the ships that are entitled to return fire? */
const mayAnswer = (state: GameState, eligible: readonly ShipId[], by: PlayerId): boolean =>
  eligible.some((id) => {
    const ship = state.ships[id];
    return ship !== undefined && !ship.destroyed && controllerOf(ship) === by;
  });

/**
 * Is *anyone* still able to answer? The window belongs to the defender, so it
 * may not be closed while a live player still holds it — but a record nobody can
 * speak for any more must not wedge the game either, and `enterResupply` remains
 * the sweep that flushes it.
 */
const anyoneMayAnswer = (state: GameState, eligible: readonly ShipId[]): boolean =>
  eligible.some((id) => {
    const ship = state.ships[id];
    if (ship === undefined || ship.destroyed) return false;
    const owner = state.players[controllerOf(ship)];
    return owner !== undefined && !owner.eliminated;
  });

/**
 * Apply one command.
 *
 * Rejections return the *original* state, unchanged and un-logged: a refusal is
 * not an event in the game's history, it is a client that guessed wrong.
 */
export function applyCommand(state: GameState, cmd: Command, map: GameMap = DEFAULT_MAP): Outcome {
  // --- Sanity ---
  const type: unknown = (cmd as { type?: unknown } | null | undefined)?.type;
  if (typeof type !== 'string') return reject(state, 'malformed command');
  if (!(type in COMMAND_PHASES)) return reject(state, `unknown order "${type}"`);

  const actor = state.players[cmd.by];
  if (!actor) return reject(state, `no such player "${cmd.by}"`);

  // --- The game is over ---
  if (state.victory) return reject(state, 'the game is over');
  if (actor.eliminated) return reject(state, 'you have withdrawn from the game');

  // --- Phase ---
  if (!legalInPhase(cmd.type, state.phase)) {
    const home = primaryPhase(cmd.type);
    return reject(
      state,
      home
        ? `that order belongs to the ${PHASE_LABELS[home].toLowerCase()} phase, not ${PHASE_LABELS[state.phase].toLowerCase()}`
        : `that order is not legal in the ${PHASE_LABELS[state.phase].toLowerCase()} phase`,
    );
  }

  // --- Whose turn ---
  const seat = seatOf(state);
  if (seat === undefined) return reject(state, 'the table has no active player');
  const responder = RESPONDER_COMMANDS.has(cmd.type);
  if (!responder && cmd.by !== seat) return reject(state, 'it is not your player-turn');

  // --- An unnamed hexside blocks everything else ---
  // The victim of an ambiguous nuke strike is owed an answer before anything
  // else happens, for the same reason return fire is: what is destroyed decides
  // what can act next. Only `endPhase` may push past it, and only by way of the
  // sweep in `enterCombat`, which chooses as the victim would have.
  const strike = pendingDevastation(state);
  if (strike && cmd.type !== 'chooseDevastatedSide') {
    const sufferer = state.players[strike.sufferer];
    const stillThere = sufferer !== undefined && !sufferer.eliminated;
    if (stillThere && cmd.type !== 'endPhase' && cmd.type !== 'concede') {
      return reject(state, 'a hexside must be named for the nuke strike first');
    }
  } else if (!strike && cmd.type === 'chooseDevastatedSide') {
    return reject(state, 'no strike is waiting on a hexside');
  }

  // --- An unanswered counterattack blocks everything else ---
  // "Ships which are attacked may return fire against any or all of their
  // attackers during the combat phase, before damage is applied." Nothing else
  // may happen in between, or the damage would land out of order.
  const pending = pendingCounterattack(state);
  if (pending) {
    const answering = cmd.type === 'counterattack' || cmd.type === 'declineCounterattack';
    // "Ships which are attacked may return fire against any or all of their
    // attackers during the combat phase, before any damage is implemented."
    // The window is the defender's, so the attacker may not shut it by ending
    // the phase out from under them: `endPhase` waits too, for as long as a live
    // player is still entitled to answer.
    const closeable = cmd.type === 'endPhase' && !anyoneMayAnswer(state, pending.attackers);
    if (!answering && !closeable && cmd.type !== 'concede') {
      return reject(state, 'the outstanding counterattack must be answered first');
    }
    if (answering && !mayAnswer(state, pending.attackers, cmd.by)) {
      return reject(state, 'that counterattack is not yours to answer');
    }
  } else if (cmd.type === 'counterattack' || cmd.type === 'declineCounterattack') {
    return reject(state, 'there is no attack to answer');
  }

  // --- Route ---
  let outcome: Outcome;
  try {
    outcome = dispatch(state, cmd, map);
  } catch (err) {
    return reject(state, err instanceof Error ? err.message : 'the order could not be carried out');
  }
  if (!outcome.result.ok) return { state, result: outcome.result };

  return { state: checkVictory(outcome.state), result: outcome.result };
}

// ---------------------------------------------------------------------------
// legalCommands
// ---------------------------------------------------------------------------

/**
 * Which orders this player could issue right now.
 *
 * Coarse by design: it answers "is this button worth showing?", not "will this
 * exact command succeed?". The cheap feasibility guards below keep the palette
 * honest — no *Take Off* button with nothing landed — without duplicating a
 * rules module's judgement, which `applyCommand` will make anyway.
 */
export function legalCommands(
  state: GameState,
  player: PlayerId,
  map: GameMap = DEFAULT_MAP,
): CommandType[] {
  if (state.victory) return [];
  const actor = state.players[player];
  if (!actor || actor.eliminated) return [];

  const out: CommandType[] = [];

  const pending = pendingCounterattack(state);
  if (pending) {
    if (mayAnswer(state, pending.attackers, player)) {
      out.push('counterattack', 'declineCounterattack');
    }
    // Ending the phase is not on offer while the return fire the rules guarantee
    // is still owed to a live player; conceding always is.
    if (player === seatOf(state)) {
      if (!anyoneMayAnswer(state, pending.attackers)) out.push('endPhase');
      out.push('concede');
    }
    return out;
  }

  // A player who is not phasing may still be asked to surrender.
  if (player !== seatOf(state)) {
    if (legalInPhase('respondToSurrender', state.phase) && hasSurrenderDemand(state, player)) {
      out.push('respondToSurrender');
    }
    return out;
  }

  for (const type of Object.keys(COMMAND_PHASES) as CommandType[]) {
    if (RESPONDER_COMMANDS.has(type) && type !== 'respondToSurrender') continue;
    if (!legalInPhase(type, state.phase)) continue;
    if (!feasible(state, type, player, map)) continue;
    out.push(type);
  }
  return out;
}

/**
 * Orders that are always on offer and are never a reason to stop in a phase.
 *
 * `endPhase` and `concede` are available in every phase to every seated player,
 * so a phase in which they are the *only* legal orders is a phase in which
 * nothing can actually be done.
 */
const FLOW_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['endPhase', 'concede']);

/**
 * Orders the ordnance phase inherits from astrogation, and which are not by
 * themselves a reason to stop in it.
 *
 * `plotCourse`, `setOptionalGravity` and `declareRam` are legal in the ordnance
 * phase for one printed reason: "When a mine is launched, it assumes the vector
 * of its launching ship. That ship must execute an immediate course change to
 * insure that it does not remain in the same hex as the mine." They exist to
 * clean up after a launch. A ship with nothing to launch has already had its
 * astrogation phase, so offering the same three orders again is not work — it is
 * the same click twice.
 *
 * This changes nothing about legality: a player who turns auto-skip off, or who
 * stops in the phase for any other reason, may still re-plot there.
 */
const ORDNANCE_CARRY_OVERS: ReadonlySet<CommandType> = new Set<CommandType>([
  'plotCourse',
  'setOptionalGravity',
  'declareRam',
]);

/**
 * Is there nothing for anybody to do in this phase?
 *
 * Used to skip phases that would otherwise cost a click and change nothing: an
 * ordnance phase with no ordnance aboard, a combat phase with nothing in range,
 * a resupply phase far from any base. The rules are untouched — the phase still
 * happens, with everything the sequence of play does automatically inside it —
 * only the prompt is dropped.
 *
 * Deliberately asks about *every* player, not just the phasing one. Two of the
 * rulebook's decisions belong to somebody else's turn: "ships which are attacked
 * may return fire ... during the combat phase", and a demand for surrender is
 * answered by the ship being asked. Skipping a phase in which a defender still
 * owes an answer would take that answer away from them, so this returns false
 * whenever anybody at the table holds a live decision.
 */
export function phaseIsIdle(state: GameState, map: GameMap = DEFAULT_MAP): boolean {
  // A finished game is not idle, it is over; and an outstanding return fire or
  // an unnamed nuke hexside is precisely a decision that must not be skipped.
  if (state.victory) return false;
  if (pendingCounterattack(state) !== null) return false;
  if (pendingDevastation(state) !== null) return false;

  for (const player of state.playerOrder) {
    for (const type of legalCommands(state, player, map)) {
      if (FLOW_COMMANDS.has(type)) continue;
      if (state.phase === 'ordnance' && ORDNANCE_CARRY_OVERS.has(type)) continue;
      return false;
    }
  }
  return true;
}

const hasSurrenderDemand = (state: GameState, player: PlayerId): boolean => {
  const demands = logisticsData(state).demands;
  return Object.keys(demands).some((shipId) => {
    const ship = state.ships[shipId];
    if (!ship || ship.destroyed || controllerOf(ship) !== player) return false;
    return (demands[shipId] ?? []).length > 0;
  });
};

/** Cheap "is there anything at all to do?" guards, one per order. */
const feasible = (state: GameState, type: CommandType, player: PlayerId, map: GameMap): boolean => {
  const mine = liveShipsOf(state, player);
  switch (type) {
    case 'endPhase':
    case 'concede':
      return true;

    case 'plotCourse':
      return mine.some((s) => s.location.kind !== 'landed');
    case 'setOptionalGravity':
      // "A ship passing through one weak gravity hex may ignore it or use it."
      return mine.some((s) => s.optionalGravity.length > 0);
    case 'land':
      // "A ship may only land by expending one fuel point while in orbit."
      return mine.some((s) => s.location.kind === 'space' && s.fuel >= 1);
    case 'takeOff':
      return mine.some((s) => s.location.kind === 'landed');
    case 'declareRam':
      // "A ship may attempt to ram an enemy ship" — allies are not targets.
      return mine.length > 0 && hasEnemyShip(state, player);
    case 'mineOre':
      // "Mining ... takes one turn, and takes place in the movement phase."
      return prospectingEnabled(state) && mine.some((s) => isZero(s.velocity) && s.disabled === 0);
    case 'emplaceEquipment':
      return mine.some(
        (s) =>
          s.cargo.some(
            (c) =>
              c.quantity > 0 &&
              (c.kind === 'automatedMine' || c.kind === 'robotGuards' || c.kind === 'orbitalBase'),
          ) && s.disabled === 0,
      );

    case 'launchOrdnance':
      return mine.some(
        (s) =>
          canLaunch(state, s, 'mine', map).ok ||
          canLaunch(state, s, 'torpedo', map).ok ||
          canLaunch(state, s, 'nuke', map).ok,
      );
    case 'launchBaseTorpedo':
      // "They are capable of launching one torpedo per turn."
      return Object.values(state.bases).some((b) => canLaunchBaseTorpedo(state, b, player, map).ok);

    case 'attack':
      // Being able to shoot is not the same as having something to shoot at.
      // `declareRam` and `demandSurrender` already ask both questions; this used
      // to ask only the first, and offered an attack to a ship alone in deep
      // space.
      return (
        mine.some((s) => canFire(s, state.options.advancedCombat)) && hasEnemyShip(state, player)
      );
    case 'suppressHexside':
      // "...by gunfire from a ship orbiting overhead", into the hexside directly
      // below. No orbit, no shot — and there is no point offering it to a fleet
      // that is nowhere near a world.
      return mine.some(
        (s) =>
          canFire(s, state.options.advancedCombat) &&
          !s.firedThisPhase &&
          map.planetaryBaseBelow(s.pos) !== undefined &&
          map.orbitOf(s.pos, s.velocity) !== undefined,
      );
    case 'counterattack':
    case 'declineCounterattack':
      return false; // handled above, only while an attack is pending
    case 'firePlanetaryDefence':
      return Object.values(state.bases).some(
        (b) =>
          // "In a player's combat phase, each of that player's bases may fire."
          !b.destroyed && b.hasPlanetaryDefences && !b.firedThisTurn && b.owner === player,
      );
    case 'demandSurrender':
      return mine.length > 0 && hasEnemyShip(state, player);
    case 'respondToSurrender':
      return hasSurrenderDemand(state, player);

    case 'resupply':
      return mine.some((s) => !s.resuppliedThisTurn && canResupplyAt(state, s, map).ok);
    case 'transferCargo':
    case 'loot':
    case 'capture':
      // All three need matched courses: "same position and the same velocity".
      return mine.some((s) => matchedShips(state, s).length > 0);
    case 'purchaseShip':
      return (state.players[player]?.megacredits ?? 0) > 0;
    case 'purchaseEquipment':
      return (
        equipmentCatalogue(state).length > 0 &&
        (state.players[player]?.megacredits ?? 0) > 0 &&
        mine.some((s) => canResupplyAt(state, s, map).ok)
      );
    case 'sellCargo':
      // Only worth offering where there is both a market and something to sell.
      return mine.some(
        (s) =>
          s.cargo.some((c) => c.quantity > 0 && (c.kind === 'ore' || c.kind === 'ctShard')) &&
          canResupplyAt(state, s, map).ok,
      );
    case 'loadCargo':
      // Money moves only in commercial hulls, and only at a base.
      return mine.some(
        (s) =>
          isCommercial(s.shipClass) &&
          canResupplyAt(state, s, map).ok &&
          ((state.players[player]?.megacredits ?? 0) > 0 ||
            s.cargo.some((c) => c.kind === 'megacredits' && c.quantity > 0)),
      );

    case 'chooseRepair':
      // Only meaningful with more than one track damaged: with one, there is no
      // choice to make, and with none there is nothing to work on.
      return state.options.advancedCombat && mine.some((s) => repairableTracks(s).length > 1);
    case 'chooseDevastatedSide':
      return pendingDevastation(state)?.sufferer === player;

    // Scenario-only orders. The engine cannot know whether this scenario has a
    // cargo run or a Freedom Fleet, so it asks the scenario the same way it asks
    // about victory — and a scenario with no handler simply never offers them.
    case 'announceDestination':
    case 'deliverCargo':
    case 'convertFleet':
      return commandHookFor(state.scenarioId) !== null && mine.length > 0;
    case 'purchaseGround':
    case 'purchaseGarrison':
    case 'declareInvasion':
    case 'resolveGroundBattle':
    case 'repairOgre':
      return commandHookFor(state.scenarioId) !== null;
  }
};

/** Is there anybody left to shoot at? Allies do not count. */
const hasEnemyShip = (state: GameState, player: PlayerId): boolean =>
  Object.values(state.ships).some(
    (s) => !s.destroyed && !areAllied(state, player, controllerOf(s)),
  );
