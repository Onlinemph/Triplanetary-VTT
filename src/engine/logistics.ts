/**
 * Logistics: bases, resupply, cargo, looting, capture, surrender, purchase and
 * the Belt's mining economy.
 *
 * Everything in this module is about *matched courses*. The rulebook is blunt
 * about it — "The only way for anything to be transferred between ships is for
 * both to have the same course and position" — and the base rules are the same
 * idea written out for stationary objects: an asteroid base wants you stopped in
 * its hex, an orbital base wants you in orbit in its hex, a planetary base wants
 * you either landed on its hexside or passing over it in orbit. So one predicate
 * (`coursesMatched`) and one eligibility function (`canResupplyAt`) carry almost
 * the whole chapter.
 *
 * Refuelling is never *just* refuelling: "Whenever a ship is refueled from a
 * base, it automatically undergoes maintenance. This repairs all remaining
 * damage and allows the ship to perform the overload maneuver once. In addition,
 * all ordnance is automatically reloaded." That is why `resupply` writes so many
 * fields at once, and why the overload flag lives on the ship rather than being
 * counted per turn: it is spent on a manoeuvre and restored by a stopover.
 *
 * Per-hex bookkeeping the `Ship` contract has nowhere to put — automated mines,
 * their stockpiles, robot guards, dropped contraterrene shards, and outstanding
 * surrender demands — is parked in `state.scenarioData.logistics`, exactly the
 * way movement parks its landing and ramming declarations.
 */

import { applyAdvancedHits, applyDamage, isDisabled, recoverDamage, shipLabel } from './combat.js';
import type {
  Capture,
  CommandResult,
  DemandSurrender,
  EmplaceEquipment,
  Loot,
  MineOre,
  PurchaseShip,
  RespondToSurrender,
  Resupply,
  TransferCargo,
} from './commands.js';
import { otherDamage, otherToHit } from './crt.js';
import { type Hex, type HexSide, distance, eq, isZero, key, sideKey } from './hex.js';
import type { GameMap } from './map.js';
import { controllerOf, shipPath } from './movement.js';
import { rollDice } from './rng.js';
import { type CargoKind, type ShipClass, CARGO, SHIP_CLASSES } from './ships.js';
import {
  ZERO,
  addCargo,
  cargoCount,
  log,
  makeShip,
  removeOrdnance,
  setCargo,
  withBase,
  withPlayer,
  withShip,
} from './state.js';
import {
  type BaseState,
  type GameState,
  type PlayerId,
  type Ship,
  type ShipId,
  activePlayer,
  areAllied,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** "Mines remain active for five turns, after which they self-destruct." */
export const ORDNANCE_LIFETIME = 5;

/** "A stationary ship on an ore hex may mine ore at .1 ton per turn." */
export const MANUAL_MINE_RATE = 0.1;

/** Automated mines "extract 1 ton per turn". */
export const AUTOMATED_MINE_RATE = 1;

/** Bases stock "an unlimited supply of fuel, mines, and torpedoes" — no nukes. */
export const RESUPPLY_ORDNANCE: readonly CargoKind[] = ['mine', 'torpedo'];

/**
 * "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton). CT
 * shards sell for MCr 100 at Ceres or MCr 200 at Luna." The Prospecting variant
 * adds "Clandestine is available as a base... It buys ore at Ceres prices."
 */
export const MARKETS: Readonly<Record<string, { ore: number; ctShard: number }>> = {
  ceres: { ore: 2, ctShard: 100 },
  luna: { ore: 3, ctShard: 200 },
  clandestine: { ore: 2, ctShard: 100 },
};

/** "Fuel: MCr .5 per point of fuel, available at any friendly base." */
export const FUEL_PRICE = 0.5;

/**
 * Fuel left to a surrendered ship, per hex to its nearest friendly base. See
 * {@link surrenderFuelReserve}.
 */
const SURRENDER_RESERVE_PER_HEX = 1 / 5;
const SURRENDER_RESERVE_FLOOR = 2;

// ---------------------------------------------------------------------------
// Scenario-data side table
// ---------------------------------------------------------------------------

/** An emplaced automated mine and whatever it has dug up so far. */
export interface MineSite {
  readonly owner: PlayerId;
  /** Tons of ore waiting to be picked up: "Mined ore is stockpiled until picked up." */
  readonly stockpile: number;
}

export interface LogisticsData {
  /** Automated mines by hex key. "Only one mine may be placed per asteroid hex." */
  readonly mines: Readonly<Record<string, MineSite>>;
  /** Robot guards by hex key; they may be dropped with or without a mine. */
  readonly guards: Readonly<Record<string, PlayerId>>;
  /** Contraterrene shards left in a hex "for later" by a grapple-equipped ship. */
  readonly shards: Readonly<Record<string, number>>;
  /** Outstanding surrender demands: target ship id -> ids of the demanding ships. */
  readonly demands: Readonly<Record<ShipId, readonly ShipId[]>>;
  /** Ship-specific surrender pacts, kept alongside the broader `surrenderedTo`. */
  readonly pacts: Readonly<Record<ShipId, readonly ShipId[]>>;
}

const LOGISTICS_KEY = 'logistics';

const EMPTY_LOGISTICS: LogisticsData = {
  mines: {},
  guards: {},
  shards: {},
  demands: {},
  pacts: {},
};

export const logisticsData = (state: GameState): LogisticsData => {
  const raw = state.scenarioData[LOGISTICS_KEY] as Partial<LogisticsData> | undefined;
  return raw ? { ...EMPTY_LOGISTICS, ...raw } : EMPTY_LOGISTICS;
};

const withLogistics = (state: GameState, patch: Partial<LogisticsData>): GameState => ({
  ...state,
  scenarioData: {
    ...state.scenarioData,
    [LOGISTICS_KEY]: { ...logisticsData(state), ...patch },
  },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const okResult: CommandResult = { ok: true };

const reject = (state: GameState, reason: string): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: false, reason },
});

/** Ore is mined a tenth of a ton at a time; keep the arithmetic printable. */
const roundTons = (t: number): number => Math.round(t * 1000) / 1000;

export const fuelCapacity = (ship: Ship): number => SHIP_CLASSES[ship.shipClass].fuelCapacity;

/** "Torch ships... have unlimited fuel but may not transfer fuel to other ships." */
export const hasUnlimitedFuel = (ship: Ship): boolean =>
  SHIP_CLASSES[ship.shipClass].fuelCapacity === Infinity;

/**
 * "Bases are marked on the map... the scenario will also indicate the ownership
 * of the various bases." A base nobody has claimed serves anyone; allies share.
 */
export const baseIsFriendly = (state: GameState, base: BaseState, player: PlayerId): boolean => {
  if (base.destroyed) return false;
  return base.owner === null || areAllied(state, base.owner, player);
};

/** Asteroid and orbital bases sit in a hex; planetary bases live on a hexside. */
const baseAtHex = (state: GameState, h: Hex): BaseState | undefined =>
  Object.values(state.bases).find((b) => b.side === undefined && eq(b.hex, h));

const baseAtSide = (state: GameState, side: HexSide): BaseState | undefined => {
  const k = sideKey(side);
  return Object.values(state.bases).find((b) => b.side !== undefined && sideKey(b.side) === k);
};

