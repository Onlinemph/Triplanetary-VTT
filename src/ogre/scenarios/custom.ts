/**
 * **Custom battle** — any forces, either board, three ways to win.
 *
 * The printed scenarios each fix a map, an allowance and a victory table.
 * This one reads all three from an `OrderOfBattle`, the same shape the
 * campaign hands a battle, so a table built in the browser's battle builder
 * travels the wire exactly as a campaign transfer does: every joiner rebuilds
 * the same board from the same order, and the referee needs nothing new.
 *
 * What the order says:
 *
 *  - `sides[0]` attacks and moves first; `sides[1]` defends and sets up first.
 *    `forces` is the engine's own vocabulary — `UnitClassId` counts, infantry
 *    in squads, `OgreTypeId` counts for cybertanks — on either side, so an
 *    Ogre-against-Ogre battle or a defence with a cybertank of its own is
 *    just a different list.
 *  - `terms.map` names the board: the cratered map or the green one, with an
 *    optional seed and size for a fresh battlefield nobody has seen before.
 *  - `terms.victory` picks the ending. *Command post*: the defence gets a
 *    command post placed deep in its ground, and the classic six outcomes
 *    apply with "the Ogre" read as "the attacking force". *Breakthrough*:
 *    the attacker's aim is to get off the far edge, scored by how much of the
 *    force's value makes it. *Attrition*: fight to the turn limit or to
 *    elimination and compare victory points.
 *  - `terms.turnLimit` ends the battle early; `terms.centralLimit` is the
 *    cratered map's screen ceiling, if the players want one.
 */

import { type Hex, distance, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, terrainAt } from '../engine/map.js';
import { MAPS, buildGevMap, buildOgreMap } from '../engine/mapdata.js';
import { OGRE_TYPES, OGRE_WEAPONS, type OgreTypeId, ogreType } from '../engine/ogres.js';
import { createRng, shuffle } from '../engine/rng.js';
import {
  SELECTABLE_CLASSES,
  UNIT_CLASSES,
  type UnitClassId,
  isInfantryClass,
  unitClass,
} from '../engine/units.js';
import {
  type GameState,
  type PlayerId,
  type Unit,
  type VictoryState,
  isOgre,
  onBoard,
  surviving,
} from '../engine/types.js';
import { createGame, log, makeOgre, makePlayer, withUnit } from '../engine/state.js';
import { ORDER_KEY, type OrderOfBattle, type OrderSide, orderOf } from '@campaign/orders.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import {
  type Deployer,
  attackStrengthOf,
  infantryCounters,
  isFree,
  limit,
  openHexes,
  place,
  withSetup,
  zone,
} from './helpers.js';

export const CUSTOM_ID = 'custom';

// ---------------------------------------------------------------------------
// The terms
// ---------------------------------------------------------------------------

export type CustomVictory = 'command-post' | 'breakthrough' | 'attrition';
export type MapKind = 'ogre' | 'gev';
type Edge = 'north' | 'south' | 'east' | 'west';

/** Which board, and — for a fresh one — how to generate it. */
export interface CustomMapSpec {
  readonly kind: MapKind;
  /** Absent means the stock board everybody knows. */
  readonly seed?: number;
  readonly cols?: number;
  readonly rows?: number;
  /** Cratered map only: roughly what fraction of the ground is holes. */
  readonly craterDensity?: number;
}

export interface CustomTerms {
  readonly map: CustomMapSpec;
  readonly victory: CustomVictory;
  /** Turns the battle runs for; null plays to the end. */
  readonly turnLimit: number | null;
  /** The cratered map's Central Area ceiling; null means none. */
  readonly centralLimit: number | null;
}

export const VICTORY_NAMES: Readonly<Record<CustomVictory, string>> = {
  'command-post': 'Command post',
  breakthrough: 'Breakthrough',
  attrition: 'Attrition',
};

export const VICTORY_BLURBS: Readonly<Record<CustomVictory, string>> = {
  'command-post':
    'The defence gets a command post deep in its ground. Destroy it and get away for the attacker; hold it and stop them for the defence.',
  breakthrough:
    'The attacker is trying to get off the far edge of the map. The more of the force’s value that makes it, the better the result.',
  attrition:
    'Fight to the turn limit or to the last unit, then compare victory points. The side that took more wins.',
};

