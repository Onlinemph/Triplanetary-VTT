/**
 * **Orbital Drop** — the campaign that is literally Triplanetary.
 *
 * From docs/ORBITAL-DROP.md: "Triplanetary handles everything above the
 * atmosphere. Ogre handles everything below it. This ruleset is the seam
 * between them." The space game is played as written — real ships, real
 * vector plots, real interceptions and real planetary defences — and three
 * things are added on top (its §1):
 *
 *  1. Ground units join the equipment price list and ride as cargo (§2).
 *  2. Bases have garrisons, and taking a base means winning an Ogre battle
 *     (§§3-6) — fought in the embedded Ogre view on a battlefield generated
 *     from the world's terrain profile.
 *  3. Captured bases produce income for their new owner (§§1.01, 7).
 *
 * Time runs on Triplanetary turns (one day each) until an invasion lands.
 * Then the sky freezes — the shell mounts the ground battle over the chart —
 * and the campaign resumes with the result applied.
 *
 * One adaptation to this engine's phase order: an invasion is declared in
 * the ordnance phase (§4.01), but landing is an astrogation decision, and
 * astrogation comes first — so the landings begin the *day after* the
 * declaration. The garrison hears the alarm a day out, which is also when
 * its reaction force starts racing home. Suppress the hexside on the
 * declaration day (the Fleet Mutiny rule, §4.02) and the guns are silent
 * when the transports come down; leave it live and they fire once at each
 * lander — 2:1, unmodified — and a lander hit at all crashes with its cargo
 * (§4.03).
 */

