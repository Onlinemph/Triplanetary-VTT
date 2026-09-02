/**
 * A computer opponent for the ground game.
 *
 * Not a search: a set of instincts, each asked of the engine's own previews
 * so it never proposes what the rules refuse. It plays either seat of any
 * scenario in the picker — the Ogre driving on the command post, the defence
 * kiting it with missile tanks, an assault force grinding toward a base —
 * and every special order the scenarios add: reserves, orbital strikes,
 * cruise missiles, deployment.
 *
 * Every instinct is a weighted sum of features, and the weights live in one
 * table (`weights.ts`) that the tuning harness searches by playing the game
 * against itself. Nothing here carries a number of its own.
 *
 * The contract with the shell is {@link aiPlan}: given a state and a player,
 * return the commands to issue *now*, in order, for the decision the state
 * is waiting on — a whole movement phase, one overrun fire round, one
 * deployment. The shell dispatches them one at a time (so a human watching
 * can follow), skips any the engine refuses, and asks again when the phase
 * changes. The plan always ends with the order that moves the game on, so a
 * computer seat can never stall.
 *
 * Deterministic: no randomness here, only in the dice the engine rolls.
 */

import { type Hex, distance, eq, key, neighbors, toOffset, withinRadius } from '../engine/hex.js';
import { type GameMap, allHexes, inBounds, terrainAt } from '../engine/map.js';
import { type Odds, oddsChance, oddsFor } from '../engine/crt.js';
import { OGRE_WEAPONS, type OgreWeaponKind, ogreType } from '../engine/ogres.js';
import { baseTerrain, defenseMultiplier, entryCost } from '../engine/terrain.js';
import { mobilityOf } from '../engine/mobility.js';
import { unitClass } from '../engine/units.js';
import type { Command } from '../engine/commands.js';
import {
  type AttackerRef,
  type Building,
  type GameState,
  type OgreUnit,
  type PlayerId,
  type TargetRef,
  type Unit,
  activePlayer,
  canAct,
  isInertOgre,
  isOgre,
  onBoard,
  setupActor,
  unitsAt,
} from '../engine/types.js';
import {
  defenseOf,
  isFireable,
  movementAllowance,
  printedAttack,
  printedDefense,
  victoryValue,
} from '../engine/state.js';
import { reachable } from '../engine/movement.js';
import {
  canStillFire,
  orbitalStrikesLeft,
  previewAttack,
  previewOrbitalStrike,
} from '../engine/combat.js';
import { canRam } from '../engine/ram.js';
import { canOverrun, overrunActor, overrunUnits, previewOverrunAttack } from '../engine/overrun.js';
import { reactionTurn, reserveEntryHexes, reservesOf } from '../engine/reserves.js';
import { launchCheck, loadedCrawlers } from '../engine/missiles.js';
import { legalSetupHexes, zoneOf } from '../engine/setup.js';
import { DEFAULT_WEIGHTS, type Role, type Weights, roleOf } from './weights.js';

export { DEFAULT_WEIGHTS, BASE_WEIGHTS, WEIGHT_SPEC, WEIGHT_KEYS } from './weights.js';
export type { Weights, WeightKey, Role } from './weights.js';

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Commands for the decision the state is waiting on, ending with the one that moves on. */
export const aiPlan = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  weights: Weights = DEFAULT_WEIGHTS,
): Command[] => {
  if (state.victory) return [];
  const ctx = makeCtx(state, map, player, weights);
  if (state.setup) {
    return setupActor(state) === player ? planSetup(ctx) : [];
  }
  if (state.overrun) {
    return overrunActor(state) === player ? planOverrun(ctx) : [];
  }
  if (activePlayer(state) !== player) return [];

  switch (state.phase) {
    case 'recovery':
      return [{ type: 'endPhase', by: player }];
    case 'movement':
      return [...planMovement(ctx), { type: 'endPhase', by: player }];
    case 'fire':
      return [...planFire(ctx), { type: 'endPhase', by: player }];
    case 'gevMovement':
      return [...planSecondMovement(ctx), { type: 'endPhase', by: player }];
  }
};

/** A key for "the decision the state is waiting on"; a plan is stale once it changes. */
export const decisionKey = (state: GameState): string =>
  state.setup
    ? `setup:${state.setup.index}`
    : state.overrun
      ? `overrun:${state.overrun.round}:${state.overrun.firing}:${state.overrun.step}`
      : `${state.turn}:${state.activePlayerIndex}:${state.phase}`;

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

type Edge = 'north' | 'south' | 'east' | 'west';

/**
 * Everything one plan reads more than once: the board as this player sees
 * it, and caches for the two expensive questions — how much fire reaches a
 * hex, and how far a hex is from a goal by ground.
 */
interface Ctx {
  readonly state: GameState;
  readonly map: GameMap;
  readonly player: PlayerId;
  readonly w: Weights;
  readonly enemies: readonly Unit[];
  readonly own: readonly Unit[];
  /** The attacker moves first, by the convention every scenario here keeps. */
  readonly attacker: boolean;
  /** The enemy's command post or base, if there is one to take. */
  readonly objective: Hex | null;
  /** Our own post or base, if there is one to keep. */
  readonly guard: Hex | null;
  /** The enemy cybertank that matters most to what we guard. */
  readonly enemyOgre: OgreUnit | null;
  readonly edge: Edge | null;
  readonly threat: Map<string, number>;
  readonly fields: Map<string, ReadonlyMap<string, number>>;
}

const makeCtx = (state: GameState, map: GameMap, player: PlayerId, w: Weights): Ctx => {
  const enemies = enemiesOf(state, player);
  const guard = guardOf(state, player);
  const ogres = enemies.filter(isOgre);
  const enemyOgre = guard ? nearestOf(ogres, guard) : (ogres[0] ?? null);
  return {
    state,
    map,
    player,
    w,
    enemies,
    own: mine(state, player),
    attacker: state.playerOrder[0] === player,
    objective: objectiveOf(state, player),
    guard,
    enemyOgre: enemyOgre && isOgre(enemyOgre) ? enemyOgre : null,
    edge: escapeEdge(state),
    threat: new Map(),
    fields: new Map(),
  };
};

