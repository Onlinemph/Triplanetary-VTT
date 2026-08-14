/**
 * Movement and astrogation.
 *
 * This module owns everything between "the player looks at the map" and "the
 * counters are in their new hexes": course prediction, plotting and fuel,
 * optional weak gravity, landing and takeoff, ramming declarations, and the
 * execution of the movement phase itself.
 *
 * ## The shape of a turn's movement
 *
 * The rulebook's basic law is short:
 *
 *   "A ship which is not accelerated by thrust or gravity will move as it did in
 *    the previous turn, in the same direction, and traveling an equal distance."
 *
 * so the *predicted* endpoint is simply
 *
 *     pos + velocity + gravity picked up last turn
 *
 * and the pilot may shift that endpoint one hex for one fuel point ("One fuel
 * point allows a ship to alter its predicted course by one hex in any
 * direction"), or two hexes for two, once, with an overload manoeuvre.
 *
 * Everything else — orbits, the fall back onto a planet after takeoff, the free
 * choice of orbital sense — falls out of that arithmetic rather than being
 * special-cased. See the derivation in `map.ts`.
 *
 * ## Where the per-turn intentions live
 *
 * Landing, takeoff and ramming are *declared* in one phase and *resolved* in the
 * movement phase, but `Ship` has no field for them and `types.ts` is a fixed
 * contract. They are therefore parked in `state.scenarioData.movement`, together
 * with the traced path of each ship's last leg (which combat needs for
 * "the attacker's closest approach"). The path is always recomputable — after a
 * move, `pos - velocity` is where the leg began — so nothing depends on it
 * surviving serialisation.
 */

import type {
  CommandResult,
  DeclareRam,
  Land,
  PlotCourse,
  SetOptionalGravity,
  TakeOff,
} from './commands.js';
import {
  type DamageResult,
  type OtherAttackKind,
  DESTRUCTION_THRESHOLD,
  hitLocation,
  otherDamage,
  otherToHit,
} from './crt.js';
import { traceSegment } from './geometry.js';
import {
  type Hex,
  type HexSide,
  add,
  distance,
  eq,
  isZero,
  key,
  ring,
  sideGravityHex,
  sideKey,
  sub,
} from './hex.js';
import type { GameMap } from './map.js';
import type { AstralBody } from './mapdata.js';
import { rollDie } from './rng.js';
import { SHIP_CLASSES, isCommercial } from './ships.js';
import { ZERO, cargoCount, log, withShip } from './state.js';
import {
  type CourseLeg,
  type GameState,
  type PlayerId,
  type Ship,
  type ShipId,
  type ShipLocation,
  activePlayer,
  areAllied,
} from './types.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One endpoint a ship could legally plot this turn, with its consequences. */
export interface PlotOption {
  readonly endpoint: Hex;
  /** Fuel points this endpoint costs: 0 to coast, 1 to steer, 2 to overload. */
  readonly accel: 0 | 1 | 2;
  /** Id of the astral body whose printed disc this course intersects, if any. */
  readonly crashesInto?: string;
  /** "Any ship whose final course places it off the map is considered eliminated." */
  readonly exitsMap: boolean;
  /** Asteroid hexes that will demand a hazard roll (speed > 1 only). */
  readonly asteroidHexes: Hex[];
  /** Length of the resulting course arrow — the ship's speed next turn. */
  readonly distance: number;
}

/** A non-mutating dry run of a plot, for the renderer's ghost arrow. */
export interface PlotPreview extends PlotOption {
  readonly legal: boolean;
  readonly reason?: string;
  /** The velocity vector this course would leave the ship with. */
  readonly velocity: Hex;
  /** Every hex the course enters, tail to head. */
  readonly path: readonly Hex[];
  readonly fuelAfter: number;
  /** Dense Clandestine asteroids on the path — fatal without scanners. */
  readonly denseAsteroids: readonly Hex[];
  /** Id of the body this course would leave the ship orbiting, if any. */
  readonly orbitBody?: string;
}

/** Per-turn movement bookkeeping that has nowhere to live on `Ship`. */
export interface MovementData {
  /** Ships committed to landing this turn, and the hexside they are landing on. */
  readonly landing: Readonly<Record<ShipId, HexSide>>;
  /** Ships committed to blasting off this turn. */
  readonly takeoff: readonly ShipId[];
  /** Ramming declarations: rammer id -> target id. */
  readonly rams: Readonly<Record<ShipId, ShipId>>;
  /** Hexes entered by each ship's most recent leg, tail to head. */
  readonly paths: Readonly<Record<ShipId, readonly Hex[]>>;
  /**
   * Turn on which each ship spent its movement phase standing still — mining
   * ("this takes place on the movement phase, instead of movement") or emplacing
   * equipment ("placement requires the miner's ship to stand still for one
   * turn"). Keyed by turn rather than cleared, so it can never leak into the
   * next day.
   */
  readonly standingStill: Readonly<Record<ShipId, number>>;
  /** Turn on which each ship last mined ore by hand: ".1 ton per turn." */
  readonly mined: Readonly<Record<ShipId, number>>;
}

const MOVEMENT_KEY = 'movement';

const EMPTY_MOVEMENT: MovementData = {
  landing: {},
  takeoff: [],
  rams: {},
  paths: {},
  standingStill: {},
  mined: {},
};

export const movementData = (state: GameState): MovementData => {
  const raw = state.scenarioData[MOVEMENT_KEY] as Partial<MovementData> | undefined;
  return raw ? { ...EMPTY_MOVEMENT, ...raw } : EMPTY_MOVEMENT;
};

const withMovementData = (state: GameState, patch: Partial<MovementData>): GameState => ({
  ...state,
  scenarioData: {
    ...state.scenarioData,
    [MOVEMENT_KEY]: { ...movementData(state), ...patch },
  },
});

/**
 * Has this ship already given its movement phase over to standing still?
 *
 * Mining "takes place on the movement phase, instead of movement", and dropping
 * an automated mine or robot guards "requires the miner's ship to stand still
 * for one turn". Both are recorded here so `plotCourse` can hold the ship to it.
 */
