/**
 * Mines, torpedoes and nukes.
 *
 * ## The shape of the rule
 *
 * All three weapons are the same object with three different fuses. The rulebook
 * builds them that way too: mines are defined first, then "A torpedo is treated
 * as a mine, except: ..." and nukes are a mine with an apocalyptic warhead. So
 * this module has exactly one movement routine and exactly one detonation
 * routine, and the three kinds differ only in
 *
 *  - what sets them off (`triggerAt`),
 *  - what happens when they go off (`detonate`), and
 *  - whether they survive going off (only a torpedo can: "A torpedo which misses
 *    all targets continues on its path and may conceivably find new targets").
 *
 * ## "Any portion of the hex"
 *
 * Contact is *not* the same test as entering a hex. The mine rule is explicit:
 *
 *   "A mine detonates when the course of a ship (or ordnance) passes through any
 *    portion of the hex occupied by the mine, or when the mine's course passes
 *    through any portion of a hex occupied by a ship or ordnance."
 *
 * so we use `traceSegment(...).touched` — interior passes, hexside runs *and*
 * single-point vertex grazes all count — rather than `.entered`, which is the
 * stricter list gravity and asteroids use. Both directions are checked:
 * `checkOrdnanceAgainstCourse` handles a ship flying past ordnance, and
 * `moveOrdnancePhase` handles ordnance flying past a ship.
 *
 * A course's *tail* hex is deliberately excluded from the contact test (unless
 * the course has zero length, in which case the object never leaves it). Two
 * reasons, both forced by the rules:
 *
 *  - A mine "assumes the vector of its launching ship", so at the instant of
 *    launch the mine and the launcher share a hex. If the tail counted, every
 *    mine would kill its own launcher and the rule that follows — "That ship must
 *    execute an immediate course change to insure that it does not remain in the
 *    same hex as the mine" — would be meaningless. The requirement is about where
 *    the two *end up*, which is what `mustAvoidOwnMine` tests.
 *  - Anything already sharing a hex at the start of a turn had its contact
 *    adjudicated on the turn it arrived; re-testing the tail would detonate the
 *    same mine twice.
 *
 * ## Sequencing
 *
 * `moveOrdnancePhase` must run *after* the phasing player's ships have moved:
 * "Spaceships move along their plotted courses to their new plotted positions.
 * Mines, torpedoes, and nukes launched by the phasing player (on this or previous
 * turns) also move at this time." Ships first means ordnance is checked against
 * final positions, and it means a launcher that obeyed the course-change rule has
 * already left the hex its mine starts in.
 *
 * Every die goes through `state.rng`; nothing here touches `Math.random`, `Date`
 * or the DOM.
 */

import type { CommandResult, LaunchBaseTorpedo, LaunchOrdnance } from './commands.js';
import {
  type DamageResult,
  type OtherAttackKind,
  gunDamage,
  otherDamage,
  otherToHit,
  rangeModifier,
  velocityModifier,
} from './crt.js';
import { type Touch, closestApproach, toPlane, traceSegment } from './geometry.js';
import {
  type Hex,
  type HexSide,
  DIRECTIONS,
  add,
  directionTo,
  distance,
  eq,
  hexSide,
  isZero,
  key,
  sideGravityHex,
  sideKey,
  sub,
  withinRadius,
} from './hex.js';
import { DEFAULT_MAP, type GameMap } from './map.js';
import type { AstralBody } from './mapdata.js';
import { rollDie, shuffle } from './rng.js';
import { CARGO, SHIP_CLASSES, canLaunchTorpedoes, nukeLimit } from './ships.js';
import {
  ZERO,
  addCargo,
  cargoCount,
  log,
  ordnanceInHex,
  removeOrdnance,
  shipsInHex,
  withBase,
  withOrdnance,
  withShip,
} from './state.js';
import {
  type BaseState,
  type CourseLeg,
  type GameState,
  type Ordnance,
  type OrdnanceId,
  type OrdnanceKind,
  type PlayerId,
  type Ship,
  type ShipId,
  activePlayer,
  areAllied,
} from './types.js';
import { applyAdvancedHits, applyDamage, canFire, shipLabel } from './combat.js';
import { ordnanceDeniedReason } from './logistics.js';
import {
  controllerOf,
  effectiveGravity,
  isLandingThisTurn,
  isTakingOffThisTurn,
  predictedEndpoint,
  shipPath,
} from './movement.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * "Mines remain active for five turns, after which they self-destruct." The same
 * sentence is repeated verbatim for torpedoes and nukes.
 */
export const ORDNANCE_LIFETIME = 5;

/**
 * "On the turn in which a torpedo is launched (and only on that turn), it may
 * accelerate one or two hexes in any direction."
 */
export const TORPEDO_BOOST = 2;

/** "Guns and planetary defenses may attack nukes at odds of 2:1." */
export const NUKE_TARGET_ODDS = '2:1' as const;

/** Hold cost, straight from the cargo table: mine 10 tons, torpedo/nuke 20. */
export const ORDNANCE_MASS: Readonly<Record<OrdnanceKind, number>> = {
  mine: CARGO.mine.mass,
  torpedo: CARGO.torpedo.mass,
  nuke: CARGO.nuke.mass,
};

/** Counter letters, as the rulebook marks them: "torpedoes with T, mines with M, and nukes with N." */
const ID_PREFIX: Readonly<Record<OrdnanceKind, string>> = {
  mine: 'M',
  torpedo: 'T',
  nuke: 'N',
};

const KIND_NAME: Readonly<Record<OrdnanceKind, string>> = {
  mine: 'Mine',
  torpedo: 'Torpedo',
  nuke: 'Nuke',
};

export const ordnanceLabel = (o: Ordnance): string => `${KIND_NAME[o.kind]} ${o.id}`;

const okResult: CommandResult = { ok: true };

const reject = (state: GameState, reason: string): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: false, reason },
});

const no = (reason: string): { ok: boolean; reason?: string } => ({ ok: false, reason });
const yes: { ok: boolean; reason?: string } = { ok: true };

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// ---------------------------------------------------------------------------
// Side table: which ship launched which item
// ---------------------------------------------------------------------------

/**
 * `Ordnance` records its owner but not its launcher, and the mine rule needs the
 * launcher ("That ship must execute an immediate course change..."). It lives in
 * `scenarioData` alongside the movement and combat modules' own bookkeeping
 * rather than widening the shared `Ordnance` shape.
 */
export const ORDNANCE_DATA_KEY = '_ordnance';

export interface OrdnanceData {
  readonly launchedBy: Readonly<Record<OrdnanceId, ShipId>>;
}

const EMPTY_DATA: OrdnanceData = { launchedBy: {} };

export const ordnanceData = (state: GameState): OrdnanceData => {
  const raw = state.scenarioData[ORDNANCE_DATA_KEY] as Partial<OrdnanceData> | undefined;
  return raw ? { ...EMPTY_DATA, ...raw } : EMPTY_DATA;
};