/** The same plan, with a move pencilled in: our side has changed, theirs has not. */
const withState = (ctx: Ctx, state: GameState): Ctx => ({
  ...ctx,
  state,
  own: mine(state, ctx.player),
});

const enemiesOf = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter((u) => u.owner !== player && onBoard(u));

const mine = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter((u) => u.owner === player && onBoard(u));

/** The enemy's command post or base building, if there is one to take. */
const objectiveOf = (state: GameState, player: PlayerId): Hex | null => {
  const cp = enemiesOf(state, player).find((u) => u.kind === 'unit' && u.classId === 'CP');
  if (cp) return cp.pos;
  const building = Object.values(state.buildings).find(
    (b) => !b.destroyed && b.owner !== null && b.owner !== player,
  );
  return building?.pos ?? null;
};

/** Our own command post or base building, if we have one to lose. */
const guardOf = (state: GameState, player: PlayerId): Hex | null => {
  const cp = mine(state, player).find((u) => u.kind === 'unit' && u.classId === 'CP');
  if (cp) return cp.pos;
  const building = Object.values(state.buildings).find((b) => !b.destroyed && b.owner === player);
  return building?.pos ?? null;
};

/** The edge an Ogre leaves by once its work is done, if the scenario has one. */
const escapeEdge = (state: GameState): Edge | null => {
  const raw = state.scenarioData['ogreEscapeEdge'];
  return raw === 'north' || raw === 'south' || raw === 'east' || raw === 'west' ? raw : null;
};

const edgeDistance = (map: GameMap, h: Hex, edge: Edge): number => {
  const o = toOffset(h);
  switch (edge) {
    case 'north':
      return o.row - 1;
    case 'south':
      return map.rows - o.row;
    case 'west':
      return o.col - 1;
    case 'east':
      return map.cols - o.col;
  }
};

/** The longest reach of a unit's guns. */
const reachOf = (u: Unit): number => {
  if (isOgre(u)) {
    return Math.max(
      0,
      ...u.weapons.filter((w) => isFireable(u, w)).map((w) => OGRE_WEAPONS[w.kind].range),
    );
  }
  const cls = unitClass(u.classId);
  return cls.laser ? 8 : cls.range;
};

const moveOf = (state: GameState, u: Unit): number =>
  isOgre(u) ? movementAllowance(u, 'movement', state.options) : unitClass(u.classId).move;

/**
 * How much attack strength the enemy can bring onto a hex next fire phase.
 * A gun that reaches from where it stands counts in full; one that would
 * have to move first counts for less, so that a hex just outside a
 * cybertank's batteries is better than one inside them even though the
 * cybertank can close the gap.
 */
const threatAt = (ctx: Ctx, h: Hex): number => {
  const k = key(h);
  const cached = ctx.threat.get(k);
  if (cached !== undefined) return cached;
  let total = 0;
  const { state } = ctx;
  const mobile = ctx.w['move.mobileThreat'];
  for (const e of ctx.enemies) {
    if (!canAct(e) || isInertOgre(e, state.turn + 1)) continue;
    const move = moveOf(state, e);
    const d = distance(e.pos, h);
    if (isOgre(e)) {
      for (const w of e.weapons) {
        if (!isFireable(e, w) || OGRE_WEAPONS[w.kind].antipersonnelOnly) continue;
        const range = OGRE_WEAPONS[w.kind].range;
        if (d <= range) total += OGRE_WEAPONS[w.kind].attack;
        else if (d <= range + move) total += OGRE_WEAPONS[w.kind].attack * mobile;
      }
    } else {
      const range = reachOf(e);
      if (d <= range) total += printedAttack(e);
      else if (d <= range + move) total += printedAttack(e) * mobile;
    }
  }
  ctx.threat.set(k, total);
  return total;
};

/** What this unit would be worth to the enemy, weighted toward what it threatens. */
const worth = (ctx: Ctx, u: Unit): number => {
  if (isOgre(u)) return ogreType(u.typeId).vp;
  const cls = unitClass(u.classId);
  if (cls.id === 'CP') return ctx.w['fire.worthCp'];
  return (
    victoryValue(u) +
    printedAttack(u) * ctx.w['fire.worthAttack'] +
    (cls.laser ? ctx.w['fire.worthLaser'] : 0)
  );
};

/** What one of a cybertank's guns is worth to the side shooting at it. */
const ogreWeaponWorth = (ctx: Ctx, kind: OgreWeaponKind, fired: boolean): number => {
  const w = ctx.w;
  const base =
    kind === 'main'
      ? w['fire.ogreMain']
      : kind === 'secondary'
        ? w['fire.ogreSecondary']
        : kind === 'missile'
          ? w['fire.ogreMissile']
          : kind === 'missileRack'
            ? w['fire.ogreRack']
            : kind === 'ap'
              ? w['fire.ogreAp']
              : w['fire.ogreArm'];
  return (
    base +
    OGRE_WEAPONS[kind].attack * w['fire.ogreWeaponAttack'] -
    (kind === 'missile' && fired ? w['fire.ogreMissileFired'] : 0)
  );
};

/** How much of the target's fire reaches our units next phase: what killing it buys. */
const threatRelief = (ctx: Ctx, e: Unit): number => {
  if (!canAct(e)) return 0;
  const move = moveOf(ctx.state, e);
  const reaches = (range: number): boolean =>
    ctx.own.some((u) => distance(u.pos, e.pos) <= range + move);
  if (isOgre(e)) {
    let total = 0;
    for (const w of e.weapons) {
      if (!isFireable(e, w) || OGRE_WEAPONS[w.kind].antipersonnelOnly) continue;
      if (reaches(OGRE_WEAPONS[w.kind].range)) total += OGRE_WEAPONS[w.kind].attack;
    }
    return total;
  }
  return reaches(reachOf(e)) ? printedAttack(e) : 0;
};

