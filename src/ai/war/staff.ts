/**
 * The general staff: the computer playing Orbital Drop above the pilot.
 *
 * The pilot in `src/ai/index.ts` flies ships — routes, fuel, fights, prizes.
 * It has no idea what a war is for. Orbital Drop is a war: bases are the
 * prizes, a base falls to a landed force that beats its garrison in the
 * ground game, and the force has to be bought, loaded into holds, escorted
 * across the map and put down under guns that must first be silenced. Every
 * one of those is a decision, and none of them is the pilot's.
 *
 * So this module is the staff. It reads the war off the state — the purse,
 * the bases, the holds, the declared invasion — and answers four questions,
 * each with an ordinary command the reducer judges like anyone's:
 *
 *  - **What to buy** (resupply phase): a garrison for a base that needs one,
 *    the manifest of a transport at the yard, a hull when the fleet is short,
 *    a cybertank's repair when the purse allows.
 *  - **Where to fly** (astrogation): an errand per ship, which the pilot
 *    flies — the wave to orbit over the target, the escort with it, an
 *    empty transport home to load.
 *  - **When to declare** (ordnance): once enough of the wave is overhead
 *    and, against live guns, enough warships with it.
 *  - **When to land** (astrogation, the day after): with the hexside
 *    silenced, or on the last day of the window when it will not be.
 *
 * Every judgement is a weighted sum of readings, and the weights are the
 * table in `weights.ts`, learned by `scripts/tune-war.ts`.
 *
 * ## What it does not see
 *
 * §3.02: a garrison's composition is recorded secretly. The staff reads only
 * the garrisons of bases it holds, and prices an enemy base at its militia
 * plus a prior (`force.garrisonPrior`) — with fog of war on, `src/net/redact.ts`
 * withholds the enemy's ledger anyway, and without it the staff simply does
 * not look. `tests/ai-war.test.ts` pins that a hidden garrison changes
 * nothing about the staff's choice.
 *
 * ## The frozen sky
 *
 * §4.05: when the landers are down "the space game pauses". While a ground
 * battle is waiting to be fought, {@link skyFrozen} is true and every seat
 * the computer plays says nothing — not even the phase-ending order — so a
 * headless war stops at the freeze for the battle to be fought, exactly as
 * the shell mounts it.
 *
 * Pure and deterministic, like the pilot: a function of the state, ties
 * broken on ids.
 */

import {
  type BaseState,
  type Command,
  type GameMap,
  type GameState,
  type Hex,
  type HexSide,
  type PlayerId,
  type Ship,
  type ShipClass,
  CARGO,
  SHIP_CLASSES,
  type CargoKind,
  areAllied,
  canFire,
  canTradeAt,
  cargoCount,
  cargoSpace,
  combatStrength,
  controllerOf,
  distance,
  isSideSuppressed,
  neighbors,
  sideGravityHex,
} from '../../engine/index.js';
import {
  GARRISON_PRICES,
  GROUND_PRICES,
  MILITIA_SQUADS,
  dropData,
  repairQuote,
} from '../../scenarios/orbitalDrop.js';
import { DEFAULT_WAR_WEIGHTS, type WarWeights } from './weights.js';

// ---------------------------------------------------------------------------
// Is this a war at all?
// ---------------------------------------------------------------------------

const DROP_KEY = 'orbitalDrop';

/** The scenario is Orbital Drop: the staff has a war to run. */
export const isWar = (state: GameState): boolean =>
  state.scenarioId === 'orbital-drop' || state.scenarioData[DROP_KEY] !== undefined;

/**
 * §4.05: the landers are down and the ground battle has not been fought.
 * Nothing in the sky moves until it has.
 */
export const skyFrozen = (state: GameState): boolean =>
  isWar(state) && dropData(state).pendingGround !== null;

// ---------------------------------------------------------------------------
// Reading the war
// ---------------------------------------------------------------------------

type Force = Readonly<Record<string, number>>;

const isGroundCargo = (kind: CargoKind): boolean => kind in GROUND_PRICES;

/** The §2 list value of what a hold carries, in MCr. */
export const holdValue = (ship: Ship): number =>
  ship.cargo.reduce((n, c) => n + (GROUND_PRICES[c.kind] ?? 0) * c.quantity, 0);

const carriesGround = (ship: Ship): boolean =>
  ship.cargo.some((c) => isGroundCargo(c.kind) && c.quantity > 0);

/**
 * Dry in open space: a ship with no fuel and no orbit is going wherever it
 * was going, forever. It carries what it carries, but it is not a wave and
 * nothing is planned around it.
 */
const stranded = (ship: Ship, map: GameMap): boolean =>
  ship.fuel <= 0 &&
  ship.location.kind === 'space' &&
  map.orbitOf(ship.pos, ship.velocity) === undefined;