import { type HexSide, eq, sideGravityHex } from '@engine/hex.js';
import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { combatStrength, isSideSuppressed } from '@engine/combat.js';
import { gunDamage } from '@engine/crt.js';
import { nextFloat, rollDie } from '@engine/rng.js';
import { canTradeAt, cargoSpace } from '@engine/logistics.js';
import { CARGO, SHIP_CLASSES, type CargoKind, type ShipClass } from '@engine/ships.js';
import { createInitialState } from '@engine/state.js';
import { addCargo, log, withBase, withShip } from '@engine/state.js';
import type {
  Command,
  CommandResult,
  DeclareInvasion,
  PurchaseGarrison,
  PurchaseGround,
  ResolveGroundBattle,
} from '@engine/commands.js';
import {
  type GameState,
  type PlayerId,
  type Ship,
  type VictoryState,
  activePlayer,
  areAllied,
  controllerOf,
} from '@engine/types.js';
import type { OrderOfBattle } from '@campaign/orders.js';
import {
  type PlayerSpec,
  baseSidesOf,
  buildBases,
  buildPlayers,
  hold,
  landed,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

type Force = Readonly<Record<string, number>>;

const COMBINE: PlayerId = 'combine';
const PANEURO: PlayerId = 'paneuro';
/** The seat a neutral base's militia fights from — nobody's, and garrisoned by nobody. */
const MILITIA: PlayerId = 'militia';

const SPECS: readonly PlayerSpec[] = [
  { id: COMBINE, faction: 'North American Combine', color: '#d94f4f', name: 'Combine' },
  { id: PANEURO, faction: 'Paneuropean Federation', color: '#3f7fd0', name: 'Paneurope' },
];

const factionOf = (id: PlayerId): string =>
  SPECS.find((s) => s.id === id)?.faction ?? (id === MILITIA ? 'Base Militia' : id);

// ---------------------------------------------------------------------------
// The numbers, straight from docs/ORBITAL-DROP.md
// ---------------------------------------------------------------------------

/** §1.01: "Every base a player controls generates MCr 0.5 per day." */
export const BASE_INCOME_PER_DAY = 0.5;
/** §3.01: "Every base has a standing militia of 6 infantry squads at no cost." */
export const MILITIA_SQUADS = 6;
/** §3.03: the reaction force enters from ground turn 5. */
export const REACTION_TURN = 5;
export const OPENING_TREASURY = 300;

/** §2: ground cargo prices in MCr, by cargo kind. Masses live in `CARGO`. */
export const GROUND_PRICES: Readonly<Partial<Record<CargoKind, number>>> = {
  gndINF: 1,
  gndHVY: 5,
  gndMSL: 5,
  gndGEV: 5,
  gndLT: 3,
  gndLGEV: 3,
  gndHWZ: 10,
  gndMHWZ: 10,
  gndSHVY: 10,
  gndMCRL: 15,
  // §2.02: an Ogre ships disassembled at MCr 5 and 10 tons per armour-unit
  // equivalent, in 50-ton modules with the last module rounded up. A Mark III
  // is 17 equivalents: MCr 85 over four modules. A Mark V is 25: MCr 125 over
  // five.
  mk3Module: 21.25,
  mk5Module: 25,
};

/** Ground units per module kind, once every module is on the ground. */
export const MODULES_PER_OGRE: Readonly<Record<string, { type: string; modules: number }>> = {
  mk3Module: { type: 'MK3', modules: 4 },
  mk5Module: { type: 'MK5', modules: 5 },
};

/** Cargo kind → the Ogre engine's unit vocabulary, for the order of battle. */
const KIND_TO_UNIT: Readonly<Partial<Record<CargoKind, string>>> = {
  gndINF: 'INF',
  gndHVY: 'HVY',
  gndMSL: 'MSL',
  gndGEV: 'GEV',
  gndLT: 'LT',
  gndLGEV: 'LGEV',
  gndHWZ: 'HWZ',
  gndMHWZ: 'MHWZ',
  gndSHVY: 'SHVY',
  gndMCRL: 'MCRL',
};

/** §3.02: garrison purchase prices, in the Ogre vocabulary the garrison keeps. */
export const GARRISON_PRICES: Readonly<Record<string, number>> = {
  INF: 1,
  HVY: 5,
  MSL: 5,
  GEV: 5,
  LT: 3,
  LGEV: 3,
  HWZ: 10,
  MHWZ: 10,
  SHVY: 10,
  MCRL: 15,
  MK3: 85,
  MK5: 125,
};

/** Armour-unit equivalents for the garrison caps (§3.02, after Ogre 1.07). */
const ARMOUR_UNITS: Readonly<Record<string, number>> = {
  HVY: 1,
  MSL: 1,
  GEV: 1,
  LT: 0.5,
  LGEV: 0.5,
  HWZ: 2,
  MHWZ: 2,
  SHVY: 2,
  MCRL: 3,
};

/** §5: each world's terrain profile, deciding the generated battlefield. */
export const WORLD_PROFILES: Readonly<Record<string, 'dead' | 'living' | 'volcanic' | 'asteroid'>> =
  {
    terra: 'living',
    venus: 'living',
    callisto: 'living',
    luna: 'dead',
    mars: 'dead',
    mercury: 'dead',
    ganymede: 'dead',
    io: 'volcanic',
    ceres: 'asteroid',
    clandestine: 'asteroid',
  };

// ---------------------------------------------------------------------------
// Scenario data
// ---------------------------------------------------------------------------

interface GarrisonState {
  readonly units: Force;
  readonly reaction: Force;
  /** The militia is rebuilding until this day (§3.01: back one day after a battle). */
  readonly militiaDownUntil?: number;
  /** A captured base pays no income until this day (§7). */
  readonly incomeFrom?: number;
}

interface Invasion {
  readonly base: string;
  readonly world: string;
  readonly side: HexSide;
  readonly attacker: PlayerId;
  readonly declaredTurn: number;
}

interface DropData {
  readonly garrisons: Readonly<Record<string, GarrisonState>>;
  readonly invasion: Invasion | null;
  /** The frozen sky: the ground battle waiting to be fought (§4.05). */
  readonly pendingGround: OrderOfBattle | null;
  readonly battleSerial: number;
}

const EMPTY_DROP: DropData = {
  garrisons: {},
  invasion: null,
  pendingGround: null,
  battleSerial: 1,
};

export const dropData = (state: GameState): DropData => ({
  ...EMPTY_DROP,
  ...(state.scenarioData['orbitalDrop'] as Partial<DropData> | undefined),
});

const withDropData = (state: GameState, patch: Partial<DropData>): GameState => ({
  ...state,
  scenarioData: {
    ...state.scenarioData,
    orbitalDrop: { ...dropData(state), ...patch },
  },
});

const garrisonOf = (state: GameState, base: string): GarrisonState =>
  dropData(state).garrisons[base] ?? { units: {}, reaction: {} };

const withGarrison = (state: GameState, base: string, g: GarrisonState): GameState =>
  withDropData(state, { garrisons: { ...dropData(state).garrisons, [base]: g } });

// ---------------------------------------------------------------------------
// Small force arithmetic
// ---------------------------------------------------------------------------

const forceAdd = (a: Force, unit: string, count: number): Force => ({
  ...a,
  [unit]: (a[unit] ?? 0) + count,
});

const forceTotal = (f: Force): number => Object.values(f).reduce((n, c) => n + c, 0);

const squadsOf = (f: Force): number => f['INF'] ?? 0;

const hasOgre = (f: Force): boolean => (f['MK3'] ?? 0) + (f['MK5'] ?? 0) > 0;

const armourUnitsOf = (f: Force): number =>
  Object.entries(f).reduce((n, [unit, count]) => n + (ARMOUR_UNITS[unit] ?? 0) * count, 0);

/** The §2 list value of a force, for the winner's 25% salvage credit (§7). */
const forceValue = (f: Force): number =>
  Object.entries(f).reduce((n, [unit, count]) => n + (GARRISON_PRICES[unit] ?? 0) * count, 0);

const forceSubtract = (a: Force, b: Force): Force => {
  const out: Record<string, number> = {};
  for (const [unit, count] of Object.entries(a)) {
    const left = count - (b[unit] ?? 0);
    if (left > 0) out[unit] = left;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface FleetEntry {
  readonly shipClass: ShipClass;
  readonly count: number;
}

/** A modest working fleet each; the war is bought, not issued. */
const OPENING_FLEET: readonly FleetEntry[] = [
  { shipClass: 'frigate', count: 1 },
  { shipClass: 'corvette', count: 2 },
  { shipClass: 'transport', count: 2 },
  { shipClass: 'tanker', count: 1 },
];

const buildFleet = (
  map: GameMap,
  owner: PlayerId,
  worlds: readonly string[],
  startNumber: number,
): Ship[] => {
  const sites: HexSide[] = worlds.flatMap((w) => baseSidesOf(map, w));
  const ships: Ship[] = [];
  let n = startNumber;
  for (const entry of OPENING_FLEET) {
    for (let i = 0; i < entry.count; i++) {
      const side = sites[n % Math.max(1, sites.length)]!;
      ships.push(
        landed(
          {
            id: `${owner}-${entry.shipClass}-${i + 1}`,
            owner,
            shipClass: entry.shipClass,
            number: n,
            cargo: hold({}),
          },
          side,
        ),
      );
      n += 1;
    }
  }
  return ships;
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const combineWorlds = ['terra', 'luna', 'venus'];
  const paneuroWorlds = ['callisto', 'io', 'ganymede', 'mars'];

  return createInitialState({
    scenarioId: 'orbital-drop',
    seed: seedOf(opts),
    players: buildPlayers(
      SPECS.map((s) => ({ ...s, megacredits: OPENING_TREASURY })),
      opts,
    ),
    ships: [
      ...buildFleet(map, COMBINE, combineWorlds, 1),
      ...buildFleet(map, PANEURO, paneuroWorlds, 100),
    ],
    bases: buildBases(map, {
      owners: {
        terra: COMBINE,
        luna: COMBINE,
        venus: COMBINE,
        callisto: PANEURO,
        io: PANEURO,
        ganymede: PANEURO,
        mars: PANEURO,
        mercury: null,
        ceres: null,
        clandestine: null,
      },
    }),
    options: { nukesAllowed: true, ...opts.options },
    scenarioData: {
      // Shipyards serve their owners: "Ships appear on any world controlled
      // by the player."
      purchaseRequiresControl: true,
      orbitalDrop: EMPTY_DROP,
    },
  });
};

// ---------------------------------------------------------------------------
// Orders (§§2-4, 7)
// ---------------------------------------------------------------------------

const refuse = (state: GameState, reason: string): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: false, reason },
});
const accept = (state: GameState): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: true },
});

