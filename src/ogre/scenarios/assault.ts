/**
 * **The Assault** — Orbital Drop's ground battle (its §§5-7).
 *
 * Where The Landing is the old campaign's fixed fight, this scenario is built
 * from whatever an invasion actually put on the ground: the landed force
 * enters from the attacker's map edge on turn 1, the garrison and its militia
 * hold the ground around the base, a designated reaction force races back
 * from dispersal from the reaction turn on, an Ogre that shipped in modules
 * spends its first turns as an inert hull, and warships overhead each owe one
 * orbital strike. The battlefield itself is generated when the invasion
 * lands, from the world's terrain profile.
 *
 * Three ScenarioDefs share this build — `assault` on the cratered map,
 * `assault-green` on the settled one, `assault-asteroid` on half of the
 * cratered map under low gravity — because a `ScenarioDef` names one map and
 * a living world, a dead one and a rock are not the same battlefield. The
 * order's documented terms:
 *
 *  - `profile`:  'dead' | 'living' | 'volcanic' | 'asteroid' — the overlay
 *    table of Orbital Drop §5. 'living' belongs to `assault-green`,
 *    'asteroid' to `assault-asteroid`, the rest to `assault`.
 *  - `world`:    body id, for the log and the briefing.
 *  - `base`:     'admin' for a planetary base (an Admin building, 20 SP) or
 *    'cp' for an asteroid base (a command post), per §6 step 1.
 *  - `entryEdge`: the attacker's map edge ('west' by default); the defender
 *    owns the opposite edge, and the reaction force enters there.
 *  - `reaction`: defender units held off the map until the reaction turn.
 *  - `reactionTurn`: first turn the reaction force may enter (5 by default).
 *  - `orbitalStrikes`: strike strengths the attacker's fleet overhead owes.
 *  - `ogreDamage`: per side, the worn record sheets of cybertanks that
 *    fought before (§7, "Damage carries over"), applied to that side's Ogres
 *    of the same type in order.
 *
 * The base is captured intact when the attacker wins with it still standing
 * — which is how the campaign side reads "captured intact" off the result's
 * victory level.
 */

import { type Hex, neighbors, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, inBounds, terrainAt } from '../engine/map.js';
import { GEV_MAP, OGRE_MAP } from '../engine/mapdata.js';
import { type OgreTypeId, type OgreWeaponKind, OGRE_TYPES, ogreType } from '../engine/ogres.js';
import { type RngState, createRng, nextInt, shuffle } from '../engine/rng.js';
import { type Terrain } from '../engine/terrain.js';
import { type UnitClassId, UNIT_CLASSES, unitClass } from '../engine/units.js';
import {
  type Building,
  type GameState,
  type OgreUnit,
  type VictoryState,
  onBoard,
  surviving,
} from '../engine/types.js';
import {
  createGame,
  log,
  makeOgre,
  makePlayer,
  makeUnit,
  setSideOverride,
  withUnit,
} from '../engine/state.js';
import { type OgreRecord, type OrderOfBattle, ORDER_KEY, orderOf } from '@campaign/orders.js';
import { key } from '../engine/hex.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import {
  type Deployer,
  infantryCounters,
  isFree,
  limit,
  place,
  withSetup,
  zone,
} from './helpers.js';

export type AssaultProfile = 'dead' | 'living' | 'volcanic' | 'asteroid';
export type Edge = 'north' | 'south' | 'east' | 'west';

const opposite = (e: Edge): Edge =>
  e === 'north' ? 'south' : e === 'south' ? 'north' : e === 'east' ? 'west' : 'east';

/** How far into the map a hex sits: 0 at the attacker's edge, 1 at the defender's. */
const depthFrom = (map: GameMap, h: Hex, edge: Edge): number => {
  const o = toOffset(h);
  switch (edge) {
    case 'west':
      return (o.col - 1) / Math.max(1, map.cols - 1);
    case 'east':
      return (map.cols - o.col) / Math.max(1, map.cols - 1);
    case 'north':
      return (o.row - 1) / Math.max(1, map.rows - 1);
    case 'south':
      return (map.rows - o.row) / Math.max(1, map.rows - 1);
  }
};