const withOrdnanceData = (state: GameState, data: OrdnanceData): GameState => ({
  ...state,
  scenarioData: { ...state.scenarioData, [ORDNANCE_DATA_KEY]: data },
});

/** The ship that launched this item, if it is still on record. */
export const launcherOf = (state: GameState, id: OrdnanceId): ShipId | undefined =>
  ordnanceData(state).launchedBy[id];

const rememberLauncher = (state: GameState, id: OrdnanceId, ship: ShipId): GameState =>
  withOrdnanceData(state, { launchedBy: { ...ordnanceData(state).launchedBy, [id]: ship } });

const forgetLauncher = (state: GameState, id: OrdnanceId): GameState => {
  const data = ordnanceData(state);
  if (!(id in data.launchedBy)) return state;
  const next = { ...data.launchedBy };
  delete next[id];
  return withOrdnanceData(state, { launchedBy: next });
};

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

/**
 * "Ships belonging to a player who owns the base at Clandestine automatically
 * have scanners... The mines and torpedoes of Clandestine's owner are unaffected
 * by the special asteroids."
 */
const ownsClandestine = (state: GameState, player: PlayerId): boolean => {
  const base = state.bases['clandestine'];
  if (!base || base.destroyed || base.owner === null) return false;
  return areAllied(state, base.owner, player);
};

/** An asteroid or orbital base standing in a hex (planetary bases sit on hexsides). */
const baseInHex = (state: GameState, h: Hex) =>
  Object.values(state.bases).find((b) => b.side === undefined && !b.destroyed && eq(b.hex, h));

const baseOnSide = (state: GameState, side: HexSide) => {
  const k = sideKey(side);
  return Object.values(state.bases).find(
    (b) => b.side !== undefined && !b.destroyed && sideKey(b.side) === k,
  );
};

/**
 * Is this ship parked at a base? "Ordnance may not be launched while the ship is
 * at a base, refueling (including transferring fuel between ships in space), or
 * taking off from or landing on a planet."
 *
 * An orbital base is exempt from its own restriction — it *is* the base, and the
 * rules give it a gun crew: "They are capable of launching one torpedo per turn."
 */
const atBase = (state: GameState, ship: Ship, map: GameMap): boolean => {
  if (ship.shipClass === 'orbitalBase') return false;
  if (ship.location.kind === 'landed') return true;
  const base = baseInHex(state, ship.pos);
  if (!base) return false;
  // "For asteroid bases, matching courses requires that the ship stop in the base
  // hex. For orbital bases, the ship must match courses with the base by being in
  // orbit and in the same hex."
  if (isZero(ship.velocity)) return true;
  return map.orbitOf(ship.pos, ship.velocity) !== undefined;
};

/**
 * "Once landed at a planetary base, a ship is immune from gunfire, mines,
 * torpedoes, and ramming, but not from nukes."
 */
const immuneTo = (ship: Ship, kind: OrdnanceKind): boolean =>
  kind !== 'nuke' && ship.location.kind === 'landed';

// ---------------------------------------------------------------------------
// Hold capacity
// ---------------------------------------------------------------------------

/** Tons of hold currently in use. "A ship may carry cargo whose total mass..." */
export const holdMassUsed = (ship: Ship): number =>
  ship.cargo.reduce((n, item) => n + item.quantity * CARGO[item.kind].mass, 0);

/**
 * May this ship take on `additional` more of `kind`?
 *
 * Two limits apply: raw hold capacity ("a carrying ship must have hold capacity
 * to carry it") and the nuke rule, "non-warships are restricted to carrying only
 * one nuke at a time."
 */