const sideEq = (a: HexSide, b: HexSide): boolean => eq(a.hex, b.hex) && a.dir === b.dir;

const purchaseGround = (
  state: GameState,
  cmd: PurchaseGround,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  if (cmd.by !== activePlayer(state)) return refuse(state, 'it is not your turn');
  const ship = state.ships[cmd.ship];
  if (!ship || ship.destroyed) return refuse(state, 'no such ship');
  if (!areAllied(state, cmd.by, controllerOf(ship))) return refuse(state, 'not your ship');
  const price = GROUND_PRICES[cmd.kind];
  if (price === undefined) return refuse(state, `${CARGO[cmd.kind].name} is not ground equipment`);
  if (!Number.isInteger(cmd.quantity) || cmd.quantity <= 0) {
    return refuse(state, 'quantity must be whole');
  }

  const at = canTradeAt(state, ship, map);
  if (!at.ok || at.baseId === undefined) return refuse(state, at.reason ?? 'not at a base');
  const base = state.bases[at.baseId];
  if (!base || base.owner === null || !areAllied(state, cmd.by, base.owner)) {
    return refuse(state, 'ground forces are bought at a base you control');
  }

  const mass = CARGO[cmd.kind].mass * cmd.quantity;
  if (mass > cargoSpace(ship)) return refuse(state, 'not enough hold space');
  const cost = price * cmd.quantity;
  const purse = state.players[cmd.by];
  if (!purse || purse.megacredits < cost) return refuse(state, `that costs MCr ${cost}`);

  let next = withShip(state, addCargo(ship, cmd.kind, cmd.quantity));
  next = {
    ...next,
    players: {
      ...next.players,
      [cmd.by]: { ...purse, megacredits: round3(purse.megacredits - cost) },
    },
  };
  next = log(
    next,
    `${cmd.quantity} × ${CARGO[cmd.kind].name} loaded aboard for MCr ${cost} (${mass} tons).`,
  );
  return accept(next);
};