const colorFor = (faction: string): string =>
  /combine|american/i.test(faction) ? '#d94f4f' : '#5b9bd5';

const isInfantryClass = (id: UnitClassId): boolean => unitClass(id).kind === 'infantry';

/** Ogre assembly delay: "(Size − 4) ground turns, minimum 2" (§6, step 3). */
export const assemblyDelay = (type: OgreTypeId): number => Math.max(2, ogreType(type).size - 4);

/** §6 step 1: the Admin building that stands for a planetary base. */
export const ADMIN_STRUCTURE_POINTS = 20;

/**
 * §5, asteroid bases: "Half of any map". The cratered board's upper half —
 * the same columns, half the rows — under the asteroid's own rules.
 */
export const HALF_OGRE_MAP: GameMap = {
  ...OGRE_MAP,
  id: 'ogre-half',
  name: 'Half map',
  rows: Math.ceil(OGRE_MAP.rows / 2),
  blurb: 'Half of the cratered board: an asteroid base, under low gravity.',
};

// ---------------------------------------------------------------------------
// The generated battlefield (§5)
// ---------------------------------------------------------------------------

/**
 * Roll the world's overlays onto the printed map. The doc hands the overlay
 * placement to a player; here the same seed that builds the battle places
 * them, so the battlefield is generated when the invasion lands and identical
 * in every replay. Craters, towns, forests, swamps and lava are terrain
 * overrides; ridges are hexside overrides.
 */