export function canCarryOrdnance(
  ship: Ship,
  kind: OrdnanceKind,
  additional = 1,
): { ok: boolean; reason?: string } {
  if (additional <= 0) return yes;
  const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
  const wanted = holdMassUsed(ship) + ORDNANCE_MASS[kind] * additional;
  if (wanted > capacity) {
    return no(
      `${shipLabel(ship)} has no hold capacity for ${additional} ${kind}(s) — ${wanted} of ${capacity} tons`,
    );
  }
  if (kind === 'nuke' && cargoCount(ship, 'nuke') + additional > nukeLimit(ship.shipClass)) {
    return no('non-warships may carry only one nuke at a time');
  }
  return yes;
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * May this ship launch one item of `kind` right now?
 *
 * A pure capability check: the caller owns phase and ownership validation.
 */
export function canLaunch(
  state: GameState,
  ship: Ship,
  kind: OrdnanceKind,
  map: GameMap,
): { ok: boolean; reason?: string } {
  if (ship.destroyed) return no(`${shipLabel(ship)} has been destroyed`);

  // "Nukes are available only if the scenario specifies."
  if (kind === 'nuke' && !state.options.nukesAllowed) {
    return no('nukes are not available in this scenario');
  }
  if (cargoCount(ship, kind) <= 0) return no(`${shipLabel(ship)} is carrying no ${kind}s`);

  // "Each ship may release only one item per turn (one mine, one torpedo, or one nuke)."
  if (ship.launchedOrdnanceThisTurn) {
    return no(`${shipLabel(ship)} has already launched ordnance this turn`);
  }

  // "Only warships may launch torpedoes." Mines and nukes need only the hold:
  // "Any ship with sufficient capacity to carry a mine may also launch it."
  if (kind === 'torpedo' && !canLaunchTorpedoes(ship.shipClass)) {
    return no('only warships may launch torpedoes');
  }

  // A captured ship's prize crew "may not fire, or return fire if fired upon".
  if (ship.capturedBy !== undefined)
    return no(`${shipLabel(ship)} is a prize and may not launch ordnance`);

  // "Ships landed at planetary bases may not fire guns or launch ordnance."
  if (ship.location.kind === 'landed') return no(`${shipLabel(ship)} is landed`);

  // "Ordnance may not be launched while the ship is at a base, refueling
  // (including transferring fuel between ships in space), or taking off from or
  // landing on a planet."
  if (atBase(state, ship, map)) return no(`${shipLabel(ship)} is at a base`);
  if (ship.resuppliedThisTurn) {
    // "No ship may fire its guns or launch ordnance during a player-turn in which
    // it resupplies." The converse is the resupply module's job: a ship that has
    // launched (`launchedOrdnanceThisTurn`) may not then resupply.
    return no(`${shipLabel(ship)} is resupplying this turn`);
  }
  if (isTakingOffThisTurn(state, ship.id)) return no(`${shipLabel(ship)} is taking off`);
  if (isLandingThisTurn(state, ship.id)) return no(`${shipLabel(ship)} is landing`);

  // Advanced system: "A ship with any weapon damage cannot fire guns or drop
  // ordnance." The dreadnaught exception is worded "can still *fire*", i.e. guns
  // only; and "Weapon hits on civilian ships have no effect except to prevent
  // their launching mines" — so any weapon damage stops ordnance, universally.
  if (state.options.advancedCombat && ship.advancedDamage.weapon > 0) {
    return no(`${shipLabel(ship)} has weapon damage and may not launch ordnance`);
  }

  // "A disabled ship cannot maneuver, launch ordnance, or attack." One exception:
  // "An orbital base may launch torpedoes, fire guns, and resupply friendly ships
  // while the base itself is slightly (D1) damaged."
  if (ship.disabled > 0) {
    const orbitalException =
      ship.shipClass === 'orbitalBase' && ship.disabled <= 1 && kind === 'torpedo';
    if (!orbitalException) return no(`${shipLabel(ship)} is disabled`);
  }

  return yes;
}

/**
 * Every velocity a torpedo launched by this ship could be given.
 *
 * `aim` is the torpedo's **resulting velocity vector**, not the acceleration
 * delta — the torpedo inherits the launcher's vector and may then "accelerate one
 * or two hexes in any direction", so the legal set is every hex vector within two
 * steps of the launcher's velocity. The launcher's own velocity is included as
 * the "do not accelerate" option (the acceleration is permitted, not compulsory),
 * and is what an omitted `aim` means.
 *
 * Vectors whose resulting endpoint is off the chart are dropped: a torpedo fired
 * off the map is simply thrown away, so they are never worth offering.
 */
export function torpedoAimOptions(state: GameState, ship: Ship, map: GameMap): Hex[] {
  void state; // the option set depends only on the launcher and the chart
  const gravity = effectiveGravity(ship, map);
  const options = withinRadius(ship.velocity, TORPEDO_BOOST).filter((v) =>
    map.inBounds(add(add(ship.pos, v), gravity)),
  );
  return options.sort(
    (a, b) => distance(a, ship.velocity) - distance(b, ship.velocity) || a.q - b.q || a.r - b.r,
  );
}

/** The hexes those aim options put the torpedo in at the end of this turn. */
export function torpedoAimEndpoints(state: GameState, ship: Ship, map: GameMap): Hex[] {
  const gravity = effectiveGravity(ship, map);
  return torpedoAimOptions(state, ship, map).map((v) => add(add(ship.pos, v), gravity));
}

/**
 * Launch one item of ordnance.
 *
 * The item is created in the launcher's hex with the launcher's vector — "it
 * assumes the vector of its launching ship" — and inherits the gravity the
 * launcher picked up last turn, so that left alone the two fly the identical
 * course. That identity is the whole point of the follow-up rule: the launcher
 * must burn fuel to break away from its own mine.
 */
export function launchOrdnance(
  state: GameState,
  cmd: LaunchOrdnance,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  // "2. Ordnance Phase. Spaceships may declare that they are launching ordnance
  // (mines, torpedoes, nukes) during this phase."
  if (state.phase !== 'ordnance')
    return reject(state, 'ordnance is launched in the ordnance phase');
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your player-turn');

  const ship = state.ships[cmd.ship];
  if (!ship) return reject(state, `unknown ship ${cmd.ship}`);
  if (controllerOf(ship) !== cmd.by) return reject(state, 'that ship is not yours');

  const check = canLaunch(state, ship, cmd.kind, map);
  if (!check.ok) return reject(state, check.reason ?? 'that ship may not launch ordnance');

  let velocity = ship.velocity;
  if (cmd.aim !== undefined) {
    if (cmd.kind !== 'torpedo') {
      return reject(
        state,
        'only a torpedo may be aimed; mines and nukes take the launcher’s vector',
      );
    }
    const boost = distance(cmd.aim, ship.velocity);
    if (boost > TORPEDO_BOOST) {
      return reject(
        state,
        `a torpedo may accelerate at most ${TORPEDO_BOOST} hexes on its launch turn (this is ${boost})`,
      );
    }
    velocity = cmd.aim;
  }

  const id = `${ID_PREFIX[cmd.kind]}${state.nextOrdnanceId}`;
  const item: Ordnance = {
    id,
    owner: controllerOf(ship),
    kind: cmd.kind,
    pos: ship.pos,
    velocity,
    // "All are affected by gravity." The item starts co-located with its launcher
    // and therefore under the same pull the launcher accumulated last turn.
    pendingGravity: effectiveGravity(ship, map),
    turnsRemaining: ORDNANCE_LIFETIME,
    launchedTurn: state.turn,
    course: [],
    // Cleared the moment it moves: the boost is available "on the turn in which a
    // torpedo is launched (and only on that turn)".
    canAccelerate: cmd.kind === 'torpedo',
  };

  let s: GameState = {
    ...state,
    ordnance: { ...state.ordnance, [id]: item },
    nextOrdnanceId: state.nextOrdnanceId + 1,
  };
  s = rememberLauncher(s, id, ship.id);
  s = withShip(s, {
    ...addCargo(ship, cmd.kind, -1),
    launchedOrdnanceThisTurn: true,
  });
  s = log(s, `${shipLabel(ship)} launches ${ordnanceLabel(item)} at ${ship.pos.q},${ship.pos.r}.`, {
    severity: 'warn',
    focus: [ship.pos],
  });

  if (cmd.kind === 'mine' && mustAvoidOwnMine(s, s.ships[ship.id]!, map)) {
    // Advisory only — the plot layer enforces it via `mustAvoidOwnMine`.
    s = log(
      s,
      `${shipLabel(ship)} must change course: it would end the turn in the same hex as ${ordnanceLabel(item)}.`,
      { severity: 'warn', focus: [ship.pos] },
    );
  }
  return { state: s, result: okResult };
}

/**
 * May this base fire its torpedo right now?
 *
 * "The two bases in the asteroid belt (Ceres and Clandestine) are asteroid
 * bases... They are capable of launching one torpedo per turn." For an orbital
 * base: "It may fire one torpedo per turn, providing resupply operations are not
 * in progress."
 */
export function canLaunchBaseTorpedo(
  state: GameState,
  base: BaseState,
  player: PlayerId,
  map: GameMap,
): { ok: boolean; reason?: string } {
  // Planetary bases get planetary defences instead; the torpedo is named only
  // for asteroid and orbital bases.
  if (base.kind === 'planetary') return no('only asteroid and orbital bases launch torpedoes');
  if (base.destroyed) return no('that base has been destroyed');
  if (base.owner === null || !areAllied(state, base.owner, player)) {
    return no('that base is not yours');
  }
  if (base.launchedThisTurn) return no('that base has already launched a torpedo this turn');
  // The proviso belongs to the orbital base alone — "It may fire one torpedo per
  // turn, providing resupply operations are not in progress" — and is repeated
  // on p. 8: "An orbital base resupplying any ship may not fire its guns or
  // launch ordnance during that player-turn." Nothing of the kind is printed for
  // Ceres and Clandestine.
  if (base.kind === 'orbital' && base.resuppliedThisTurn) {
    return no('that base is resupplying this turn');
  }
  // A scenario may shut the magazine: "Torpedoes and mines are available only to
  // the Enforcers, but also only from Terran bases."
  const denied = ordnanceDeniedReason(state, base, player, map);
  if (denied) return no(denied);
  return yes;
}

/**
 * Every vector a base's torpedo could be given: "it may accelerate one or two
 * hexes in any direction", from a standing start, and not off the chart.
 */
export function baseTorpedoAimOptions(base: BaseState, map: GameMap): Hex[] {
  return withinRadius(ZERO, TORPEDO_BOOST)
    .filter((v) => !isZero(v) && map.inBounds(add(base.hex, v)))
    .sort((a, b) => distance(a, ZERO) - distance(b, ZERO) || a.q - b.q || a.r - b.r);
}

/**
 * Fire a base's own torpedo.
 *
 * A base draws on "an unlimited supply of fuel, mines, and torpedoes", so there
 * is no hold to debit, and it stands still, so the torpedo's whole vector comes
 * from the launch boost: "On the turn in which a torpedo is launched (and only
 * on that turn), it may accelerate one or two hexes in any direction."
 */
export function launchBaseTorpedo(
  state: GameState,
  cmd: LaunchBaseTorpedo,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  if (state.phase !== 'ordnance')
    return reject(state, 'ordnance is launched in the ordnance phase');
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your player-turn');

  const base = state.bases[cmd.base];
  if (!base) return reject(state, `unknown base ${cmd.base}`);
  const check = canLaunchBaseTorpedo(state, base, cmd.by, map);
  if (!check.ok) return reject(state, check.reason ?? 'that base may not launch a torpedo');

  const boost = distance(cmd.aim, ZERO);
  if (boost < 1 || boost > TORPEDO_BOOST) {
    return reject(
      state,
      `a torpedo may accelerate one or two hexes in any direction (this is ${boost})`,
    );
  }
  if (!map.inBounds(add(base.hex, cmd.aim))) return reject(state, 'that would send it off the map');

  const id = `${ID_PREFIX.torpedo}${state.nextOrdnanceId}`;
  const item: Ordnance = {
    id,
    owner: base.owner!,
    kind: 'torpedo',
    pos: base.hex,
    velocity: cmd.aim,
    // The base is a fixture, not a ship coasting in from somewhere: it has
    // entered no gravity hex, so the torpedo starts with no pull on it and
    // picks up whatever the hexes it enters this turn hand it.
    pendingGravity: ZERO,
    turnsRemaining: ORDNANCE_LIFETIME,
    launchedTurn: state.turn,
    course: [],
    canAccelerate: false,
  };

  let s: GameState = {
    ...state,
    ordnance: { ...state.ordnance, [id]: item },
    nextOrdnanceId: state.nextOrdnanceId + 1,
  };
  s = withBase(s, { ...base, launchedThisTurn: true });
  s = log(s, `${base.id} launches ${ordnanceLabel(item)} at ${base.hex.q},${base.hex.r}.`, {
    severity: 'warn',
    focus: [base.hex],
  });
  return { state: s, result: okResult };
}

/*
 * There is deliberately no command to scrap live ordnance.
 *
 * The rules give an item exactly two ways off the board: detonation, and
 * "Mines remain active for five turns, after which they self-destruct." An
 * at-will removal would dissolve the obligation the very next sentence imposes
 * — "That ship must execute an immediate course change to insure that it does
 * not remain in the same hex as the mine" — and would let a player walk a fleet
 * through its own minefield for free.
 */

// ---------------------------------------------------------------------------
// The launcher's obligation to break away from its own mine
// ---------------------------------------------------------------------------

/** Where an item of ordnance will be at the end of its next move. */
export function ordnanceEndpoint(o: Ordnance): Hex {
  return add(add(o.pos, o.velocity), o.pendingGravity);
}

/**
 * The mine this ship launched this turn that it is still riding along with, if
 * any, together with the hex the two would share.
 *
 * "When a mine is launched, it assumes the vector of its launching ship. That
 * ship must execute an immediate course change to insure that it does not remain
 * in the same hex as the mine."
 */
export function ownMineConflict(
  state: GameState,
  ship: Ship,
  map: GameMap = DEFAULT_MAP,
): { mine: Ordnance; hex: Hex } | null {
  if (ship.destroyed) return null;
  const launched = ordnanceData(state).launchedBy;
  const shipEnd = ship.plottedEndpoint ?? predictedEndpoint(state, ship, map);
  for (const id of Object.keys(state.ordnance).sort()) {
    const mine = state.ordnance[id];
    if (!mine || mine.kind !== 'mine') continue;
    if (mine.launchedTurn !== state.turn) continue;
    if (launched[id] !== ship.id) continue;
    const mineEnd = ordnanceEndpoint(mine);
    if (eq(mineEnd, shipEnd)) return { mine, hex: mineEnd };
  }
  return null;
}

/**
 * Predicate for the astrogation/movement layer: this ship's current plot is
 * illegal because it leaves the ship sharing a hex with a mine it just laid.
 */
export function mustAvoidOwnMine(
  state: GameState,
  ship: Ship,
  map: GameMap = DEFAULT_MAP,
): boolean {
  return ownMineConflict(state, ship, map) !== null;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

const discard = (state: GameState, id: OrdnanceId, verb: string): GameState => {
  const item = state.ordnance[id];
  if (!item) return state;
  let s = removeOrdnance(state, id);
  s = forgetLauncher(s, id);
  return log(s, `${ordnanceLabel(item)} ${verb}.`, { focus: [item.pos] });
};

/** Removal with no log line — used when a louder message is being written anyway. */
const drop = (state: GameState, id: OrdnanceId): GameState =>
  forgetLauncher(removeOrdnance(state, id), id);

// ---------------------------------------------------------------------------
// Damage plumbing
// ---------------------------------------------------------------------------

/** One roll of a non-gun damage column against one ship, basic or advanced. */
const applyOther = (
  state: GameState,
  kind: OtherAttackKind,
  roll: number,
  target: ShipId,
  cause: string,
): GameState => {
  if (state.options.advancedCombat) {
    return applyAdvancedHits(state, target, otherToHit(kind, roll), cause).state;
  }
  return applyDamage(state, target, otherDamage(kind, roll), cause);
};

/** Did this roll actually hurt the target? Used for the torpedo's single hit. */
const scored = (state: GameState, kind: OtherAttackKind, roll: number): boolean =>
  state.options.advancedCombat ? otherToHit(kind, roll) > 0 : otherDamage(kind, roll) !== null;

const destroyShip = (state: GameState, id: ShipId, cause: string): GameState =>
  applyDamage(state, id, 'E' as DamageResult, cause);

// ---------------------------------------------------------------------------
// Detonation
// ---------------------------------------------------------------------------

interface DetonationOptions {
  /** Human-readable trigger, for the log. */
  readonly reason: string;
  /**
   * True when the trigger destroys the item whatever the damage roll does — an
   * astral body, an asteroid field, another piece of ordnance. Only a torpedo
   * that was set off by ships alone can survive a soft trigger.
   */
  readonly hard: boolean;
  /** A ship whose course ran through the hex; it counts as present. */
  readonly triggeringShip?: ShipId;
  /**
   * Force the triggering ship onto the casualty list even though it is now
   * landed. A ship diving to a base was still in space when its course crossed
   * the mine, and "Once landed at a planetary base, a ship is immune" only from
   * the moment it is down.
   */
  readonly exposeTrigger?: boolean;
  /** Hex the item came from, used to work out which hexside a nuke devastates. */
  readonly from?: Hex;
  /** Cascade guard for nuke-inside-a-blast. */
  readonly depth?: number;
}

interface DetonationOutcome {
  readonly state: GameState;
  /** False only when a torpedo missed everything and flies on. */
  readonly consumed: boolean;
}

/** Everything that counts as standing in the hex when the fuse trips. */
const victimsIn = (
  state: GameState,
  at: Hex,
  kind: OrdnanceKind,
  opts: DetonationOptions,
): Ship[] => {
  const here = shipsInHex(state, at).filter((s) => !immuneTo(s, kind));
  const triggeringShip = opts.triggeringShip;
  if (triggeringShip !== undefined && !here.some((s) => s.id === triggeringShip)) {
    const mover = state.ships[triggeringShip];
    // The mover's course passed through the hex even though it did not stop there:
    // "At the instant of contact with a mine (during the movement phase), an
    // affected ship rolls one die."
    if (mover && !mover.destroyed && (opts.exposeTrigger === true || !immuneTo(mover, kind))) {
      here.push(mover);
    }
  }
  return here.sort(byId);
};

/**
 * Set off one item of ordnance in `at`.
 *
 * Returns `consumed: false` only for a torpedo that failed to hurt anything and
 * is therefore still flying.
 */
export function detonate(
  state: GameState,
  id: OrdnanceId,
  at: Hex,
  map: GameMap,
  opts: DetonationOptions,
): DetonationOutcome {
  const item = state.ordnance[id];
  if (!item) return { state, consumed: true };
  const depth = opts.depth ?? 0;

  // "A nuke explodes when it enters any hex containing a ship, base, asteroid,
  // mine, or torpedo, or when any of these things enter its own hex." A mine or
  // torpedo going off next to a nuke therefore sets the nuke off, and the nuke's
  // blast is what actually resolves.
  if (item.kind !== 'nuke' && depth < 2) {
    const nuke = ordnanceInHex(state, at).find((x) => x.id !== id && x.kind === 'nuke');
    if (nuke) {
      let s = drop(state, id);
      s = log(s, `${ordnanceLabel(item)} sets off ${ordnanceLabel(nuke)}.`, {
        severity: 'bad',
        focus: [at],
      });
      const blast = detonate(s, nuke.id, at, map, {
        reason: ordnanceLabel(item),
        hard: true,
        ...(opts.triggeringShip !== undefined ? { triggeringShip: opts.triggeringShip } : {}),
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        depth: depth + 1,
      });
      return { state: blast.state, consumed: true };
    }
  }

  // Clandestine's cordon: "Other mines and torpedoes entering those asteroids
  // detonate without harming ships."
  if (
    item.kind !== 'nuke' &&
    map.isDenseAsteroid(at, new Set(state.clearedAsteroids)) &&
    !ownsClandestine(state, item.owner)
  ) {
    return {
      state: discard(state, id, 'detonates harmlessly in the dense asteroids around Clandestine'),
      consumed: true,
    };
  }

  if (item.kind === 'nuke') return detonateNuke(state, item, at, map, opts);

  const cause = `${ordnanceLabel(item)} (${opts.reason})`;
  const victims = victimsIn(state, at, item.kind, opts);

  /**
   * "Mines, torpedoes, and nukes automatically destroy mines and are themselves
   * destroyed." Contact is mutual, so whatever was standing in the hex comes off
   * the board alongside the item that ran into it — otherwise a minefield would
   * be immune to being swept, and two mines dropped in one hex would leave a
   * survivor. Nukes are not swept here: one in the hex is set off above instead,
   * and its own blast clears everything.
   */
  const sweepStruck = (s0: GameState): GameState => {
    if (!opts.hard) return s0;
    let s1 = s0;
    for (const other of ordnanceInHex(s0, at).sort(byId)) {
      if (other.id === id || other.kind === 'nuke') continue;
      s1 = discard(
        s1,
        other.id,
        `is destroyed at ${at.q},${at.r} — contact with ${ordnanceLabel(item)}`,
      );
    }
    return s1;
  };

  if (item.kind === 'mine') {
    // "At the instant of contact with a mine (during the movement phase), an
    // affected ship rolls one die and consults the mine column of the damage
    // table. If more than one ship is in the hex affected by the mine, each ship
    // rolls separately for a mine result." No range or velocity modifiers exist
    // for mines — contact is contact.
    let s = state;
    s = log(s, `${ordnanceLabel(item)} detonates at ${at.q},${at.r} — ${opts.reason}.`, {
      severity: 'bad',
      focus: [at],
    });
    for (const victim of victims) {
      const current = s.ships[victim.id];
      if (!current || current.destroyed) continue;
      const roll = rollDie(s.rng);
      s = { ...s, rng: roll.state };
      s = applyOther(s, 'mine', roll.value, victim.id, cause);
    }
    return { state: sweepStruck(drop(s, id)), consumed: true };
  }

  // Torpedo. "A torpedo hits only a single target. In the event that there is
  // more than one ship in the affected hex, damage is rolled for each, in a
  // randomly chosen order, until one ship (only) is damaged or destroyed, or all
  // ships have been rolled for without damage resulting."
  const order = shuffle(
    state.rng,
    victims.map((v) => v.id),
  );
  let s: GameState = { ...state, rng: order.state };
  let hit = false;
  for (const victimId of order.items) {
    const current = s.ships[victimId];
    if (!current || current.destroyed) continue;
    const roll = rollDie(s.rng);
    s = { ...s, rng: roll.state };
    const damaged = scored(s, 'torpedo', roll.value);
    s = applyOther(s, 'torpedo', roll.value, victimId, cause);
    if (damaged) {
      hit = true;
      break;
    }
  }

  if (hit) {
    s = log(s, `${ordnanceLabel(item)} finds its target at ${at.q},${at.r}.`, {
      severity: 'bad',
      focus: [at],
    });
    return { state: sweepStruck(drop(s, id)), consumed: true };
  }
  if (opts.hard) {
    return {
      state: sweepStruck(discard(s, id, `is destroyed at ${at.q},${at.r} — ${opts.reason}`)),
      consumed: true,
    };
  }
  // "A torpedo which misses all targets continues on its path and may conceivably
  // find new targets."
  s = log(s, `${ordnanceLabel(item)} misses at ${at.q},${at.r} and runs on.`, { focus: [at] });
  return { state: s, consumed: false };
}

/**
 * Which hexside a nuke devastates.
 *
 * "If a nuke reaches a moon or planet without detonating against a target in the
 * hex, it devastates one entire hex side. If it is not clear which hex side has
 * been affected, the suffering player makes the choice." We resolve it
 * deterministically: the side the warhead came in over, i.e. the one facing the
 * hex the nuke occupied immediately before reaching the world. When the approach
 * vector does not land on a neighbour (a graze from further out), the closest of
 * the six directions by angle wins, which is the same answer a player eyeballing
 * the arrow would give.
 */
export function nukeDevastationSide(body: AstralBody, from: Hex): HexSide {
  const trace = traceSegment(from, body.hex).entered;
  const idx = trace.findIndex((h) => eq(h, body.hex));
  const previous = idx > 0 ? trace[idx - 1]! : from;

  const direct = directionTo(body.hex, previous);
  if (direct >= 0) return hexSide(body.hex, direct);

  const approach = toPlane(sub(previous, body.hex));
  let best = 0;
  let bestDot = -Infinity;
  for (let dir = 0; dir < 6; dir++) {
    const unit = toPlane(DIRECTIONS[dir]!);
    const dot = unit.x * approach.x + unit.y * approach.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = dir;
    }
  }
  return hexSide(body.hex, best);
}

const detonateNuke = (
  state: GameState,
  nuke: Ordnance,
  at: Hex,
  map: GameMap,
  opts: DetonationOptions,
): DetonationOutcome => {
  const cause = `${ordnanceLabel(nuke)} (${opts.reason})`;
  const body = map.bodyAt(at);
  // Take the nuke off the board first so it is not caught in its own blast.
  let s = drop(state, nuke.id);

  if (body && body.landing === 'hexside') {
    // A moon or a planet: the specific devastation rule replaces the general
    // "destroys everything in the hex".
    const side = nukeDevastationSide(body, opts.from ?? sub(at, nuke.velocity));
    const k = sideKey(side);
    s = log(s, `${ordnanceLabel(nuke)} strikes ${body.name} and devastates hexside ${side.dir}.`, {
      severity: 'bad',
      focus: [at],
    });
    if (!s.devastatedSides.includes(k)) {
      s = { ...s, devastatedSides: [...s.devastatedSides, k] };
    }
    // "Any ships on the planet which landed through that hex side, and any base on
    // that side, are destroyed."
    const base = baseOnSide(s, side);
    if (base) {
      s = withBase(s, { ...base, destroyed: true });
      s = log(s, `The base at ${base.id} is obliterated.`, { severity: 'bad', focus: [at] });
    }
    for (const ship of shipsInHex(s, at).sort(byId)) {
      const landedElsewhere = ship.location.kind === 'landed' && sideKey(ship.location.side) !== k;
      if (landedElsewhere) continue;
      s = destroyShip(s, ship.id, cause);
    }
    for (const other of ordnanceInHex(s, at).sort(byId)) {
      s = discard(s, other.id, `is destroyed by ${ordnanceLabel(nuke)}`);
    }
    return { state: s, consumed: true };
  }

  // Open space, an asteroid, or a base out in the black: "It destroys everything
  // in the hex automatically (an asteroid hex becomes clear space as a result)."
  s = log(s, `${ordnanceLabel(nuke)} detonates at ${at.q},${at.r} — ${opts.reason}.`, {
    severity: 'bad',
    focus: [at],
  });

  const caught = shipsInHex(s, at).map((x) => x.id);
  if (opts.triggeringShip !== undefined && !caught.includes(opts.triggeringShip)) {
    caught.push(opts.triggeringShip);
  }
  for (const shipId of caught.sort()) s = destroyShip(s, shipId, cause);

  // "mines, torpedoes, and nukes automatically destroy mines and are themselves
  // destroyed" — nothing survives the fireball.
  for (const other of ordnanceInHex(s, at).sort(byId)) {
    s = discard(s, other.id, `is destroyed by ${ordnanceLabel(nuke)}`);
  }

  const base = baseInHex(s, at);
  if (base) {
    // Asteroid bases "may not be harmed except by a nuke".
    s = withBase(s, { ...base, destroyed: true });
    s = log(s, `The base at ${base.id} is destroyed.`, { severity: 'bad', focus: [at] });
  }

  const cleared = new Set(s.clearedAsteroids);
  const isRock =
    map.isAsteroid(at, cleared) || (body !== undefined && body.kind === 'majorAsteroid');
  if (isRock && !cleared.has(key(at))) {
    s = { ...s, clearedAsteroids: [...s.clearedAsteroids, key(at)] };
    s = log(s, `The asteroids at ${at.q},${at.r} are blasted into clear space.`, {
      severity: 'warn',
      focus: [at],
    });
  }
  return { state: s, consumed: true };
};

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

interface TriggerInfo {
  readonly reason: string;
  readonly hard: boolean;
}

/**
 * Does this touch of `touch.hex` set the item off?
 *
 * "Mines, torpedoes, and nukes are detonated when they enter a hex containing a
 * ship, astral body, mine, torpedo, or nuke", with the nuke's list extended to
 * bases and asteroids and the mine's contact test widened to "any portion of the
 * hex".
 *
 * Astral bodies and asteroid fields are *entry* conditions — the rules say
 * "enter" and "entering", and "portions of astral body hexes not covered by the
 * printed disk are considered to be part of the adjacent gravity hexes" — so a
 * vertex graze past a planet is not a collision. Ships and ordnance use the wider
 * "any portion" test.
 */
const triggerAt = (
  state: GameState,
  item: Ordnance,
  touch: Touch,
  map: GameMap,
): TriggerInfo | null => {
  const h = touch.hex;
  const entered = touch.mode === 'interior';
  const cleared = new Set(state.clearedAsteroids);

  if (entered) {
    const body = map.bodyAt(h);
    if (body) return { reason: `strikes ${body.name}`, hard: true };

    if (map.isAsteroid(h, cleared)) {
      // "Mines and torpedoes detonate upon entering an asteroid hex. A nuke
      // detonating in any asteroid hex converts the hex to clear space."
      const exempt =
        item.kind !== 'nuke' &&
        map.isDenseAsteroid(h, cleared) &&
        ownsClandestine(state, item.owner);
      if (!exempt) return { reason: 'the asteroids', hard: true };
    }
  }

  // "mines, torpedoes, and nukes automatically destroy mines and are themselves
  // destroyed."
  const others = ordnanceInHex(state, h)
    .filter((x) => x.id !== item.id)
    .sort(byId);
  const other = others[0];
  if (other) return { reason: `contact with ${ordnanceLabel(other)}`, hard: true };

  if (item.kind === 'nuke') {
    const base = baseInHex(state, h);
    if (base) return { reason: `the base at ${base.id}`, hard: true };
  }

  const ships = shipsInHex(state, h).filter((s) => !immuneTo(s, item.kind));
  if (ships.length > 0) {
    // Ordnance is indiscriminate: the rules say "a hex containing a ship", with no
    // friend-or-foe test. That is exactly why a launcher has to steer clear of its
    // own mine.
    return { reason: 'contact with a ship', hard: item.kind !== 'torpedo' };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Ordnance movement
// ---------------------------------------------------------------------------

/**
 * Gravity picked up by one leg. Identical to the ship rule — "Gravity takes
 * effect on the turn after an object enters the gravity hex", counting the hexes
 * entered this turn but not the one the leg started in, and pulling on a
 * stationary object every turn it sits still.
 *
 * Weak gravity's opt-out ("A ship passing through one weak gravity hex may ignore
 * it or use it, as the player chooses") is a *piloting* decision: a mine has no
 * pilot and a torpedo's drive is spent, so unmanned ordnance always takes the
 * pull.
 */
const ordnanceGravity = (from: Hex, to: Hex, map: GameMap): Hex => {
  const entered = eq(from, to) ? [to] : traceSegment(from, to).entered.filter((h) => !eq(h, from));
  const { mandatory, optional } = map.accumulateGravity(entered);
  let g = mandatory;
  for (const h of optional) g = add(g, map.weakGravityArrow(h));
  return g;
};

const moveOneItem = (state: GameState, id: OrdnanceId, map: GameMap): GameState => {
  const start = state.ordnance[id];
  if (!start) return state;

  const from = start.pos;
  const to = ordnanceEndpoint(start);
  const trace = traceSegment(from, to);
  const stationary = eq(from, to);

  let s = state;
  for (const touch of trace.touched) {
    // The tail hex is not re-tested; see the module header.
    if (!stationary && eq(touch.hex, from)) continue;
    const current = s.ordnance[id];
    if (!current) return s;
    const trigger = triggerAt(s, current, touch, map);
    if (!trigger) continue;
    const outcome = detonate(s, id, touch.hex, map, {
      reason: trigger.reason,
      hard: trigger.hard,
      from,
    });
    s = outcome.state;
    if (outcome.consumed) return s;
  }

  const survivor = s.ordnance[id];
  if (!survivor) return s;

  // "Any ship whose final course places it off the map is considered eliminated" —
  // unguided ordnance simply drifts away and stops being anyone's problem.
  if (!map.inBounds(to)) {
    return discard(s, id, `drifts off the map at ${to.q},${to.r}`);
  }

  const leg: CourseLeg = { turn: s.turn, from, to, accel: 0 };
  s = withOrdnance(s, {
    ...survivor,
    pos: to,
    velocity: sub(to, from),
    pendingGravity: ordnanceGravity(from, to, map),
    course: [...survivor.course, leg],
    // The launch-turn boost is spent the moment the torpedo flies.
    canAccelerate: false,
  });
  if (!stationary) {
    s = log(s, `${ordnanceLabel(survivor)} runs to ${to.q},${to.r}.`, { focus: [from, to] });
  }
  return s;
};

/**
 * Move every item of ordnance belonging to the phasing player.
 *
 * "Mines, torpedoes, and nukes launched by the phasing player (on this or
 * previous turns) also move at this time. If ordnance encounters a target, it
 * explodes during this phase."
 *
 * Call this *after* `executeMovementPhase`: see the module header.
 */
export function moveOrdnancePhase(state: GameState, map: GameMap): GameState {
  const player = activePlayer(state);
  let s = state;
  // A stable order keeps the die rolls reproducible across replays.
  for (const id of Object.keys(state.ordnance).sort()) {
    const item = s.ordnance[id];
    if (!item) continue;
    // "...launched by the phasing player (on this or previous turns)." An ally's
    // ordnance moves on the ally's own player-turn, not on this one.
    if (item.owner !== player) continue;
    s = moveOneItem(s, id, map);
  }
  return s;
}

/**
 * Check a ship's course against every piece of ordnance on the board.
 *
 * The other half of the contact rule: "A mine detonates when the course of a ship
 * (or ordnance) passes through any portion of the hex occupied by the mine." The
 * movement layer calls this once per ship, after that ship has flown its leg,
 * passing the leg it flew.
 */
export function checkOrdnanceAgainstCourse(
  state: GameState,
  shipId: ShipId,
  from: Hex,
  to: Hex,
  map: GameMap,
): GameState {
  const ship = state.ships[shipId];
  if (!ship || ship.destroyed) return state;

  const trace = traceSegment(from, to);
  const stationary = eq(from, to);

  // Earliest point along the leg at which each hex is touched, so encounters are
  // resolved in the order the ship actually meets them.
  const touchedAt = new Map<string, number>();
  for (const touch of trace.touched) {
    if (!stationary && eq(touch.hex, from)) continue;
    const k = key(touch.hex);
    const seen = touchedAt.get(k);
    if (seen === undefined || touch.t < seen) touchedAt.set(k, touch.t);
  }

  const encounters = Object.values(state.ordnance)
    .map((o) => ({ id: o.id, t: touchedAt.get(key(o.pos)) }))
    .filter((e): e is { id: OrdnanceId; t: number } => e.t !== undefined)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

  let s = state;
  for (const encounter of encounters) {
    const current = s.ships[shipId];
    if (!current || current.destroyed) break;
    const item = s.ordnance[encounter.id];
    if (!item) continue;
    // "Once landed at a planetary base, a ship is immune from gunfire, mines,
    // torpedoes, and ramming, but not from nukes." The shelter only covers the
    // hex the ship came to rest in: contact made earlier along the same leg
    // happened while the ship was still in space.
    const enRoute = !eq(item.pos, to);
    if (immuneTo(current, item.kind) && !enRoute) continue;
    s = detonate(s, encounter.id, item.pos, map, {
      reason: `contact with ${shipLabel(current)}`,
      hard: item.kind !== 'torpedo',
      triggeringShip: shipId,
      exposeTrigger: enRoute,
      from: item.pos,
    }).state;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

/**
 * Count one turn off every item belonging to `owner`, scrapping the expired.
 *
 * "Mines remain active for five turns, after which they self-destruct." Called at
 * the end of that player's player-turn, so an item launched on turn N is gone
 * after it has moved on turn N+4.
 */
export function ageOrdnance(state: GameState, owner: PlayerId): GameState {
  let s = state;
  for (const id of Object.keys(state.ordnance).sort()) {
    const item = s.ordnance[id];
    if (!item || item.owner !== owner) continue;
    const left = item.turnsRemaining - 1;
    if (left <= 0) {
      s = discard(s, id, 'self-destructs after five turns');
    } else {
      s = withOrdnance(s, { ...item, turnsRemaining: left });
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Shooting at a nuke
// ---------------------------------------------------------------------------

/**
 * "Guns and planetary defenses have no effect on mines" — and a torpedo "is
 * treated as a mine, except" for a list that does not restore vulnerability to
 * gunfire, so only nukes can be shot down.
 */
export const attackableByGuns = (item: Ordnance): boolean => item.kind === 'nuke';

interface NukeShot {
  readonly range: number;
  readonly relativeVelocity: number;
  readonly modifier: number;
}

const rollAtNuke = (
  state: GameState,
  nuke: Ordnance,
  shot: NukeShot,
  shooter: string,
): { state: GameState; destroyed: boolean; roll: number } => {
  const die = rollDie(state.rng);
  let s: GameState = { ...state, rng: die.state };
  const modified = die.value + shot.modifier;
  // "Guns and planetary defenses may attack nukes at odds of 2:1 (with
  // modifications for range and relative velocity). A 'disabled' nuke is
  // destroyed." Any result at all on the 2:1 column — D2 through E — kills it.
  const result = gunDamage(NUKE_TARGET_ODDS, modified);
  const destroyed = result !== null;

  s = log(
    s,
    `Fire at ${ordnanceLabel(nuke)} from ${shooter} at 2:1 — die ${die.value}${
      shot.modifier !== 0 ? ` ${shot.modifier > 0 ? '+' : ''}${shot.modifier}` : ''
    } (range ${shot.range}, relative velocity ${shot.relativeVelocity}): ${
      destroyed ? 'destroyed' : 'no effect'
    }.`,
    { severity: destroyed ? 'good' : 'warn', focus: [nuke.pos] },
  );
  if (destroyed) {
    // Shot down, not set off: "A 'disabled' nuke is destroyed" — the warhead is
    // wrecked, so nothing in its hex suffers.
    s = drop(s, nuke.id);
  }
  return { state: s, destroyed, roll: die.value };
};

/**
 * Gunfire against a nuke.
 *
 * The odds are fixed at 2:1 no matter how many guns are pooled, so extra
 * attackers buy nothing but the greatest — that is, the worst — range and
 * velocity penalties, exactly as "In any combat with multiple targets or
 * attackers, use the greatest possible penalties" requires. Firing still costs
 * each ship its shot for the phase: "No ship may attack or be attacked more than
 * once per combat phase."
 */
export function attackNuke(
  state: GameState,
  attackers: readonly ShipId[],
  nuke: OrdnanceId,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  if (state.phase !== 'combat') return reject(state, 'guns are fired during the combat phase');

  const item = state.ordnance[nuke];
  if (!item) return reject(state, `unknown ordnance ${nuke}`);
  if (!attackableByGuns(item)) {
    return reject(state, 'guns and planetary defences have no effect on mines or torpedoes');
  }
  if (attackers.length === 0) return reject(state, 'no attacking ships were named');

  const ships: Ship[] = [];
  for (const id of attackers) {
    const ship = state.ships[id];
    if (!ship) return reject(state, `unknown ship ${id}`);
    if (ships.some((s) => s.id === ship.id))
      return reject(state, `${shipLabel(ship)} was listed twice`);
    if (!canFire(ship, state.options.advancedCombat)) {
      return reject(state, `${shipLabel(ship)} may not fire`);
    }
    if (ship.firedThisPhase) {
      return reject(state, `${shipLabel(ship)} has already fired this combat phase`);
    }
    ships.push(ship);
  }

  const side = ships[0]!.owner;
  for (const ship of ships) {
    if (!areAllied(state, side, ship.owner)) {
      return reject(state, 'attacking ships must belong to the same side');
    }
    // "Only ships of the phasing player may initiate attacks."
    if (!areAllied(state, activePlayer(state), ship.owner)) {
      return reject(state, 'only the phasing player may initiate attacks');
    }
    // "Attacks may be made 'through' other ships, ordnance, and asteroids, but not
    // through moons, planets, or Sol."
    const blocker = map.lineOfSightBlockedBy(ship.pos, item.pos);
    if (blocker) return reject(state, `${blocker.name} blocks the line of fire`);
  }

  // "This range is always measured from the attacker's closest approach to the
  // target's final position", taking the greatest over all attackers.
  let range = 0;
  let relativeVelocity = 0;
  for (const ship of ships) {
    range = Math.max(range, closestApproach(shipPath(state, ship), item.pos));
    relativeVelocity = Math.max(relativeVelocity, distance(ship.velocity, item.velocity));
  }
  // "Heroic ships always add +1 to the die roll for gun combat when attacking."
  const heroic = ships.some((s) => s.heroic);
  const modifier = rangeModifier(range) + velocityModifier(relativeVelocity) + (heroic ? 1 : 0);

  let s = state;
  for (const ship of ships) s = withShip(s, { ...s.ships[ship.id]!, firedThisPhase: true });

  const names = ships.map(shipLabel).join(', ');
  const shot = rollAtNuke(s, item, { range, relativeVelocity, modifier }, names);
  return { state: shot.state, result: okResult };
}

/**
 * A planetary base's defences shooting at a nuke.
 *
 * Planetary defences normally fire with "no modification for range or relative
 * velocity", but the nuke rule is the specific one and says "Guns and planetary
 * defenses may attack nukes at odds of 2:1 (with modifications for range and
 * relative velocity)" — so the modifiers do apply here. A base does not move, so
 * its closest approach is simply where it stands.
 */
export function firePlanetaryDefenceAtNuke(
  state: GameState,
  baseId: string,
  nuke: OrdnanceId,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  if (state.phase !== 'combat') return reject(state, 'planetary defences fire in the combat phase');

  const base = state.bases[baseId];
  if (!base) return reject(state, `unknown base ${baseId}`);
  if (base.kind !== 'planetary' || !base.side) {
    return reject(state, 'only planetary bases have planetary defences');
  }
  if (base.destroyed) return reject(state, 'that base has been destroyed');
  if (!base.hasPlanetaryDefences) return reject(state, 'that base has no planetary defences');
  if (base.firedThisTurn) return reject(state, 'that base has already fired this turn');
  if (base.owner === null || !areAllied(state, activePlayer(state), base.owner)) {
    return reject(state, 'that base is not yours');
  }

  const item = state.ordnance[nuke];
  if (!item) return reject(state, `unknown ordnance ${nuke}`);
  if (!attackableByGuns(item)) {
    return reject(state, 'planetary defences have no effect on mines or torpedoes');
  }

  // "Planetary bases may fire at enemy ships in the gravity hex directly above the
  // base's hex side" — the same envelope applies to a nuke coming down on them.
  const above = sideGravityHex(base.side);
  if (!eq(item.pos, above)) {
    return reject(state, 'that nuke is not in the gravity hex above the base');
  }
  const blocker = map.lineOfSightBlockedBy(base.hex, item.pos);
  if (blocker) return reject(state, `${blocker.name} blocks the line of fire`);

  const range = distance(base.hex, item.pos);
  const relativeVelocity = distance(ZERO, item.velocity);
  const modifier = rangeModifier(range) + velocityModifier(relativeVelocity);

  let s = withBase(state, { ...base, firedThisTurn: true });
  const shot = rollAtNuke(
    s,
    item,
    { range, relativeVelocity, modifier },
    `Planetary defences at ${base.id}`,
  );
  s = shot.state;
  return { state: s, result: okResult };
}
