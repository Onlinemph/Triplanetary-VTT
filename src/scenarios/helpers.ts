/**
 * Shared scenario-construction and victory-analysis helpers.
 *
 * Everything here is a pure function of its arguments. The two jobs it does:
 *
 *  1. **Setup.** Turning rulebook phrases like "a corsair in orbit around Venus"
 *     or "the Enforcers have all bases on the map with the exception of
 *     Clandestine" into the `Ship` and `BaseState` records `createInitialState`
 *     wants, without every scenario file hand-rolling the same spreads.
 *  2. **Reading a state back.** Victory conditions ask questions the engine has
 *     no reason to answer for itself — "has this ship passed a gravity hex of
 *     every full-gravity body?", "how much fuel has it burned?" — and those
 *     answers are all derivable from the course record each ship carries.
 */

import { toPlane } from '@engine/geometry.js';
import {
  type Hex,
  type HexSide,
  ORIGIN,
  hex,
  directionTo,
  distance,
  eq,
  hexSide,
  key,
  neighbor,
  sideKey,
  sub,
  withinRadius,
} from '@engine/hex.js';
import { type GameMap } from '@engine/map.js';
import { MAP_RADIUS } from '@engine/mapdata.js';
import { type RngState, shuffle } from '@engine/rng.js';
import { CARGO, SHIP_CLASSES, type CargoKind, type ShipClass } from '@engine/ships.js';
import { ZERO, makePlayer, makeShip } from '@engine/state.js';
import type {
  BaseState,
  CargoItem,
  GameState,
  Player,
  PlayerId,
  Ship,
  ShipId,
  VictoryState,
} from '@engine/types.js';
import type { BuildOptions, PlayerTemplate } from './types.js';

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

/**
 * The seed used when a caller does not supply one. Every scenario is fully
 * determined by its seed, so a fixed default makes a fresh game reproducible
 * and makes the scenario tests deterministic without any extra plumbing.
 */
export const DEFAULT_SEED = 20370101;

export const seedOf = (opts: BuildOptions): number => opts.seed ?? DEFAULT_SEED;

/**
 * How many seats to fill.
 *
 * `BuildOptions` carries no explicit player count; the length of `playerNames`
 * is the caller's way of saying how many are playing. With no names at all a
 * scenario fills its full complement.
 */
export const seatCount = (
  opts: BuildOptions,
  min: number,
  max: number,
  fallback: number,
): number => {
  const asked = opts.playerNames?.length ?? fallback;
  return Math.max(min, Math.min(max, asked));
};