/** The loaded transports the staff can still send somewhere. */
const waveOf = (war: War): Ship[] =>
  war.transports.filter((s) => carriesGround(s) && !stranded(s, war.map));

/** The §2 list value of a garrison, in MCr. */
export const forceValue = (f: Force): number =>
  Object.entries(f).reduce((n, [unit, count]) => n + (GARRISON_PRICES[unit] ?? 0) * count, 0);

const isTransport = (ship: Ship): boolean => {
  const cls = SHIP_CLASSES[ship.shipClass];
  return !cls.warship && cls.cargoCapacity >= 50;
};

const isWarship = (ship: Ship): boolean => SHIP_CLASSES[ship.shipClass].warship;

/** A base the war can be fought over: on a world or a rock, standing. */
const invadable = (base: BaseState): boolean =>
  !base.destroyed &&
  base.kind !== 'orbital' &&
  (base.kind === 'asteroid' || base.side !== undefined);

/** The hex a ship must be in to be "overhead": over the hexside, or at the rock. */
export const overheadHex = (base: BaseState): Hex =>
  base.kind === 'planetary' && base.side ? sideGravityHex(base.side) : base.hex;

/** The base's planetary guns will fire on a lander (§4.03). */
const gunsLive = (state: GameState, base: BaseState): boolean =>
  base.kind === 'planetary' &&
  base.side !== undefined &&
  base.hasPlanetaryDefences &&
  !base.suppressed &&
  !isSideSuppressed(state, base.side);

/** Everything the staff reads more than once in one decision. */
interface War {
  readonly state: GameState;
  readonly map: GameMap;
  readonly me: PlayerId;
  readonly w: WarWeights;
  readonly purse: number;
  readonly ships: readonly Ship[];
  readonly transports: readonly Ship[];
  readonly warships: readonly Ship[];
  readonly enemies: readonly Ship[];
  readonly myBases: readonly BaseState[];
  readonly targets: readonly BaseState[];
  readonly drop: ReturnType<typeof dropData>;
  /** The invasion this power has declared, while it stands. */
  readonly invasion: { readonly base: string; readonly declaredTurn: number } | null;
}

const readWar = (state: GameState, me: PlayerId, map: GameMap, w: WarWeights): War => {
  const ships = Object.values(state.ships)
    .filter((s) => !s.destroyed)
    .sort((a, b) => a.id.localeCompare(b.id));
  const mine = ships.filter((s) => areAllied(state, me, controllerOf(s)));
  const bases = Object.values(state.bases).sort((a, b) => a.id.localeCompare(b.id));
  const drop = dropData(state);
  const inv = drop.invasion;
  return {
    state,
    map,
    me,
    w,
    purse: state.players[me]?.megacredits ?? 0,
    ships: mine,
    transports: mine.filter(isTransport),
    warships: mine.filter(isWarship),
    enemies: ships.filter((s) => !areAllied(state, me, controllerOf(s))),
    myBases: bases.filter((b) => !b.destroyed && b.owner !== null && areAllied(state, me, b.owner)),
    targets: bases.filter(
      (b) =>
        invadable(b) &&
        (b.owner === null || !areAllied(state, me, b.owner)) &&
        // §8.01: "Clandestine's special asteroids still protect the pirate
        // home base from approach" — a rock ringed by the dense belt is not a
        // target a transport without scanners can be sent at.
        !cordoned(state, map, b.hex),
    ),
    drop,
    invasion:
      inv && areAllied(state, me, inv.attacker)
        ? { base: inv.base, declaredTurn: inv.declaredTurn }
        : null,
  };
};

/** Is the approach to this hex closed by dense asteroids (the pirate cordon)? */
const cordoned = (state: GameState, map: GameMap, hex: Hex): boolean => {
  const cleared = new Set(state.clearedAsteroids);
  if (map.isDenseAsteroid(hex, cleared)) return true;
  return neighbors(hex).some((n) => map.isDenseAsteroid(n, cleared));
};