/**
 * The body a base belongs to, which is also its market identity ("ceres",
 * "luna"). Planetary and asteroid bases sit in their world's own hex, so the map
 * answers directly; an orbital base floating in a gravity hex falls back to the
 * prefix of its id.
 */
export const baseBodyId = (base: BaseState, map: GameMap): string => {
  const body = map.bodyAt(base.hex);
  if (body) return body.id;
  const colon = base.id.indexOf(':');
  return colon >= 0 ? base.id.slice(0, colon) : base.id;
};

const nameOfBase = (state: GameState, baseId: string, map: GameMap): string => {
  const base = state.bases[baseId];
  if (!base) return baseId;
  return map.body(baseBodyId(base, map))?.name ?? baseId;
};

// ---------------------------------------------------------------------------
// Matched courses
// ---------------------------------------------------------------------------

/**
 * "The only way for anything to be transferred between ships is for both to have
 * the same course and position."
 *
 * Position *and* velocity, then — two ships crossing in the same hex at
 * different speeds are passing each other at kilometres per second, not docking.
 * Landed ships are a special case: the whole world shares one hex, so two ships
 * on the ground only count as alongside each other when they came down on the
 * same hexside ("It must take off from the hex side where it landed").
 */
export function coursesMatched(a: Ship, b: Ship): boolean {
  if (a.destroyed || b.destroyed) return false;
  if (!eq(a.pos, b.pos) || !eq(a.velocity, b.velocity)) return false;
  if (a.location.kind === 'landed' || b.location.kind === 'landed') {
    if (a.location.kind !== 'landed' || b.location.kind !== 'landed') return false;
    return sideKey(a.location.side) === sideKey(b.location.side);
  }
  return true;
}