/** The player's own name for seat `index`, or the template's default. */
export const nameFor = (opts: BuildOptions, index: number, fallback: string): string => {
  const given = opts.playerNames?.[index];
  const trimmed = given?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** A `PlayerTemplate` plus the fixed id the scenario's ship records refer to. */
export interface PlayerSpec extends PlayerTemplate {
  readonly id: PlayerId;
  readonly allies?: readonly PlayerId[];
  readonly megacredits?: number;
  readonly points?: number;
}

export const templatesOf = (specs: readonly PlayerSpec[]): PlayerTemplate[] =>
  specs.map(({ faction, color, name }) => ({ faction, color, name }));

export const buildPlayers = (specs: readonly PlayerSpec[], opts: BuildOptions): Player[] =>
  specs.map((spec, i) =>
    makePlayer(spec.id, nameFor(opts, i, spec.name), spec.faction, spec.color, {
      allies: spec.allies ?? [],
      megacredits: spec.megacredits ?? 0,
      points: spec.points ?? 0,
    }),
  );

// ---------------------------------------------------------------------------
// Ship placement
// ---------------------------------------------------------------------------

export interface ShipOpts {
  readonly id: ShipId;
  readonly owner: PlayerId;
  readonly shipClass: ShipClass;
  readonly number?: number;
  readonly name?: string;
  readonly fuel?: number;
  readonly cargo?: readonly CargoItem[];
}

/** Cargo shorthand: `hold({ mine: 2, torpedo: 1 })`. */
export const hold = (items: Partial<Record<CargoKind, number>>): CargoItem[] => {
  const out: CargoItem[] = [];
  for (const kind of Object.keys(items) as CargoKind[]) {
    const quantity = items[kind];
    if (quantity !== undefined && quantity > 0) out.push({ kind, quantity });
  }
  return out;
};

/**
 * A ship sitting on a world.
 *
 * A landed ship's position is the world's own hex — the whole globe is one hex —
 * and the hexside records where it came down, because "It must take off from the
 * hex side where it landed."
 */
export const landed = (o: ShipOpts, side: HexSide): Ship =>
  makeShip({ ...o, pos: side.hex, location: { kind: 'landed', side } });

/**
 * A ship stopped at an asteroid base. "Ships may land at Ceres and Clandestine,
 * or at any unnamed asteroid in the Belt, by simply stopping in the hex."
 */
export const atAsteroidBase = (o: ShipOpts, h: Hex): Ship =>
  makeShip({ ...o, pos: h, location: { kind: 'asteroidBase', hex: h } });

/** A ship free in space, stationary unless a velocity is given. */
export const inSpace = (o: ShipOpts, pos: Hex, velocity: Hex = ZERO): Ship =>
  makeShip({ ...o, pos, velocity });

/** Counter-clockwise (+1) or clockwise (-1) around a body. */
export type OrbitSense = 1 | -1;

/**
 * A ship already in orbit at the start of play.
 *
 * "A ship which moves at one hex per turn from one gravity hex to an adjacent
 * gravity hex of the same body is in orbit." That fixes everything: the ship
 * stands in gravity hex `dir`, arrived from the neighbouring gravity hex, and
 * carries the pull it picked up on the way in — "Gravity takes effect on the
 * turn after an object enters the gravity hex". Without that pending arrow the
 * ship would fly off on its first turn instead of coasting round.
 *
 * Weak gravity (Luna, Io) is optional for the first hex of a run, so it is
 * seeded as an *accepted* optional pull rather than a mandatory one; a pilot who
 * declines it on turn 1 leaves orbit, which is exactly the choice the rules give.
 */
export const inOrbit = (
  o: ShipOpts,
  map: GameMap,
  bodyId: string,
  dir: number,
  sense: OrbitSense = 1,
): Ship => {
  const body = map.body(bodyId);
  if (!body) throw new Error(`unknown body ${bodyId}`);
  const pos = neighbor(body.hex, dir);
  const previous = neighbor(body.hex, dir - sense);
  const ship = makeShip({ ...o, pos, velocity: sub(pos, previous) });
  const inward = sub(body.hex, pos);
  if (body.gravity === 'weak') {
    return {
      ...ship,
      pendingGravity: ZERO,
      optionalGravity: [pos],
      acceptedOptionalGravity: [key(pos)],
    };
  }
  return { ...ship, pendingGravity: inward };
};

/**
 * Put a ship in orbit around whatever body owns the gravity hex it is standing
 * in — "Vessels in gravity hexes may be assumed to be in orbit, and the
 * direction of their orbits indicated." Returns `null` for a hex with no gravity.
 */
export const orbitAtHex = (
  o: ShipOpts,
  map: GameMap,
  pos: Hex,
  sense: OrbitSense = 1,
): Ship | null => {
  const source = map.gravityAt(pos)[0];
  if (!source) return null;
  const body = map.body(source.bodyId);
  if (!body) return null;
  const dir = directionTo(body.hex, pos);
  if (dir < 0) return null;
  return inOrbit(o, map, source.bodyId, dir, sense);
};

// ---------------------------------------------------------------------------
// Bases
// ---------------------------------------------------------------------------

/** The hexside `dir` of a world, whether or not it carries a printed base. */
export const sideOf = (map: GameMap, bodyId: string, dir: number): HexSide => {
  const body = map.body(bodyId);
  if (!body) throw new Error(`unknown body ${bodyId}`);
  return hexSide(body.hex, dir);
};

/** Every printed base site on a world, in hexside order. */
export const baseSidesOf = (map: GameMap, bodyId: string): HexSide[] =>
  map
    .allPlanetaryBases()
    .filter((b) => b.bodyId === bodyId)
    .map((b) => b.side);

/**
 * The base site on `bodyId` whose gravity hex lies nearest `toward` — the side a
 * pilot heading that way would naturally use. Ties break on the lower direction
 * index so the choice is deterministic.
 */
export const baseSideToward = (map: GameMap, bodyId: string, toward: Hex): HexSide => {
  const sides = baseSidesOf(map, bodyId);
  if (sides.length === 0) throw new Error(`${bodyId} has no bases`);
  let best = sides[0]!;
  let bestDistance = Infinity;
  for (const side of sides) {
    const d = distance(neighbor(side.hex, side.dir), toward);
    if (d < bestDistance) {
      bestDistance = d;
      best = side;
    }
  }
  return best;
};

/** How planetary defences are distributed across the scenario's bases. */
export type DefenceSpec = 'as-printed' | 'none' | readonly string[];

export interface BaseSpec {
  /** Owner per body id. Bodies not listed fall back to `defaultOwner`. */
  readonly owners?: Readonly<Record<string, PlayerId | null>>;
  /**
   * Owner per individual base id (`"terra:0"`, `"ceres"`), for scenarios that
   * split a world between players — Nova's "The EastBloc selects three adjacent
   * Terran hexsides; the WestBloc gets the other three." Takes precedence over
   * `owners`, and naming a site here also puts it in use.
   */
  readonly sites?: Readonly<Record<string, PlayerId | null>>;
  readonly defaultOwner?: PlayerId | null;
  /**
   * Bodies (or individual base ids) whose bases are not in use this scenario
   * ("Only Terra, Venus, and Io have bases"). There is no "absent" flag on
   * `BaseState` — a base that is not there is exactly one that cannot be
   * refuelled at, taken off from, or used as a detector, which is what
   * `destroyed` already means.
   */
  readonly absent?: readonly string[];
  /**
   * The inverse: when given, *only* these bodies or base ids are in use, plus
   * anything named in `sites`. Nova's colonies work this way — a bloc's farther
   * colony "has only one base".
   */
  readonly present?: readonly string[];
  /** Which bodies keep planetary defences ("Planetary defenses are not operating"). */
  readonly defences?: DefenceSpec;
  /** Extra orbital bases the scenario places, beyond the printed chart. */
  readonly orbital?: readonly { id: string; owner: PlayerId; hex: Hex }[];
}

/**
 * Materialise the scenario's base ownership.
 *
 * "All bases marked on the map are assumed to be in use unless a scenario
 * indicates differently; the scenario will also indicate the ownership of the
 * various bases."
 */
export const buildBases = (map: GameMap, spec: BaseSpec = {}): BaseState[] => {
  const absent = new Set(spec.absent ?? []);
  const present = spec.present ? new Set(spec.present) : undefined;
  const sites = spec.sites;

  const defenceOf = (bodyId: string, printed: boolean): boolean => {
    if (spec.defences === undefined || spec.defences === 'as-printed') return printed;
    if (spec.defences === 'none') return false;
    return printed && spec.defences.includes(bodyId);
  };
  const ownerOf = (siteId: string, bodyId: string): PlayerId | null => {
    if (sites && siteId in sites) return sites[siteId] ?? null;
    const owners = spec.owners;
    if (owners && bodyId in owners) return owners[bodyId] ?? null;
    return spec.defaultOwner ?? null;
  };
  const missing = (siteId: string, bodyId: string): boolean => {
    if (sites && siteId in sites) return false;
    if (present) return !present.has(siteId) && !present.has(bodyId);
    return absent.has(siteId) || absent.has(bodyId);
  };

  const out: BaseState[] = [];

  for (const site of map.allPlanetaryBases()) {
    out.push({
      id: site.id,
      kind: 'planetary',
      owner: ownerOf(site.id, site.bodyId),
      side: site.side,
      hex: site.side.hex,
      destroyed: missing(site.id, site.bodyId),
      suppressed: false,
      hasPlanetaryDefences: defenceOf(site.bodyId, site.hasPlanetaryDefences),
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    });
  }

  for (const site of map.allAsteroidBases()) {
    out.push({
      id: site.id,
      kind: 'asteroid',
      owner: ownerOf(site.id, site.bodyId),
      hex: site.hex,
      destroyed: missing(site.id, site.bodyId),
      suppressed: false,
      // "They serve the ordinary functions of a base but do not have planetary
      // defenses."
      hasPlanetaryDefences: false,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    });
  }

  for (const o of spec.orbital ?? []) {
    out.push({
      id: o.id,
      kind: 'orbital',
      owner: o.owner,
      hex: o.hex,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: false,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    });
  }

  return out;
};

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The combat strength point system (rulebook p. 9): "Ships are acquired on the
 * basis of combat strength points. Commercial ships with D-suffix strengths cost
 * half the printed strength (a liner costs 1 point, a transport or tanker costs
 * 1/2 point). This system is basic, and deals only with the costs of ships. Fuel
 * is free in this system and available at any base."
 *
 * Used by Nova's 50-point fleets, Retribution's Freedom Fleet and Piracy's
 * "2 points for every point of combat strength".
 */
export const combatPointCost = (cls: ShipClass): number => {
  const def = SHIP_CLASSES[cls];
  return def.defensiveOnly ? def.combatStrength / 2 : def.combatStrength;
};

// ---------------------------------------------------------------------------
// Deterministic placement
// ---------------------------------------------------------------------------

/** Every ordinary asteroid hex, in a stable order, for scenarios that hide in the Belt. */
export const asteroidHexes = (map: GameMap): Hex[] =>
  [...map.belt.asteroids]
    .sort()
    .map((k) => {
      const comma = k.indexOf(',');
      return { q: Number(k.slice(0, comma)), r: Number(k.slice(comma + 1)) };
    })
    .filter((h) => map.inBounds(h));

/**
 * Plausible stations near a set of worlds: their gravity hexes (an orbit) and
 * the clear space just outside (a picket). Used by scenarios that say only
 * "these may be placed anywhere on the map" but whose play is all in-system.
 */
export const sitesAround = (map: GameMap, bodyIds: readonly string[], maxRing = 5): Hex[] => {
  const occupied = new Set(map.bodies.map((b) => key(b.hex)));
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const id of bodyIds) {
    const body = map.body(id);
    if (!body) continue;
    for (const h of withinRadius(body.hex, maxRing)) {
      const k = key(h);
      if (seen.has(k) || occupied.has(k)) continue;
      if (!map.inBounds(h) || map.isAsteroid(h)) continue;
      seen.add(k);
      out.push(h);
    }
  }
  out.sort((a, b) => key(a).localeCompare(key(b)));
  return out;
};