export const MAP_LIMITS = {
  cols: { min: 12, max: 40 },
  rows: { min: 12, max: 40 },
  craterDensity: { min: 0, max: 0.3 },
} as const;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Read a map spec out of free-form JSON, ignoring what it does not understand. */
export const readMapSpec = (raw: unknown): CustomMapSpec => {
  if (raw === 'gev' || raw === 'ogre') return { kind: raw };
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind: MapKind = r['kind'] === 'gev' ? 'gev' : 'ogre';
  const seed = asNumber(r['seed']);
  const cols = asNumber(r['cols']);
  const rows = asNumber(r['rows']);
  const density = asNumber(r['craterDensity']);
  return {
    kind,
    ...(seed === undefined ? {} : { seed: Math.floor(seed) }),
    ...(cols === undefined
      ? {}
      : { cols: clamp(Math.floor(cols), MAP_LIMITS.cols.min, MAP_LIMITS.cols.max) }),
    ...(rows === undefined
      ? {}
      : { rows: clamp(Math.floor(rows), MAP_LIMITS.rows.min, MAP_LIMITS.rows.max) }),
    ...(density === undefined || kind !== 'ogre'
      ? {}
      : {
          craterDensity: clamp(density, MAP_LIMITS.craterDensity.min, MAP_LIMITS.craterDensity.max),
        }),
  };
};

/** The terms, with a default for everything the order leaves out. */
export const readTerms = (raw: Readonly<Record<string, unknown>>): CustomTerms => {
  const victory = raw['victory'];
  const turnLimit = asNumber(raw['turnLimit']);
  const centralLimit = asNumber(raw['centralLimit']);
  return {
    map: readMapSpec(raw['map']),
    victory:
      victory === 'breakthrough' || victory === 'attrition' || victory === 'command-post'
        ? victory
        : 'command-post',
    turnLimit: turnLimit !== undefined && turnLimit > 0 ? Math.floor(turnLimit) : null,
    centralLimit: centralLimit !== undefined && centralLimit > 0 ? Math.floor(centralLimit) : null,
  };
};

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

const isStock = (spec: CustomMapSpec): boolean =>
  spec.seed === undefined &&
  spec.cols === undefined &&
  spec.rows === undefined &&
  spec.craterDensity === undefined;

/** A generated board is deterministic in its spec, so one copy serves everybody. */
const generated = new Map<string, GameMap>();

/**
 * The board a spec names. The stock boards are the ones every other scenario
 * plays on; anything else is generated from the seed, and the cratered map's
 * area lines are rescaled so a taller or shorter board still has a North, a
 * Central and a South Area in the printed proportions.
 */
export const customMap = (spec: CustomMapSpec): GameMap => {
  const stock = MAPS[spec.kind];
  if (isStock(spec) && stock) return stock;
  const k = JSON.stringify([
    spec.kind,
    spec.seed ?? null,
    spec.cols ?? null,
    spec.rows ?? null,
    spec.craterDensity ?? null,
  ]);
  const seen = generated.get(k);
  if (seen) return seen;
  const size = {
    ...(spec.seed === undefined ? {} : { seed: spec.seed }),
    ...(spec.cols === undefined ? {} : { cols: spec.cols }),
    ...(spec.rows === undefined ? {} : { rows: spec.rows }),
  };
  const built =
    spec.kind === 'gev'
      ? buildGevMap(size)
      : buildOgreMap({
          ...size,
          ...(spec.craterDensity === undefined ? {} : { craterDensity: spec.craterDensity }),
        });
  const map: GameMap = {
    ...built,
    id: `${spec.kind}:${spec.seed ?? 'stock'}:${built.cols}x${built.rows}`,
    name: `${built.name}${spec.seed === undefined ? '' : ` #${spec.seed}`}`,
    ...(spec.kind === 'ogre'
      ? {
          areaLines: {
            north: Math.max(2, Math.round((built.rows * 8) / 21)),
            south: Math.min(built.rows - 1, Math.round((built.rows * 17) / 21)),
          },
        }
      : {}),
  };
  generated.set(k, map);
  return map;
};

// ---------------------------------------------------------------------------
// The ground
// ---------------------------------------------------------------------------