const nearestOf = <T extends { pos: Hex }>(units: readonly T[], from: Hex): T | null =>
  units.reduce<T | null>(
    (best, u) => (best === null || distance(u.pos, from) < distance(best.pos, from) ? u : best),
    null,
  );

/**
 * How many hexes of ground lie between `h` and the goal for a unit that
 * moves like `u`. Craters, water and whatever else it may never enter are
 * not ground. The straight-line count is no use here: it walks an Ogre into
 * a crater pocket and keeps it there, because every way out looks like a
 * step back. Where no ground connects the two at all, the crow's count
 * stands in.
 */
const groundDistance = (ctx: Ctx, u: Unit, h: Hex, goal: Hex): number => {
  const mobility = mobilityOf(u);
  const id = `${mobility}:${key(goal)}`;
  let field = ctx.fields.get(id);
  if (!field) {
    const { map, state } = ctx;
    const open = (x: Hex): boolean =>
      entryCost(terrainAt(map, x, state.terrainOverrides), mobility).cost !== null;
    const dist = new Map<string, number>();
    dist.set(key(goal), 0);
    const queue: Hex[] = [goal];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      const d = dist.get(key(at))!;
      for (const n of neighbors(at)) {
        const k = key(n);
        if (dist.has(k) || !inBounds(map, n) || !open(n)) continue;
        dist.set(k, d + 1);
        queue.push(n);
      }
    }
    field = dist;
    ctx.fields.set(id, field);
  }
  return field.get(key(h)) ?? distance(h, goal);
};

/** True when `h` lies on one of the enemy cybertank's shortest roads to what we guard. */
const onOgreRoad = (ctx: Ctx, h: Hex): boolean => {
  const ogre = ctx.enemyOgre;
  if (!ogre || !ctx.guard) return false;
  const whole = groundDistance(ctx, ogre, ogre.pos, ctx.guard);
  return groundDistance(ctx, ogre, h, ctx.guard) + groundDistance(ctx, ogre, h, ogre.pos) === whole;
};

// ---------------------------------------------------------------------------
// Shots, hypothetical and real: what a gun on a target is worth
// ---------------------------------------------------------------------------

/** The fraction of a kill a disable is worth, for this target. */
const disableWorth = (ctx: Ctx, target: Unit | undefined): number => {
  if (!target || target.kind !== 'unit') return 0;
  if (target.disabled !== 'none') return ctx.w['fire.disableDisabled'];
  return unitClass(target.classId).kind === 'infantry'
    ? ctx.w['fire.disableInfantry']
    : ctx.w['fire.disableArmour'];
};

/** Expected worth of a tread attack of `attack` strength on an Ogre. */
const treadValue = (ctx: Ctx, ogre: OgreUnit, attack: number, guns: number): number => {
  const hitOn =
    baseTerrain(terrainAt(ctx.map, ogre.pos, ctx.state.terrainOverrides)) === 'town' ? 6 : 5;
  const chance = (7 - hitOn) / 6;
  const lost = Math.min(ogre.treads, attack);
  // Treads are worth more the fewer are left: slowing a cybertank is the game.
  const scarcity =
    1 + (1 - ogre.treads / ogreType(ogre.typeId).treads) * ctx.w['fire.treadScarcity'];
  return chance * lost * ctx.w['fire.tread'] * scarcity - guns * ctx.w['fire.treadGunCost'];
};

/** The Combat Results Table, remembered: the same odds come up thousands of times a plan. */
const chanceCache = new Map<string, { x: number; d: number }>();
const chanceOf = (odds: Odds): { x: number; d: number } => {
  const k = odds.kind === 'column' ? odds.column : odds.kind;
  let c = chanceCache.get(k);
  if (!c) {
    const full = oddsChance(odds);
    c = { x: full.x, d: full.d };
    chanceCache.set(k, c);
  }
  return c;
};

/** Expected worth of odds against a target of the given worth. */
const oddsValue = (ctx: Ctx, odds: Odds, value: number, target: Unit | undefined): number => {
  const chance = chanceOf(odds);
  return (chance.x / 6) * value + (chance.d / 6) * value * disableWorth(ctx, target);
};

/**
 * What one gun of `attack` strength and `range`, fired from `from`, could
 * expect to do to enemy `e` — without asking the engine, so a hex can be
 * scored before anything stands on it. A cybertank is taken at its best
 * target: the most valuable gun still on it, or its treads.
 */
const shotFrom = (ctx: Ctx, from: Hex, attack: number, range: number, e: Unit): number => {
  if (attack <= 0 || distance(from, e.pos) > range) return 0;
  if (isOgre(e)) {
    const townMul =
      baseTerrain(terrainAt(ctx.map, e.pos, ctx.state.terrainOverrides)) === 'town' ? 2 : 1;
    let best = e.treads > 0 ? treadValue(ctx, e, attack, 1) : 0;
    const seen = new Set<OgreWeaponKind>();
    for (const w of e.weapons) {
      if (w.destroyed || seen.has(w.kind)) continue;
      seen.add(w.kind);
      const value = oddsValue(
        ctx,
        oddsFor(attack, OGRE_WEAPONS[w.kind].defense * townMul),
        ogreWeaponWorth(ctx, w.kind, w.fired),
        undefined,
      );
      if (value > best) best = value;
    }
    return best;
  }
  return oddsValue(
    ctx,
    oddsFor(attack, defenseOf(ctx.state, ctx.map, e)),
    worth(ctx, e) + threatRelief(ctx, e) * ctx.w['fire.threatRelief'],
    e,
  );
};

/**
 * The expected kill value of this unit's guns from a hex, this turn.
 * `candidates` narrows the enemies to those any hex the unit can reach
 * could possibly see, so a plan does not re-scan the whole board per hex.
 */