/**
 * Pick `count` hexes from `candidates`, no two closer than `minDistance`.
 *
 * The candidate list is shuffled through the game's own generator, so the layout
 * is random from the players' point of view and identical for a given seed.
 * Greedy selection is enough here: the callers only ever ask for a handful of
 * sites out of hundreds.
 */
export const pickSpaced = (
  rng: RngState,
  candidates: readonly Hex[],
  count: number,
  minDistance: number,
  /** Hexes already spoken for, which the new picks must also stay clear of. */
  already: readonly Hex[] = [],
): { rng: RngState; hexes: Hex[] } => {
  const shuffled = shuffle(rng, candidates);
  const chosen: Hex[] = [];
  const blocked = [...already];
  for (const h of shuffled.items) {
    if (chosen.length >= count) break;
    if (blocked.every((c) => distance(c, h) >= minDistance)) {
      chosen.push(h);
      blocked.push(h);
    }
  }
  return { rng: shuffled.state, hexes: chosen };
};

/**
 * Unit vector pointing from `from` toward `to`, or zero when they coincide.
 *
 * Hex distance is flat-topped: from most hexes two or three of the six
 * directions reduce it by exactly one, and picking the first of them by index
 * can end up 60° off the true bearing. Ties therefore break on the *geometric*
 * heading — the direction whose plane vector best aligns with the real one —
 * which is the step a player tracing a straight edge would take.
 */