const purchaseGarrison = (
  state: GameState,
  cmd: PurchaseGarrison,
): { state: GameState; result: CommandResult } => {
  if (cmd.by !== activePlayer(state)) return refuse(state, 'it is not your turn');
  const base = state.bases[cmd.base];
  if (!base || base.destroyed) return refuse(state, 'no such base');
  if (base.owner === null || !areAllied(state, cmd.by, base.owner)) {
    return refuse(state, 'garrisons are bought for a base you hold');
  }
  const price = GARRISON_PRICES[cmd.unit];
  if (price === undefined) return refuse(state, `"${cmd.unit}" is not a garrison unit`);
  if (!Number.isInteger(cmd.count) || cmd.count <= 0) return refuse(state, 'count must be whole');

  const g = garrisonOf(state, cmd.base);
  const all = Object.entries(g.reaction).reduce(
    (acc, [unit, n]) => forceAdd(acc, unit, n),
    g.units,
  );
  const planetary = base.kind === 'planetary';
  const armourCap = planetary ? 12 : 6;
  const squadCap = planetary ? 20 : 10;

  if (cmd.unit === 'MK3' || cmd.unit === 'MK5') {
    // §3.02: one Ogre, planetary bases only, counted against the armour cap —
    // read here as consuming it: a garrison cybertank IS the armour garrison.
    if (!planetary) return refuse(state, 'an asteroid base cannot garrison a cybertank that size');
    if (cmd.count !== 1 || hasOgre(all)) return refuse(state, 'one garrison Ogre, no more');
    if (armourUnitsOf(all) > 0) {
      return refuse(
        state,
        'the Ogre takes the whole armour allowance — the garrison already has armour',
      );
    }
  } else if (cmd.unit === 'INF') {
    if (squadsOf(all) + cmd.count > squadCap) {
      return refuse(state, `the squad cap here is ${squadCap}`);
    }
  } else {
    const adding = (ARMOUR_UNITS[cmd.unit] ?? 1) * cmd.count;
    if (hasOgre(all)) return refuse(state, 'the garrison Ogre takes the whole armour allowance');
    if (armourUnitsOf(all) + adding > armourCap) {
      return refuse(state, `the armour cap here is ${armourCap} units`);
    }
  }

  const cost = price * cmd.count;
  const purse = state.players[cmd.by];
  if (!purse || purse.megacredits < cost) return refuse(state, `that costs MCr ${cost}`);

  // §3.03: up to half the purchased garrison may be the reaction force.
  const units = cmd.reaction ? g.units : forceAdd(g.units, cmd.unit, cmd.count);
  const reaction = cmd.reaction ? forceAdd(g.reaction, cmd.unit, cmd.count) : g.reaction;
  if (cmd.reaction) {
    const half = (forceTotal(units) + forceTotal(reaction)) / 2;
    if (forceTotal(reaction) > half) {
      return refuse(state, 'no more than half the garrison may stand off as the reaction force');
    }
  }

  let next = withGarrison(state, cmd.base, { ...g, units, reaction });
  next = {
    ...next,
    players: {
      ...next.players,
      [cmd.by]: { ...purse, megacredits: round3(purse.megacredits - cost) },
    },
  };
  // §3.02 wants the composition secret; the ledger says only that money moved.
  next = log(next, `Garrison stores arrive at ${cmd.base} (MCr ${cost}).`);
  return accept(next);
};