export const standingStillThisTurn = (state: GameState, id: ShipId): boolean =>
  movementData(state).standingStill[id] === state.turn;

/** Has this ship already taken its ".1 ton per turn" by hand this turn? */
export const minedThisTurn = (state: GameState, id: ShipId): boolean =>
  movementData(state).mined[id] === state.turn;

/** Record that a ship is spending this turn's movement phase standing still. */
export const commitToStandingStill = (state: GameState, id: ShipId, mining: boolean): GameState =>
  withMovementData(state, {
    standingStill: { ...movementData(state).standingStill, [id]: state.turn },
    ...(mining ? { mined: { ...movementData(state).mined, [id]: state.turn } } : {}),
  });

const SPACE: ShipLocation = { kind: 'space' };

const okResult: CommandResult = { ok: true };
const reject = (state: GameState, reason: string): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: false, reason },
});

// ---------------------------------------------------------------------------
// Small predicates
// ---------------------------------------------------------------------------

/**
 * Who flies this ship. "A captured ship must be returned to a base friendly to
 * the captor before it may be used for any other mission" — so until then the
 * captor, not the original owner, gives it orders.
 */
export const controllerOf = (ship: Ship): PlayerId => ship.capturedBy ?? ship.owner;

export const shipLabel = (ship: Ship): string =>
  ship.name ?? `${SHIP_CLASSES[ship.shipClass].name} ${ship.number}`;

/**
 * Is the drive usable at all? "A disabled ship cannot maneuver, launch ordnance,
 * or attack. It may only drift on its current course." The advanced system is
 * harsher still: "A ship with any drive damage cannot maneuver."
 */
const driveWorks = (state: GameState, ship: Ship): boolean => {
  if (ship.disabled > 0) return false;
  if (state.options.advancedCombat && ship.advancedDamage.drive > 0) return false;
  return true;
};

/** Can this ship change its course this turn? Landed ships must blast off first. */
export const canManeuver = (state: GameState, ship: Ship): boolean => {
  if (ship.destroyed) return false;
  if (ship.location.kind === 'landed') return false;
  return driveWorks(state, ship);
};

/**
 * "Warships may perform one overload maneuver between maintenance stopovers.
 * Overload allows expenditure of two fuel points in one turn... Commercial ships
 * (transports, packets, tankers, liners) may not perform the overload maneuver."
 */
export const canOverload = (state: GameState, ship: Ship): boolean => {
  if (!canManeuver(state, ship)) return false;
  if (!ship.overloadAvailable) return false;
  if (isCommercial(ship.shipClass) || !SHIP_CLASSES[ship.shipClass].warship) return false;
  return ship.fuel >= 2;
};

/**
 * "Only ships possessing scanners may enter those hexes. Other ships are
 * destroyed... Ships belonging to a player who owns the base at Clandestine
 * automatically have scanners."
 */
export const hasScanners = (state: GameState, ship: Ship): boolean => {
  if (cargoCount(ship, 'scanners') > 0) return true;
  const clandestine = state.bases['clandestine'];
  if (clandestine && clandestine.owner && !clandestine.destroyed) {
    return areAllied(state, clandestine.owner, controllerOf(ship));
  }
  return false;
};

/** Is a base friendly to this player? Unclaimed bases serve anyone. */
const baseIsFriendly = (state: GameState, baseId: string, player: PlayerId): boolean => {
  const base = state.bases[baseId];
  if (!base || base.destroyed) return false;
  return base.owner === null || areAllied(state, base.owner, player);
};

const baseAtSide = (state: GameState, side: HexSide) => {
  const k = sideKey(side);
  return Object.values(state.bases).find((b) => b.side !== undefined && sideKey(b.side) === k);
};

/** An asteroid or orbital base sitting in a hex (planetary bases live on hexsides). */
const baseAtHex = (state: GameState, h: Hex) =>
  Object.values(state.bases).find((b) => b.side === undefined && eq(b.hex, h));

// ---------------------------------------------------------------------------
// Course prediction
// ---------------------------------------------------------------------------

/**
 * The gravity actually acting on this turn's course: everything mandatory that
 * was picked up last turn, plus whichever weak-gravity hexes the pilot accepted.
 *
 * "A ship passing through one weak gravity hex may ignore it or use it, as the
 * player chooses."
 */
export const effectiveGravity = (ship: Ship, map: GameMap): Hex => {
  let g = ship.pendingGravity;
  if (ship.optionalGravity.length === 0) return g;
  const accepted = new Set(ship.acceptedOptionalGravity);
  for (const h of ship.optionalGravity) {
    if (accepted.has(key(h))) g = add(g, map.weakGravityArrow(h));
  }
  return g;
};

/**
 * Where the ship goes if it burns no fuel: "the ship would normally move to C,
 * except for the effects of the gravity hexes entered last turn."
 */
export const predictedEndpoint = (state: GameState, ship: Ship, map: GameMap): Hex => {
  void state;
  return add(add(ship.pos, ship.velocity), effectiveGravity(ship, map));
};

/** The predicted course arrow, tail to head. */
export const predictedCourse = (
  state: GameState,
  ship: Ship,
  map: GameMap,
): { from: Hex; to: Hex } => ({
  from: ship.pos,
  to: predictedEndpoint(state, ship, map),
});

/**
 * The body a course crashes into, if any.
 *
 * "If a ship's course vector intersects the printed outline of an astral body,
 * it has crashed." Two exemptions, both from p. 4: a ship "specifically landing"
 * is not crashing, and "Ships may land at Ceres and Clandestine, or at any
 * unnamed asteroid in the Belt, by simply stopping in the hex" — an arrowhead
 * that comes to rest in a major asteroid's hex is a landing approach, not a
 * collision, otherwise no ship could ever reach those bases at all.
 */