/** Every other live ship whose course this one has matched. */
export function matchedShips(state: GameState, ship: Ship): Ship[] {
  return Object.values(state.ships).filter((s) => s.id !== ship.id && coursesMatched(ship, s));
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

/** Total mass carried, in tons. "Fuel is not 'cargo' and its mass is disregarded." */
export function cargoMass(ship: Ship): number {
  let total = 0;
  for (const item of ship.cargo) total += item.quantity * CARGO[item.kind].mass;
  return roundTons(total);
}

/** "A ship may carry cargo whose total mass is less than or equal to its capacity." */
export function cargoSpace(ship: Ship): number {
  const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
  if (capacity === Infinity) return Infinity;
  return roundTons(capacity - cargoMass(ship));
}

/**
 * "Note that non-warships may carry only one nuke at a time, and that only a
 * transport may carry an orbital base."
 *
 * The base rules on p. 7 are one word wider than the cargo note on p. 8 — "A
 * base may be carried only by a transport or packet" — and we take the more
 * specific of the two, since it is the rule that describes the object.
 */
export function canCarry(ship: Ship, kind: CargoKind, quantity: number): string | null {
  if (quantity <= 0) return 'quantity must be positive';
  // Ore is the only divisible cargo: manual mining produces a tenth of a ton at
  // a time. Everything else is discrete: "An item of cargo may not be split
  // among two or more ships for transport."
  if (kind !== 'ore' && !Number.isInteger(quantity)) return `${CARGO[kind].name} cannot be split`;
  if (kind === 'nuke') {
    const limit = SHIP_CLASSES[ship.shipClass].warship ? Infinity : 1;
    if (cargoCount(ship, 'nuke') + quantity > limit) {
      return 'non-warships may carry only one nuke at a time';
    }
  }
  if (kind === 'orbitalBase' && ship.shipClass !== 'transport' && ship.shipClass !== 'packet') {
    return 'only a transport or packet may carry an orbital base';
  }
  const mass = quantity * CARGO[kind].mass;
  if (mass > cargoSpace(ship)) return `${shipLabel(ship)} has no room for that`;
  return null;
}

// ---------------------------------------------------------------------------
// Resupply eligibility
// ---------------------------------------------------------------------------

export interface ResupplyCheck {
  readonly ok: boolean;
  readonly baseId?: string;
  readonly reason?: string;
}

/**
 * Which friendly base, if any, this ship has matched courses with (rulebook p. 8).
 *
 *  - **Planetary.** "The ship must either land on the world in the same hex side
 *    as the base, or pass through the gravity hex directly above the base's hex
 *    side while in orbit." Orbit is derived, never stored, so we ask the map.
 *  - **Asteroid.** "For asteroid bases, matching courses requires that the ship
 *    stop in the base hex."
 *  - **Orbital.** "The ship must match courses with the base by being in orbit
 *    and in the same hex."
 *
 * Suppression is deliberately *not* consulted: "The base on a suppressed hexside
 * is not affected."
 */
export function canResupplyAt(state: GameState, ship: Ship, map: GameMap): ResupplyCheck {
  if (ship.destroyed) return { ok: false, reason: 'the ship has been destroyed' };
  const player = controllerOf(ship);

  // Landed: the hexside itself must carry the base.
  if (ship.location.kind === 'landed') {
    const base = baseAtSide(state, ship.location.side);
    if (!base) return { ok: false, reason: 'that hexside has no base' };
    if (!baseIsFriendly(state, base, player)) {
      return { ok: false, reason: `the base at ${base.id} is not friendly` };
    }
    return { ok: true, baseId: base.id };
  }

  // Stopped on a rock: Ceres, Clandestine, or a bare belt asteroid.
  if (ship.location.kind === 'asteroidBase' && isZero(ship.velocity)) {
    const base = baseAtHex(state, ship.pos);
    if (!base) return { ok: false, reason: 'there is no base in this hex' };
    if (!baseIsFriendly(state, base, player)) {
      return { ok: false, reason: `the base at ${base.id} is not friendly` };
    }
    return { ok: true, baseId: base.id };
  }

  // An orbital base is a counter sitting in one gravity hex. A ship matches
  // courses with it "by being in orbit and in the same hex" — and once it has,
  // "it stops moving and remains with the base", so a ship already parked there
  // has matched courses in the plainest sense of all: both are stationary in the
  // same hex, and it may go on resupplying for as long as it stays.
  const here = baseAtHex(state, ship.pos);
  const orbiting = map.orbitOf(ship.pos, ship.velocity);
  if (
    here &&
    here.kind === 'orbital' &&
    (orbiting !== undefined || isZero(ship.velocity)) &&
    baseIsFriendly(state, here, player)
  ) {
    return { ok: true, baseId: here.id };
  }

  if (!orbiting) {
    return { ok: false, reason: 'the ship has not matched courses with a base' };
  }

  // Passing over a planetary base while in orbit. Both ends of a one-hex leg
  // count as "passed through"; at orbital speed there is nothing in between.
  for (const h of shipPath(state, ship)) {
    const site = map.planetaryBaseBelow(h);
    // The base must belong to the world actually being orbited — a hex cannot
    // be "directly above" a hexside of some other body.
    if (!site || site.bodyId !== orbiting.id) continue;
    const base = state.bases[site.id];
    if (!base || !baseIsFriendly(state, base, player)) continue;
    return { ok: true, baseId: base.id };
  }

  return { ok: false, reason: 'the ship has not matched courses with a base' };
}

// ---------------------------------------------------------------------------
// Resupply
// ---------------------------------------------------------------------------

const maintain = (ship: Ship): Ship => ({
  ...ship,
  // "This repairs all remaining damage..." — including the advanced system's
  // wrecked weapon track, which "can no longer [be repaired]... it must get back
  // to a base."
  disabled: 0,
  advancedDamage: { weapon: 0, drive: 0, structure: 0 },
  // "...and allows the ship to perform the overload maneuver once." Commercial
  // ships never get it: they "may not perform the overload maneuver."
  overloadAvailable: SHIP_CLASSES[ship.shipClass].warship,
});

/**
 * Refuel, repair and rearm a ship at a base.
 *
 * The one restriction that bites is timing: "No ship may fire its guns or launch
 * ordnance during a player-turn in which it resupplies." Since the resupply
 * phase is the *last* of the five, that rule can only be enforced backwards —
 * a ship that has already shot or dropped something this player-turn may not
 * pull into a base. The forward half of the same rule is `resuppliedThisTurn`,
 * which combat and ordnance read.
 */
export function resupply(
  state: GameState,
  cmd: Resupply,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const ship = state.ships[cmd.ship];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  if (controllerOf(ship) !== cmd.by) return reject(state, 'that ship is not yours');
  if (state.phase !== 'resupply') return reject(state, 'bases resupply in the resupply phase');
  if (ship.resuppliedThisTurn) return reject(state, `${shipLabel(ship)} has already resupplied`);
  if (ship.firedThisPhase || ship.launchedOrdnanceThisTurn) {
    return reject(
      state,
      'a ship may not fire its guns or launch ordnance during a player-turn in which it resupplies',
    );
  }

  const check = canResupplyAt(state, ship, map);
  if (!check.ok || check.baseId === undefined) {
    return reject(state, check.reason ?? 'no base available');
  }
  const base = state.bases[check.baseId]!;

  // "An orbital base resupplying any ship may not fire its guns or launch
  // ordnance during that player-turn" — read symmetrically, a base that has
  // already fired this player-turn has spent its turn.
  if (base.kind === 'orbital' && base.firedThisTurn) {
    return reject(state, 'that orbital base has already fired this turn');
  }

  // Work out the new ordnance loadout before touching anything, so an illegal
  // request rejects cleanly. "The ship may select any assortment of mines and
  // torpedoes which fits in the hold capacity of the ship."
  let rearmed: Ship = ship;
  if (cmd.loadout) {
    const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
    let loadMass = 0;
    for (const item of cmd.loadout) {
      if (!RESUPPLY_ORDNANCE.includes(item.kind)) {
        return reject(
          state,
          'bases carry only fuel, mines and torpedoes; anything else must be bought',
        );
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        return reject(state, 'ordnance comes in whole units');
      }
      loadMass += item.quantity * CARGO[item.kind].mass;
    }
    let otherMass = 0;
    for (const item of ship.cargo) {
      if (RESUPPLY_ORDNANCE.includes(item.kind)) continue;
      otherMass += item.quantity * CARGO[item.kind].mass;
    }
    if (otherMass + loadMass > capacity) {
      return reject(state, 'that loadout does not fit in the hold');
    }
    for (const kind of RESUPPLY_ORDNANCE) rearmed = setCargo(rearmed, kind, 0);
    for (const item of cmd.loadout) {
      if (item.quantity > 0) rearmed = setCargo(rearmed, item.kind, item.quantity);
    }
  }

  const refuelled: Ship = {
    ...maintain(rearmed),
    fuel: fuelCapacity(ship),
    resuppliedThisTurn: true,
    // "Once a ship has been detected by the enemy, it remains detected
    // (regardless of range) until it arrives at a friendly base." It has.
    detectedBy: [],
  };

  let s = withShip(state, refuelled);
  s = withBase(s, { ...base, resuppliedThisTurn: true });

  // An orbital base counter is also a ship in some scenarios; if one is sitting
  // on this base it spends its player-turn resupplying too.
  const baseShip = Object.values(s.ships).find(
    (o) =>
      o.shipClass === 'orbitalBase' &&
      !o.destroyed &&
      eq(o.pos, base.hex) &&
      (base.owner === null || areAllied(s, base.owner, o.owner)),
  );
  if (baseShip && baseShip.id !== ship.id) {
    s = withShip(s, { ...baseShip, resuppliedThisTurn: true });
  }

  // "Having done so, it stops moving and remains with the base." Station-keeping
  // by the base, so the gravity it is sitting in stops pulling it down as well —
  // otherwise "remains with the base" would last exactly one turn.
  if (base.kind === 'orbital') {
    s = withShip(s, {
      ...s.ships[ship.id]!,
      velocity: ZERO,
      pendingGravity: ZERO,
      optionalGravity: [],
      acceptedOptionalGravity: [],
    });
  }

  s = releaseCapture(s, ship.id, base);

  const where = nameOfBase(s, base.id, map);
  s = log(s, `${shipLabel(ship)} refuels and undergoes maintenance at ${where}.`, {
    severity: 'good',
    focus: [ship.pos],
  });
  return { state: s, result: okResult };
}

/**
 * "A captured ship must be returned to a base friendly to the captor before it
 * may be used for any other mission." Once it is, the prize joins the captor's
 * fleet — "The Patrol may take captured pirate vessels into service"; the
 * Pirates "must first return them to Clandestine for refit".
 */
const releaseCapture = (state: GameState, id: ShipId, base: BaseState): GameState => {
  const ship = state.ships[id];
  if (!ship || ship.capturedBy === undefined) return state;
  const captor = ship.capturedBy;
  if (!baseIsFriendly(state, base, captor)) return state;
  const next = log(
    withShip(state, { ...ship, owner: captor, capturedBy: undefined, surrenderedTo: [] }),
    `${shipLabel(ship)} is refitted and enters service with ${
      state.players[captor]?.name ?? captor
    }.`,
    { severity: 'good', focus: [ship.pos] },
  );
  return next;
};

// ---------------------------------------------------------------------------
// Transfers, looting and rescue
// ---------------------------------------------------------------------------

type TransferItem = { readonly kind: CargoKind | 'fuel'; readonly quantity: number };

/** Why this item cannot move from `giver` to `taker`, or `null` if it can. */
const transferObjection = (giver: Ship, taker: Ship, item: TransferItem): string | null => {
  if (item.quantity <= 0) return 'quantity must be positive';
  if (item.kind === 'fuel') {
    // "Torch ships... have unlimited fuel but may not transfer fuel to other ships."
    if (hasUnlimitedFuel(giver)) return 'torch ships may not transfer fuel to other ships';
    if (giver.fuel < item.quantity) return `${shipLabel(giver)} has only ${giver.fuel} fuel`;
    const room = fuelCapacity(taker) - taker.fuel;
    if (item.quantity > room) return `${shipLabel(taker)} can only take ${room} more fuel`;
    return null;
  }
  if (cargoCount(giver, item.kind) < item.quantity) {
    return `${shipLabel(giver)} does not carry that much ${CARGO[item.kind].name}`;
  }
  return canCarry(taker, item.kind, item.quantity);
};

const applyTransfer = (
  giver: Ship,
  taker: Ship,
  item: TransferItem,
): { giver: Ship; taker: Ship } => {
  if (item.kind === 'fuel') {
    return {
      giver: { ...giver, fuel: roundTons(giver.fuel - item.quantity) },
      taker: { ...taker, fuel: roundTons(taker.fuel + item.quantity) },
    };
  }
  return {
    giver: addCargo(giver, item.kind, -item.quantity),
    taker: addCargo(taker, item.kind, item.quantity),
  };
};

/**
 * Move cargo or fuel between two ships that have matched courses — the rulebook's
 * "rescue" when it is done between friends.
 *
 * Fuel gets one extra restriction, borrowed from the ordnance chapter: "Ordnance
 * may not be launched while the ship is at a base, refueling (including
 * transferring fuel between ships in space)." Ordnance is launched in phase 2
 * and fuel changes hands in phase 5, so the only way to enforce that within one
 * player-turn is to refuse the refuelling.
 */
export function transferCargo(
  state: GameState,
  cmd: TransferCargo,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  void map;
  const from = state.ships[cmd.from];
  const to = state.ships[cmd.to];
  if (!from || from.destroyed) return reject(state, 'no such ship');
  if (!to || to.destroyed) return reject(state, 'no such ship');
  if (from.id === to.id) return reject(state, 'a ship cannot transfer to itself');
  if (state.phase !== 'resupply') return reject(state, 'cargo moves in the resupply phase');

  const giverSide = controllerOf(from);
  const takerSide = controllerOf(to);
  if (cmd.by !== giverSide && cmd.by !== takerSide) {
    return reject(state, 'neither ship is yours');
  }
  if (!areAllied(state, giverSide, takerSide)) {
    return reject(state, 'taking goods from an enemy is looting, not a transfer');
  }
  if (!coursesMatched(from, to)) {
    return reject(state, 'the two ships have not matched courses');
  }
  if (cmd.kind === 'fuel' && (from.launchedOrdnanceThisTurn || to.launchedOrdnanceThisTurn)) {
    return reject(state, 'a ship may not refuel in space on a turn it launched ordnance');
  }

  const item: TransferItem = { kind: cmd.kind, quantity: cmd.quantity };
  const objection = transferObjection(from, to, item);
  if (objection) return reject(state, objection);

  const moved = applyTransfer(from, to, item);
  let s = withShip(withShip(state, moved.giver), moved.taker);
  const what = cmd.kind === 'fuel' ? 'fuel' : CARGO[cmd.kind].name;
  s = log(s, `${shipLabel(from)} transfers ${cmd.quantity} ${what} to ${shipLabel(to)}.`, {
    focus: [from.pos],
  });
  return { state: s, result: okResult };
}

/**
 * "The surrendered ship must be left with enough fuel to reach a friendly base."
 *
 * The rulebook does not quantify that, and honestly it cannot: the answer is an
 * astrogation problem. We reserve one fuel point per five hexes to the nearest
 * friendly base — roughly one course correction per leg — with a floor of two so
 * a surrendered ship is never left completely adrift. If it has no friendly base
 * left anywhere, nothing may be taken.
 */
export function surrenderFuelReserve(state: GameState, ship: Ship, map: GameMap): number {
  void map;
  let nearest = Infinity;
  for (const base of Object.values(state.bases)) {
    if (!baseIsFriendly(state, base, ship.owner)) continue;
    nearest = Math.min(nearest, distance(ship.pos, base.hex));
  }
  if (!Number.isFinite(nearest)) return ship.fuel;
  const reserve = Math.max(SURRENDER_RESERVE_FLOOR, Math.ceil(nearest * SURRENDER_RESERVE_PER_HEX));
  return Math.min(reserve, fuelCapacity(ship));
}

/**
 * "Only disabled (or surrendered) ships may be looted. A ship which is
 * eliminated has broken up or exploded and may not be looted."
 */
export function loot(
  state: GameState,
  cmd: Loot,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const looter = state.ships[cmd.ship];
  const victim = state.ships[cmd.target];
  if (!looter || looter.destroyed) return reject(state, 'no such ship');
  if (!victim || victim.destroyed) return reject(state, 'the wreck cannot be looted');
  if (looter.id === victim.id) return reject(state, 'a ship cannot loot itself');
  if (controllerOf(looter) !== cmd.by) return reject(state, 'that ship is not yours');
  if (state.phase !== 'resupply') return reject(state, 'looting happens in the resupply phase');
  if (!coursesMatched(looter, victim)) {
    return reject(state, 'the two ships have not matched courses');
  }

  const surrendered = victim.surrenderedTo.includes(cmd.by);
  if (!surrendered && !isDisabled(victim, state.options.advancedCombat)) {
    return reject(state, 'only disabled or surrendered ships may be looted');
  }

  // Validate the whole haul first: looting is all-or-nothing so a rejection
  // never leaves half the cargo in the hold of a ship that cannot take it.
  let giver: Ship = victim;
  let taker: Ship = looter;
  const reserve = surrendered ? surrenderFuelReserve(state, victim, map) : 0;
  for (const item of cmd.items) {
    const objection = transferObjection(giver, taker, item);
    if (objection) return reject(state, objection);
    if (item.kind === 'fuel' && giver.fuel - item.quantity < reserve) {
      return reject(
        state,
        `a surrendered ship must be left with enough fuel to reach a friendly base (${reserve})`,
      );
    }
    const moved = applyTransfer(giver, taker, item);
    giver = moved.giver;
    taker = moved.taker;
  }

  let s = withShip(withShip(state, giver), taker);
  const haul = cmd.items
    .map((i) => `${i.quantity} ${i.kind === 'fuel' ? 'fuel' : CARGO[i.kind].name}`)
    .join(', ');
  const friendly = areAllied(state, controllerOf(looter), controllerOf(victim));
  s = log(
    s,
    friendly
      ? `${shipLabel(looter)} takes ${haul} off ${shipLabel(victim)}.`
      : `${shipLabel(looter)} loots ${haul} from ${shipLabel(victim)}.`,
    { severity: friendly ? 'good' : 'warn', focus: [victim.pos] },
  );
  return { state: s, result: okResult };
}

/**
 * "While a ship is disabled, it may be captured by an enemy that matches
 * courses... Surrendered ships may not be captured."
 */
export function capture(
  state: GameState,
  cmd: Capture,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  void map;
  const captor = state.ships[cmd.ship];
  const prize = state.ships[cmd.target];
  if (!captor || captor.destroyed) return reject(state, 'no such ship');
  if (!prize || prize.destroyed) return reject(state, 'no such ship');
  if (captor.id === prize.id) return reject(state, 'a ship cannot capture itself');
  if (controllerOf(captor) !== cmd.by) return reject(state, 'that ship is not yours');
  if (state.phase !== 'resupply') return reject(state, 'capture happens in the resupply phase');
  if (areAllied(state, cmd.by, controllerOf(prize))) {
    return reject(state, 'that ship is not an enemy');
  }
  // A disabled ship "cannot maneuver" — it cannot chase anything down, even if
  // the geometry happens to have put the two on the same course.
  if (isDisabled(captor, state.options.advancedCombat)) {
    return reject(state, `${shipLabel(captor)} is disabled and cannot take a prize`);
  }
  if (!isDisabled(prize, state.options.advancedCombat)) {
    return reject(state, 'only disabled ships may be captured');
  }
  if (prize.surrenderedTo.length > 0) {
    return reject(state, 'surrendered ships may not be captured');
  }
  if (!coursesMatched(captor, prize)) {
    return reject(state, 'the two ships have not matched courses');
  }

  // "However, if a merchant ship is recaptured it is returned to its owner."
  const recaptured = areAllied(state, cmd.by, prize.owner);
  const taken: Ship = recaptured
    ? { ...prize, capturedBy: undefined }
    : { ...prize, capturedBy: cmd.by };

  let s = withShip(state, taken);
  s = log(
    s,
    recaptured
      ? `${shipLabel(captor)} recaptures ${shipLabel(prize)} and returns her to her owner.`
      : `${shipLabel(captor)} captures ${shipLabel(prize)}; the prize must reach a friendly base before she can be used.`,
    { severity: recaptured ? 'good' : 'warn', focus: [prize.pos] },
  );
  return { state: s, result: okResult };
}

// ---------------------------------------------------------------------------
// Surrender
// ---------------------------------------------------------------------------

/** Scenario hook: "note that aliens will not surrender". */
const refusesSurrender = (state: GameState, player: PlayerId): boolean => {
  const list = state.scenarioData['noSurrender'];
  return Array.isArray(list) && (list as readonly unknown[]).includes(player);
};

/**
 * "A ship may demand that an enemy ship surrender." The demand is recorded and
 * answered by the other player with {@link respondToSurrender} — a bargain needs
 * two signatures.
 */
export function demandSurrender(
  state: GameState,
  cmd: DemandSurrender,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  void map;
  const demander = state.ships[cmd.ship];
  const target = state.ships[cmd.target];
  if (!demander || demander.destroyed) return reject(state, 'no such ship');
  if (!target || target.destroyed) return reject(state, 'no such ship');
  if (controllerOf(demander) !== cmd.by) return reject(state, 'that ship is not yours');
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your player-turn');
  if (areAllied(state, cmd.by, controllerOf(target))) {
    return reject(state, 'that ship is not an enemy');
  }
  if (target.surrenderedTo.includes(cmd.by)) {
    return reject(state, `${shipLabel(target)} has already surrendered to you`);
  }
  if (target.capturedBy !== undefined) return reject(state, 'that ship is already a prize');
  if (refusesSurrender(state, target.owner)) {
    return reject(state, `${shipLabel(target)} will never surrender`);
  }

  const data = logisticsData(state);
  const existing = data.demands[cmd.target] ?? [];
  if (existing.includes(cmd.ship)) return reject(state, 'that demand is already outstanding');

  let s = withLogistics(state, {
    demands: { ...data.demands, [cmd.target]: [...existing, cmd.ship] },
  });
  s = log(s, `${shipLabel(demander)} demands that ${shipLabel(target)} surrender.`, {
    severity: 'warn',
    focus: [target.pos],
  });
  return { state: s, result: okResult };
}

/**
 * "Surrender is a binding bargain. Both parties agree not to attack the other
 * specific ship."
 *
 * The `Ship` contract records the bargain as a list of *players* — which is what
 * combat reads — so we widen the promise to the demanding player's whole side
 * and keep the ship-specific pairing alongside it for scenarios and the log.
 */
export function respondToSurrender(
  state: GameState,
  cmd: RespondToSurrender,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  void map;
  const ship = state.ships[cmd.ship];
  const demander = state.ships[cmd.to];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  if (!demander || demander.destroyed) return reject(state, 'no such ship');
  if (controllerOf(ship) !== cmd.by) return reject(state, 'that ship is not yours');

  const data = logisticsData(state);
  const outstanding = data.demands[cmd.ship] ?? [];
  if (!outstanding.includes(cmd.to)) return reject(state, 'no such surrender demand');

  const remaining = outstanding.filter((id) => id !== cmd.to);
  const demands = { ...data.demands };
  if (remaining.length > 0) demands[cmd.ship] = remaining;
  else delete demands[cmd.ship];

  if (!cmd.accept) {
    let s = withLogistics(state, { demands });
    s = log(s, `${shipLabel(ship)} refuses to surrender to ${shipLabel(demander)}.`, {
      severity: 'warn',
      focus: [ship.pos],
    });
    return { state: s, result: okResult };
  }

  if (refusesSurrender(state, ship.owner)) {
    return reject(state, `${shipLabel(ship)} will never surrender`);
  }

  const captorSide = controllerOf(demander);
  const pact = data.pacts[cmd.ship] ?? [];
  let s = withLogistics(state, {
    demands,
    pacts: { ...data.pacts, [cmd.ship]: pact.includes(cmd.to) ? pact : [...pact, cmd.to] },
  });
  s = withShip(s, {
    ...ship,
    surrenderedTo: ship.surrenderedTo.includes(captorSide)
      ? ship.surrenderedTo
      : [...ship.surrenderedTo, captorSide],
  });
  s = log(
    s,
    `${shipLabel(ship)} surrenders to ${shipLabel(demander)} — neither may fire on the other again.`,
    { severity: 'bad', focus: [ship.pos] },
  );
  return { state: s, result: okResult };
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

/** Scenarios may narrow the catalogue ("only freighters and packets are available"). */
const purchasableClasses = (state: GameState): readonly ShipClass[] | null => {
  const list = state.scenarioData['purchasableClasses'];
  return Array.isArray(list) ? (list as readonly ShipClass[]) : null;
};

/**
 * "New ships and equipment may be purchased on any world as soon as a player
 * accumulates enough money"; in Interplanetary War, "Ships appear immediately"
 * at the world where they were bought.
 */
export function purchaseShip(
  state: GameState,
  cmd: PurchaseShip,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const player = state.players[cmd.by];
  if (!player) return reject(state, 'no such player');
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your player-turn');
  if (cmd.shipClass === 'orbitalBase') {
    return reject(
      state,
      'an orbital base is bought as cargo and emplaced by a transport or packet',
    );
  }
  const allowed = purchasableClasses(state);
  if (allowed && !allowed.includes(cmd.shipClass)) {
    return reject(state, `${SHIP_CLASSES[cmd.shipClass].name}s are not for sale in this scenario`);
  }

  const cost = SHIP_CLASSES[cmd.shipClass].cost;
  if (player.megacredits < cost) {
    return reject(state, `${player.name} cannot afford MCr ${cost}`);
  }

  // The yard has to be somewhere: a friendly base on a world.
  const base = cmd.side ? baseAtSide(state, cmd.side) : baseAtHex(state, cmd.at);
  if (!base) return reject(state, 'there is no base there');
  if (!baseIsFriendly(state, base, cmd.by)) return reject(state, 'that base is not friendly');

  const number = state.nextShipNumber;
  const id = `${cmd.by}-${cmd.shipClass}-${number}`;
  // "All new ships start with a full fuel load."
  const ship = makeShip({
    id,
    owner: cmd.by,
    shipClass: cmd.shipClass,
    number,
    pos: cmd.side ? cmd.side.hex : cmd.at,
    location: cmd.side ? { kind: 'landed', side: cmd.side } : { kind: 'asteroidBase', hex: cmd.at },
  });

  let s: GameState = { ...state, nextShipNumber: number + 1 };
  s = withShip(s, ship);
  s = withPlayer(s, { ...player, megacredits: roundTons(player.megacredits - cost) });
  s = log(
    s,
    `${player.name} commissions ${shipLabel(ship)} at ${nameOfBase(s, base.id, map)} for MCr ${cost}.`,
    { severity: 'good', focus: [ship.pos] },
  );
  return { state: s, result: okResult };
}

/**
 * Buy equipment into a ship's hold at a friendly base. There is no command for
 * this in the protocol — scenarios that use the MegaCredit table drive it — but
 * the price list and the hold check belong here with everything else.
 */
export function purchaseEquipment(
  state: GameState,
  shipId: ShipId,
  kind: CargoKind,
  quantity: number,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const ship = state.ships[shipId];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  const buyer = state.players[controllerOf(ship)];
  if (!buyer) return reject(state, 'no such player');
  const price = CARGO[kind].cost;
  if (price === null) return reject(state, `${CARGO[kind].name} has no list price`);
  if (!Number.isInteger(quantity) || quantity <= 0) return reject(state, 'quantity must be whole');

  const check = canResupplyAt(state, ship, map);
  if (!check.ok) return reject(state, check.reason ?? 'not at a base');

  const objection = canCarry(ship, kind, quantity);
  if (objection) return reject(state, objection);
  const total = price * quantity;
  if (buyer.megacredits < total) return reject(state, `${buyer.name} cannot afford MCr ${total}`);

  let s = withShip(state, addCargo(ship, kind, quantity));
  s = withPlayer(s, { ...buyer, megacredits: roundTons(buyer.megacredits - total) });
  s = log(s, `${shipLabel(ship)} takes on ${quantity} ${CARGO[kind].name} for MCr ${total}.`, {
    focus: [ship.pos],
  });
  return { state: s, result: okResult };
}

/**
 * Sell ore and contraterrene shards at a market base. Prices are per the
 * Prospecting scenario; Clandestine "buys ore at Ceres prices".
 */
export function sellCargo(
  state: GameState,
  shipId: ShipId,
  kinds: readonly CargoKind[],
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const ship = state.ships[shipId];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  const seller = state.players[controllerOf(ship)];
  if (!seller) return reject(state, 'no such player');

  const check = canResupplyAt(state, ship, map);
  if (!check.ok || check.baseId === undefined)
    return reject(state, check.reason ?? 'not at a base');
  const base = state.bases[check.baseId]!;
  const market = MARKETS[baseBodyId(base, map)];
  if (!market) return reject(state, `${nameOfBase(state, base.id, map)} does not buy ore`);

  let sold: Ship = ship;
  let earned = 0;
  for (const kind of kinds) {
    const held = cargoCount(sold, kind);
    if (held <= 0) continue;
    const unit = kind === 'ore' ? market.ore : kind === 'ctShard' ? market.ctShard : null;
    if (unit === null) return reject(state, `${CARGO[kind].name} is not traded here`);
    earned += held * unit;
    sold = setCargo(sold, kind, 0);
  }
  if (earned <= 0) return reject(state, 'there is nothing to sell');

  let s = withShip(state, sold);
  s = withPlayer(s, { ...seller, megacredits: roundTons(seller.megacredits + earned) });
  s = log(
    s,
    `${shipLabel(ship)} sells her cargo at ${nameOfBase(s, base.id, map)} for MCr ${roundTons(earned)}.`,
    { severity: 'good', focus: [ship.pos] },
  );
  return { state: s, result: okResult };
}

// ---------------------------------------------------------------------------
// Prospecting and mining
// ---------------------------------------------------------------------------

/** Prospecting is a scenario, not a general rule; the driver may call it always. */
export const prospectingEnabled = (state: GameState): boolean =>
  state.scenarioData['prospecting'] === true;

const withProspected = (state: GameState, k: string, value: 'ore' | 'barren'): GameState => ({
  ...state,
  prospected: { ...state.prospected, [k]: value },
});

/**
 * "Any ship may prospect by passing through an asteroid hex at a speed of 1. Two
 * dice are rolled. On the first roll, a 6 indicates that ore is present... On the
 * second roll, a 1 indicates the ship has encountered a CT shard. If the ship is
 * equipped with PM grapples, the shard may be picked up and sold, or left for
 * later; otherwise, it explodes and the ship suffers an attack as per asteroids."
 *
 * "Each hex may only be prospected once", which also makes this idempotent: it
 * is safe for the turn driver to call it more than once in a player-turn.
 */
export function runProspecting(state: GameState, map: GameMap): GameState {
  if (!prospectingEnabled(state)) return state;
  const player = activePlayer(state);
  let s = state;

  for (const id of Object.keys(state.ships).sort()) {
    const ship = s.ships[id];
    if (!ship || ship.destroyed) continue;
    if (controllerOf(ship) !== player) continue;
    // "passing through an asteroid hex at a speed of 1" — exactly one hex.
    if (distance(ZERO, ship.velocity) !== 1) continue;
    const cleared = new Set(s.clearedAsteroids);
    if (!map.isAsteroid(ship.pos, cleared)) continue;
    const k = key(ship.pos);
    if (s.prospected[k] !== undefined) continue;

    const roll = rollDice(s.rng, 2);
    s = { ...s, rng: roll.state };
    const [oreRoll, shardRoll] = [roll.values[0]!, roll.values[1]!];

    const found = oreRoll === 6;
    s = withProspected(s, k, found ? 'ore' : 'barren');
    s = log(
      s,
      found
        ? `${shipLabel(ship)} prospects ${k} and strikes ore.`
        : `${shipLabel(ship)} prospects ${k} — barren rock.`,
      { severity: found ? 'good' : 'info', focus: [ship.pos] },
    );

    if (shardRoll !== 1) continue;
    s = handleShard(s, id, map);
  }
  return s;
}

const handleShard = (state: GameState, id: ShipId, map: GameMap): GameState => {
  void map;
  const ship = state.ships[id];
  if (!ship || ship.destroyed) return state;
  let s = state;

  if (cargoCount(ship, 'pmGrapples') > 0) {
    // "the shard may be picked up and sold, or left for later" — we take it if
    // there is room, and leave it in the hex if there is not.
    if (canCarry(ship, 'ctShard', 1) === null) {
      s = withShip(s, addCargo(ship, 'ctShard', 1));
      return log(s, `${shipLabel(ship)} grapples a contraterrene shard aboard.`, {
        severity: 'good',
        focus: [ship.pos],
      });
    }
    const data = logisticsData(s);
    const k = key(ship.pos);
    s = withLogistics(s, { shards: { ...data.shards, [k]: (data.shards[k] ?? 0) + 1 } });
    return log(s, `${shipLabel(ship)} marks a contraterrene shard at ${k} for later.`, {
      focus: [ship.pos],
    });
  }

  // "otherwise, it explodes and the ship suffers an attack as per asteroids."
  const roll = rollDice(s.rng, 1);
  s = { ...s, rng: roll.state };
  const value = roll.values[0]!;
  s = log(s, `${shipLabel(ship)} strikes an ungrappled contraterrene shard (die ${value}).`, {
    severity: 'bad',
    focus: [ship.pos],
  });
  if (s.options.advancedCombat) {
    return applyAdvancedHits(s, id, otherToHit('asteroid', value), 'a contraterrene shard').state;
  }
  return applyDamage(s, id, otherDamage('asteroid', value), 'a contraterrene shard');
};

/** Whose robot guards, if anyone's, are standing over this hex. */
export const guardsAt = (state: GameState, h: Hex): PlayerId | undefined =>
  logisticsData(state).guards[key(h)];

export const mineAt = (state: GameState, h: Hex): MineSite | undefined =>
  logisticsData(state).mines[key(h)];

/**
 * "A stationary ship on an ore hex may mine ore at .1 ton per turn; this takes
 * place on the movement phase, instead of movement."
 *
 * The same standing-still also lets the ship pick up whatever an automated mine
 * has stockpiled here, subject to the guards: "Robot guards... prevent anyone
 * other than the owner from removing stockpiled ore."
 */
export function mineOre(
  state: GameState,
  cmd: MineOre,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const ship = state.ships[cmd.ship];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  if (controllerOf(ship) !== cmd.by) return reject(state, 'that ship is not yours');
  if (state.phase !== 'astrogation' && state.phase !== 'movement') {
    return reject(state, 'mining takes the place of movement');
  }
  if (!isZero(ship.velocity)) return reject(state, 'only a stationary ship may mine');
  if (ship.plottedEndpoint && !eq(ship.plottedEndpoint, ship.pos)) {
    return reject(state, 'mining takes the place of movement — cancel the plotted course');
  }
  if (ship.disabled > 0) return reject(state, `${shipLabel(ship)} is disabled`);
  if (!map.isAsteroid(ship.pos, new Set(state.clearedAsteroids))) {
    return reject(state, 'there is nothing to mine here');
  }

  const k = key(ship.pos);
  const player = controllerOf(ship);
  const guards = guardsAt(state, ship.pos);
  if (guards !== undefined && !areAllied(state, guards, player)) {
    return reject(state, 'robot guards hold this claim');
  }

  const data = logisticsData(state);
  const site = data.mines[k];
  let s = state;
  let hold: Ship = ship;
  let took = 0;

  // Collect the stockpile first — it is already dug.
  if (site && areAllied(state, site.owner, player) && site.stockpile > 0) {
    const room = cargoSpace(hold);
    took = roundTons(Math.min(site.stockpile, room === Infinity ? site.stockpile : room));
    if (took > 0) {
      hold = addCargo(hold, 'ore', took);
      s = withLogistics(s, {
        mines: { ...data.mines, [k]: { ...site, stockpile: roundTons(site.stockpile - took) } },
      });
    }
  }

  // Then swing a pick, if the hex actually has ore and the hold has room.
  let dug = 0;
  if (state.prospected[k] === 'ore' && cargoSpace(hold) >= MANUAL_MINE_RATE) {
    dug = MANUAL_MINE_RATE;
    hold = setCargo(hold, 'ore', roundTons(cargoCount(hold, 'ore') + dug));
  }

  if (took === 0 && dug === 0) {
    return reject(state, 'there is no ore to be had here');
  }

  s = withShip(s, hold);
  s = log(
    s,
    dug > 0 && took > 0
      ? `${shipLabel(ship)} mines ${dug} ton and loads ${took} tons of stockpiled ore.`
      : dug > 0
        ? `${shipLabel(ship)} mines ${dug} ton of ore.`
        : `${shipLabel(ship)} loads ${took} tons of stockpiled ore.`,
    { severity: 'good', focus: [ship.pos] },
  );
  return { state: s, result: okResult };
}

/**
 * Drop an automated mine, robot guards, or an orbital base.
 *
 * "Only one mine may be placed per asteroid hex; placement requires the miner's
 * ship to stand still for one turn, and takes place in the movement phase." Robot
 * guards want the same standing start, "but this may be done at the same time as
 * an automated mine is dropped off".
 */
export function emplaceEquipment(
  state: GameState,
  cmd: EmplaceEquipment,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const ship = state.ships[cmd.ship];
  if (!ship || ship.destroyed) return reject(state, 'no such ship');
  if (controllerOf(ship) !== cmd.by) return reject(state, 'that ship is not yours');
  if (ship.disabled > 0) return reject(state, `${shipLabel(ship)} is disabled`);
  if (cargoCount(ship, cmd.kind) < 1) {
    return reject(state, `${shipLabel(ship)} carries no ${CARGO[cmd.kind].name}`);
  }

  const player = controllerOf(ship);
  const k = key(ship.pos);
  const data = logisticsData(state);

  if (cmd.kind === 'orbitalBase') return emplaceOrbitalBase(state, cmd, map);

  // Mining gear: stand still for a turn, in the Belt.
  if (state.phase !== 'astrogation' && state.phase !== 'movement') {
    return reject(state, 'equipment is emplaced in the movement phase');
  }
  if (!isZero(ship.velocity)) return reject(state, 'the ship must stand still for one turn');
  if (ship.plottedEndpoint && !eq(ship.plottedEndpoint, ship.pos)) {
    return reject(state, 'the ship must stand still for one turn');
  }
  if (!map.isAsteroid(ship.pos, new Set(state.clearedAsteroids))) {
    return reject(state, 'mining equipment belongs in an asteroid hex');
  }
  const guards = guardsAt(state, ship.pos);
  if (guards !== undefined && !areAllied(state, guards, player)) {
    return reject(state, 'robot guards hold this claim');
  }

  let s = withShip(state, addCargo(ship, cmd.kind, -1));
  if (cmd.kind === 'automatedMine') {
    if (data.mines[k]) return reject(state, 'only one mine may be placed per asteroid hex');
    s = withLogistics(s, { mines: { ...data.mines, [k]: { owner: player, stockpile: 0 } } });
    s = log(s, `${shipLabel(ship)} emplaces an automated mine at ${k}.`, {
      severity: 'good',
      focus: [ship.pos],
    });
  } else {
    if (guards !== undefined) return reject(state, 'this claim is already guarded');
    s = withLogistics(s, { guards: { ...data.guards, [k]: player } });
    s = log(s, `${shipLabel(ship)} sets robot guards at ${k}.`, {
      severity: 'good',
      focus: [ship.pos],
    });
  }
  return { state: s, result: okResult };
}

/**
 * "A base may be placed in two ways: In a gravity hex of a planet or satellite.
 * The ship carrying the base must be in orbit to emplace the base... On a world
 * surface hex side which does not already have a base present." Either way,
 * "Once placed, a base cannot be picked up again or moved."
 */
const emplaceOrbitalBase = (
  state: GameState,
  cmd: EmplaceEquipment,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  const ship = state.ships[cmd.ship]!;
  const player = controllerOf(ship);
  if (ship.shipClass !== 'transport' && ship.shipClass !== 'packet') {
    return reject(state, 'a base may be carried only by a transport or packet');
  }

  if (cmd.side) {
    // Surface emplacement: the carrier has to be on that hexside to unload.
    if (ship.location.kind !== 'landed' || sideKey(ship.location.side) !== sideKey(cmd.side)) {
      return reject(state, 'the ship must be landed on that hexside');
    }
    if (baseAtSide(state, cmd.side)) return reject(state, 'that hexside already has a base');
    const id = `base:${sideKey(cmd.side)}`;
    // "It is now treated as a planetary base and can provide detection and
    // planetary defense fire."
    const base: BaseState = {
      id,
      kind: 'planetary',
      owner: player,
      side: cmd.side,
      hex: cmd.side.hex,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: true,
      firedThisTurn: false,
      resuppliedThisTurn: false,
    };
    let s = withShip(state, addCargo(ship, 'orbitalBase', -1));
    s = withBase(s, base);
    s = log(
      s,
      `${shipLabel(ship)} unloads a base onto ${map.bodyAt(cmd.side.hex)?.name ?? 'the surface'}.`,
      { severity: 'good', focus: [cmd.side.hex] },
    );
    return { state: s, result: okResult };
  }

  const body = map.orbitOf(ship.pos, ship.velocity);
  if (!body) return reject(state, 'the ship must be in orbit to emplace a base');
  if (baseAtHex(state, ship.pos)) return reject(state, 'that hex already has a base');
  const id = `orbital:${key(ship.pos)}`;
  // "The base remains in that gravity hex; it does not literally orbit."
  const base: BaseState = {
    id,
    kind: 'orbital',
    owner: player,
    hex: ship.pos,
    destroyed: false,
    suppressed: false,
    hasPlanetaryDefences: false,
    firedThisTurn: false,
    resuppliedThisTurn: false,
  };
  let s = withShip(state, addCargo(ship, 'orbitalBase', -1));
  s = withBase(s, base);
  s = log(s, `${shipLabel(ship)} emplaces an orbital base over ${body.name}.`, {
    severity: 'good',
    focus: [ship.pos],
  });
  return { state: s, result: okResult };
};

// ---------------------------------------------------------------------------
// The resupply phase
// ---------------------------------------------------------------------------

/** Automated mines "extract 1 ton per turn"; the ore waits to be picked up. */
const runAutomatedMines = (state: GameState, player: PlayerId): GameState => {
  const data = logisticsData(state);
  const keys = Object.keys(data.mines).sort();
  if (keys.length === 0) return state;
  const mines: Record<string, MineSite> = { ...data.mines };
  let touched = false;
  for (const k of keys) {
    const site = mines[k]!;
    // One production tick per game turn: the owner's own resupply phase.
    if (site.owner !== player) continue;
    // A mine only produces where there is ore to produce.
    if (state.prospected[k] !== 'ore') continue;
    mines[k] = { ...site, stockpile: roundTons(site.stockpile + AUTOMATED_MINE_RATE) };
    touched = true;
  }
  return touched ? withLogistics(state, { mines }) : state;
};

/**
 * Prizes that have made it home. `resupply` does this for a ship that actually
 * refuels; this catches the one that simply sits at the base.
 */
const releaseCapturedShips = (state: GameState, map: GameMap): GameState => {
  let s = state;
  for (const id of Object.keys(state.ships).sort()) {
    const ship = s.ships[id];
    if (!ship || ship.destroyed || ship.capturedBy === undefined) continue;
    const check = canResupplyAt(s, ship, map);
    if (!check.ok || check.baseId === undefined) continue;
    const base = s.bases[check.baseId];
    if (!base) continue;
    s = releaseCapture(s, id, base);
  }
  return s;
};

/**
 * "Mines remain active for five turns, after which they self-destruct" — and the
 * same for torpedoes and nukes.
 *
 * The countdown is *derived* from the launch turn rather than decremented, so
 * calling this twice in a player-turn cannot age a mine twice; and it is clamped
 * to whatever the ordnance module has already written, so it can only ever bring
 * a self-destruct forward, never postpone one.
 */
const ageOrdnance = (state: GameState, player: PlayerId): GameState => {
  let s = state;
  for (const id of Object.keys(state.ordnance).sort()) {
    const o = s.ordnance[id];
    if (!o || o.owner !== player) continue;
    const elapsed = s.turn - o.launchedTurn + 1;
    const remaining = Math.min(o.turnsRemaining, ORDNANCE_LIFETIME - elapsed);
    if (remaining <= 0) {
      s = removeOrdnance(s, id);
      s = log(s, `A ${o.kind} launched on day ${o.launchedTurn} self-destructs.`, {
        focus: [o.pos],
      });
      continue;
    }
    if (remaining !== o.turnsRemaining) {
      s = { ...s, ordnance: { ...s.ordnance, [id]: { ...o, turnsRemaining: remaining } } };
    }
  }
  return s;
};

/**
 * Fleet Mutiny: "A planetary base is captured if an enemy warship lands there
 * while no friendly warship is present." Off by default; scenarios opt in with
 * `scenarioData.baseCaptureByLanding`.
 */
export function captureBasesByLanding(state: GameState, map: GameMap): GameState {
  if (state.scenarioData['baseCaptureByLanding'] !== true) return state;
  let s = state;
  for (const base of Object.values(state.bases)) {
    if (base.kind !== 'planetary' || base.destroyed || !base.side) continue;
    const side = base.side;
    const landed = Object.values(s.ships).filter(
      (sh) =>
        !sh.destroyed &&
        sh.location.kind === 'landed' &&
        sideKey(sh.location.side) === sideKey(side) &&
        SHIP_CLASSES[sh.shipClass].warship,
    );
    if (landed.length === 0) continue;
    const owner = base.owner;
    const defenders = owner === null ? [] : landed.filter((sh) => areAllied(s, owner, sh.owner));
    if (defenders.length > 0) continue;
    const taker = landed[0]!;
    const captor = controllerOf(taker);
    if (owner !== null && areAllied(s, owner, captor)) continue;
    s = withBase(s, { ...base, owner: captor });
    s = log(
      s,
      `${shipLabel(taker)} seizes the base at ${map.body(baseBodyId(base, map))?.name ?? base.id}.`,
      { severity: 'warn', focus: [base.hex] },
    );
  }
  return s;
}

/**
 * The resupply phase's automatic half.
 *
 * "5. Resupply Phase. Spaceships may refuel, resupply, load and unload cargo,
 * loot captured ships, or rescue, as appropriate. Damage is recovered." The
 * player-driven half arrives as commands; this runs everything that happens on
 * its own, ending with repairs, which "recover at the end of the Resupply phase".
 *
 * Prospecting is rolled here rather than in the movement phase — its natural
 * home — because this is the hook the turn driver guarantees; it is idempotent
 * and gated on the scenario, so nothing else has to know.
 */
export function runResupplyPhase(state: GameState, map: GameMap): GameState {
  const player = activePlayer(state);
  let s = state;
  s = runProspecting(s, map);
  s = runAutomatedMines(s, player);
  s = releaseCapturedShips(s, map);
  s = captureBasesByLanding(s, map);
  s = ageOrdnance(s, player);
  // "A damaged ship will repair itself at the rate of one 'D' per turn. It
  // recovers at the end of the Resupply phase."
  s = recoverDamage(s, player);
  return s;
}