const declareInvasion = (
  state: GameState,
  cmd: DeclareInvasion,
  map: GameMap,
): { state: GameState; result: CommandResult } => {
  if (cmd.by !== activePlayer(state)) return refuse(state, 'it is not your turn');
  const data = dropData(state);
  if (data.pendingGround) return refuse(state, 'a ground battle is already waiting to be fought');
  if (data.invasion) return refuse(state, 'one invasion at a time');

  const base = state.bases[cmd.base];
  if (!base || base.destroyed) return refuse(state, 'no such base');
  if (base.owner !== null && areAllied(state, cmd.by, base.owner)) {
    return refuse(state, 'that base is already yours');
  }
  if (base.kind !== 'planetary' || !base.side) {
    return refuse(state, 'only a planetary base can be stormed from orbit — for now');
  }

  const above = sideGravityHex(base.side);
  const overhead = Object.values(state.ships).some(
    (s) => !s.destroyed && areAllied(state, cmd.by, controllerOf(s)) && eq(s.pos, above),
  );
  if (!overhead)
    return refuse(state, 'declaring an invasion takes a ship in orbit over the hexside');

  const world = map.bodyAt(base.side.hex)?.id ?? cmd.base;
  const next = withDropData(state, {
    invasion: {
      base: cmd.base,
      world,
      side: base.side,
      attacker: cmd.by,
      declaredTurn: state.turn,
    },
  });
  return accept(
    log(next, `INVASION DECLARED against ${cmd.base}. The landings begin tomorrow.`, {
      severity: 'warn',
      focus: [base.side.hex],
    }),
  );
};

// ---------------------------------------------------------------------------
// The freeze: run the guns, then hand the ground to Ogre (§§4.03-4.06)
// ---------------------------------------------------------------------------

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const landersAt = (state: GameState, attacker: PlayerId, side: HexSide): Ship[] =>
  Object.values(state.ships).filter(
    (s) =>
      !s.destroyed &&
      areAllied(state, attacker, controllerOf(s)) &&
      s.location.kind === 'landed' &&
      sideEq(s.location.side, side),
  );

/** The landed force, read off the surviving landers' manifests. */
const groundForceOf = (ships: readonly Ship[]): Force => {
  let force: Force = {};
  const modules: Record<string, number> = {};
  for (const ship of ships) {
    for (const item of ship.cargo) {
      const unit = KIND_TO_UNIT[item.kind];
      if (unit) force = forceAdd(force, unit, item.quantity);
      if (item.kind in MODULES_PER_OGRE) {
        modules[item.kind] = (modules[item.kind] ?? 0) + item.quantity;
      }
    }
  }
  // §2.02: all modules must be landed before assembly begins; incomplete
  // cybertanks are scrap on the beach.
  for (const [kind, count] of Object.entries(modules)) {
    const spec = MODULES_PER_OGRE[kind]!;
    const whole = Math.floor(count / spec.modules);
    if (whole > 0) force = forceAdd(force, spec.type, whole);
  }
  return force;
};