const crashBody = (
  map: GameMap,
  from: Hex,
  to: Hex,
  landingBodyId?: string,
): AstralBody | undefined => {
  const body = map.crashedInto(from, to);
  if (!body) return undefined;
  if (landingBodyId !== undefined && body.id === landingBodyId) return undefined;
  if (body.landing === 'stop' && eq(to, body.hex)) return undefined;
  return body;
};

/** Dense Clandestine asteroids a course would enter. Fatal without scanners. */
export const denseAsteroidsOnCourse = (
  state: GameState,
  map: GameMap,
  from: Hex,
  to: Hex,
): Hex[] => {
  const cleared = new Set(state.clearedAsteroids);
  return traceSegment(from, to).entered.filter((h) => map.isDenseAsteroid(h, cleared));
};

const describeOption = (
  state: GameState,
  ship: Ship,
  endpoint: Hex,
  accel: 0 | 1 | 2,
  map: GameMap,
): PlotOption => {
  const from = ship.pos;
  const body = crashBody(map, from, endpoint);
  const cleared = new Set(state.clearedAsteroids);
  return {
    endpoint,
    accel,
    ...(body ? { crashesInto: body.id } : {}),
    exitsMap: !map.inBounds(endpoint),
    asteroidHexes: map.asteroidHazards(from, endpoint, cleared),
    distance: distance(from, endpoint),
  };
};

/**
 * Give back the fuel (and the overload) committed to an existing plot, so a
 * player may re-plot freely during the astrogation phase.
 */
const clearPlot = (ship: Ship): Ship => {
  if (ship.plottedEndpoint === undefined && ship.plottedAccel === 0) return ship;
  return {
    ...ship,
    plottedEndpoint: undefined,
    plottedAccel: 0,
    fuel: ship.fuel + ship.plottedAccel,
    overloadAvailable: ship.plottedAccel === 2 ? true : ship.overloadAvailable,
  };
};

/**
 * Every endpoint the ship could plot this turn.
 *
 * Fatal options (crashes, map exits) are *included* and flagged rather than
 * filtered: the rules let a pilot fly into a planet, and the UI only has to warn
 * (`options.confirmFatalPlots`).
 */
export const reachableEndpoints = (
  state: GameState,
  original: Ship,
  map: GameMap,
): PlotOption[] => {
  if (original.destroyed) return [];
  // "It must take off from the hex side where it landed" — a landed ship has no
  // course to plot until it uses its boosters.
  if (original.location.kind === 'landed') return [];

  // Any course already plotted this turn is refundable, so the options offered
  // are those of a ship that has not yet spent anything.
  const ship = clearPlot(original);
  const base = predictedEndpoint(state, ship, map);
  const out: PlotOption[] = [describeOption(state, ship, base, 0, map)];

  if (canManeuver(state, ship) && ship.fuel >= 1) {
    for (const h of ring(base, 1)) out.push(describeOption(state, ship, h, 1, map));
  }
  if (canOverload(state, ship)) {
    for (const h of ring(base, 2)) out.push(describeOption(state, ship, h, 2, map));
  }
  return out;
};

// ---------------------------------------------------------------------------
// Plotting
// ---------------------------------------------------------------------------

interface PlotCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly accel: 0 | 1 | 2;
  /** The ship with any previous plot refunded — the basis for the new plot. */
  readonly ship: Ship;
  readonly base: Hex;
}

const checkPlot = (
  state: GameState,
  original: Ship,
  endpoint: Hex,
  map: GameMap,
  overload: boolean,
): PlotCheck => {
  const ship = clearPlot(original);
  const base = predictedEndpoint(state, ship, map);
  const d = distance(base, endpoint);
  const fail = (reason: string): PlotCheck => ({
    ok: false,
    reason,
    accel: 0,
    ship,
    base,
  });

  if (ship.destroyed) return fail(`${shipLabel(ship)} has been destroyed`);
  if (ship.location.kind === 'landed') {
    return fail(`${shipLabel(ship)} is landed and must take off first`);
  }
  // Mining "takes place on the movement phase, instead of movement", and
  // emplacing equipment "requires the miner's ship to stand still for one turn":
  // once the ship has done either, this turn's movement is spent.
  if (!eq(endpoint, ship.pos) && standingStillThisTurn(state, ship.id)) {
    return fail(`${shipLabel(ship)} must stand still for the turn it works this hex`);
  }
  if (d > 2) {
    return fail(
      `${endpoint.q},${endpoint.r} is ${d} hexes off the predicted course; a ship may alter its course by at most two hexes`,
    );
  }
  const accel = d as 0 | 1 | 2;
  if (accel > 0 && !canManeuver(state, ship)) {
    return fail(`${shipLabel(ship)} cannot maneuver and may only drift on its current course`);
  }
  if (accel === 2) {
    if (!overload) {
      return fail('a two-hex course change requires an overload maneuver');
    }
    if (isCommercial(ship.shipClass) || !SHIP_CLASSES[ship.shipClass].warship) {
      return fail('commercial ships may not perform the overload maneuver');
    }
    if (!ship.overloadAvailable) {
      return fail(
        `${shipLabel(ship)} has already overloaded; only one overload is allowed between maintenance stopovers`,
      );
    }
  }
  if (ship.fuel < accel) {
    return fail(`${shipLabel(ship)} has only ${ship.fuel} fuel point(s) remaining`);
  }
  return { ok: true, accel, ship, base };
};

/**
 * Preview a plot without touching the state — everything the renderer needs to
 * draw a ghost arrow and explain why it is or is not legal.
 */
export const previewPlot = (
  state: GameState,
  ship: Ship,
  endpoint: Hex,
  map: GameMap,
  overload = false,
): PlotPreview => {
  const check = checkPlot(state, ship, endpoint, map, overload);
  const option = describeOption(state, ship, endpoint, check.accel, map);
  const velocity = sub(endpoint, ship.pos);
  const orbit = map.orbitOf(endpoint, velocity);
  return {
    ...option,
    legal: check.ok,
    ...(check.reason ? { reason: check.reason } : {}),
    velocity,
    path: traceSegment(ship.pos, endpoint).entered,
    fuelAfter: check.ship.fuel - check.accel,
    denseAsteroids: denseAsteroidsOnCourse(state, map, ship.pos, endpoint),
    ...(orbit ? { orbitBody: orbit.id } : {}),
  };
};