const killValueFrom = (ctx: Ctx, u: Unit, from: Hex, candidates: readonly Unit[]): number => {
  if (isOgre(u)) {
    if (isInertOgre(u, ctx.state.turn)) return 0;
    let total = 0;
    const seen = new Map<OgreWeaponKind, number>();
    for (const w of u.weapons) {
      if (!isFireable(u, w) || w.fired) continue;
      seen.set(w.kind, (seen.get(w.kind) ?? 0) + 1);
    }
    for (const [kind, count] of seen) {
      const spec = OGRE_WEAPONS[kind];
      let best = 0;
      for (const e of candidates) {
        if (spec.antipersonnelOnly && !(e.kind === 'unit' && isInfantry(e))) continue;
        const v = shotFrom(ctx, from, spec.attack, spec.range, e);
        if (v > best) best = v;
      }
      total += best * count;
    }
    return total;
  }
  if (!canAct(u) || (u.kind === 'unit' && u.disabled !== 'none')) return 0;
  const attack = printedAttack(u);
  const range = reachOf(u);
  let best = 0;
  for (const e of candidates) {
    const v = shotFrom(ctx, from, attack, range, e);
    if (v > best) best = v;
  }
  return best;
};

/** Enemies within `radius` of `from`: all any reachable hex could put in range. */
const enemiesNear = (ctx: Ctx, from: Hex, radius: number): Unit[] =>
  ctx.enemies.filter((e) => distance(e.pos, from) <= radius);

const isInfantry = (u: Unit): boolean =>
  u.kind === 'unit' && unitClass(u.classId).kind === 'infantry';

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

const planMovement = (ctx0: Ctx): Command[] => {
  const out: Command[] = [];
  let ctx = ctx0;
  const { map, player } = ctx;

  // Reserves race back the moment they may (Orbital Drop §3.03).
  if (ctx.state.turn >= reactionTurn(ctx.state)) {
    const target =
      ctx.objective ??
      (ctx.enemies[0]
        ? (nearestOf(ctx.enemies, myCentre(ctx) ?? ctx.enemies[0].pos)?.pos ?? null)
        : null);
    for (const r of reservesOf(ctx.state, player)) {
      const hexes = reserveEntryHexes(ctx.state, map, r);
      if (hexes.length === 0) continue;
      let best = hexes[0]!;
      let bestScore = -Infinity;
      for (const h of hexes) {
        const score =
          -(target ? groundDistance(ctx, r, h, target) : 0) * ctx.w['reserve.goal'] -
          (threatAt(ctx, h) / ownDefense(ctx, r)) * ctx.w['reserve.threat'];
        if (score > bestScore) {
          best = h;
          bestScore = score;
        }
      }
      out.push({ type: 'deployReserve', by: player, unit: r.id, at: best });
      // Mark the hex taken so two reserves do not pick the same one.
      ctx = withState(ctx, {
        ...ctx.state,
        units: { ...ctx.state.units, [r.id]: { ...r, offMap: undefined, pos: best } },
      });
    }
  }

  const movers = ctx.own
    .filter(
      (u) => canAct(u) && !isInertOgre(u, ctx.state.turn) && !(u.kind === 'unit' && u.ridingOn),
    )
    // Ogres decide first: everything else moves around where the cybertank goes.
    .sort((a, b) => (isOgre(b) ? 1 : 0) - (isOgre(a) ? 1 : 0) || a.id.localeCompare(b.id));

  for (const u of movers) {
    const cmd = moveFor(ctx, u);
    if (!cmd) continue;
    out.push(cmd);
    // Pencil the move in so the next unit does not plan into the same hex.
    if (cmd.type === 'moveUnit') {
      const dest = cmd.path[cmd.path.length - 1];
      if (dest && inBounds(map, dest)) {
        ctx = withState(ctx, {
          ...ctx.state,
          units: {
            ...ctx.state.units,
            [u.id]: { ...u, pos: dest, movementEnded: true } as Unit,
          },
        });
      }
    }
  }
  return out;
};

const myCentre = (ctx: Ctx): Hex | null => {
  const units = ctx.own;
  if (units.length === 0) return null;
  const q = units.reduce((n, u) => n + u.pos.q, 0) / units.length;
  const r = units.reduce((n, u) => n + u.pos.r, 0) / units.length;
  return { q: Math.round(q), r: Math.round(r) };
};

/** What a unit counts as its defence when weighing enemy fire against it. */
const ownDefense = (ctx: Ctx, u: Unit): number =>
  isOgre(u) ? ctx.w['move.ogreDefense'] : Math.max(1, printedDefense(u));

type Goal = { kind: 'hex'; hex: Hex } | { kind: 'edge'; edge: Edge } | { kind: 'hold' };

const moveFor = (ctx: Ctx, u: Unit): Command | null => {
  const { state, map, player } = ctx;
  if (movementAllowance(u, state.phase, state.options) <= 0 || u.movementEnded) return null;

  const options = reachable(state, map, u);

  // --- A cybertank looks for something to ram first --------------------
  if (isOgre(u) || (u.kind === 'unit' && u.classId === 'SHVY')) {
    const ram = ramFor(ctx, u, options);
    if (ram) return ram;
  }

  // --- Where to go ------------------------------------------------------
  const goal = goalFor(ctx, u);
  const near = enemiesNear(
    ctx,
    u.pos,
    movementAllowance(u, state.phase, state.options) + reachOf(u),
  );
  let best: { hex: Hex; cost: number; path: readonly Hex[] } = { hex: u.pos, cost: 0, path: [] };
  let bestScore = scoreHex(ctx, u, u.pos, goal, null, near);
  for (const r of options) {
    const score = scoreHex(ctx, u, r.hex, goal, r.hazard, near);
    if (score > bestScore + 1e-9) {
      best = { hex: r.hex, cost: r.cost, path: r.path };
      bestScore = score;
    }
  }

  // Off the map, when that is the goal and the edge is one step away.
  if (goal.kind === 'edge' && isOgre(u)) {
    const step = neighbors(u.pos).find((n) => !inBounds(map, n) && edgeStep(map, n, goal.edge));
    if (step) return { type: 'moveUnit', by: player, unit: u.id, path: [step] };
    if (best.hex !== u.pos && edgeDistance(map, best.hex, goal.edge) === 0) {
      const off = neighbors(best.hex).find((n) => !inBounds(map, n) && edgeStep(map, n, goal.edge));
      if (off && best.cost + 1 <= movementAllowance(u, state.phase, state.options)) {
        return { type: 'moveUnit', by: player, unit: u.id, path: [...best.path, off] };
      }
    }
  }

  if (best.path.length === 0) return null;
  return { type: 'moveUnit', by: player, unit: u.id, path: [...best.path] };
};