const runTheGunsAndFreeze = (state: GameState): GameState => {
  const data = dropData(state);
  const inv = data.invasion;
  if (!inv || data.pendingGround) return state;
  // The landings begin the day after the declaration, and the freeze happens
  // as the attacker's own player-turn closes with transports on the ground.
  if (activePlayer(state) !== inv.attacker || state.turn <= inv.declaredTurn) return state;

  const base = state.bases[inv.base];
  if (
    !base ||
    base.destroyed ||
    (base.owner !== null && areAllied(state, inv.attacker, base.owner))
  ) {
    // The target fell to something else, or changed hands: the invasion is moot.
    return log(
      withDropData(state, { invasion: null }),
      'The invasion order is overtaken by events.',
    );
  }

  let next = state;
  let landers = landersAt(next, inv.attacker, inv.side);
  if (landers.length === 0) {
    // Nobody down yet: the window stays open for two days, then closes.
    if (state.turn > inv.declaredTurn + 2) {
      return log(
        withDropData(next, { invasion: null }),
        'The invasion window closes with nobody on the ground.',
      );
    }
    return next;
  }

  // §4.03: "If the hexside is not suppressed, its planetary defenses fire once
  // at each landing ship: 2:1 ... A ship disabled during its landing turn
  // crashes with all cargo."
  const silenced =
    isSideSuppressed(next, inv.side) || !base.hasPlanetaryDefences || base.suppressed;
  if (!silenced) {
    for (const ship of landers) {
      const die = rollDie(next.rng);
      next = { ...next, rng: die.state };
      const hit = gunDamage('2:1', die.value) !== null;
      next = log(
        next,
        `The guns at ${inv.base} fire on the lander (2:1, rolled ${die.value}): ` +
          (hit ? 'it crashes with all cargo.' : 'it gets down.'),
        { severity: hit ? 'bad' : 'warn', focus: [inv.side.hex] },
      );
      if (hit) next = withShip(next, { ...ship, destroyed: true });
    }
    landers = landersAt(next, inv.attacker, inv.side);
  }

  const force = groundForceOf(landers);
  if (landers.length === 0 || forceTotal(force) === 0) {
    return log(
      withDropData(next, { invasion: null }),
      'Nothing of the landing force reached the ground. The invasion fails.',
      { severity: 'bad' },
    );
  }

  // §§3, 6: the defence — garrison, militia unless rebuilding, reaction force.
  const g = garrisonOf(next, inv.base);
  const militiaUp = (g.militiaDownUntil ?? 0) <= next.turn;
  const defence = militiaUp ? forceAdd(g.units, 'INF', MILITIA_SQUADS) : g.units;
  const defenderId = base.owner ?? MILITIA;

  // §6.01: each warship overhead owes one strike at its combat strength.
  const above = sideGravityHex(inv.side);
  const strikes = Object.values(next.ships)
    .filter(
      (s) =>
        !s.destroyed &&
        areAllied(next, inv.attacker, controllerOf(s)) &&
        eq(s.pos, above) &&
        SHIP_CLASSES[s.shipClass].warship,
    )
    .map((s) => combatStrength(s))
    .filter((n) => n > 0);

  const draw = nextFloat(next.rng);
  next = { ...next, rng: draw.state };
  const seed = Math.floor(draw.value * 0x7ffffffe) + 1;

  const profile = WORLD_PROFILES[inv.world] ?? 'dead';
  const order: OrderOfBattle = {
    battleId: `drop-${data.battleSerial}-${inv.base}`,
    seed,
    scenarioId: profile === 'living' ? 'assault-green' : 'assault',
    sides: [
      { player: inv.attacker, faction: factionOf(inv.attacker), forces: force },
      { player: defenderId, faction: factionOf(defenderId), forces: defence },
    ],
    terms: {
      world: inv.world,
      profile,
      entryEdge: 'west',
      reaction: g.reaction,
      reactionTurn: REACTION_TURN,
      orbitalStrikes: strikes,
    },
  };

  next = withDropData(next, { pendingGround: order, battleSerial: data.battleSerial + 1 });
  return log(
    next,
    `THE SKY FREEZES over ${inv.base}. ${landers.length} lander${landers.length === 1 ? '' : 's'} down; the ground battle begins.`,
    { severity: 'warn', focus: [inv.side.hex] },
  );
};

// ---------------------------------------------------------------------------
// Aftermath (§7)
// ---------------------------------------------------------------------------

const stripUnit = (f: Force, unit: string): Force => {
  const rest = { ...f } as Record<string, number>;
  delete rest[unit];
  return rest;
};

const clearGroundCargo = (ship: Ship): Ship => ({
  ...ship,
  cargo: ship.cargo.filter((c) => !(c.kind in GROUND_PRICES)),
});