interface Ground {
  readonly attacker: Hex[];
  readonly attackerLabel: string;
  readonly defender: Hex[];
  readonly defenderLabel: string;
  /** The cratered map's Central Area, where the screen ceiling applies. */
  readonly central: Hex[] | null;
  /** Where the attacker came from, and leaves by once its work is done. */
  readonly homeEdge: Edge;
  /** The edge a breakthrough is measured at. */
  readonly farEdge: Edge;
  /** Deeper is farther from the attacker's edge; the post goes deepest. */
  depth(h: Hex): number;
}

const standable = (map: GameMap, h: Hex): boolean => {
  const t = terrainAt(map, h);
  return t !== 'crater' && t !== 'water';
};

const groundOf = (map: GameMap, kind: MapKind): Ground => {
  if (kind === 'gev') {
    // The Crossing's shape: the attacker holds the western strip, the defence
    // the eastern two thirds, and the river runs between them.
    const strip = Math.max(2, Math.round(map.cols / 5));
    const line = Math.round(map.cols / 3);
    return {
      attacker: allHexes(map).filter((h) => toOffset(h).col <= strip && standable(map, h)),
      attackerLabel: 'the western strip',
      defender: allHexes(map).filter((h) => toOffset(h).col >= line && standable(map, h)),
      defenderLabel: 'the eastern two thirds',
      central: null,
      homeEdge: 'west',
      farEdge: 'east',
      depth: (h) => toOffset(h).col,
    };
  }
  // The printed areas: the attacker comes on in the South Area, the defence
  // sets up in the North and Central Areas.
  const central = openHexes(map, 'central');
  return {
    attacker: openHexes(map, 'south'),
    attackerLabel: 'the South Area',
    defender: [...openHexes(map, 'north'), ...central],
    defenderLabel: 'the North and Central Areas',
    central,
    homeEdge: 'south',
    farEdge: 'north',
    depth: (h) => map.rows - toOffset(h).row,
  };
};

// ---------------------------------------------------------------------------
// Forces
// ---------------------------------------------------------------------------

/** One counter to put down: a cybertank, or a conventional unit of so many squads. */
export type Counter =
  | { readonly kind: 'ogre'; readonly type: OgreTypeId }
  | { readonly kind: 'unit'; readonly cls: UnitClassId; readonly squads: number };

/**
 * Expand a side's `forces` into counters, in the order they are best placed:
 * cybertanks and the command post first, then armour, then infantry split the
 * way the counter mix splits (3.02). An id outside the engine's vocabulary is
 * a corrupt or mistyped order, and a battle silently missing half a force is
 * worse than no battle, so it throws.
 */
export const expandForces = (forces: Readonly<Record<string, number>>): Counter[] => {
  const ogres: Counter[] = [];
  const armour: Counter[] = [];
  const infantry: Counter[] = [];
  for (const [id, raw] of Object.entries(forces)) {
    const count = Math.floor(raw);
    if (!(count > 0)) continue;
    if (id in OGRE_TYPES) {
      for (let i = 0; i < count; i++) ogres.push({ kind: 'ogre', type: id as OgreTypeId });
    } else if (!(id in UNIT_CLASSES)) {
      throw new Error(`the order asks for "${id}", which is not a unit this game fields`);
    } else if (isInfantryClass(id as UnitClassId)) {
      for (const squads of infantryCounters(count)) {
        infantry.push({ kind: 'unit', cls: id as UnitClassId, squads });
      }
    } else if (SELECTABLE_CLASSES.includes(id as UnitClassId) || id === 'CP') {
      for (let i = 0; i < count; i++)
        armour.push({ kind: 'unit', cls: id as UnitClassId, squads: 1 });
    } else {
      throw new Error(`the order asks for "${id}", which is not a unit this game fields`);
    }
  }
  return [...ogres, ...armour, ...infantry];
};

/** The attack strength a counter contributes to a screen ceiling. */
const screenStrength = (c: Counter): number =>
  c.kind === 'ogre' ? Infinity : unitClass(c.cls).attack * c.squads;

const putDown = (d: Deployer, owner: PlayerId, c: Counter, hexes: Hex[]): boolean => {
  if (c.kind === 'unit') return place(d, owner, c.cls, hexes, c.squads) !== null;
  while (hexes.length > 0 && !isFree(d.state, hexes[0]!)) hexes.shift();
  const at = hexes.shift();
  if (!at) return false;
  d.state = withUnit(
    d.state,
    makeOgre(`${owner}-${c.type.toLowerCase()}-${d.serial++}`, owner, c.type, at),
  );
  return true;
};