/**
 * Shared gatekeeping for the astrogation commands.
 *
 * Courses are plotted in the astrogation phase, but the ordnance phase has to be
 * allowed too: "When a mine is launched, it assumes the vector of its launching
 * ship. That ship must execute an immediate course change to insure that it does
 * not remain in the same hex as the mine."
 */
const authorise = (
  state: GameState,
  shipId: ShipId,
  by: PlayerId,
  phases: readonly GameState['phase'][],
): { ship: Ship } | { reason: string } => {
  const ship = state.ships[shipId];
  if (!ship) return { reason: `no such ship: ${shipId}` };
  if (ship.destroyed) return { reason: `${shipLabel(ship)} has been destroyed` };
  if (!phases.includes(state.phase)) {
    return { reason: `that order belongs to the ${phases[0]} phase` };
  }
  if (by !== activePlayer(state)) return { reason: 'it is not your player-turn' };
  if (by !== controllerOf(ship)) return { reason: `${shipLabel(ship)} is not under your command` };
  return { ship };
};

/** Commit this turn's course, charging fuel. */
export const plotCourse = (
  state: GameState,
  cmd: PlotCourse,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  const auth = authorise(state, cmd.ship, cmd.by, ['astrogation', 'ordnance']);
  if ('reason' in auth) return reject(state, auth.reason);
  const ship = auth.ship;

  const md = movementData(state);
  if (md.landing[ship.id] !== undefined) {
    return reject(state, `${shipLabel(ship)} is committed to landing this turn`);
  }
  if (md.takeoff.includes(ship.id)) {
    return reject(state, `${shipLabel(ship)} is committed to taking off this turn`);
  }

  const check = checkPlot(state, ship, cmd.endpoint, map, cmd.overload === true);
  if (!check.ok) return reject(state, check.reason ?? 'illegal course');

  const next: Ship = {
    ...check.ship,
    plottedEndpoint: cmd.endpoint,
    plottedAccel: check.accel,
    fuel: check.ship.fuel - check.accel,
    // "Warships may perform one overload maneuver between maintenance stopovers."
    overloadAvailable: check.accel === 2 ? false : check.ship.overloadAvailable,
  };

  let s = withShip(state, next);
  const burn =
    check.accel === 0
      ? 'coasting'
      : check.accel === 1
        ? 'burning 1 fuel'
        : 'burning 2 fuel (overload)';
  s = log(s, `${shipLabel(ship)} plots a course to ${cmd.endpoint.q},${cmd.endpoint.r}, ${burn}.`, {
    focus: [ship.pos, cmd.endpoint],
  });

  // Warnings only — the rules permit a pilot to fly into a planet or off the map.
  const option = describeOption(state, ship, cmd.endpoint, check.accel, map);
  if (option.crashesInto) {
    const body = map.body(option.crashesInto);
    s = log(s, `Warning: that course intersects ${body?.name ?? option.crashesInto}.`, {
      severity: 'warn',
      focus: [cmd.endpoint],
    });
  }
  if (option.exitsMap) {
    s = log(s, 'Warning: that course ends off the map.', {
      severity: 'warn',
      focus: [cmd.endpoint],
    });
  }
  return { state: s, result: okResult };
};

/**
 * Accept or decline one optional weak-gravity effect.
 *
 * Doing so moves the predicted endpoint, so any course already plotted is
 * refunded and must be re-plotted from the new prediction.
 */
export const setOptionalGravity = (
  state: GameState,
  cmd: SetOptionalGravity,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  void map;
  const auth = authorise(state, cmd.ship, cmd.by, ['astrogation', 'ordnance']);
  if ('reason' in auth) return reject(state, auth.reason);
  const ship = auth.ship;

  if (!ship.optionalGravity.some((h) => eq(h, cmd.hex))) {
    return reject(
      state,
      `${cmd.hex.q},${cmd.hex.r} is not a weak gravity hex ${shipLabel(ship)} may decline this turn`,
    );
  }

  const k = key(cmd.hex);
  const already = ship.acceptedOptionalGravity.includes(k);
  if (already === cmd.accept) return { state, result: okResult };

  const accepted = cmd.accept
    ? [...ship.acceptedOptionalGravity, k]
    : ship.acceptedOptionalGravity.filter((x) => x !== k);

  const hadPlot = ship.plottedEndpoint !== undefined;
  const next: Ship = { ...clearPlot(ship), acceptedOptionalGravity: accepted };

  let s = withShip(state, next);
  s = log(
    s,
    `${shipLabel(ship)} ${cmd.accept ? 'accepts' : 'declines'} the weak gravity of ${cmd.hex.q},${cmd.hex.r}.`,
    { focus: [cmd.hex] },
  );
  if (hadPlot) {
    s = log(s, `${shipLabel(ship)}'s course was refunded and must be re-plotted.`, {
      severity: 'warn',
    });
  }
  return { state: s, result: okResult };
};

// ---------------------------------------------------------------------------
// Landing and takeoff
// ---------------------------------------------------------------------------

/**
 * Commit to a landing.
 *
 * "A ship may only land by expending one fuel point while in orbit. The ship
 * then moves to any hex side on the planet." The fuel is charged now; the ship
 * actually reaches the surface during the movement phase.
 */