/** True when an off-map hex is past the given edge (rather than a corner overshoot). */
const edgeStep = (map: GameMap, off: Hex, edge: Edge): boolean => {
  const o = toOffset(off);
  switch (edge) {
    case 'north':
      return o.row < 1;
    case 'south':
      return o.row > map.rows;
    case 'west':
      return o.col < 1;
    case 'east':
      return o.col > map.cols;
  }
};

const goalFor = (ctx: Ctx, u: Unit): Goal => {
  if (ctx.attacker) {
    if (ctx.objective) return { kind: 'hex', hex: ctx.objective };
    if (ctx.edge && isOgre(u)) return { kind: 'edge', edge: ctx.edge };
    // Nothing left to take: hunt the nearest enemy.
    const nearest = nearestOf(ctx.enemies, u.pos);
    return nearest ? { kind: 'hex', hex: nearest.pos } : { kind: 'hold' };
  }
  // The defence goes for the cybertank, or failing that whatever is nearest.
  const ogre = nearestOf(ctx.enemies.filter(isOgre), u.pos);
  const nearest = ogre ?? nearestOf(ctx.enemies, u.pos);
  if (!nearest) return { kind: 'hold' };
  return { kind: 'hex', hex: nearest.pos };
};

/**
 * How good a hex is for this unit to end the phase in: every feature the
 * weight table names, summed. The weights are the whole personality.
 */
const scoreHex = (
  ctx: Ctx,
  u: Unit,
  h: Hex,
  goal: Goal,
  hazard: null | 'disable' | 'stuck',
  near: readonly Unit[],
): number => {
  const { w, state, map } = ctx;
  const role: Role = roleOf(u);
  const reach = reachOf(u);
  const infantry = isInfantry(u);
  const terrain = terrainAt(map, h, state.terrainOverrides);
  const cover = defenseMultiplier(terrain, infantry) - 1;

  let score = 0;

  // Toward the goal, by ground.
  if (goal.kind === 'hex') {
    const d = groundDistance(ctx, u, h, goal.hex);
    score -=
      d * (ctx.attacker ? w['move.goalAttacker'] : w['move.goalDefender']) * w[`move.goal.${role}`];
  } else if (goal.kind === 'edge') {
    score -= edgeDistance(map, h, goal.edge) * w['move.edge'] * w[`move.goal.${role}`];
  }

  // Hold at own range: a gun that outranges the enemy does not walk into him.
  const nearest = nearestOf(ctx.enemies, h);
  if (nearest && reach >= 2) {
    const range = distance(h, nearest.pos);
    if (range < reach) score -= (reach - range) * w[`move.standoff.${role}`];
  }

  // Targets this hex puts in reach, weighted by what they are worth …
  let inReach = 0;
  if (reach > 0) {
    for (const e of ctx.enemies) if (distance(e.pos, h) <= reach) inReach += worth(ctx, e);
  }
  score += Math.min(inReach, w['move.inReachCap']) * w[`move.inReach.${role}`];
  // … and what the guns could actually do from here this turn.
  score += killValueFrom(ctx, u, h, near) * w[`move.kill.${role}`];

  // Enemy fire that can reach the hex next phase, against our own defence.
  score -=
    (threatAt(ctx, h) / ownDefense(ctx, u)) *
    (ctx.attacker ? w['move.threatAttacker'] : w['move.threatDefender']) *
    w[`move.threat.${role}`];

  score += cover * w[`move.cover.${role}`];
  if (hazard === 'stuck') score -= w['move.hazardStuck'];
  if (hazard === 'disable') score -= w['move.hazardDisable'];
  if (isOgre(u) && baseTerrain(terrain) === 'water') score -= w['move.ogreWater'];

  // Between the cybertank and what we guard, and on its road if that pays.
  if (ctx.guard && ctx.enemyOgre) {
    const ogre = ctx.enemyOgre;
    const off = distance(h, ogre.pos) + distance(h, ctx.guard) - distance(ogre.pos, ctx.guard);
    score -= off * w[`move.screen.${role}`];
    if (w[`move.block.${role}`] > 0 && onOgreRoad(ctx, h)) score += w[`move.block.${role}`];
  }

  // Do not stack on a friend on the one-per-hex map (the engine refuses it
  // anyway) and do not crowd on the green one.
  if (unitsAt(state, h).some((o) => o.owner === ctx.player && o.id !== u.id))
    score -= w['move.crowd'];
  return score;
};