export const stepToward = (from: Hex, to: Hex): Hex => {
  const d = distance(from, to);
  if (d === 0) return ZERO;
  const bearing = toPlane(sub(to, from));
  let best = ZERO;
  let bestDistance = d;
  let bestAlignment = -Infinity;
  for (let dir = 0; dir < 6; dir++) {
    const candidate = neighbor(from, dir);
    const cd = distance(candidate, to);
    if (cd > bestDistance) continue;
    const unit = toPlane(sub(candidate, from));
    const alignment = unit.x * bearing.x + unit.y * bearing.y;
    if (cd < bestDistance || alignment > bestAlignment) {
      bestDistance = cd;
      bestAlignment = alignment;
      best = sub(candidate, from);
    }
  }
  return best;
};

/**
 * Entry points along "the map edge closest to Jupiter", and the inward unit
 * vector an arriving fleet flies on.
 *
 * "Closest to Jupiter" is measured to Jupiter, not to a ray traced out past it:
 * the rim is enumerated in full and sorted by its actual hex distance to the
 * body. An earlier version walked outward from the target along `stepToward` and
 * took the hexes nearest the resulting apex, which put the alien fleet 11-14
 * hexes from Jupiter when the nearest rim hex is 7 — the ray's tie-break landed
 * 60° off the true bearing and the arc followed it there.
 *
 * `inward` is the heading from the chosen arc back toward Sol, which is the
 * course an arriving fleet flies at "a speed of one hex per turn".
 */