const resolveGroundBattle = (
  state: GameState,
  cmd: ResolveGroundBattle,
): { state: GameState; result: CommandResult } => {
  const data = dropData(state);
  const inv = data.invasion;
  const order = data.pendingGround;
  if (!inv || !order) return refuse(state, 'no ground battle is waiting for a result');
  if (cmd.result.battleId !== order.battleId) {
    return refuse(state, 'that result belongs to a different battle');
  }
  const base = state.bases[inv.base];
  if (!base) return refuse(state, 'the base is gone');

  const attackerId = order.sides[0]!.player;
  const defenderId = order.sides[1]!.player;
  const attackerWon = cmd.result.winners.includes(attackerId);
  const aSurvivors = cmd.result.survivors[attackerId] ?? {};
  const dSurvivors = cmd.result.survivors[defenderId] ?? {};
  // The assault's victory levels encode the base's fate: 'complete' means it
  // stands (captured intact, or successfully defended); 'marginal' means the
  // battle was won over a ruin.
  const baseIntact = cmd.result.level !== 'marginal';

  let next = state;

  // §7 salvage: the winner sells the loser's wrecks at a quarter of list.
  const loserForces = attackerWon ? order.sides[1]!.forces : order.sides[0]!.forces;
  const loserSurvivors = attackerWon ? stripUnit(dSurvivors, 'CP') : aSurvivors;
  const salvage = round3(forceValue(forceSubtract(loserForces, loserSurvivors)) * 0.25);
  const winnerId = attackerWon ? attackerId : defenderId;
  const winnerPurse = next.players[winnerId];
  if (salvage > 0 && winnerPurse) {
    next = {
      ...next,
      players: {
        ...next.players,
        [winnerId]: { ...winnerPurse, megacredits: round3(winnerPurse.megacredits + salvage) },
      },
    };
  }

  if (attackerWon) {
    // "Captured base: changes ownership immediately ... income starting the
    // day after that. Surviving attacker units become its garrison."
    next = withBase(next, {
      ...base,
      owner: attackerId === MILITIA ? null : attackerId,
      destroyed: !baseIntact,
    });
    next = withGarrison(next, inv.base, {
      units: stripUnit(aSurvivors, 'CP'),
      reaction: {},
      militiaDownUntil: next.turn + 1,
      incomeFrom: next.turn + 2,
    });
    for (const ship of landersAt(next, attackerId, inv.side)) {
      next = withShip(next, clearGroundCargo(ship));
    }
    next = log(
      next,
      baseIntact
        ? `${inv.base} FALLS INTACT to ${factionOf(attackerId)}. Salvage: MCr ${salvage}.`
        : `${inv.base} is TAKEN AS A RUIN by ${factionOf(attackerId)}. Salvage: MCr ${salvage}.`,
      { severity: 'warn', focus: [inv.side.hex] },
    );
  } else {
    // "Failed invasion: surviving attacker units are captured with their
    // landed ships." The garrison that held is whatever walked away, less the
    // militia that will rebuild on its own.
    const survivors = stripUnit(dSurvivors, 'CP');
    const militia = Math.min(MILITIA_SQUADS, survivors['INF'] ?? 0);
    const units =
      militia > 0 ? { ...survivors, INF: (survivors['INF'] ?? 0) - militia } : survivors;
    next = withBase(next, { ...base, destroyed: !baseIntact });
    next = withGarrison(next, inv.base, {
      units: (units['INF'] ?? 0) > 0 ? units : stripUnit(units, 'INF'),
      reaction: {},
      militiaDownUntil: next.turn + 1,
    });
    for (const ship of landersAt(next, inv.attacker, inv.side)) {
      const captured =
        defenderId === MILITIA
          ? { ...clearGroundCargo(ship), destroyed: true }
          : { ...clearGroundCargo(ship), owner: defenderId };
      next = withShip(next, captured);
    }
    next = log(
      next,
      `The invasion of ${inv.base} FAILS. The landed ships are taken with their crews.` +
        (salvage > 0 ? ` Salvage: MCr ${salvage}.` : ''),
      { severity: 'warn', focus: [inv.side.hex] },
    );
  }

  next = withDropData(next, { invasion: null, pendingGround: null });
  return accept(next);
};

// ---------------------------------------------------------------------------
// Upkeep and victory
// ---------------------------------------------------------------------------

const endPlayerTurn = (state: GameState, _map: GameMap): GameState => {
  let next = state;
  const player = activePlayer(next);

  // §1.01: income, skipping bases still standing up after capture.
  const purse = next.players[player];
  if (purse) {
    const paying = Object.values(next.bases).filter((b) => {
      if (b.destroyed || b.owner !== player) return false;
      const g = dropData(next).garrisons[b.id];
      return (g?.incomeFrom ?? 0) <= next.turn;
    });
    if (paying.length > 0) {
      next = {
        ...next,
        players: {
          ...next.players,
          [player]: {
            ...purse,
            megacredits: round3(purse.megacredits + paying.length * BASE_INCOME_PER_DAY),
          },
        },
      };
    }
  }

  return runTheGunsAndFreeze(next);
};