const rollOverlays = (
  rng: RngState,
  map: GameMap,
  profile: AssaultProfile,
  entryEdge: Edge,
): { rng: RngState; overrides: Record<string, Terrain>; ridges: [Hex, Hex][] } => {
  const overrides: Record<string, Terrain> = {};
  const ridges: [Hex, Hex][] = [];
  let s = rng;

  const ground = allHexes(map).filter((h) => {
    const t = terrainAt(map, h);
    return t !== 'crater' && t !== 'water' && depthFrom(map, h, entryEdge) > 0.15;
  });

  const draw = (): Hex | null => {
    if (ground.length === 0) return null;
    const pick = nextInt(s, ground.length);
    s = pick.state;
    return ground.splice(pick.value, 1)[0] ?? null;
  };
  const roll = (sides: number): number => {
    const r = nextInt(s, sides);
    s = r.state;
    return r.value + 1;
  };
  /** A ridge hexside: between a drawn hex and a neighbour still on the map. */
  const ridge = (): void => {
    const h = draw();
    if (!h) return;
    const ns = neighbors(h).filter((n) => inBounds(map, n) && terrainAt(map, n) !== 'crater');
    if (ns.length === 0) return;
    const pick = nextInt(s, ns.length);
    s = pick.state;
    ridges.push([h, ns[pick.value]!]);
  };

  if (profile === 'living') {
    // "Roll 1d6 and place that many overlays of the defender's choice from:
    // town, forest, swamp" — the settled country around the base.
    const kinds: Terrain[] = ['town', 'forest', 'swamp'];
    const n = roll(6);
    for (let i = 0; i < n; i++) {
      const h = draw();
      if (h) overrides[key(h)] = kinds[i % kinds.length]!;
    }
  } else if (profile === 'asteroid') {
    // "2d6 ridge hexsides placed alternately, defender first."
    const n = roll(6) + roll(6);
    for (let i = 0; i < n; i++) ridge();
  } else {
    // Dead worlds: "the attacker places that many crater or ridge overlays
    // (attacker's choice which)" — here the die chooses for them. Io adds
    // lava, which the engine's water already is: impassable to everything,
    // fire crosses it.
    const n = roll(6);
    for (let i = 0; i < n; i++) {
      if (profile === 'dead' && roll(2) === 2) {
        ridge();
        continue;
      }
      const h = draw();
      if (h) overrides[key(h)] = 'crater';
    }
    if (profile === 'volcanic') {
      const lava = roll(3);
      for (let i = 0; i < lava; i++) {
        const h = draw();
        if (h) overrides[key(h)] = 'water';
      }
    }
  }

  return { rng: s, overrides, ridges };
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const termEdge = (order: OrderOfBattle): Edge => {
  const raw = order.terms['entryEdge'];
  return raw === 'north' || raw === 'south' || raw === 'east' || raw === 'west' ? raw : 'west';
};

const termProfile = (order: OrderOfBattle): AssaultProfile => {
  const raw = order.terms['profile'];
  return raw === 'living' || raw === 'volcanic' || raw === 'asteroid' ? raw : 'dead';
};

/** 'admin' for a planetary base, 'cp' for an asteroid base; a CP by default. */
const termBase = (order: OrderOfBattle, profile: AssaultProfile): 'admin' | 'cp' => {
  const raw = order.terms['base'];
  if (raw === 'admin' || raw === 'cp') return raw;
  return profile === 'asteroid' ? 'cp' : 'admin';
};

const termDamage = (order: OrderOfBattle): Readonly<Record<string, readonly OgreRecord[]>> => {
  const raw = order.terms['ogreDamage'];
  return typeof raw === 'object' && raw !== null
    ? (raw as Readonly<Record<string, readonly OgreRecord[]>>)
    : {};
};

/**
 * Wear a fresh cybertank down to a carried record sheet (§7): the treads it
 * had left, the components it lost, the missiles it fired.
 */
export const applyOgreRecord = (ogre: OgreUnit, record: OgreRecord): OgreUnit => {
  const lost: Record<string, number> = { ...record.lost };
  let spent = record.missilesSpent;
  const weapons = ogre.weapons.map((w) => {
    if ((lost[w.kind] ?? 0) > 0) {
      lost[w.kind] = (lost[w.kind] ?? 0) - 1;
      return { ...w, destroyed: true };
    }
    if (w.kind === 'missile' && spent > 0) {
      spent -= 1;
      return { ...w, fired: true };
    }
    return w;
  });
  return {
    ...ogre,
    weapons,
    treads: Math.max(0, Math.min(ogre.treads, record.treads)),
    internalMissiles: Math.max(0, Math.min(ogre.internalMissiles, record.internalMissiles)),
  };
};

const build = (map: GameMap, opts: ScenarioBuildOptions, scenarioId: string): GameState => {
  const order = opts.order ?? { ...DEFAULT_ASSAULT, seed: opts.seed };
  const [attacker, defender] = order.sides;
  if (!attacker || !defender) throw new Error('an assault needs an attacker and a defender');

  const profile = termProfile(order);
  const baseKind = termBase(order, profile);
  const entryEdge = termEdge(order);
  const defenderEdge = opposite(entryEdge);
  const rawReaction = order.terms['reactionTurn'];
  const reactionTurn = typeof rawReaction === 'number' && rawReaction > 0 ? rawReaction : 5;
  const rawStrikes = order.terms['orbitalStrikes'];
  const strikes = Array.isArray(rawStrikes)
    ? (rawStrikes as unknown[]).filter((n): n is number => typeof n === 'number' && n > 0)
    : [];
  const reaction = (order.terms['reaction'] ?? {}) as Readonly<Record<string, number>>;
  const damage = termDamage(order);

  let rng = createRng(order.seed ^ 0x0d20);
  const rolled = rollOverlays(rng, map, profile, entryEdge);
  rng = rolled.rng;

  const base = createGame({
    scenarioId,
    mapId: map.id,
    seed: order.seed,
    players: [
      makePlayer(attacker.player, attacker.faction, attacker.faction, colorFor(attacker.faction)),
      makePlayer(defender.player, defender.faction, defender.faction, colorFor(defender.faction)),
    ],
    options: {
      // A living world plays by the green-map rules; the rest by the Ogre-map
      // rules — "no stacking, ramming rules recommended for speed" (§5). An
      // asteroid grounds the hovercraft and speeds everything else.
      stackingLimit: profile === 'living' ? 5 : 1,
      overrunCombat: profile === 'living',
      ...(profile === 'asteroid' ? { lowGravity: true, noHover: true } : {}),
      ...opts.options,
    },
    scenarioData: {
      [ORDER_KEY]: order,
      reactionTurn,
      reserveEdge: defenderEdge,
      orbitalStrikes: strikes,
      orbitalStrikeSide: attacker.player,
    },
  });

  let ridged: GameState = { ...base, terrainOverrides: rolled.overrides };
  for (const [a, b] of rolled.ridges) ridged = setSideOverride(ridged, a, b, 'ridge');

  const d: Deployer = { state: ridged, serial: 1 };
  const open = (h: Hex): boolean => {
    const t = terrainAt(map, h, d.state.terrainOverrides);
    return t !== 'crater' && t !== 'water';
  };

  // --- The attacker enters from their edge, everything at once (§6.2) ------
  const strip = shuffle(
    rng,
    allHexes(map).filter((h) => open(h) && depthFrom(map, h, entryEdge) <= 0.15),
  );
  rng = strip.state;
  const stripHexes = strip.items;
  deployForces(d, attacker.player, attacker.forces, stripHexes, {
    // An invading Ogre landed in modules: inert until it finishes assembling.
    ogreActivatesOn: (type) => 1 + assemblyDelay(type),
    records: damage[attacker.player] ?? [],
  });

  // --- The defender owns the half with the base (§6.1) ---------------------
  const central = shuffle(
    rng,
    allHexes(map).filter((h) => {
      const depth = depthFrom(map, h, entryEdge);
      return open(h) && depth > 1 / 3 && depth < 2 / 3;
    }),
  );
  rng = central.state;
  const rear = shuffle(
    rng,
    allHexes(map).filter((h) => open(h) && depthFrom(map, h, entryEdge) >= 2 / 3),
  );
  rng = rear.state;

  // The base as deep as the map allows: the defender knows where the drop is
  // coming from. A planetary base is an Admin building of 20 SP; an asteroid
  // base a command post (§6 step 1).
  const baseSites = [...rear.items].sort(
    (a, b) => depthFrom(map, b, entryEdge) - depthFrom(map, a, entryEdge),
  );
  if (baseKind === 'admin') {
    const site = baseSites[0];
    if (!site) throw new Error('the base has no ground');
    const building: Building = {
      id: 'base',
      kind: 'admin',
      owner: defender.player,
      pos: site,
      structurePoints: ADMIN_STRUCTURE_POINTS,
      maxStructurePoints: ADMIN_STRUCTURE_POINTS,
      destroyed: false,
    };
    d.state = { ...d.state, buildings: { ...d.state.buildings, [building.id]: building } };
  } else {
    place(d, defender.player, 'CP', baseSites);
  }

  // "No more than 20 attack strength points may set up in the central third"
  // — a screen forward, the rest of the force back with the base.
  const screen = deployScreened(
    d,
    defender.player,
    defender.forces,
    central.items,
    rear.items,
    damage[defender.player] ?? [],
  );
  void screen;

  // --- The reaction force waits off the map (§3.03) ------------------------
  const parkRow = rear.items[0] ?? baseSites[0];
  if (parkRow) {
    for (const [id, count] of Object.entries(reaction)) {
      if (count <= 0) continue;
      if (id in OGRE_TYPES) {
        for (let i = 0; i < count; i++) {
          const ogre = makeOgre(
            `${defender.player}-${id.toLowerCase()}-r${d.serial++}`,
            defender.player,
            id as OgreTypeId,
            parkRow,
          );
          d.state = withUnit(d.state, { ...ogre, offMap: 'reserve' });
        }
      } else if (id in UNIT_CLASSES && isInfantryClass(id as UnitClassId)) {
        for (const squads of infantryCounters(count)) {
          const unit = makeUnit(
            `${defender.player}-${id.toLowerCase()}-r${d.serial++}`,
            defender.player,
            id as UnitClassId,
            parkRow,
            squads,
          );
          d.state = withUnit(d.state, { ...unit, offMap: 'reserve' });
        }
      } else if (id in UNIT_CLASSES) {
        for (let i = 0; i < count; i++) {
          const unit = makeUnit(
            `${defender.player}-${id.toLowerCase()}-r${d.serial++}`,
            defender.player,
            id as UnitClassId,
            parkRow,
            1,
          );
          d.state = withUnit(d.state, { ...unit, offMap: 'reserve' });
        }
      }
    }
  }

  const strikeNote =
    strikes.length > 0
      ? ` ${strikes.length} warship${strikes.length === 1 ? '' : 's'} overhead each owe one strike.`
      : '';
  const groundNote =
    profile === 'asteroid'
      ? ' Low gravity: everything moves a hex further, and nothing hovers.'
      : '';
  const built = log(
    d.state,
    'info',
    `The drop is down on the ${entryEdge}ern edge. The garrison holds the ${baseKind === 'admin' ? 'base' : 'command post'};` +
      ` the reaction force arrives from turn ${reactionTurn}.${strikeNote}${groundNote}`,
  );

  // §6: "Defender sets up first ... The attacker chooses which edge before
  // the defender sets up — the defender knows where the drop is coming
  // from, not what's in it." The defender owns the half with the base, with
  // the central-third ceiling; the attacker rearranges inside the drop zone.
  const defenderGround = allHexes(map).filter(
    (h) => open(h) && depthFrom(map, h, entryEdge) > 1 / 3,
  );
  const centralThird = defenderGround.filter((h) => depthFrom(map, h, entryEdge) < 2 / 3);
  const dropStrip = allHexes(map).filter((h) => open(h) && depthFrom(map, h, entryEdge) <= 0.15);
  return withSetup(built, opts.setup, [defender.player, attacker.player], {
    [defender.player]: zone(defenderGround, 'the base’s half of the map', [
      limit(centralThird, 20, 'the central third'),
    ]),
    [attacker.player]: zone(dropStrip, `the ${entryEdge}ern edge`),
  });
};

/**
 * Deploy the landed force. Ogres take `ogreActivatesOn` when given — an
 * invader's assembly delay — and wear the carried record sheets in order;
 * everything else places like The Landing.
 */
const deployForces = (
  d: Deployer,
  owner: string,
  forces: Readonly<Record<string, number>>,
  hexes: Hex[],
  opts: {
    ogreActivatesOn?: (type: OgreTypeId) => number;
    records?: readonly OgreRecord[];
  } = {},
): void => {
  const records = [...(opts.records ?? [])];
  for (const [id, count] of Object.entries(forces)) {
    if (count <= 0) continue;
    if (id in OGRE_TYPES) {
      for (let i = 0; i < count; i++) {
        while (hexes.length > 0 && !isFree(d.state, hexes[0]!)) hexes.shift();
        const at = hexes.shift();
        if (!at) throw new Error('the drop zone is out of ground');
        let ogre = makeOgre(
          `${owner}-${id.toLowerCase()}-${d.serial++}`,
          owner,
          id as OgreTypeId,
          at,
        );
        const worn = records.findIndex((r) => r.type === id);
        if (worn >= 0) ogre = applyOgreRecord(ogre, records.splice(worn, 1)[0]!);
        const activatesOn = opts.ogreActivatesOn?.(id as OgreTypeId);
        d.state = withUnit(d.state, activatesOn !== undefined ? { ...ogre, activatesOn } : ogre);
      }
    } else if (!(id in UNIT_CLASSES)) {
      throw new Error(`the order asks for "${id}", which is not a unit this game fields`);
    } else if (isInfantryClass(id as UnitClassId)) {
      for (const squads of infantryCounters(count)) {
        place(d, owner, id as UnitClassId, hexes, squads);
      }
    } else {
      for (let i = 0; i < count; i++) place(d, owner, id as UnitClassId, hexes);
    }
  }
};

/**
 * The defender's setup split: a screen in the central third up to 20 printed
 * attack points (adapting the Mark III Attack limit), everything else back
 * with the base. Garrison Ogres arrive assembled and stand with the base,
 * wearing whatever the last battle left them.
 */
const deployScreened = (
  d: Deployer,
  owner: string,
  forces: Readonly<Record<string, number>>,
  central: Hex[],
  rear: Hex[],
  carried: readonly OgreRecord[],
): number => {
  let screened = 0;
  const CENTRAL_LIMIT = 20;
  const records = [...carried];

  for (const [id, count] of Object.entries(forces)) {
    if (count <= 0) continue;
    if (id in OGRE_TYPES) {
      for (let i = 0; i < count; i++) {
        while (rear.length > 0 && !isFree(d.state, rear[0]!)) rear.shift();
        const at = rear.shift();
        if (!at) throw new Error('the base has no ground left');
        let ogre = makeOgre(
          `${owner}-${id.toLowerCase()}-${d.serial++}`,
          owner,
          id as OgreTypeId,
          at,
        );
        const worn = records.findIndex((r) => r.type === id);
        if (worn >= 0) ogre = applyOgreRecord(ogre, records.splice(worn, 1)[0]!);
        d.state = withUnit(d.state, ogre);
      }
    } else if (!(id in UNIT_CLASSES)) {
      throw new Error(`the garrison lists "${id}", which is not a unit this game fields`);
    } else if (isInfantryClass(id as UnitClassId)) {
      for (const squads of infantryCounters(count)) {
        if (screened + squads <= CENTRAL_LIMIT) {
          place(d, owner, id as UnitClassId, central, squads);
          screened += squads;
        } else {
          place(d, owner, id as UnitClassId, rear, squads);
        }
      }
    } else {
      const strength = unitClass(id as UnitClassId).attack;
      for (let i = 0; i < count; i++) {
        if (id !== 'HWZ' && screened + strength <= CENTRAL_LIMIT) {
          place(d, owner, id as UnitClassId, central);
          screened += strength;
        } else {
          place(d, owner, id as UnitClassId, rear);
        }
      }
    }
  }
  return screened;
};

// ---------------------------------------------------------------------------
// Victory (§6.02)
// ---------------------------------------------------------------------------

/** Whether the base — building or command post — still stands. */
const baseStandsIn = (state: GameState, defender: string): boolean => {
  const building = state.buildings['base'];
  if (building) return !building.destroyed;
  const cp = Object.values(state.units).find(
    (u) => u.kind === 'unit' && u.owner === defender && u.classId === 'CP',
  );
  return !!cp && surviving(cp);
};

const checkVictory = (state: GameState): VictoryState | null => {
  const order = orderOf(state.scenarioData);
  if (!order) return null;
  const attacker = order.sides[0]!.player;
  const defender = order.sides[1]!.player;

  const units = Object.values(state.units);
  const baseStands = baseStandsIn(state, defender);
  const attackerLeft = units.some((u) => u.owner === attacker && onBoard(u));
  // Reserves still waiting off the map are still in the fight — they can
  // enter on any later turn.
  const defenderLeft = units.some(
    (u) =>
      u.owner === defender &&
      !(u.kind === 'unit' && u.classId === 'CP') &&
      (onBoard(u) || u.offMap === 'reserve'),
  );

  // "The attacker wins by destroying the base structure..."
  if (!baseStands && attackerLeft) {
    return {
      winners: [attacker],
      level: 'marginal',
      reason: 'The base is destroyed. The invasion succeeds, but there is nothing left to take.',
    };
  }

  // "The defender wins by destroying or driving off every attacking unit."
  if (!attackerLeft) {
    return baseStands
      ? {
          winners: [defender],
          level: 'complete',
          reason: 'Nothing of the landing force remains. The base stands.',
        }
      : {
          winners: [defender],
          level: 'marginal',
          reason: 'The invaders are gone — and so is the base they came for.',
        };
  }

  // "...or by holding the map when all defenders are gone; the base is
  // captured intact in the second case only."
  if (!defenderLeft) {
    return {
      winners: [attacker],
      level: 'complete',
      reason: 'The garrison is gone and the base is taken intact.',
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// The printed default, and the three scenario defs
// ---------------------------------------------------------------------------

/** A printed default so the assault is also just a scenario on the picker. */
export const DEFAULT_ASSAULT: OrderOfBattle = {
  battleId: 'assault-default',
  seed: 20370614,
  scenarioId: 'assault',
  sides: [
    {
      player: 'combine',
      faction: 'North American Combine',
      forces: { HVY: 4, MSL: 2, GEV: 2, INF: 9, MK3: 1 },
    },
    {
      player: 'paneuro',
      faction: 'Paneuropean Federation',
      // Six of the squads are the base's standing militia (§3.01).
      forces: { HVY: 2, MSL: 2, INF: 18 },
    },
  ],
  terms: {
    world: 'mars',
    profile: 'dead',
    base: 'admin',
    entryEdge: 'west',
    reaction: { HVY: 2, INF: 6 },
    reactionTurn: 5,
    orbitalStrikes: [3, 2],
  },
};

/** The asteroid default: a smaller fight on half a board, no hovercraft. */
export const DEFAULT_ASTEROID_ASSAULT: OrderOfBattle = {
  ...DEFAULT_ASSAULT,
  battleId: 'assault-asteroid-default',
  scenarioId: 'assault-asteroid',
  sides: [
    {
      player: 'combine',
      faction: 'North American Combine',
      forces: { HVY: 3, MSL: 1, INF: 6, MK1: 1 },
    },
    { player: 'paneuro', faction: 'Paneuropean Federation', forces: { HVY: 2, INF: 12 } },
  ],
  terms: {
    world: 'ceres',
    profile: 'asteroid',
    base: 'cp',
    entryEdge: 'west',
    reaction: { INF: 3 },
    reactionTurn: 5,
    orbitalStrikes: [2],
  },
};

const BRIEFING =
  'An invasion from orbit, fought on a battlefield generated when the drop came ' +
  'down: the terrain profile of the world above decides the overlays.\n\n' +
  'The landed force enters from its own map edge on turn 1 — all of it at once. ' +
  'The garrison and the base’s militia set up around the base — an Admin building ' +
  'of 20 structure points on a planet, a command post on a rock — no more ' +
  'than 20 attack strength points of them forward in the central third. From turn 5 ' +
  'the reaction force — garrison dispersed away from the base when the alarm ' +
  'sounded — enters from the defender’s edge, any or all of it, on any turn.\n\n' +
  'An invading Ogre shipped in fifty-ton modules and spends its first turns as an ' +
  'inert hull: it cannot move or fire, and any D result against it is an X. A ' +
  'defending Ogre starts assembled — wearing whatever its last battle left it. Each ' +
  'warship overhead owes the attacker one orbital strike: its combat strength, any ' +
  'target, any range, once per battle.';

const VICTORY_CONDITIONS: readonly string[] = [
  'Attacker destroys the base: the invasion succeeds, but takes a ruin.',
  'Attacker holds the map when every defender is gone: the base is captured intact.',
  'Defender destroys or drives off every attacking unit: the invasion fails.',
];

const makeDef = (
  id: string,
  name: string,
  map: GameMap,
  blurb: string,
  fallback: OrderOfBattle,
): ScenarioDef => ({
  id,
  name,
  mapId: map.id,
  players: 2,
  map,
  blurb,
  briefing: BRIEFING,
  victoryConditions: VICTORY_CONDITIONS,
  build: (opts) =>
    build(map, opts.order ? opts : { ...opts, order: { ...fallback, seed: opts.seed } }, id),
  checkVictory,
});

/** Dead and volcanic worlds: the cratered map. */
export const ASSAULT: ScenarioDef = makeDef(
  'assault',
  'The Assault',
  OGRE_MAP,
  'An invasion from orbit against a dug-in garrison, on a dead world.',
  DEFAULT_ASSAULT,
);

/** Living worlds — Terra, Venus, Callisto: the green map. */
export const ASSAULT_GREEN: ScenarioDef = makeDef(
  'assault-green',
  'The Assault (living world)',
  GEV_MAP,
  'An invasion from orbit into settled country, on a living world.',
  DEFAULT_ASSAULT,
);

/** Asteroid bases — Ceres, Clandestine: half the cratered map, low gravity. */
export const ASSAULT_ASTEROID: ScenarioDef = makeDef(
  'assault-asteroid',
  'The Assault (asteroid)',
  HALF_OGRE_MAP,
  'A raid on an asteroid base: half a map, ridges, low gravity, and nothing to hover on.',
  DEFAULT_ASTEROID_ASSAULT,
);

export type { OgreWeaponKind };