export const edgeToward = (
  map: GameMap,
  toward: Hex,
  count: number,
): { hexes: Hex[]; inward: Hex } => {
  const sol = map.body('sol')?.hex ?? ORIGIN;

  // The rim: in bounds, with at least one neighbour off the chart.
  const rim: Hex[] = [];
  const span = MAP_RADIUS + 2;
  for (let q = -span; q <= span; q++) {
    for (let r = -span; r <= span; r++) {
      const h = hex(q, r);
      if (!map.inBounds(h)) continue;
      for (let dir = 0; dir < 6; dir++) {
        if (!map.inBounds(neighbor(h, dir))) {
          rim.push(h);
          break;
        }
      }
    }
  }
  rim.sort((a, b) => {
    const d = distance(a, toward) - distance(b, toward);
    return d !== 0 ? d : key(a).localeCompare(key(b));
  });

  const hexes = rim.slice(0, Math.max(0, count));
  const anchor = hexes[0] ?? toward;
  return { hexes, inward: stepToward(anchor, sol) };
};

/**
 * Roll one die per entry until two rolls differ — the Nova colony draw, where
 * "If both sides roll the same number, both roll again."
 */
export const rollDistinct = (
  rng: RngState,
  count: number,
  roll: (r: RngState) => { state: RngState; value: number },
): { rng: RngState; values: number[] } => {
  let s = rng;
  for (let attempt = 0; attempt < 64; attempt++) {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const res = roll(s);
      s = res.state;
      values.push(res.value);
    }
    if (new Set(values).size === values.length) return { rng: s, values };
  }
  // Unreachable for count <= 6 with a fair die, but the loop must terminate.
  return { rng: s, values: Array.from({ length: count }, (_, i) => i + 1) };
};

// ---------------------------------------------------------------------------
// Reading a state back
// ---------------------------------------------------------------------------

export const shipLabelOf = (ship: Ship): string =>
  ship.name ?? `${SHIP_CLASSES[ship.shipClass].name} ${ship.number}`;

/** Live ships a player *owns*, prizes included, for "is this side wiped out?". */
export const ownedShips = (state: GameState, player: PlayerId): Ship[] =>
  Object.values(state.ships).filter((s) => !s.destroyed && s.owner === player);

/** Is this ship sitting on the named world (any hexside)? */
export const isLandedOn = (map: GameMap, ship: Ship, bodyId: string): boolean => {
  if (ship.destroyed || ship.location.kind !== 'landed') return false;
  return map.bodyAt(ship.location.side.hex)?.id === bodyId;
};

/** Is this ship stopped at the named asteroid base? */
export const isAtAsteroidBase = (map: GameMap, ship: Ship, bodyId: string): boolean => {
  if (ship.destroyed || ship.location.kind !== 'asteroidBase') return false;
  return map.bodyAt(ship.location.hex)?.id === bodyId;
};

/**
 * The turn on which a ship first arrived at a world, or `null` if it never has.
 *
 * A course leg that ends inside a body's hex can only be a landing: "If a ship's
 * course vector intersects the printed outline of an astral body, it has
 * crashed", so a ship that is still flying and has a leg ending there landed.
 */