const checkVictory = (state: GameState): VictoryState | null => {
  // The sky is frozen: nothing is decided until the ground battle is.
  if (dropData(state).pendingGround) return null;

  for (const spec of SPECS) {
    const foe = SPECS.find((s) => s.id !== spec.id)!;
    const ships = Object.values(state.ships).some(
      (s) => !s.destroyed && controllerOf(s) === spec.id,
    );
    const bases = Object.values(state.bases).some((b) => !b.destroyed && b.owner === spec.id);
    if (!ships && !bases) {
      return victory(
        [foe.id],
        'decisive',
        `${spec.name} has neither a ship in space nor a base to build one. The war is over.`,
      );
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const handleCommand = (
  state: GameState,
  cmd: Command,
  map: GameMap,
): { state: GameState; result: CommandResult } | null => {
  switch (cmd.type) {
    case 'purchaseGround':
      return purchaseGround(state, cmd, map);
    case 'purchaseGarrison':
      return purchaseGarrison(state, cmd);
    case 'declareInvasion':
      return declareInvasion(state, cmd, map);
    case 'resolveGroundBattle':
      return resolveGroundBattle(state, cmd);
    default:
      return null;
  }
};

export const orbitalDrop: ScenarioDef = {
  id: 'orbital-drop',
  name: 'Orbital Drop',
  blurb: 'The whole war: Triplanetary above the atmosphere, Ogre below it.',
  description:
    'Triplanetary handles everything above the atmosphere. Ogre handles everything ' +
    'below it. Ground units join the equipment price list and ride as cargo — a ' +
    'transport holds five tanks, or one fifty-ton module of a disassembled Ogre — ' +
    'so a serious invasion is a convoy, visible to detectors, escorted or not. ' +
    'Every base holds six squads of free militia and whatever garrison its owner ' +
    'has quietly bought. Declare an invasion from orbit, suppress the hexside or ' +
    'run the guns, and when the transports are down the sky freezes: the battle ' +
    'is fought on an Ogre battlefield generated from the world’s terrain ' +
    'profile, with the reaction force racing home and every warship overhead ' +
    'owing one orbital strike. A captured base pays MCr 0.5 a day. ' +
    'Bases are the biggest prizes on the board — which is exactly what makes ' +
    'the ground game matter.',
  players: { min: 2, max: 2 },
  length: 'long',
  playerTemplates: templatesOf(SPECS),
  build,
  checkVictory,
  endPlayerTurn,
  handleCommand,
  specialRules: [
    'Ground forces are bought at any base you control, at the Orbital Drop price list, and ride as cargo: an infantry squad is MCr 1 and 2 tons, a tank MCr 5 and 10 tons, an Ogre MCr 5 and 10 tons per armour-unit equivalent, shipped in 50-ton modules that may travel on different ships. All modules must be landed before assembly begins.',
    'Every base has a standing militia of 6 infantry squads at no cost, replenished one day after any battle. Garrisons may be bought up to 12 armour units and 20 squads at a planetary base (6 and 10 at an asteroid base); up to half may be designated the reaction force, which enters the ground battle from turn 5. One garrison Ogre is allowed, and it takes the whole armour allowance.',
    'An invasion is declared in the ordnance phase against a base with your ship in orbit over its hexside; the landings begin the next day. An unsuppressed hexside fires once at each lander at 2:1 — any result at all crashes it with all cargo. Suppress the hexside first (a suppressing ship fires at nothing else) and the guns are silent.',
    'When the landers are down the sky freezes: courses, ordnance and fuel hold while the ground battle is fought on a battlefield generated from the world’s profile — green and settled, cratered and dead, or volcanic with lava the fire crosses and nothing enters. Each warship overhead owes the attacker one orbital strike at its combat strength.',
    'A captured base changes hands immediately and pays income from the day after next; surviving attackers become its garrison. The winner salvages the loser’s wrecks at a quarter of list price. A failed invasion loses its landed ships with their crews.',
    'Victory is the campaign’s: play to an agreed end date and count net worth — or to the knife, when a power has neither a ship in space nor a base to build one.',
  ],
};