export const land = (
  state: GameState,
  cmd: Land,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  const auth = authorise(state, cmd.ship, cmd.by, ['astrogation']);
  if ('reason' in auth) return reject(state, auth.reason);
  const ship = auth.ship;

  if (ship.location.kind !== 'space') {
    return reject(state, `${shipLabel(ship)} is already at a base`);
  }
  if (!driveWorks(state, ship)) {
    return reject(state, `${shipLabel(ship)} cannot maneuver and so cannot land`);
  }

  const body = map.bodyAt(cmd.side.hex);
  if (!body || body.landing !== 'hexside') {
    return reject(state, `${cmd.side.hex.q},${cmd.side.hex.r} is not a world with landing sites`);
  }

  // "A ship may only land by expending one fuel point while in orbit."
  const orbit = map.orbitOf(ship.pos, ship.velocity);
  if (!orbit || orbit.id !== body.id) {
    return reject(state, `${shipLabel(ship)} must be in orbit around ${body.name} to land`);
  }

  // "A ship may burn one fuel point per turn." Re-issuing `land` picks a
  // different hexside for the same landing, so the point charged by the earlier
  // command this turn comes back before the new one is taken — exactly as
  // `clearPlot` refunds a superseded course.
  const cleared = clearPlot(ship);
  const refunded = movementData(state).landing[ship.id]
    ? { ...cleared, fuel: cleared.fuel + 1 }
    : cleared;
  if (refunded.fuel < 1) {
    return reject(state, `${shipLabel(ship)} has no fuel left to land with`);
  }
  if (state.devastatedSides.includes(sideKey(cmd.side))) {
    return reject(state, `that hexside of ${body.name} has been devastated`);
  }

  const next: Ship = { ...refunded, fuel: refunded.fuel - 1 };
  let s = withShip(state, next);
  s = withMovementData(s, {
    landing: { ...movementData(s).landing, [ship.id]: cmd.side },
  });
  s = log(s, `${shipLabel(ship)} burns 1 fuel to land on ${body.name}.`, {
    focus: [ship.pos, body.hex],
  });

  // "It may take off in the next turn, provided that that hex side contained a
  // base." Landing on a bare hexside is legal, but strands the ship.
  const base = baseAtSide(state, cmd.side);
  if (!base || base.destroyed) {
    s = log(
      s,
      `Warning: there is no base on that hexside; ${shipLabel(ship)} cannot take off again.`,
      {
        severity: 'warn',
      },
    );
  }
  return { state: s, result: okResult };
};

/**
 * Commit to a takeoff.
 *
 * "Ships blast off using boosters, available only at friendly bases. Boosters
 * provide an acceleration of one hex from the world or satellite to an adjacent
 * hex. Thus, takeoff requires no fuel points."
 */
export const takeOff = (
  state: GameState,
  cmd: TakeOff,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  const auth = authorise(state, cmd.ship, cmd.by, ['astrogation']);
  if ('reason' in auth) return reject(state, auth.reason);
  const ship = auth.ship;

  if (ship.location.kind === 'asteroidBase') {
    // "They take off by accelerating out of the hex" — an ordinary plotted course.
    return reject(
      state,
      `${shipLabel(ship)} leaves an asteroid base by plotting a course out of the hex`,
    );
  }
  if (ship.location.kind !== 'landed') {
    return reject(state, `${shipLabel(ship)} is not landed`);
  }
  if (!driveWorks(state, ship)) {
    return reject(state, `${shipLabel(ship)} is disabled and cannot take off`);
  }

  const side = ship.location.side;
  const base = baseAtSide(state, side);
  if (!base || base.destroyed) {
    return reject(state, `${shipLabel(ship)} landed on a hexside with no base and cannot take off`);
  }
  if (!baseIsFriendly(state, base.id, controllerOf(ship))) {
    return reject(state, 'boosters are available only at friendly bases');
  }
  if (state.devastatedSides.includes(sideKey(side))) {
    return reject(state, 'that hexside has been devastated');
  }

  const body = map.bodyAt(side.hex);
  let s = withMovementData(state, {
    takeoff: [...movementData(state).takeoff, ship.id],
  });
  s = log(
    s,
    `${shipLabel(ship)} readies boosters to lift off from ${body?.name ?? 'the surface'}.`,
    {
      focus: [side.hex, sideGravityHex(side)],
    },
  );
  return { state: s, result: okResult };
};

// ---------------------------------------------------------------------------
// Ramming
// ---------------------------------------------------------------------------

/**
 * Does a course arrow pass through the *centre* of a hex?
 *
 * "The ramming ship's course must pass through the center of the hex occupied by
 * the target ship." Axial coordinates are an affine image of the plane, so
 * collinearity is exact integer arithmetic — no epsilon needed.
 */
export const courseThroughCentre = (from: Hex, to: Hex, h: Hex): boolean => {
  const d = sub(to, from);
  const e = sub(h, from);
  if (isZero(d)) return eq(from, h);
  if (d.q * e.r - d.r * e.q !== 0) return false;
  const t = d.q !== 0 ? e.q / d.q : e.r / d.r;
  return t >= 0 && t <= 1;
};

/** Declare a ramming attempt. Resolved during the movement phase. */
export const declareRam = (
  state: GameState,
  cmd: DeclareRam,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  const auth = authorise(state, cmd.ship, cmd.by, ['astrogation', 'ordnance', 'movement']);
  if ('reason' in auth) return reject(state, auth.reason);
  const ship = auth.ship;

  const target = state.ships[cmd.target];
  if (!target || target.destroyed) return reject(state, 'no such target');
  if (target.id === ship.id) return reject(state, 'a ship cannot ram itself');
  if (areAllied(state, controllerOf(ship), controllerOf(target))) {
    return reject(state, 'you may only attempt to ram an enemy ship');
  }
  // "Once landed at a planetary base, a ship is immune from gunfire, mines,
  // torpedoes, and ramming, but not from nukes."
  if (target.location.kind === 'landed') {
    return reject(state, `${shipLabel(target)} is landed and immune to ramming`);
  }
  if (!canManeuver(state, ship)) {
    return reject(state, `${shipLabel(ship)} cannot maneuver and so cannot ram`);
  }

  const to = ship.plottedEndpoint ?? predictedEndpoint(state, ship, map);
  if (!courseThroughCentre(ship.pos, to, target.pos)) {
    return reject(
      state,
      `${shipLabel(ship)}'s course does not pass through the center of ${target.pos.q},${target.pos.r}`,
    );
  }

  // "A ship may ram (or attempt to ram) only one target per turn" — a second
  // declaration before the movement phase replaces the first rather than adding.
  let s = withMovementData(state, {
    rams: { ...movementData(state).rams, [ship.id]: target.id },
  });
  s = log(s, `${shipLabel(ship)} declares a ramming attempt against ${shipLabel(target)}.`, {
    severity: 'warn',
    focus: [ship.pos, target.pos],
  });
  return { state: s, result: okResult };
};