/** Ram what is worth ramming: the command post always, armour when the treads can spare it. */
const ramFor = (ctx: Ctx, u: Unit, options: readonly { hex: Hex }[]): Command | null => {
  const { state, map, player, w } = ctx;
  const overrun = state.options.overrunCombat;
  let best: { cmd: Command; value: number } | null = null;
  const seen = new Set<string>();
  for (const e of ctx.enemies) {
    if (seen.has(key(e.pos))) continue;
    seen.add(key(e.pos));
    const legal = overrun ? canOverrun(state, map, u, e.pos).ok : canRam(state, map, u, e.pos).ok;
    if (!legal) continue;
    let value = 0;
    for (const v of unitsAt(state, e.pos).filter((x) => x.owner !== player)) {
      if (v.kind === 'unit' && v.classId === 'CP') value += w['ram.cp'];
      else if (isOgre(v)) value += overrun ? w['ram.ogreOverrun'] : w['ram.ogre'];
      else if (isInfantry(v)) value += overrun ? w['ram.infantryOverrun'] : 0;
      else value += victoryValue(v) * w['ram.armour'];
    }
    // A cybertank on its last treads keeps them for the road out.
    if (isOgre(u)) {
      const type = ogreType(u.typeId);
      if (u.treads < type.treads * w['ram.treadReserve'] && value < w['ram.cp'] / 2) continue;
    }
    if (value <= 0) continue;
    // Prefer the ram that carries the cybertank toward its goal over one that
    // takes it away — and a tank corking the only lane through the craters
    // is worth ramming whatever it is, because there is no way round it.
    if (ctx.objective) {
      const here = groundDistance(ctx, u, u.pos, ctx.objective);
      const there = groundDistance(ctx, u, e.pos, ctx.objective);
      if (there < here) {
        value += w['ram.toward'];
        const boxedIn = options.every((r) => groundDistance(ctx, u, r.hex, ctx.objective!) >= here);
        if (boxedIn) value += w['ram.boxed'];
      } else {
        value -= (there - here + 1) * w['ram.away'];
      }
    }
    if (!best || value > best.value) {
      best = {
        value,
        cmd: overrun
          ? { type: 'overrun', by: player, unit: u.id, target: e.pos }
          : { type: 'ram', by: player, unit: u.id, target: e.pos },
      };
    }
  }
  return best && best.value >= w['ram.min'] ? best.cmd : null;
};