/**
 * What a force is worth, for the builder's budget line and the breakthrough
 * tally: armour units (1.07, 13.03) and squads, counted separately the way
 * the scenarios state allowances.
 */
export const forceValue = (
  forces: Readonly<Record<string, number>>,
): { readonly armorUnits: number; readonly squads: number; readonly counters: number } => {
  let armorUnits = 0;
  let squads = 0;
  let counters = 0;
  for (const [id, raw] of Object.entries(forces)) {
    const count = Math.floor(raw);
    if (!(count > 0)) continue;
    if (id in OGRE_TYPES) {
      armorUnits += OGRE_TYPES[id as OgreTypeId].armorUnits * count;
      counters += count;
    } else if (id in UNIT_CLASSES) {
      const cls = UNIT_CLASSES[id as UnitClassId];
      if (cls.kind === 'infantry') {
        squads += count;
        counters += infantryCounters(count).length;
      } else {
        armorUnits += cls.armorUnits * count;
        counters += count;
      }
    }
  }
  return { armorUnits, squads, counters };
};

/** A unit's worth in armour units, for the breakthrough tally. */
const unitValue = (u: Unit): number => {
  if (isOgre(u)) return ogreType(u.typeId).armorUnits;
  const cls = unitClass(u.classId);
  return cls.kind === 'infantry' ? cls.armorUnits * u.squads : cls.armorUnits;
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** A ready-made combined-arms duel, for a builder opened cold and for tests. */
export const DEFAULT_CUSTOM: OrderOfBattle = {
  battleId: 'custom-default',
  seed: 0,
  scenarioId: CUSTOM_ID,
  sides: [
    {
      player: 'attacker',
      faction: 'Paneuropean Federation',
      forces: { MK3: 1, HVY: 2, GEV: 3, INF: 6 },
    },
    {
      player: 'defender',
      faction: 'North American Combine',
      forces: { HVY: 3, MSL: 2, GEV: 2, HWZ: 1, INF: 12 },
    },
  ],
  terms: { map: { kind: 'ogre' }, victory: 'command-post', centralLimit: 20 },
};

const colours = (attacker: OrderSide, defender: OrderSide): [string, string] => {
  const red = '#d94f4f';
  const blue = '#5b9bd5';
  if (/combine/i.test(attacker.faction) && !/combine/i.test(defender.faction)) return [red, blue];
  return [blue, red];
};

const build = (opts: ScenarioBuildOptions): GameState => {
  const order = opts.order ?? { ...DEFAULT_CUSTOM, seed: opts.seed };
  const [attacker, defender] = order.sides;
  if (!attacker || !defender) throw new Error('a custom battle needs an attacker and a defender');
  if (attacker.player === defender.player) {
    throw new Error('the two sides of a custom battle need different ids');
  }
  const terms = readTerms(order.terms);
  const map = customMap(terms.map);
  const ground = groundOf(map, terms.map.kind);
  const [attackerColour, defenderColour] = colours(attacker, defender);

  const base = createGame({
    scenarioId: CUSTOM_ID,
    mapId: map.id,
    seed: order.seed,
    players: [
      makePlayer(attacker.player, attacker.faction, attacker.faction, attackerColour),
      makePlayer(defender.player, defender.faction, defender.faction, defenderColour),
    ],
    options: {
      // The cratered map's rules or the green map's: no stacking and ramming
      // on the one, real stacking and overrun combat on the other (5.02, 6.00).
      stackingLimit: terms.map.kind === 'gev' ? 5 : 1,
      overrunCombat: terms.map.kind === 'gev',
      ...opts.options,
    },
    scenarioData: {
      [ORDER_KEY]: order,
      terms: CUSTOM_ID,
      victory: terms.victory,
      turnLimit: terms.turnLimit,
      farEdge: ground.farEdge,
      // Where a cybertank heads once the post is down — or, in a breakthrough,
      // from the start.
      ogreEscapeEdge: terms.victory === 'breakthrough' ? ground.farEdge : ground.homeEdge,
    },
  });

  let rng = createRng(order.seed ^ 0xc057);
  const d: Deployer = { state: base, serial: 1 };

  // --- The defence, first: it sets up first, and the post goes deepest. ---
  const defenderForces: Record<string, number> = { ...defender.forces };
  const defGround = shuffle(rng, ground.defender);
  rng = defGround.state;
  if (terms.victory === 'command-post') {
    delete defenderForces['CP'];
    const deep = [...defGround.items].sort((a, b) => ground.depth(b) - ground.depth(a));
    if (place(d, defender.player, 'CP', deep) === null) {
      throw new Error('there is no ground for the command post');
    }
  }
  // A screen forward up to the ceiling, the rest behind the line — the shape
  // of the printed setup, so the seeded arrangement is legal to keep.
  const forward: Hex[] = [];
  const rear: Hex[] = [];
  const centralKeys = new Set((ground.central ?? []).map((h) => `${h.q},${h.r}`));
  for (const h of defGround.items) {
    (ground.central !== null && terms.centralLimit !== null && centralKeys.has(`${h.q},${h.r}`)
      ? forward
      : rear
    ).push(h);
  }
  let screened = 0;
  for (const c of expandForces(defenderForces)) {
    const strength = screenStrength(c);
    const goesForward =
      forward.length > 0 &&
      terms.centralLimit !== null &&
      c.kind === 'unit' &&
      c.cls !== 'HWZ' &&
      screened + strength <= terms.centralLimit;
    const placed = goesForward
      ? putDown(d, defender.player, c, forward) || putDown(d, defender.player, c, rear)
      : putDown(d, defender.player, c, rear) || putDown(d, defender.player, c, forward);
    if (goesForward) screened += strength;
    if (!placed) throw new Error(`${ground.defenderLabel} is out of ground for the defence`);
  }

  // --- The attacker -------------------------------------------------------
  const attGround = shuffle(rng, ground.attacker);
  rng = attGround.state;
  const near = [...attGround.items].sort((a, b) => ground.depth(a) - ground.depth(b));
  for (const c of expandForces(attacker.forces)) {
    if (!putDown(d, attacker.player, c, near)) {
      throw new Error(`${ground.attackerLabel} is out of ground for the attacker`);
    }
  }

  const attackerValue = Object.values(d.state.units)
    .filter((u) => u.owner === attacker.player)
    .reduce((n, u) => n + unitValue(u), 0);
  d.state = {
    ...d.state,
    scenarioData: {
      ...d.state.scenarioData,
      attackerValue,
      defenderStartStrength: attackStrengthOf(d.state, defender.player),
    },
  };

  const built = log(
    d.state,
    'info',
    `${attacker.faction} comes on from ${ground.attackerLabel}; ${defender.faction} holds ` +
      `${ground.defenderLabel}. ${VICTORY_NAMES[terms.victory]}` +
      (terms.turnLimit === null ? '.' : `, ${terms.turnLimit} turns.`),
  );

  const defenderZone =
    ground.central !== null && terms.centralLimit !== null
      ? zone(ground.defender, ground.defenderLabel, [
          limit(ground.central, terms.centralLimit, 'the Central Area'),
        ])
      : zone(ground.defender, ground.defenderLabel);
  return withSetup(built, opts.setup, [defender.player, attacker.player], {
    [defender.player]: defenderZone,
    [attacker.player]: zone(ground.attacker, ground.attackerLabel),
  });
};

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

const won = (winners: PlayerId[], level: VictoryState['level'], reason: string): VictoryState => ({
  winners,
  level,
  reason,
});

interface Tally {
  readonly state: GameState;
  readonly attacker: OrderSide;
  readonly defender: OrderSide;
  readonly attackers: Unit[];
  readonly defenders: Unit[];
  readonly timeUp: boolean;
}

const commandPost = (t: Tally): VictoryState | null => {
  const { state, attacker, defender, attackers, defenders } = t;
  const A = [attacker.player];
  const D = [defender.player];
  const cp = defenders.find((u) => u.kind === 'unit' && u.classId === 'CP');
  const cpAlive = cp !== undefined && surviving(cp);
  const attackerLeft = attackers.some(onBoard);
  const escaped = attackers.some(
    (u) => !u.destroyed && u.offMap !== undefined && u.offMap !== 'reserve',
  );

  if (!defenders.some(onBoard)) {
    return won(
      A,
      'complete',
      `Every defending unit is gone. Complete ${attacker.faction} victory.`,
    );
  }

  // Cybertanks with no treads left, and nothing else on the attacker's side
  // that moves: the same reading the printed scenario takes of an Ogre that
  // cannot make the edge or reach the post.
  const onField = attackers.filter(onBoard);
  if (onField.length > 0 && onField.every((u) => isOgre(u) && u.treads <= 0)) {
    if (!cpAlive) {
      return won(
        A,
        'marginal',
        'The command post is destroyed, but nothing on the attacking side can move. Marginal victory.',
      );
    }
    const reach = Math.max(
      0,
      ...onField.flatMap((u) =>
        isOgre(u)
          ? u.weapons.filter((w) => !w.destroyed).map((w) => OGRE_WEAPONS[w.kind].range)
          : [],
      ),
    );
    if (cp && onField.every((u) => distance(u.pos, cp.pos) > reach)) {
      return won(
        D,
        'standard',
        'The attack is immobilised short of the post, and no gun left can reach it. Defence victory.',
      );
    }
  }

  if (attackerLeft && !t.timeUp) return null;

  if (attackerLeft) {
    // Time ran out with the attack still on the field.
    return cpAlive
      ? won(
          D,
          'standard',
          `The command post held out to the turn limit. ${defender.faction} victory.`,
        )
      : won(
          A,
          'marginal',
          'The command post is destroyed, but the attack never got clear. Marginal victory.',
        );
  }

  if (!cpAlive) {
    return escaped
      ? won(
          A,
          'standard',
          `The command post is destroyed and the attack got away. ${attacker.faction} victory.`,
        )
      : won(
          A,
          'marginal',
          'The command post is destroyed, but so is the attack. Marginal victory.',
        );
  }
  if (escaped) {
    return won(
      D,
      'marginal',
      'The command post survives, but the attack got away. Marginal defence victory.',
    );
  }
  const start = state.scenarioData['defenderStartStrength'];
  const strength = attackStrengthOf(state, defender.player);
  if (typeof start === 'number' && start > 0 && strength * 2 >= start) {
    return won(
      D,
      'complete',
      `The command post survives with ${strength} points of attack strength around it. Complete ${defender.faction} victory.`,
    );
  }
  return won(
    D,
    'standard',
    `The command post survives and the attack is destroyed. ${defender.faction} victory.`,
  );
};

const breakthrough = (t: Tally): VictoryState | null => {
  const { state, attacker, defender, attackers, defenders } = t;
  const A = [attacker.player];
  const D = [defender.player];
  const far = state.scenarioData['farEdge'];
  const total = state.scenarioData['attackerValue'];
  if (!defenders.some(onBoard)) {
    return won(
      A,
      'complete',
      `Every defending unit is gone. Complete ${attacker.faction} victory.`,
    );
  }
  if (attackers.some(onBoard) && !t.timeUp) return null;
  const through = attackers
    .filter((u) => !u.destroyed && u.offMap === far)
    .reduce((n, u) => n + unitValue(u), 0);
  const share = typeof total === 'number' && total > 0 ? through / total : 0;
  const pct = `${Math.round(share * 100)}%`;
  if (share >= 0.75)
    return won(
      A,
      'complete',
      `${pct} of the force is through and away. Complete ${attacker.faction} victory.`,
    );
  if (share >= 0.5)
    return won(A, 'standard', `${pct} of the force broke through. ${attacker.faction} victory.`);
  if (share >= 0.25)
    return won(
      A,
      'marginal',
      `${pct} of the force broke through. Marginal ${attacker.faction} victory.`,
    );
  if (share > 0)
    return won(
      D,
      'marginal',
      `Only ${pct} of the force got through. Marginal ${defender.faction} victory.`,
    );
  return won(D, 'complete', `Nothing got through. Complete ${defender.faction} victory.`);
};

const attrition = (t: Tally): VictoryState | null => {
  const { state, attacker, defender, attackers, defenders } = t;
  if (attackers.some(onBoard) && defenders.some(onBoard) && !t.timeUp) return null;
  const a = state.players[attacker.player]?.victoryPoints ?? 0;
  const b = state.players[defender.player]?.victoryPoints ?? 0;
  if (a === b) {
    return won(
      [defender.player],
      'marginal',
      `Both sides took ${a} victory points; the defence held the field. Marginal ${defender.faction} victory.`,
    );
  }
  const [winner, more, less] = a > b ? [attacker, a, b] : [defender, b, a];
  const ratio = less === 0 ? Infinity : more / less;
  const level: VictoryState['level'] =
    ratio >= 2 ? 'complete' : ratio >= 1.5 ? 'standard' : 'marginal';
  return won([winner.player], level, `${winner.faction} took ${more} victory points to ${less}.`);
};

const checkVictory = (state: GameState): VictoryState | null => {
  const order = orderOf(state.scenarioData);
  const [attacker, defender] = order?.sides ?? [];
  if (!order || !attacker || !defender) return null;
  const units = Object.values(state.units);
  const limitRaw = state.scenarioData['turnLimit'];
  const turnLimit = typeof limitRaw === 'number' && limitRaw > 0 ? limitRaw : null;
  const tally: Tally = {
    state,
    attacker,
    defender,
    attackers: units.filter((u) => u.owner === attacker.player),
    defenders: units.filter((u) => u.owner === defender.player),
    timeUp: turnLimit !== null && state.turn > turnLimit,
  };
  switch (state.scenarioData['victory']) {
    case 'breakthrough':
      return breakthrough(tally);
    case 'attrition':
      return attrition(tally);
    default:
      return commandPost(tally);
  }
};

// ---------------------------------------------------------------------------
// Describing one
// ---------------------------------------------------------------------------

/** A force as a sentence: "Ogre Mark III, 2 Heavy Tanks, 3 GEVs, 6 squads". */
export const describeForces = (forces: Readonly<Record<string, number>>): string => {
  const parts: string[] = [];
  for (const [id, raw] of Object.entries(forces)) {
    const count = Math.floor(raw);
    if (!(count > 0)) continue;
    if (id in OGRE_TYPES) {
      const name = OGRE_TYPES[id as OgreTypeId].name;
      parts.push(count === 1 ? name : `${count} × ${name}`);
    } else if (id in UNIT_CLASSES) {
      const cls = UNIT_CLASSES[id as UnitClassId];
      if (cls.kind === 'infantry') {
        parts.push(
          `${count} ${cls.id === 'INF' ? 'squad' : cls.name + ' squad'}${count === 1 ? '' : 's'}`,
        );
      } else {
        parts.push(count === 1 ? cls.name : `${count} × ${cls.name}`);
      }
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing';
};

/** The lines a lobby or a briefing shows for a custom order. */
export const describeCustom = (order: OrderOfBattle): string[] => {
  const terms = readTerms(order.terms);
  const map = customMap(terms.map);
  const [attacker, defender] = order.sides;
  const lines = [
    `Map: ${map.name}, ${map.cols} × ${map.rows}`,
    `Victory: ${VICTORY_NAMES[terms.victory]}` +
      (terms.turnLimit === null ? '' : `, ${terms.turnLimit} turns`) +
      (terms.centralLimit === null ? '' : `; ${terms.centralLimit} attack points forward`),
  ];
  if (attacker) lines.push(`${attacker.faction} (attacking): ${describeForces(attacker.forces)}`);
  if (defender) lines.push(`${defender.faction} (defending): ${describeForces(defender.forces)}`);
  return lines;
};

export const CUSTOM: ScenarioDef = {
  id: CUSTOM_ID,
  name: 'Custom battle',
  mapId: MAPS['ogre']!.id,
  players: 2,
  map: MAPS['ogre']!,
  mapFor: (state) => {
    const order = orderOf(state.scenarioData);
    return customMap(readTerms(order?.terms ?? {}).map);
  },
  blurb: 'Any forces, either board, three ways to win — built in the battle builder.',
  briefing:
    'A battle of your own design. The builder sets the map, both forces and the terms; ' +
    'the order of battle it produces is what every joiner rebuilds, so a table shows the ' +
    'same board to everyone.\n\n' +
    'The attacker sets up in the South Area of the cratered map, or the western strip of the ' +
    'green one, and moves first. The defence sets up first, in the rest of the ground, with a ' +
    'command post placed deepest when the terms call for one.',
  victoryConditions: [
    'Command post: the classic outcomes, with the whole attacking force standing in for the Ogre.',
    'Breakthrough: scored by how much of the attacking force’s value leaves by the far edge.',
    'Attrition: victory points at the turn limit, or when one side is gone.',
  ],
  build,
  checkVictory,
};