// ---------------------------------------------------------------------------
// Damage application (hazards and rams only; gunnery lives in the combat module)
// ---------------------------------------------------------------------------

const destroyShip = (
  state: GameState,
  id: ShipId,
  cause: string,
  focus: readonly Hex[],
): GameState => {
  const ship = state.ships[id];
  if (!ship || ship.destroyed) return state;
  const s = withShip(state, { ...ship, destroyed: true, destroyedBy: cause });
  return log(s, `${shipLabel(ship)} is destroyed — ${cause}.`, {
    severity: 'bad',
    focus,
  });
};

/**
 * Apply a basic-system damage result.
 *
 * "Damage is cumulative; if a ship is already disabled, any new results are
 * added to its current period of disablement. If a ship ever reaches a condition
 * of D6 or greater, it is destroyed."
 */
const applyResult = (
  state: GameState,
  id: ShipId,
  result: DamageResult,
  cause: string,
  focus: readonly Hex[],
): GameState => {
  const ship = state.ships[id];
  if (!ship || ship.destroyed) return state;
  if (result === null) {
    return log(state, `${shipLabel(ship)} comes through ${cause} unharmed.`, {
      focus,
    });
  }
  if (result === 'E') return destroyShip(state, id, cause, focus);

  const disabled = ship.disabled + result;
  if (disabled >= DESTRUCTION_THRESHOLD) return destroyShip(state, id, cause, focus);
  const s = withShip(state, { ...ship, disabled });
  return log(s, `${shipLabel(ship)} is disabled for ${disabled} turn(s) by ${cause}.`, {
    severity: 'bad',
    focus,
  });
};

/** Advanced system: roll a location for every hit scored. */
const applyHits = (
  state: GameState,
  id: ShipId,
  hits: number,
  cause: string,
  focus: readonly Hex[],
): GameState => {
  const ship = state.ships[id];
  if (!ship || ship.destroyed) return state;
  if (hits <= 0) {
    return log(state, `${shipLabel(ship)} comes through ${cause} unharmed.`, {
      focus,
    });
  }

  let s = state;
  let dmg = ship.advancedDamage;
  for (let i = 0; i < hits; i++) {
    const roll = rollDie(s.rng);
    s = { ...s, rng: roll.state };
    const loc = hitLocation(roll.value);
    dmg = {
      weapon: dmg.weapon + loc.weapon,
      drive: dmg.drive + loc.drive,
      structure: dmg.structure + loc.structure,
    };
  }

  // "if structure reaches D6 or below, the ship explodes or falls apart, and is lost."
  if (dmg.structure >= DESTRUCTION_THRESHOLD) {
    s = withShip(s, { ...ship, advancedDamage: dmg });
    return destroyShip(s, id, cause, focus);
  }
  s = withShip(s, { ...ship, advancedDamage: dmg });
  return log(
    s,
    `${shipLabel(ship)} takes ${hits} hit(s) from ${cause} (weapon ${dmg.weapon}, drive ${dmg.drive}, structure ${dmg.structure}).`,
    { severity: 'bad', focus },
  );
};

/** One roll of a non-gun damage column, applied to every listed victim. */
const resolveOther = (
  state: GameState,
  kind: OtherAttackKind,
  modifiedRoll: number,
  victims: readonly ShipId[],
  cause: string,
  focus: readonly Hex[],
): GameState => {
  let s = state;
  if (s.options.advancedCombat) {
    const hits = otherToHit(kind, modifiedRoll);
    for (const v of victims) s = applyHits(s, v, hits, cause, focus);
    return s;
  }
  const result = otherDamage(kind, modifiedRoll);
  for (const v of victims) s = applyResult(s, v, result, cause, focus);
  return s;
};

// ---------------------------------------------------------------------------
// The movement phase
// ---------------------------------------------------------------------------

const recordPath = (state: GameState, id: ShipId, path: readonly Hex[]): GameState =>
  withMovementData(state, {
    paths: { ...movementData(state).paths, [id]: path },
  });

/**
 * Hexes entered by a ship's most recent leg — what combat needs for "the
 * attacker's closest approach".
 *
 * Falls back to recomputing the leg from `pos - velocity`, which is exactly
 * where the leg began, so this is correct even for a freshly deserialised state.
 */
export const shipPath = (state: GameState, ship: Ship): Hex[] => {
  const stored = movementData(state).paths[ship.id];
  if (stored && stored.length > 0) return [...stored];
  return traceSegment(sub(ship.pos, ship.velocity), ship.pos).entered;
};

export const isLandingThisTurn = (state: GameState, id: ShipId): boolean =>
  movementData(state).landing[id] !== undefined;

export const isTakingOffThisTurn = (state: GameState, id: ShipId): boolean =>
  movementData(state).takeoff.includes(id);

export const ramTarget = (state: GameState, id: ShipId): ShipId | undefined =>
  movementData(state).rams[id];

/**
 * Which hexes count as "entered" for gravity this turn.
 *
 * The hex a ship starts in was entered on a *previous* turn and its gravity has
 * already been paid: "Gravity takes effect on the turn after an object enters
 * the gravity hex." Figure 6 confirms this — the gravity of hex II, which the
 * ship is sitting in at the start of turn 2, is applied once, not twice.
 *
 * A ship that does not move at all is a different case: it never leaves the hex,
 * so the pull keeps acting on it. That is exactly the situation the takeoff rule
 * describes — "Unless fuel is spent on the next turn, the ship would fall back
 * to the planet and crash."
 */
const gravityHexesEntered = (from: Hex, to: Hex, entered: readonly Hex[]): Hex[] => {
  if (eq(from, to)) return [to];
  return entered.filter((h) => !eq(h, from));
};