/** GEVs that shot this turn get away; anything else with a second move sits tight. */
const planSecondMovement = (ctx0: Ctx): Command[] => {
  const out: Command[] = [];
  let ctx = ctx0;
  const { map, player, w } = ctx;
  for (const u of ctx.own) {
    if (u.kind !== 'unit' || unitClass(u.classId).secondMove == null) continue;
    if (!canAct(u) || u.movementEnded || u.ridingOn) continue;
    const reach = reachOf(u);
    const defense = ownDefense(ctx, u);
    const score = (h: Hex, cost: number): number => {
      let inReach = 0;
      for (const e of ctx.enemies) if (distance(e.pos, h) <= reach) inReach += worth(ctx, e);
      const terrain = terrainAt(map, h, ctx.state.terrainOverrides);
      return (
        -(threatAt(ctx, h) / defense) * w['second.threat'] -
        cost * w['second.cost'] +
        Math.min(inReach, w['move.inReachCap']) * w['second.reach'] +
        (defenseMultiplier(terrain, false) - 1) * w['second.cover'] -
        (unitsAt(ctx.state, h).some((o) => o.owner === player && o.id !== u.id)
          ? w['move.crowd']
          : 0)
      );
    };
    const options = reachable(ctx.state, map, u);
    let best: Hex | null = null;
    let bestScore = score(u.pos, 0);
    for (const r of options) {
      if (r.hazard) continue;
      const s = score(r.hex, r.cost);
      if (s > bestScore + 1e-9) {
        best = r.hex;
        bestScore = s;
      }
    }
    if (best) {
      const path = options.find((r) => eq(r.hex, best!))?.path ?? [];
      if (path.length > 0) {
        out.push({ type: 'moveUnit', by: player, unit: u.id, path: [...path] });
        ctx = withState(ctx, {
          ...ctx.state,
          units: { ...ctx.state.units, [u.id]: { ...u, pos: best, movementEnded: true } },
        });
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Every gun a player could still fire this phase, as attacker refs. */
const gunsOf = (ctx: Ctx): AttackerRef[] => {
  const refs: AttackerRef[] = [];
  for (const u of ctx.own) {
    if (!canStillFire(ctx.state, u) || isInertOgre(u, ctx.state.turn)) continue;
    if (isOgre(u)) {
      for (const w of u.weapons)
        if (isFireable(u, w) && !w.fired) refs.push({ unit: u.id, weapon: w.id });
    } else {
      refs.push({ unit: u.id });
    }
  }
  return refs;
};

const strengthOfRef = (state: GameState, ref: AttackerRef): number => {
  const u = state.units[ref.unit];
  if (!u) return 0;
  if (isOgre(u)) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    return w ? OGRE_WEAPONS[w.kind].attack : 0;
  }
  return printedAttack(u);
};

/** What spending this gun on a shot costs: a missile is not had back. */
const gunCost = (ctx: Ctx, ref: AttackerRef): number => {
  const u = ctx.state.units[ref.unit];
  if (u && isOgre(u) && ref.weapon) {
    const w = u.weapons.find((x) => x.id === ref.weapon);
    if (w && (w.kind === 'missile' || w.kind === 'missileRack'))
      return ctx.w['fire.gunCost'] + ctx.w['fire.missileCost'];
  }
  return ctx.w['fire.gunCost'];
};

interface Target {
  readonly ref: TargetRef;
  readonly value: number;
  readonly hex: Hex;
}

/** Every way of hurting the enemy: units, Ogre components, buildings. */
const targetsOf = (ctx: Ctx): Target[] => {
  const out: Target[] = [];
  for (const e of ctx.enemies) out.push(...unitTargets(ctx, e));
  for (const b of Object.values(ctx.state.buildings)) {
    if (b.destroyed || b.owner === ctx.player) continue;
    out.push({
      ref: { kind: 'building', building: b.id },
      value: ctx.w['fire.buildingValue'],
      hex: b.pos,
    });
  }
  return out;
};

const unitTargets = (ctx: Ctx, e: Unit): Target[] => {
  const out: Target[] = [];
  if (isOgre(e)) {
    const seen = new Set<string>();
    for (const w of e.weapons) {
      if (w.destroyed || seen.has(w.kind)) continue;
      seen.add(w.kind);
      out.push({
        ref: { kind: 'ogreWeapon', unit: e.id, weapon: w.id },
        value: ogreWeaponWorth(ctx, w.kind, w.fired),
        hex: e.pos,
      });
    }
    if (e.treads > 0) out.push({ ref: { kind: 'ogreTreads', unit: e.id }, value: 0, hex: e.pos });
  } else {
    out.push({
      ref: { kind: 'unit', unit: e.id },
      value: worth(ctx, e) + threatRelief(ctx, e) * ctx.w['fire.threatRelief'],
      hex: e.pos,
    });
  }
  return out;
};

interface Shot {
  readonly attackers: AttackerRef[];
  readonly target: TargetRef;
  readonly ev: number;
}

interface Preview {
  readonly ok: boolean;
  readonly odds: Odds;
  readonly treadAttack?: boolean;
  readonly attackStrength: number;
  readonly structureDamage?: number;
  readonly defenseStrength: number;
}

/**
 * The best shot available with the guns still loaded: for every target, the
 * strongest guns in range are stacked on it until the odds stop improving
 * the expected value, and the target with the best expected value wins.
 */
const bestShot = (
  ctx: Ctx,
  guns: readonly AttackerRef[],
  targets: readonly Target[],
  preview: (attackers: readonly AttackerRef[], target: TargetRef) => Preview,
  overrun: boolean,
): Shot | null => {
  let best: Shot | null = null;
  for (const t of targets) {
    const inRange = guns
      .filter((g) => preview([g], t.ref).ok)
      .sort((a, b) => strengthOfRef(ctx.state, b) - strengthOfRef(ctx.state, a));
    if (inRange.length === 0) continue;

    // Treads are one gun at a time (7.13.2).
    const limit = t.ref.kind === 'ogreTreads' ? 1 : inRange.length;
    for (let n = 1; n <= limit; n++) {
      const attackers = inRange.slice(0, n);
      const p = preview(attackers, t.ref);
      if (!p.ok) continue;
      const ev = expectedValue(ctx, p, t, attackers, overrun);
      // Spend guns only where they earn their keep: each extra gun must add.
      if (!best || ev > best.ev + 0.01) best = { attackers, target: t.ref, ev };
    }
  }
  return best && best.ev > ctx.w['fire.min'] ? best : null;
};

const expectedValue = (
  ctx: Ctx,
  p: Preview,
  t: Target,
  attackers: readonly AttackerRef[],
  overrun: boolean,
): number => {
  const { state, w } = ctx;
  const cost = attackers.reduce((n, a) => n + gunCost(ctx, a), 0);
  if (p.treadAttack) {
    const ogre = state.units[(t.ref as { unit: string }).unit];
    if (!ogre || !isOgre(ogre)) return 0;
    return treadValue(ctx, ogre, p.attackStrength, attackers.length);
  }
  if (t.ref.kind === 'building') {
    const done = (p.structureDamage ?? 0) >= p.defenseStrength;
    return (
      (done ? w['fire.buildingDone'] : (p.structureDamage ?? 0) * w['fire.buildingSp']) -
      attackers.length * w['fire.buildingGunCost']
    );
  }
  const chance = oddsChance(p.odds, overrun ? 'overrun' : 'normal');
  const target = t.ref.kind === 'unit' ? state.units[t.ref.unit] : undefined;
  return (chance.x / 6) * t.value + (chance.d / 6) * t.value * disableWorth(ctx, target) - cost;
};

const planFire = (ctx: Ctx): Command[] => {
  const out: Command[] = [];
  const { state: s, map, player, w } = ctx;

  // The fleet overhead speaks first (Orbital Drop §6.01).
  if (s.scenarioData['orbitalStrikeSide'] === player) {
    const targets = targetsOf(ctx).filter((t) => t.ref.kind !== 'ogreTreads');
    for (let i = orbitalStrikesLeft(s).length - 1; i >= 0; i--) {
      let best: { target: TargetRef; ev: number } | null = null;
      for (const t of targets) {
        const p = previewOrbitalStrike(s, map, i, t.ref);
        if (!p.ok) continue;
        const ev =
          t.ref.kind === 'building'
            ? (p.structureDamage ?? 0) * w['strike.buildingSp']
            : (oddsChance(p.odds).x / 6) * t.value;
        if (!best || ev > best.ev) best = { target: t.ref, ev };
      }
      if (best && best.ev > w['strike.min'])
        out.push({ type: 'orbitalStrike', by: player, strike: i, target: best.target });
    }
  }

  // A loaded crawler looks for the hex where the blast pays.
  for (const crawler of loadedCrawlers(s, player)) {
    const aim = bestMissileAim(ctx, crawler);
    if (aim) out.push({ type: 'launchCruiseMissile', by: player, unit: crawler.id, target: aim });
  }

  // Then the guns, greedily, until nothing left is worth a shot.
  let guns = gunsOf(ctx);
  const spent = new Set<string>();
  const refKey = (r: AttackerRef): string => `${r.unit}:${r.weapon ?? ''}`;
  const targets = targetsOf(ctx);
  for (let i = 0; i < 60 && guns.length > 0; i++) {
    const shot = bestShot(
      ctx,
      guns.filter((g) => !spent.has(refKey(g))),
      targets,
      (a, t) => previewAttack(s, map, a, t),
      false,
    );
    if (!shot) break;
    out.push({ type: 'attack', by: player, attackers: shot.attackers, target: shot.target });
    for (const a of shot.attackers) spent.add(refKey(a));
    guns = guns.filter((g) => !spent.has(refKey(g)));
  }
  return out;
};

/** Where a cruise missile does the most harm to them and the least to us. */
const bestMissileAim = (ctx: Ctx, crawler: Unit): Hex | null => {
  const { state, map, player, w } = ctx;
  let best: { hex: Hex; value: number } | null = null;
  for (const h of allHexes(map)) {
    if (launchCheck(state, map, crawler, h)) continue;
    let value = 0;
    for (const u of Object.values(state.units)) {
      if (!onBoard(u)) continue;
      const d = distance(u.pos, h);
      if (d > 2) continue;
      const worthOf = isOgre(u) ? ogreType(u.typeId).vp * w['cm.ogreVp'] : worth(ctx, u);
      const factor = d === 0 ? 1 : d === 1 ? w['cm.ring1'] : w['cm.ring2'];
      value += (u.owner === player ? -w['cm.ownLoss'] : 1) * worthOf * factor;
    }
    for (const b of Object.values(state.buildings)) {
      if (b.destroyed || distance(b.pos, h) > 1) continue;
      value += (b.owner === player ? -w['cm.ownBuilding'] : 1) * w['cm.building'];
    }
    if (!best || value > best.value) best = { hex: h, value };
  }
  return best && best.value >= w['cm.min'] ? best.hex : null;
};

// ---------------------------------------------------------------------------
// Overrun rounds
// ---------------------------------------------------------------------------

const planOverrun = (ctx: Ctx): Command[] => {
  const { state, map, player, w } = ctx;
  const overrun = state.overrun!;
  if (overrun.step === 'dismount') return [{ type: 'endFireRound', by: player }];

  const side = overrun.attacker === player ? 'attacker' : 'defender';
  const other = side === 'attacker' ? 'defender' : 'attacker';
  const guns: AttackerRef[] = [];
  for (const u of overrunUnits(state, side)) {
    const p = overrun.participants.find((x) => x.unit === u.id);
    if (!p) continue;
    if (isOgre(u)) {
      for (const wpn of u.weapons) {
        if (
          isFireable(u, wpn) &&
          !p.weaponsFired.includes(wpn.id) &&
          !(wpn.kind === 'missileRack' && wpn.fired)
        ) {
          guns.push({ unit: u.id, weapon: wpn.id });
        }
      }
    } else if (!p.fired) {
      guns.push({ unit: u.id });
      if (u.kind === 'unit' && (unitClass(u.classId).ap ?? 0) > 0)
        guns.push({ unit: u.id, antipersonnel: true });
    }
  }
  const targets: Target[] = [];
  for (const e of overrunUnits(state, other)) targets.push(...unitTargets(ctx, e));
  if (side === 'attacker') {
    for (const b of Object.values(state.buildings)) {
      if (!b.destroyed && b.owner !== player && eq(b.pos, overrun.hex)) {
        targets.push({
          ref: { kind: 'building', building: b.id },
          value: w['fire.buildingValue'],
          hex: b.pos,
        });
      }
    }
  }

  const out: Command[] = [];
  const spent = new Set<string>();
  const refKey = (r: AttackerRef): string =>
    `${r.unit}:${r.weapon ?? ''}:${r.antipersonnel ? 'ap' : ''}`;
  for (let i = 0; i < 40; i++) {
    const left = guns.filter((g) => !spent.has(refKey(g)) && !spent.has(`${g.unit}:*`));
    if (left.length === 0) break;
    const shot = bestShot(
      ctx,
      left,
      targets,
      (a, t) => previewOverrunAttack(state, map, a, t),
      true,
    );
    if (!shot) break;
    out.push({ type: 'overrunAttack', by: player, attackers: shot.attackers, target: shot.target });
    for (const a of shot.attackers) {
      spent.add(refKey(a));
      // A conventional unit fires once a round, AP guns or main gun.
      if (!a.weapon) spent.add(`${a.unit}:*`);
    }
  }
  out.push({ type: 'endFireRound', by: player });
  return out;
};

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Before turn 1: every counter in our zone looks for the hex it would rather
 * start in — nearer the objective or the post, in cover, not on top of a
 * friend, toward or away from where the enemy comes from — and asks for it.
 * The engine refuses what the ceilings forbid, and the shell skips those.
 */
const planSetup = (ctx0: Ctx): Command[] => {
  const { map, player, w } = ctx0;
  const zone = zoneOf(ctx0.state, player);
  const done: Command = { type: 'finishSetup', by: player };
  if (!zone) return [done];
  let ctx = ctx0;
  const front = frontOf(ctx);
  const anchor = ctx.attacker ? ctx.objective : (ctx.guard ?? ctx.objective);
  const inZone = new Set(zone.hexes);
  const units = ctx.own
    .filter((u) => inZone.has(key(u.pos)) && canAct(u))
    .sort((a, b) => victoryValue(b) - victoryValue(a) || a.id.localeCompare(b.id));
  const out: Command[] = [];
  for (const u of units) {
    const infantry = isInfantry(u);
    const score = (h: Hex): number => {
      let s = 0;
      if (anchor) s -= groundDistance(ctx, u, h, anchor) * w['deploy.goal'];
      if (front.length > 0) {
        const near = front.reduce((m, f) => Math.min(m, distance(h, f)), Infinity);
        s -= near * w['deploy.front'];
      }
      s +=
        (defenseMultiplier(terrainAt(map, h, ctx.state.terrainOverrides), infantry) - 1) *
        w['deploy.cover'];
      const friends = ctx.own.filter((o) => o.id !== u.id && distance(o.pos, h) <= 1).length;
      s -= friends * w['deploy.spread'];
      return s;
    };
    let best = u.pos;
    let bestScore = score(u.pos);
    for (const h of legalSetupHexes(ctx.state, map, u)) {
      const s = score(h);
      if (s > bestScore + 1e-9) {
        best = h;
        bestScore = s;
      }
    }
    if (!eq(best, u.pos)) {
      out.push({ type: 'placeUnit', by: player, unit: u.id, at: best });
      ctx = withState(ctx, {
        ...ctx.state,
        units: { ...ctx.state.units, [u.id]: { ...u, pos: best } as Unit },
      });
    }
  }
  out.push(done);
  return out;
};

/** Where the enemy is, or will come from: their counters, else their setup zone. */
const frontOf = (ctx: Ctx): Hex[] => {
  if (ctx.enemies.length > 0) return ctx.enemies.map((e) => e.pos);
  const out: Hex[] = [];
  for (const p of ctx.state.playerOrder) {
    if (p === ctx.player) continue;
    const zone = zoneOf(ctx.state, p);
    if (!zone) continue;
    for (const k of zone.hexes) {
      const comma = k.indexOf(',');
      out.push({ q: Number(k.slice(0, comma)), r: Number(k.slice(comma + 1)) });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Exports for tests and the shell
// ---------------------------------------------------------------------------

export const aiSeatName = (state: GameState, player: PlayerId): string =>
  state.players[player]?.name ?? player;

export type { Building, OgreUnit };
export { withinRadius };