export const arrivalTurn = (map: GameMap, ship: Ship, bodyId: string): number | null => {
  const body = map.body(bodyId);
  if (!body) return null;
  for (const leg of ship.course) {
    if (eq(leg.to, body.hex)) return leg.turn;
  }
  return null;
};

/**
 * Fuel a ship has burned on manoeuvres so far: "Fuel remaining for a ship may be
 * determined by inspection of course plots." Each circled arrow is one point,
 * each double circle two, and the point spent to land is recorded the same way.
 */
export const fuelBurned = (ship: Ship): number => ship.course.reduce((n, leg) => n + leg.accel, 0);

/**
 * Has this ship ever been disabled, even temporarily?
 *
 * `Ship` keeps only the disablement still outstanding, so the historical answer
 * has to come from the log — which is the game's own record of what happened,
 * and is written by `applyDamage` in exactly this shape.
 */
export const everDisabled = (state: GameState, ship: Ship): boolean => {
  if (ship.disabled > 0) return true;
  const needle = `${shipLabelOf(ship)} disabled for `;
  return state.log.some((entry) => entry.text.startsWith(needle));
};

/**
 * How many complete turns a player has kept its whole fleet on the ground.
 *
 * Retribution turns on this: "If the Enforcers hide, keeping their ships
 * grounded for 12 or more turns, then the Sons of Liberty win is automatic",
 * and the mirror clause punishes an indecisive rebel. Grounded means exactly
 * that — every surviving hull sitting at a base, and no course flown since — so
 * a fleet coasting in orbit doing nothing does not count as hiding.
 */
export const turnsGrounded = (state: GameState, player: PlayerId): number => {
  const fleet = ownedShips(state, player);
  if (fleet.length === 0) return 0;
  if (fleet.some((s) => s.location.kind === 'space')) return 0;

  let last = 0;
  for (const ship of Object.values(state.ships)) {
    if (ship.owner !== player) continue;
    for (const leg of ship.course) {
      if (leg.turn > last) last = leg.turn;
    }
  }
  return Math.max(0, state.turn - 1 - last);
};

/** Hexsides of a given world that appear in a list of `sideKey`s. */
export const sidesOnBody = (map: GameMap, bodyId: string, keys: readonly string[]): string[] => {
  const body = map.body(bodyId);
  if (!body) return [];
  const wanted = new Set<string>();
  for (let dir = 0; dir < 6; dir++) wanted.add(sideKey(hexSide(body.hex, dir)));
  return keys.filter((k) => wanted.has(k));
};

/**
 * Net worth for the Prospecting scenario: "counting all property at full
 * purchase value and unsold ore at MCr 2 per ton."
 *
 * Contraterrene shards have no list price, so they are valued at what Ceres pays
 * for them, the same market the ore price comes from.
 */
export const CT_SHARD_VALUATION = 100;
export const ORE_VALUATION = 2;

export const netWorth = (state: GameState, player: PlayerId): number => {
  let total = state.players[player]?.megacredits ?? 0;
  for (const ship of Object.values(state.ships)) {
    if (ship.destroyed || (ship.capturedBy ?? ship.owner) !== player) continue;
    total += SHIP_CLASSES[ship.shipClass].cost;
    for (const item of ship.cargo) {
      if (item.kind === 'ore') total += item.quantity * ORE_VALUATION;
      else if (item.kind === 'ctShard') total += item.quantity * CT_SHARD_VALUATION;
      else total += (CARGO[item.kind].cost ?? 0) * item.quantity;
    }
  }
  return Math.round(total * 100) / 100;
};

// ---------------------------------------------------------------------------
// Victory helpers
// ---------------------------------------------------------------------------

export const victory = (
  winners: readonly PlayerId[],
  level: VictoryState['level'],
  reason: string,
): VictoryState => ({ winners, level, reason });

/** Nobody wins: Lateral 7's "If the passengers... are destroyed, both players lose." */
export const mutualDefeat = (reason: string): VictoryState => ({
  winners: [],
  level: 'moral',
  reason,
});