/** Where a ship comes to rest: stopping in an asteroid hex is a landing. */
const locationAfter = (state: GameState, map: GameMap, to: Hex, velocity: Hex): ShipLocation => {
  if (!isZero(velocity)) return SPACE;
  // "Ships may land at Ceres and Clandestine, or at any unnamed asteroid in the
  // Belt, by simply stopping in the hex."
  const body = map.bodyAt(to);
  if (body && body.landing === 'stop') return { kind: 'asteroidBase', hex: to };
  if (map.isAsteroid(to, new Set(state.clearedAsteroids))) return { kind: 'asteroidBase', hex: to };
  return SPACE;
};

/**
 * "Once a ship has been detected by the enemy, it remains detected (regardless
 * of range) until it arrives at a friendly base." Arrival is a movement event,
 * so the detection flags are cleared here — but only when a friendly base is
 * actually there. Coming to rest on a bare belt rock hides nothing.
 */
const clearDetectionOnArrival = (
  state: GameState,
  ship: Ship,
  baseId: string | undefined,
): Ship => {
  if (ship.detectedBy.length === 0) return ship;
  if (baseId === undefined) return ship;
  // "Ships which reach Clandestine drop off the detectors of the opposing side" —
  // that base hides everyone, friend or not.
  if (baseId !== 'clandestine' && !baseIsFriendly(state, baseId, controllerOf(ship))) return ship;
  return { ...ship, detectedBy: [] };
};

const resolveTakeOff = (state: GameState, id: ShipId, map: GameMap): GameState => {
  const ship = state.ships[id]!;
  if (ship.location.kind !== 'landed') return state;
  const side = ship.location.side;
  const from = ship.pos;
  const to = sideGravityHex(side);

  // "The planetary surface gravity immediately cancels takeoff velocity, leaving
  // the ship stationary in the gravity hex immediately above the base." The
  // booster still counts as *entering* that gravity hex, so its pull is felt
  // next turn — which is why an unpowered ship falls back and crashes.
  const { mandatory, optional } = map.accumulateGravity([to]);
  const leg: CourseLeg = { turn: state.turn, from, to, accel: 0 };

  let s = withShip(state, {
    ...ship,
    pos: to,
    velocity: ZERO,
    pendingGravity: mandatory,
    optionalGravity: optional,
    acceptedOptionalGravity: [],
    location: SPACE,
    course: [...ship.course, leg],
    plottedEndpoint: undefined,
    plottedAccel: 0,
  });
  s = recordPath(s, id, [from, to]);
  const body = map.bodyAt(side.hex);
  s = log(
    s,
    `${shipLabel(ship)} lifts off from ${body?.name ?? 'the surface'} and hangs stationary above it.`,
    {
      focus: [from, to],
    },
  );
  return s;
};

const resolveLanding = (state: GameState, id: ShipId, side: HexSide, map: GameMap): GameState => {
  const ship = state.ships[id]!;
  const from = ship.pos;
  const to = side.hex;
  const body = map.bodyAt(to);

  // The fuel point was charged when the landing was declared.
  const leg: CourseLeg = { turn: state.turn, from, to, accel: 1 };
  const base = baseAtSide(state, side);
  const landed: Ship = clearDetectionOnArrival(
    state,
    {
      ...ship,
      pos: to,
      velocity: ZERO,
      pendingGravity: ZERO,
      optionalGravity: [],
      acceptedOptionalGravity: [],
      location: { kind: 'landed', side },
      course: [...ship.course, leg],
      plottedEndpoint: undefined,
      plottedAccel: 0,
    },
    base?.id,
  );

  let s = withShip(state, landed);
  s = recordPath(s, id, [from, to]);
  s = log(s, `${shipLabel(ship)} lands on ${body?.name ?? 'the surface'} at hexside ${side.dir}.`, {
    severity: 'good',
    focus: [from, to],
  });
  return s;
};

/**
 * "A die is rolled for each asteroid hex entered and the asteroid column of the
 * damage table is consulted."
 *
 * The rulebook books the *effects* of astrogation hazards into the combat phase
 * ("If astrogation hazards were encountered during the movement phase, their
 * effects are rolled for during this phase"), but nothing between the two phases
 * observes the difference, and resolving them here keeps a ship's fate settled
 * before rams are worked out. `map.asteroidHazards` already enforces "at a speed
 * greater than one hex per turn" and the shared-hexside case.
 */
const rollAsteroidHazards = (
  state: GameState,
  id: ShipId,
  from: Hex,
  to: Hex,
  map: GameMap,
): GameState => {
  const cleared = new Set(state.clearedAsteroids);
  const hazards = map.asteroidHazards(from, to, cleared);
  let s = state;
  for (const h of hazards) {
    const cur = s.ships[id];
    if (!cur || cur.destroyed) break;
    const roll = rollDie(s.rng);
    s = { ...s, rng: roll.state };
    s = resolveOther(s, 'asteroid', roll.value, [id], `the asteroids at ${h.q},${h.r}`, [h]);
  }
  return s;
};