const nearestOwnBase = (war: War, to: Hex): BaseState | null => {
  let best: BaseState | null = null;
  let bestD = Infinity;
  for (const b of war.myBases) {
    if (!invadable(b)) continue; // an orbital base is no yard for a landing
    const d = distance(overheadHex(b), to);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
};

/** Enemy fighting strength the staff can see within `radius` of a hex. */
const enemyStrengthNear = (war: War, hex: Hex, radius: number): number =>
  war.enemies
    .filter((s) => distance(s.pos, hex) <= radius)
    .reduce((n, s) => n + combatStrength(s), 0);

const enemyTransportsNear = (war: War, hex: Hex, radius: number): number =>
  war.enemies.filter((s) => isTransport(s) && distance(s.pos, hex) <= radius).length;

// ---------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------

/**
 * Where the wave is: the loaded transports, or failing those the forward
 * yard. A wave in flight is measured from where it will be next day rather
 * than where it is, so a target it is closing on keeps its lead.
 */
const waveHex = (war: War, target: BaseState): Hex | null => {
  const lead = waveLead(war);
  if (lead !== undefined) {
    return { q: lead.pos.q + lead.velocity.q, r: lead.pos.r + lead.velocity.r };
  }
  const yard = nearestOwnBase(war, overheadHex(target));
  return yard ? overheadHex(yard) : null;
};

/** The loaded transport the wave is measured from: the lowest id still flying. */
const waveLead = (war: War): Ship | undefined => waveOf(war)[0];

/**
 * How far the wave can still be sent. A loaded wave is judged on the fuel
 * actually in the lead transport's tanks, not on a full load: a wave that
 * has flown half its range cannot be turned toward a target the other way.
 */
const waveReach = (war: War): number => {
  const lead = waveLead(war);
  if (lead === undefined) return transportReach();
  return Math.floor((Math.max(0, lead.fuel - 3) / 2) ** 2);
};

/**
 * How far a transport can be sent and still stop: braking sheds a hex of
 * speed a turn and every turn is a burn, so `d` hexes cost about `2·√d`
 * points, with two kept back to come to rest. A tanker would stretch it;
 * the pilot does not fly tanker operations, so the staff does not plan on
 * them.
 */
const transportReach = (): number => {
  const fuel = SHIP_CLASSES.transport.fuelCapacity;
  // Three points kept back: two to come to rest, one to make orbit.
  return Math.floor(((fuel - 3) / 2) ** 2);
};

/** How far an empty transport is sent to a better yard: well inside its tanks. */
const relocationReach = (): number => Math.floor(transportReach() * 0.75);

/**
 * What a base is worth going for, from where the wave is now.
 *
 * Distance is measured from the wave rather than from home, which is what
 * keeps the choice steady: a wave in flight toward a base gets closer to it
 * every day, so the base it was sent against keeps winning the comparison
 * without the staff having to remember anything.
 */
export const targetScore = (war: War, base: BaseState): number | null => {
  const from = waveHex(war, base);
  if (from === null) return null;
  const { w } = war;
  const at = overheadHex(base);
  let score = base.kind === 'planetary' ? w['target.planetary'] : w['target.asteroid'];
  if (base.owner === null) score *= w['target.neutral'];
  // Measured to the world, not the hexside: every base on a world is the same
  // trip, and scoring them alike lets the lowest id win steadily rather than
  // the choice wandering round the planet as the wave comes in.
  const trip = distance(from, base.hex);
  score -= trip * w['target.distance'];
  score -= Math.max(0, trip - waveReach(war)) * w['target.range'];
  // A wave in flight keeps going where it is going: the world it is nearest
  // (or as good as) gets a bonus of its own, so a fleet arriving over the
  // target does not send it on to the next one, and a transport's tanks are
  // not spent dithering between two worlds it could have reached either of.
  // For the same reason the enemy's fleet is weighed before the wave sails
  // and not after: a wave cannot outrun what it finds, only land under it.
  const flying = waveLead(war) !== undefined;
  if (flying && trip <= nearestWorldDistance(war, from) + 2) score += w['target.nearest'];
  if (gunsLive(war.state, base)) score -= w['target.guns'];
  if (!flying) score -= enemyStrengthNear(war, at, 6) * w['target.enemyStrength'];
  if (war.invasion?.base === base.id) score += w['target.committed'];
  return score;
};

/** How far the nearest world with a base worth taking is from a point. */
const nearestWorldDistance = (war: War, from: Hex): number =>
  war.targets.reduce((best, b) => Math.min(best, distance(from, b.hex)), Infinity);

/** The base the staff is going for, or null when nothing is worth it. */
export const chooseTarget = (war: War): BaseState | null => {
  let best: BaseState | null = null;
  let bestScore = -Infinity;
  for (const base of war.targets) {
    const s = targetScore(war, base);
    if (s === null) continue;
    if (s > bestScore + 1e-9) {
      best = base;
      bestScore = s;
    }
  }
  if (best === null || bestScore < war.w['target.min']) return null;
  return best;
};

// ---------------------------------------------------------------------------
// The landing force
// ---------------------------------------------------------------------------

/** What the defence of a base is expected to be worth, in MCr (§§3.01-3.02). */
const expectedDefence = (war: War, target: BaseState): number =>
  MILITIA_SQUADS * GARRISON_PRICES['INF']! +
  (target.owner === null ? 0 : war.w['force.garrisonPrior']);

interface Line {
  readonly kind: CargoKind;
  readonly appetite: number;
}

const LINES: readonly { readonly kind: CargoKind; readonly key: keyof WarWeights }[] = [
  { kind: 'gndINF', key: 'force.infantry' },
  { kind: 'gndHVY', key: 'force.heavy' },
  { kind: 'gndMSL', key: 'force.missile' },
  { kind: 'gndGEV', key: 'force.gev' },
  { kind: 'gndHWZ', key: 'force.howitzer' },
];

const OGRE_MODULE: CargoKind = 'mk3Module';
const OGRE_MODULES = 4;

/**
 * A hold's worth of ground force, chosen by appetite and cut to a budget.
 *
 * Tons are shared out in proportion to the appetites, rounded down to whole
 * counters, and the slack goes to infantry, which fits anywhere. If the
 * budget will not cover it the dearest items come off first; if it will not
 * cover a squad, the hold stays empty.
 */
export const manifestFor = (
  w: WarWeights,
  capacity: number,
  budget: number,
): Partial<Record<CargoKind, number>> => {
  const lines: Line[] = LINES.map((l) => ({ kind: l.kind, appetite: Math.max(0, w[l.key]) }));
  const total = lines.reduce((n, l) => n + l.appetite, 0);
  const out: Partial<Record<CargoKind, number>> = {};
  if (total <= 0 || capacity <= 0) return out;

  let tons = 0;
  for (const l of lines) {
    if (l.kind === 'gndINF' || l.appetite <= 0) continue;
    const mass = CARGO[l.kind].mass;
    const count = Math.floor((capacity * l.appetite) / total / mass);
    if (count > 0) {
      out[l.kind] = count;
      tons += count * mass;
    }
  }
  const squads = Math.floor((capacity - tons) / CARGO.gndINF.mass);
  if (squads > 0) out['gndINF'] = squads;

  // Cut to the budget, dearest first.
  const cost = (): number =>
    (Object.keys(out) as CargoKind[]).reduce(
      (n, k) => n + (GROUND_PRICES[k] ?? 0) * (out[k] ?? 0),
      0,
    );
  while (cost() > budget) {
    const dearest = (Object.keys(out) as CargoKind[])
      .filter((k) => (out[k] ?? 0) > 0)
      .sort((a, b) => (GROUND_PRICES[b] ?? 0) - (GROUND_PRICES[a] ?? 0) || a.localeCompare(b))[0];
    if (dearest === undefined) break;
    out[dearest] = (out[dearest] ?? 0) - 1;
    if (out[dearest] === 0) delete out[dearest];
  }
  return out;
};

/**
 * Transports landed at the forward yard, in id order. A transport at some
 * other base of ours is not loaded there: the wave is bought where the trip
 * to the target is shortest, and the transport goes there empty first.
 */
const transportsAtYard = (
  war: War,
  target: BaseState | null,
): { ship: Ship; base: BaseState }[] => {
  const out: { ship: Ship; base: BaseState }[] = [];
  for (const ship of war.transports) {
    const at = canTradeAt(war.state, ship, war.map);
    if (!at.ok || at.baseId === undefined) continue;
    const base = war.state.bases[at.baseId];
    if (!base || base.owner === null || !areAllied(war.state, war.me, base.owner)) continue;
    if (!atForwardYard(war, base, target)) continue;
    out.push({ ship, base });
  }
  return out;
};

/**
 * What each transport at a yard should be carrying, from one shared budget.
 *
 * Computed for the whole yard at once so that one purse is not promised to
 * two holds. Earlier ids draw first. A hold already carrying something keeps
 * its plan as long as what is aboard fits it, so the plan is the same before
 * and after each purchase and the buying converges.
 */
export const yardPlans = (war: War): Map<string, Partial<Record<CargoKind, number>>> => {
  const plans = new Map<string, Partial<Record<CargoKind, number>>>();
  const target = chooseTarget(war);
  if (target === null) return plans;

  const wanted = expectedDefence(war, target) * war.w['force.overmatch'];
  const yard = transportsAtYard(war, target);
  const aboardElsewhere = waveOf(war)
    .filter((s) => !yard.some((y) => y.ship.id === s.id))
    .reduce((n, s) => n + holdValue(s), 0);
  let need = wanted - aboardElsewhere;
  // The whole yard's holds are on the same purse, and what is already aboard
  // was paid for out of it.
  let budget = war.purse - war.w['force.reserve'] + yard.reduce((n, y) => n + holdValue(y.ship), 0);

  // A cybertank in modules, when the appetite is there and the hulls are:
  // four modules, four holds, all on the same beach the same day (§2.02).
  const wantOgre =
    war.w['force.ogre'] >= Math.max(...LINES.map((l) => war.w[l.key])) &&
    yard.length >= OGRE_MODULES &&
    budget >= GROUND_PRICES[OGRE_MODULE]! * OGRE_MODULES;
  let modules = wantOgre ? OGRE_MODULES : 0;

  for (const { ship } of yard) {
    if (need <= 0 && holdValue(ship) === 0) {
      plans.set(ship.id, {});
      continue;
    }
    const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
    let plan: Partial<Record<CargoKind, number>>;
    if (modules > 0 && cargoCount(ship, OGRE_MODULE) <= 1 && !carriesOther(ship, OGRE_MODULE)) {
      plan = { [OGRE_MODULE]: 1 };
      modules -= 1;
    } else {
      plan = manifestFor(war.w, capacity, Math.max(0, budget));
    }
    const cost = (Object.keys(plan) as CargoKind[]).reduce(
      (n, k) => n + (GROUND_PRICES[k] ?? 0) * (plan[k] ?? 0),
      0,
    );
    budget -= cost;
    need -= cost;
    plans.set(ship.id, plan);
  }
  return plans;
};

const carriesOther = (ship: Ship, kind: CargoKind): boolean =>
  ship.cargo.some((c) => c.kind !== kind && isGroundCargo(c.kind) && c.quantity > 0);

/** Whether a transport's hold holds everything its plan asked for. */
const holdComplete = (ship: Ship, plan: Partial<Record<CargoKind, number>>): boolean =>
  (Object.keys(plan) as CargoKind[]).every((k) => cargoCount(ship, k) >= (plan[k] ?? 0));

/** The next ground purchase at any yard, or null when every hold is as planned. */
const groundPurchase = (war: War): Command | null => {
  const plans = yardPlans(war);
  for (const { ship } of transportsAtYard(war, chooseTarget(war))) {
    const plan = plans.get(ship.id) ?? {};
    for (const kind of Object.keys(plan).sort() as CargoKind[]) {
      const short = (plan[kind] ?? 0) - cargoCount(ship, kind);
      if (short <= 0) continue;
      const price = GROUND_PRICES[kind] ?? Infinity;
      const mass = CARGO[kind].mass;
      const quantity = Math.min(
        short,
        Math.floor(cargoSpace(ship) / mass),
        Math.floor(war.purse / price),
      );
      if (quantity <= 0) continue;
      return { type: 'purchaseGround', by: war.me, ship: ship.id, kind, quantity };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Garrisons and the shop
// ---------------------------------------------------------------------------

const OGRE_UNITS = ['MK1', 'MK2', 'MK3', 'MK5'];

const garrisonWorth = (war: War, base: BaseState): number => {
  const g = war.drop.garrisons[base.id];
  return g ? forceValue(g.units) + forceValue(g.reaction) : 0;
};

const garrisonWanted = (war: War, base: BaseState): number => {
  const at = overheadHex(base);
  return (
    (base.kind === 'planetary' ? war.w['garrison.planetary'] : war.w['garrison.asteroid']) +
    enemyStrengthNear(war, at, 8) * war.w['garrison.threat'] +
    enemyTransportsNear(war, at, 8) * war.w['garrison.transports']
  );
};

const armourUnitsOf = (f: Force): number =>
  Object.entries(f).reduce((n, [unit, count]) => {
    const per =
      unit === 'LT' || unit === 'LGEV'
        ? 0.5
        : unit === 'HWZ' || unit === 'MHWZ' || unit === 'SHVY'
          ? 2
          : unit === 'MCRL'
            ? 3
            : unit === 'INF' || OGRE_UNITS.includes(unit)
              ? 0
              : 1;
    return n + per * count;
  }, 0);

/**
 * One garrison purchase, for the base whose garrison falls shortest of what
 * the staff wants there — subject to the share of the war chest the staff
 * will sink into standing forces at all.
 */
const garrisonPurchase = (war: War): Command | null => {
  const { w } = war;
  const held = war.myBases.reduce((n, b) => n + garrisonWorth(war, b), 0);
  const ceiling = w['garrison.share'] * (war.purse + held);

  let pick: BaseState | null = null;
  let deficit = 0;
  for (const base of war.myBases) {
    if (!invadable(base)) continue;
    const d = garrisonWanted(war, base) - garrisonWorth(war, base);
    if (d > deficit + 1e-9) {
      deficit = d;
      pick = base;
    }
  }
  if (pick === null) return null;

  const g = war.drop.garrisons[pick.id] ?? { units: {}, reaction: {} };
  const all: Record<string, number> = { ...g.units };
  for (const [u, n] of Object.entries(g.reaction)) all[u] = (all[u] ?? 0) + n;
  const planetary = pick.kind === 'planetary';
  const armourCap = planetary ? 12 : 6;
  const squadCap = planetary ? 20 : 10;
  const squads = all['INF'] ?? 0;
  const armour = armourUnitsOf(all);
  const hasOgre = OGRE_UNITS.some((t) => (all[t] ?? 0) > 0);
  const total = Object.values(all).reduce((n, c) => n + c, 0);
  const reaction = Object.values(g.reaction).reduce((n, c) => n + c, 0);

  const affordable = (price: number): boolean =>
    war.purse >= price && held + price <= ceiling + 1e-9;

  // A cybertank, when it is the staff's first appetite and the armour slot is empty.
  const ogreAppetite = w['garrison.ogre'];
  if (
    ogreAppetite >= Math.max(w['garrison.infantry'], w['garrison.armour']) &&
    !hasOgre &&
    armour === 0
  ) {
    const type = planetary ? 'MK3' : 'MK2';
    const price = GARRISON_PRICES[type]!;
    if (affordable(price) && price <= deficit + price * 0.5) {
      return { type: 'purchaseGarrison', by: war.me, base: pick.id, unit: type, count: 1 };
    }
  }

  // Otherwise infantry or armour, whichever the appetite and the room favour.
  const infRoom = squads < squadCap;
  const armRoom = !hasOgre && armour < armourCap;
  const preferInf =
    infRoom &&
    (!armRoom ||
      w['garrison.infantry'] * (1 - squads / squadCap) >=
        w['garrison.armour'] * (1 - armour / armourCap));
  const unit = preferInf ? 'INF' : armRoom ? (armour % 2 === 0 ? 'HVY' : 'MSL') : null;
  if (unit === null) return null;
  const price = GARRISON_PRICES[unit]!;
  if (!affordable(price)) return null;
  // §3.03: no more than half stands off. One more into the reaction force is
  // legal only while the garrison proper still outnumbers it afterwards.
  const intoReaction =
    reaction + 1 <= total - reaction && reaction / Math.max(1, total) < w['garrison.reaction'];
  return {
    type: 'purchaseGarrison',
    by: war.me,
    base: pick.id,
    unit,
    count: 1,
    ...(intoReaction ? { reaction: true } : {}),
  };
};

/** A worn cybertank into the shop, when the purse can stand it (§7). */
const repairOrder = (war: War): Command | null => {
  for (const base of war.myBases) {
    const g = war.drop.garrisons[base.id];
    if (!g?.ogres) continue;
    for (let i = 0; i < g.ogres.length; i++) {
      const o = g.ogres[i]!;
      if (o.repairDoneOn !== undefined && o.repairDoneOn > war.state.turn) continue;
      const quote = repairQuote(o);
      if (quote.cost <= 0) continue;
      if (war.purse < quote.cost + war.w['repair.reserve']) continue;
      return { type: 'repairOgre', by: war.me, base: base.id, index: i };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// The yard
// ---------------------------------------------------------------------------

/**
 * The forward yard: the own base nearest the target — or, with no target
 * chosen, nearest any enemy base. Waves are loaded there, hulls are
 * commissioned there, and empty transports go there to wait, because a
 * transport's tanks are the war's real range and the trip that counts is
 * the last one.
 */
const yardFor = (war: War, target: BaseState | null = chooseTarget(war)): BaseState | null => {
  const enemyHexes = target ? [target.hex] : war.targets.map((b) => b.hex);
  let best: BaseState | null = null;
  let bestD = Infinity;
  for (const b of war.myBases) {
    if (!invadable(b)) continue;
    const d = enemyHexes.length ? Math.min(...enemyHexes.map((h) => distance(h, b.hex))) : 0;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
};

/** The same world as the forward yard: any of its pads will do for loading. */
const atForwardYard = (war: War, base: BaseState, target: BaseState | null): boolean => {
  const yard = yardFor(war, target);
  if (yard === null) return false;
  const here = war.map.bodyAt(base.hex)?.id ?? base.id;
  const there = war.map.bodyAt(yard.hex)?.id ?? yard.id;
  return here === there;
};

const commission = (war: War, shipClass: ShipClass): Command | null => {
  const yard = yardFor(war);
  if (yard === null) return null;
  return {
    type: 'purchaseShip',
    by: war.me,
    shipClass,
    at: yard.kind === 'planetary' && yard.side ? yard.side.hex : yard.hex,
    ...(yard.kind === 'planetary' && yard.side ? { side: yard.side } : {}),
  };
};

/** A hull from the yard, when the fleet is short and the purse is not. */
const hullPurchase = (war: War): Command | null => {
  const { w } = war;
  const spare = war.purse - w['fleet.reserve'];
  if (war.transports.length < w['fleet.transports'] && spare >= SHIP_CLASSES.transport.cost) {
    return commission(war, 'transport');
  }
  const strength = war.warships.reduce((n, s) => n + combatStrength(s), 0);
  if (strength < w['fleet.escortStrength']) {
    if (spare >= SHIP_CLASSES.frigate.cost) return commission(war, 'frigate');
    if (spare >= SHIP_CLASSES.corvette.cost) return commission(war, 'corvette');
  }
  return null;
};

// ---------------------------------------------------------------------------
// The orders
// ---------------------------------------------------------------------------

/** Everything the staff buys in the resupply phase, one order at a time. */
export const warResupplyOrder = (
  state: GameState,
  me: PlayerId,
  map: GameMap,
  w: WarWeights = DEFAULT_WAR_WEIGHTS,
): Command | null => {
  if (!isWar(state) || skyFrozen(state)) return null;
  const war = readWar(state, me, map, w);
  return (
    garrisonPurchase(war) ?? groundPurchase(war) ?? repairOrder(war) ?? hullPurchase(war) ?? null
  );
};

/** The share of the loaded wave that is in position over the target. */
const waveInPosition = (war: War, target: BaseState): { there: number; total: number } => {
  let there = 0;
  let total = 0;
  for (const ship of waveOf(war)) {
    const worth = holdValue(ship);
    if (worth <= 0) continue;
    total += worth;
    if (inPositionOver(war, ship, target)) there += worth;
  }
  return { there, total };
};

/** In orbit around the target's world, or stopped at the rock. */
const inPositionOver = (war: War, ship: Ship, target: BaseState): boolean => {
  if (target.kind === 'planetary') {
    const world = war.map.bodyAt(target.hex);
    return world !== undefined && war.map.orbitOf(ship.pos, ship.velocity)?.id === world.id;
  }
  return ship.location.kind === 'asteroidBase' && distance(ship.pos, target.hex) === 0;
};

const overhead = (war: War, target: BaseState): Ship[] =>
  war.ships.filter((s) => distance(s.pos, overheadHex(target)) === 0);

/**
 * §4.01: declare, in the ordnance phase, once enough of the wave is overhead
 * — and, against a base whose guns are live, enough warships with it to
 * silence the hexside this combat phase.
 */
export const warOrdnanceOrder = (
  state: GameState,
  me: PlayerId,
  map: GameMap,
  w: WarWeights = DEFAULT_WAR_WEIGHTS,
): Command | null => {
  if (!isWar(state) || skyFrozen(state)) return null;
  const war = readWar(state, me, map, w);
  if (war.drop.invasion !== null) return null;
  const target = chooseTarget(war);
  if (target === null) return null;
  const wave = waveInPosition(war, target);
  if (wave.total <= 0 || wave.there < wave.total * w['assault.commit']) return null;
  const above = overhead(war, target);
  if (above.length === 0) return null;
  // Against live guns the wave will not go down until a warship over the
  // hexside has silenced it (§4.02), and the window is two days. Declaring
  // before then is a gamble on the escort getting there in time, and the
  // weight says how much escort makes the gamble worth taking.
  if (gunsLive(state, target)) {
    const escort = war.warships
      .filter((s) => inPositionOver(war, s, target))
      .reduce((n, s) => n + combatStrength(s), 0);
    if (escort < w['assault.escort']) return null;
  }
  return { type: 'declareInvasion', by: me, base: target.id };
};

/**
 * §4.02: a warship over the hexside silences its guns, and fires at nothing
 * else that turn. Asked after the pilot has found nothing worth shooting.
 */
export const warCombatOrder = (
  state: GameState,
  me: PlayerId,
  map: GameMap,
  w: WarWeights = DEFAULT_WAR_WEIGHTS,
): Command | null => {
  if (!isWar(state) || skyFrozen(state)) return null;
  const war = readWar(state, me, map, w);
  const target = war.invasion ? (state.bases[war.invasion.base] ?? null) : chooseTarget(war);
  if (target === null || !gunsLive(state, target) || !target.side) return null;
  // Silence it the first time a warship passes over, while the wave is still
  // on its way: suppression is permanent here, and the shot costs nothing
  // the pilot wanted to fire anyway.
  if (war.invasion === null && waveOf(war).length === 0) return null;
  const side = target.side;
  for (const ship of overhead(war, target)) {
    if (!isWarship(ship) || ship.firedThisPhase) continue;
    if (!canFire(ship, state.options.advancedCombat)) continue;
    if (map.orbitOf(ship.pos, ship.velocity)?.id !== map.bodyAt(side.hex)?.id) continue;
    return { type: 'suppressHexside', by: me, ship: ship.id, side };
  }
  return null;
};

/** Where the staff sends a ship, in the pilot's own vocabulary. */
export interface WarErrand {
  readonly hex: Hex;
  readonly bodyId?: string;
  /** Be in orbit at `hex` and stay there: an escort over the target. */
  readonly orbit?: boolean;
  /** The errand ends on the ground, at this hexside. */
  readonly land: boolean;
  readonly side?: HexSide;
  /** A transport's trip: flown with fuel kept back, when a route allows it. */
  readonly frugal?: boolean;
  readonly why: string;
}

/**
 * To the target: into any orbit of its world — the ring carries a ship over
 * the hexside in its own time, and holding one hex of a ring is not a thing
 * a ship can do — or, when the landing is on, down onto the hexside itself.
 * A rock is reached by stopping in its hex, which is the landing.
 */
const errandTo = (war: War, base: BaseState, land: boolean, why: string): WarErrand => {
  if (base.kind === 'planetary' && base.side) {
    const world = war.map.bodyAt(base.side.hex);
    return {
      hex: land ? sideGravityHex(base.side) : (world?.hex ?? base.hex),
      ...(world ? { bodyId: world.id } : {}),
      land,
      side: base.side,
      ...(land ? {} : { orbit: true }),
      why,
    };
  }
  return { hex: base.hex, land: false, why };
};

/**
 * §4.04: the landers go down the day after the declaration — with the
 * hexside silenced, or on the last day of the window when it will not be.
 * Before that the wave holds in orbit.
 */
const mayLandNow = (war: War, target: BaseState): boolean => {
  const inv = war.invasion;
  if (inv === null || inv.base !== target.id) return false;
  if (war.state.turn <= inv.declaredTurn) return false;
  // Never down the guns' throats: 2:1 with any result a crash is a coin toss
  // for the whole wave. If the window shuts first, the staff declares again.
  return !gunsLive(war.state, target);
};

/**
 * The staff's errand for one ship, or null to leave it to the pilot.
 *
 * A loaded transport goes to the target and, once the invasion is declared
 * and the guns are quiet, down onto it. A warship rides with the wave and
 * holds over the hexside, where it can suppress and later strike. An empty
 * transport goes home to the nearest yard and stays down there until it has
 * a hold's worth to carry.
 */
export const warErrand = (
  state: GameState,
  ship: Ship,
  map: GameMap,
  w: WarWeights = DEFAULT_WAR_WEIGHTS,
): WarErrand | null => {
  if (!isWar(state)) return null;
  const me = controllerOf(ship);
  const war = readWar(state, me, map, w);
  const target = war.invasion ? (state.bases[war.invasion.base] ?? null) : chooseTarget(war);
  const wave = waveOf(war);

  if (isTransport(ship)) {
    if (stranded(ship, map)) return null; // nothing the pilot can do either
    if (carriesGround(ship)) {
      if (target === null) return homeErrand(war, ship);
      // A hold still being filled at the yard stays on the pad.
      const plans = yardPlans(war);
      const plan = plans.get(ship.id);
      if (plan !== undefined && !holdComplete(ship, plan)) return homeErrand(war, ship);
      return {
        ...errandTo(war, target, mayLandNow(war, target), 'carry the landing to the target'),
        frugal: true,
      };
    }
    return homeErrand(war, ship);
  }

  if (isWarship(ship) && target !== null && (wave.length > 0 || war.invasion !== null)) {
    return errandTo(war, target, false, 'escort the wave and silence the guns');
  }
  return null;
};

/**
 * Back to the yard, and down. The forward yard — the own base nearest the
 * enemy — rather than the nearest one: a wave is loaded where the trip to
 * the target is shortest, and a transport's fuel is the war's real range.
 */
const homeErrand = (war: War, ship: Ship): WarErrand | null => {
  const forward = yardFor(war);
  const nearest = nearestOwnBase(war, ship.pos);
  const yard =
    forward !== null && distance(ship.pos, forward.hex) <= relocationReach() ? forward : nearest;
  if (yard === null) return null;
  if (yard.kind === 'planetary' && yard.side) {
    const world = war.map.bodyAt(yard.side.hex);
    return {
      hex: sideGravityHex(yard.side),
      ...(world ? { bodyId: world.id } : {}),
      land: true,
      side: yard.side,
      frugal: true,
      why: 'return to the yard',
    };
  }
  return { hex: yard.hex, land: false, frugal: true, why: 'return to the yard' };
};

/** For tests and the tuner's report: the staff's reading of the position. */
export const warReading = (
  state: GameState,
  me: PlayerId,
  map: GameMap,
  w: WarWeights = DEFAULT_WAR_WEIGHTS,
): { target: string | null; wave: number; garrisons: Record<string, number> } => {
  const war = readWar(state, me, map, w);
  const target = chooseTarget(war);
  const garrisons: Record<string, number> = {};
  for (const b of war.myBases) garrisons[b.id] = garrisonWorth(war, b);
  return {
    target: target?.id ?? null,
    wave: waveOf(war).reduce((n, s) => n + holdValue(s), 0),
    garrisons,
  };
};