const moveShip = (state: GameState, id: ShipId, map: GameMap): GameState => {
  const ship = state.ships[id]!;
  const md = movementData(state);

  if (md.takeoff.includes(id)) return resolveTakeOff(state, id, map);
  const landingSide = md.landing[id];
  if (landingSide) return resolveLanding(state, id, landingSide, map);
  // Landed ships do not move.
  if (ship.location.kind === 'landed') return state;

  const from = ship.pos;
  const plotted = ship.plottedEndpoint;
  const to = plotted ?? predictedEndpoint(state, ship, map);
  const accel = plotted ? ship.plottedAccel : 0;
  const velocity = sub(to, from);
  const trace = traceSegment(from, to);

  // 1. Crashes. "If a ship's course vector intersects the printed outline of an
  //    astral body, it has crashed. The ship is eliminated."
  const crash = crashBody(map, from, to);
  // 2. Leaving the map. "The initial projected course may leave the map, but the
  //    final head of the course arrow must be on the map at the end of the turn."
  const exits = !map.inBounds(to);
  // Clandestine's cordon: "Only ships possessing scanners may enter those hexes.
  // Other ships are destroyed."
  const dense = trace.entered.filter((h) =>
    map.isDenseAsteroid(h, new Set(state.clearedAsteroids)),
  );
  const blindInDense = dense.length > 0 && !hasScanners(state, ship);

  const cause = crash
    ? `crashed into ${crash.name}`
    : exits
      ? 'left the map'
      : blindInDense
        ? 'lost in the dense asteroids around Clandestine'
        : undefined;

  const leg: CourseLeg = {
    turn: state.turn,
    from,
    to,
    accel,
    ...(cause ? { terminal: true } : {}),
  };

  const moved: Ship = {
    ...ship,
    pos: to,
    velocity,
    course: [...ship.course, leg],
    plottedEndpoint: undefined,
    plottedAccel: 0,
    acceptedOptionalGravity: [],
  };

  if (cause) {
    let s = withShip(state, {
      ...moved,
      pendingGravity: ZERO,
      optionalGravity: [],
      destroyed: true,
      destroyedBy: cause,
    });
    s = recordPath(s, id, trace.entered);
    return log(s, `${shipLabel(ship)} is lost — ${cause}.`, {
      severity: 'bad',
      focus: [from, to],
    });
  }

  // 5. Gravity from the hexes this course entered, felt next turn.
  //    "When two or more weak gravity hexes are entered consecutively, the
  //    second and later hexes have the effect of full gravity hexes, regardless
  //    of how the first such hex is treated." A run of entries is not reset by
  //    the turn boundary: the hex the ship started in is the last one it
  //    entered, so a weak arrow there makes this turn's first weak hex a
  //    second-or-later one. Without the carry, an orbit of Luna or Io — one hex
  //    per turn, so every weak hex is the first of its own turn — could be
  //    declined away for free, contradicting "such a ship will continue to orbit
  //    until fuel is burned to produce a course change."
  const { mandatory, optional } = map.accumulateGravity(
    gravityHexesEntered(from, to, trace.entered),
    map.hasWeakGravity(from),
  );
  const location = locationAfter(state, map, to, velocity);
  const settled: Ship =
    location.kind === 'asteroidBase'
      ? clearDetectionOnArrival(state, moved, baseAtHex(state, to)?.id)
      : moved;

  let s = withShip(state, {
    ...settled,
    pendingGravity: mandatory,
    optionalGravity: optional,
    location,
  });
  // 3. Record the traced path for combat's closest-approach measurement.
  s = recordPath(s, id, trace.entered);

  if (!eq(from, to)) {
    s = log(s, `${shipLabel(ship)} moves ${distance(from, to)} hex(es) to ${to.q},${to.r}.`, {
      focus: [from, to],
    });
  } else {
    s = log(s, `${shipLabel(ship)} is stationary at ${to.q},${to.r}.`, {
      focus: [to],
    });
  }

  // 4. Astrogation hazards.
  s = rollAsteroidHazards(s, id, from, to, map);
  return s;
};

/**
 * Resolve declared rams once every ship has moved.
 *
 * "The ramming ship rolls a die, subtracts the difference in vectors if it is
 * greater than 2 (as for gunfire; see p. 5) and consults the Ramming column of
 * the damage table. The results apply to both ships."
 *
 * The parenthetical points at Figure 9 for *measuring* the vector difference —
 * plot both courses from a common point and count the hexes between the heads —
 * and the subtraction itself is the full difference, applied only once that
 * difference exceeds two.
 */
const resolveRams = (state: GameState): GameState => {
  const rams = movementData(state).rams;
  let s = state;
  for (const rammerId of Object.keys(rams).sort()) {
    const targetId = rams[rammerId]!;
    const rammer = s.ships[rammerId];
    const target = s.ships[targetId];
    if (!rammer || !target || rammer.destroyed || target.destroyed) continue;

    const from = sub(rammer.pos, rammer.velocity);
    if (!courseThroughCentre(from, rammer.pos, target.pos)) {
      s = log(
        s,
        `${shipLabel(rammer)} misses ${shipLabel(target)} — its course did not pass through the center of the hex.`,
        { focus: [rammer.pos, target.pos] },
      );
      continue;
    }

    const relative = distance(rammer.velocity, target.velocity);
    const modifier = relative > 2 ? -relative : 0;
    const roll = rollDie(s.rng);
    s = { ...s, rng: roll.state };

    s = log(
      s,
      `${shipLabel(rammer)} rams ${shipLabel(target)} (die ${roll.value}${
        modifier !== 0 ? `, ${modifier} for ${relative} hexes of relative velocity` : ''
      }).`,
      { severity: 'warn', focus: [target.pos] },
    );
    s = resolveOther(s, 'ram', roll.value + modifier, [rammerId, targetId], 'the collision', [
      target.pos,
    ]);
  }
  return s;
};

/**
 * Move every ship of the phasing player.
 *
 * "Spaceships move along their plotted courses to their new plotted positions."
 * A ship with no plot coasts to its predicted endpoint — that is the default
 * behaviour of vector movement, not an omission. Ordnance movement belongs to
 * the ordnance module and is sequenced by the turn driver.
 */
export const executeMovementPhase = (state: GameState, map: GameMap): GameState => {
  const player = activePlayer(state);
  let s = state;

  // A stable order keeps the die rolls reproducible across replays.
  for (const id of Object.keys(state.ships).sort()) {
    const ship = s.ships[id];
    if (!ship || ship.destroyed) continue;
    if (controllerOf(ship) !== player) continue;
    s = moveShip(s, id, map);
  }

  // "Ramming takes place during the movement phase." Resolved after every ship
  // has flown, so a ram result can never rewrite a course still to be flown.
  s = resolveRams(s);

  // Declarations are good for one player-turn only.
  s = withMovementData(s, { landing: {}, takeoff: [], rams: {} });
  return s;
};
