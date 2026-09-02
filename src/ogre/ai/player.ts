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
import { oddsChance } from '../engine/crt.js';
import { OGRE_WEAPONS, ogreType } from '../engine/ogres.js';
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
import { isFireable, movementAllowance, printedAttack, victoryValue } from '../engine/state.js';
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
import { CRUISE_MISSILE, launchCheck, loadedCrawlers } from '../engine/missiles.js';

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Commands for the decision the state is waiting on, ending with the one that moves on. */
export const aiPlan = (state: GameState, map: GameMap, player: PlayerId): Command[] => {
  if (state.victory) return [];
  if (state.setup) {
    return setupActor(state) === player ? [{ type: 'finishSetup', by: player }] : [];
  }
  if (state.overrun) {
    return overrunActor(state) === player ? planOverrun(state, map, player) : [];
  }
  if (activePlayer(state) !== player) return [];

  switch (state.phase) {
    case 'recovery':
      return [{ type: 'endPhase', by: player }];
    case 'movement':
      return [...planMovement(state, map, player), { type: 'endPhase', by: player }];
    case 'fire':
      return [...planFire(state, map, player), { type: 'endPhase', by: player }];
    case 'gevMovement':
      return [...planSecondMovement(state, map, player), { type: 'endPhase', by: player }];
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

const enemiesOf = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter((u) => u.owner !== player && onBoard(u));

const mine = (state: GameState, player: PlayerId): Unit[] =>
  Object.values(state.units).filter((u) => u.owner === player && onBoard(u));

/** The attacker moves first, by the convention every scenario here keeps. */
const isAttacker = (state: GameState, player: PlayerId): boolean => state.playerOrder[0] === player;

/** The enemy's command post or base building, if there is one to take. */
const objectiveOf = (state: GameState, player: PlayerId): Hex | null => {
  const cp = enemiesOf(state, player).find((u) => u.kind === 'unit' && u.classId === 'CP');
  if (cp) return cp.pos;
  const building = Object.values(state.buildings).find(
    (b) => !b.destroyed && b.owner !== null && b.owner !== player,
  );
  return building?.pos ?? null;
};

/** The edge an Ogre leaves by once its work is done, if the scenario has one. */
const escapeEdge = (state: GameState): 'north' | 'south' | 'east' | 'west' | null => {
  const raw = state.scenarioData['ogreEscapeEdge'];
  return raw === 'north' || raw === 'south' || raw === 'east' || raw === 'west' ? raw : null;
};

const edgeDistance = (map: GameMap, h: Hex, edge: 'north' | 'south' | 'east' | 'west'): number => {
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

/** How much attack strength the enemy can bring onto a hex next fire phase. */
const threatAt = (state: GameState, player: PlayerId, h: Hex): number => {
  let total = 0;
  for (const e of enemiesOf(state, player)) {
    if (!canAct(e) || isInertOgre(e, state.turn + 1)) continue;
    const move = isOgre(e)
      ? movementAllowance(e, 'movement', state.options)
      : unitClass(e.classId).move;
    if (isOgre(e)) {
      for (const w of e.weapons) {
        if (!isFireable(e, w) || OGRE_WEAPONS[w.kind].antipersonnelOnly) continue;
        if (distance(e.pos, h) <= OGRE_WEAPONS[w.kind].range + move)
          total += OGRE_WEAPONS[w.kind].attack;
      }
    } else if (distance(e.pos, h) <= reachOf(e) + move) {
      total += printedAttack(e);
    }
  }
  return total;
};

/** What this unit would be worth to the enemy, weighted toward what it threatens. */
const worth = (u: Unit): number => {
  if (isOgre(u)) return ogreType(u.typeId).vp;
  const cls = unitClass(u.classId);
  if (cls.id === 'CP') return 400;
  return victoryValue(u) + printedAttack(u) * 3 + (cls.laser ? 30 : 0);
};

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

const planMovement = (state: GameState, map: GameMap, player: PlayerId): Command[] => {
  const out: Command[] = [];
  let s = state;

  // Reserves race back the moment they may (Orbital Drop §3.03).
  if (s.turn >= reactionTurn(s)) {
    const target =
      objectiveOf(s, s.playerOrder.find((p) => p !== player) ?? player) ??
      myCentre(s, player) ??
      null;
    for (const r of reservesOf(s, player)) {
      const hexes = reserveEntryHexes(s, map, r);
      if (hexes.length === 0) continue;
      const at = target
        ? hexes.reduce((best, h) => (distance(h, target) < distance(best, target) ? h : best))
        : hexes[0]!;
      out.push({ type: 'deployReserve', by: player, unit: r.id, at });
      // Mark the hex taken so two reserves do not pick the same one.
      s = { ...s, units: { ...s.units, [r.id]: { ...r, offMap: undefined, pos: at } } };
    }
  }

  const attacker = isAttacker(s, player);
  const objective = objectiveOf(s, player);
  const edge = escapeEdge(s);
  const fields = new Map<string, ReadonlyMap<string, number>>();

  const movers = mine(s, player)
    .filter((u) => canAct(u) && !isInertOgre(u, s.turn) && !(u.kind === 'unit' && u.ridingOn))
    // Ogres decide first: everything else moves around where the cybertank goes.
    .sort((a, b) => (isOgre(b) ? 1 : 0) - (isOgre(a) ? 1 : 0) || a.id.localeCompare(b.id));

  for (const u of movers) {
    const cmd = moveFor(s, map, player, u, { attacker, objective, edge, fields });
    if (!cmd) continue;
    out.push(cmd);
    // Pencil the move in so the next unit does not plan into the same hex.
    if (cmd.type === 'moveUnit') {
      const dest = cmd.path[cmd.path.length - 1];
      if (dest && inBounds(map, dest)) {
        s = {
          ...s,
          units: { ...s.units, [u.id]: { ...u, pos: dest, movementEnded: true } as Unit },
        };
      }
    }
  }
  return out;
};

const myCentre = (state: GameState, player: PlayerId): Hex | null => {
  const units = mine(state, player);
  if (units.length === 0) return null;
  const q = units.reduce((n, u) => n + u.pos.q, 0) / units.length;
  const r = units.reduce((n, u) => n + u.pos.r, 0) / units.length;
  return { q: Math.round(q), r: Math.round(r) };
};

interface Aims {
  readonly attacker: boolean;
  readonly objective: Hex | null;
  readonly edge: 'north' | 'south' | 'east' | 'west' | null;
  /** Walking distances to each goal asked about this phase, by mobility. */
  readonly fields: Map<string, ReadonlyMap<string, number>>;
}

/**
 * How many hexes of ground lie between `h` and the goal for a unit that
 * moves like `u`. Craters, water and whatever else it may never enter are
 * not ground. The straight-line count is no use here: it walks an Ogre into
 * a crater pocket and keeps it there, because every way out looks like a
 * step back. Where no ground connects the two at all, the crow's count
 * stands in.
 */
const groundDistance = (
  state: GameState,
  map: GameMap,
  u: Unit,
  h: Hex,
  goal: Hex,
  fields: Map<string, ReadonlyMap<string, number>>,
): number => {
  const mobility = mobilityOf(u);
  const id = `${mobility}:${key(goal)}`;
  let field = fields.get(id);
  if (!field) {
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
    fields.set(id, field);
  }
  return field.get(key(h)) ?? distance(h, goal);
};

const moveFor = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  u: Unit,
  aims: Aims,
): Command | null => {
  if (movementAllowance(u, state.phase, state.options) <= 0 || u.movementEnded) return null;

  // --- A cybertank looks for something to ram first --------------------
  if (isOgre(u) || (u.kind === 'unit' && u.classId === 'SHVY')) {
    const ram = ramFor(state, map, player, u, aims);
    if (ram) return ram;
  }

  // --- Where to go ------------------------------------------------------
  const goal = goalFor(state, map, player, u, aims);
  const options = reachable(state, map, u);
  const here = {
    hex: u.pos,
    cost: 0,
    endsMovement: false,
    hazard: null as null | 'disable' | 'stuck',
    path: [] as Hex[],
  };
  let best = here;
  let bestScore = scoreHex(state, map, player, u, u.pos, goal, aims, null);
  for (const r of options) {
    const score = scoreHex(state, map, player, u, r.hex, goal, aims, r.hazard);
    if (score > bestScore + 1e-9) {
      best = {
        hex: r.hex,
        cost: r.cost,
        endsMovement: r.endsMovement,
        hazard: r.hazard,
        path: [...r.path],
      };
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
  return { type: 'moveUnit', by: player, unit: u.id, path: best.path };
};

const edgeStep = (map: GameMap, off: Hex, edge: 'north' | 'south' | 'east' | 'west'): boolean => {
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

type Goal =
  | { readonly kind: 'hex'; readonly hex: Hex }
  | { readonly kind: 'edge'; readonly edge: 'north' | 'south' | 'east' | 'west' }
  | { readonly kind: 'hold' };

const goalFor = (state: GameState, map: GameMap, player: PlayerId, u: Unit, aims: Aims): Goal => {
  const enemies = enemiesOf(state, player);
  if (aims.attacker) {
    if (aims.objective) return { kind: 'hex', hex: aims.objective };
    if (aims.edge && isOgre(u)) return { kind: 'edge', edge: aims.edge };
    // Nothing left to take: hunt the nearest enemy.
    const nearest = nearestOf(enemies, u.pos);
    return nearest ? { kind: 'hex', hex: nearest.pos } : { kind: 'hold' };
  }
  // The defence stands between the enemy and what it guards.
  const nearest = nearestOf(enemies, u.pos);
  if (!nearest) return { kind: 'hold' };
  void map;
  return { kind: 'hex', hex: nearest.pos };
};

const nearestOf = (units: readonly Unit[], from: Hex): Unit | null =>
  units.reduce<Unit | null>(
    (best, u) => (best === null || distance(u.pos, from) < distance(best.pos, from) ? u : best),
    null,
  );

/**
 * How good a hex is for this unit to end the phase in.
 *
 * An attacker wants to be closer to the objective; a defender wants the
 * enemy inside its own reach and itself outside the enemy's; everybody
 * prefers cover and dislikes swamp. The weights are the whole personality.
 */
const scoreHex = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  u: Unit,
  h: Hex,
  goal: Goal,
  aims: Aims,
  hazard: null | 'disable' | 'stuck',
): number => {
  const enemies = enemiesOf(state, player);
  const reach = reachOf(u);
  const infantry = u.kind === 'unit' && unitClass(u.classId).kind === 'infantry';
  const terrain = terrainAt(map, h, state.terrainOverrides);
  const cover = defenseMultiplier(terrain, infantry) - 1;
  const threat = threatAt(state, player, h);
  const myDefense = isOgre(u)
    ? 12
    : Math.max(1, unitClass(u.classId).defense * (infantry ? u.squads : 1));

  // Targets this hex puts in reach, weighted by what they are worth.
  let inReach = 0;
  for (const e of enemies) {
    if (distance(e.pos, h) <= reach && reach > 0) inReach += worth(e);
  }

  let score = 0;
  if (goal.kind === 'hex') {
    const d = groundDistance(state, map, u, h, goal.hex, aims.fields);
    score -= d * (aims.attacker ? 10 : 4);
    // A defender that outranges the threat holds at its own range.
    const range = distance(h, goal.hex);
    if (!aims.attacker && reach >= 3 && range < reach) score -= (reach - range) * 6;
  } else if (goal.kind === 'edge') {
    score -= edgeDistance(map, h, goal.edge) * 12;
  }
  score += Math.min(inReach, 80) * (aims.attacker ? 0.15 : 0.35);
  score -= (threat / myDefense) * (aims.attacker ? 1.5 : 4);
  score += cover * 6;
  if (hazard === 'stuck') score -= 40;
  if (hazard === 'disable') score -= 12;
  if (isOgre(u) && baseTerrain(terrain) === 'water') score -= 30;
  // Do not stack on a friend on the one-per-hex map (the engine refuses it
  // anyway) and do not crowd on the green one.
  if (unitsAt(state, h).some((o) => o.owner === player && o.id !== u.id)) score -= 3;
  return score;
};

/** Ram what is worth ramming: the command post always, armour when the treads can spare it. */
const ramFor = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  u: Unit,
  aims: Aims,
): Command | null => {
  const overrun = state.options.overrunCombat;
  let best: { cmd: Command; value: number } | null = null;
  const seen = new Set<string>();
  for (const e of enemiesOf(state, player)) {
    if (seen.has(key(e.pos))) continue;
    seen.add(key(e.pos));
    const legal = overrun ? canOverrun(state, map, u, e.pos).ok : canRam(state, map, u, e.pos).ok;
    if (!legal) continue;
    let value = 0;
    for (const v of unitsAt(state, e.pos).filter((x) => x.owner !== player)) {
      if (v.kind === 'unit' && v.classId === 'CP') value += 1000;
      else if (isOgre(v)) value += overrun ? 20 : 10;
      else if (v.kind === 'unit' && unitClass(v.classId).kind === 'infantry')
        value += overrun ? 6 : 0;
      else value += victoryValue(v) * 2;
    }
    // A cybertank on its last treads keeps them for the road out.
    if (isOgre(u)) {
      const type = ogreType(u.typeId);
      if (u.treads < type.treads * 0.3 && value < 500) continue;
    }
    if (value <= 0) continue;
    // Prefer the ram that carries the Ogre toward its goal over one that
    // takes it away — and a tank corking the only lane through the craters
    // is worth ramming whatever it is, because there is no way round it.
    if (aims.objective) {
      const here = groundDistance(state, map, u, u.pos, aims.objective, aims.fields);
      const there = groundDistance(state, map, u, e.pos, aims.objective, aims.fields);
      if (there < here) {
        value += 4;
        const boxedIn = reachable(state, map, u).every(
          (r) => groundDistance(state, map, u, r.hex, aims.objective!, aims.fields) >= here,
        );
        if (boxedIn) value += 30;
      } else {
        value -= (there - here + 1) * 6;
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
  return best && best.value >= 8 ? best.cmd : null;
};

/** GEVs that shot this turn get away; anything else with a second move sits tight. */
const planSecondMovement = (state: GameState, map: GameMap, player: PlayerId): Command[] => {
  const out: Command[] = [];
  const enemies = enemiesOf(state, player);
  for (const u of mine(state, player)) {
    if (u.kind !== 'unit' || unitClass(u.classId).secondMove == null) continue;
    if (!canAct(u) || u.movementEnded || u.ridingOn) continue;
    const options = reachable(state, map, u);
    let best: Hex | null = null;
    let bestScore = -threatAt(state, player, u.pos);
    for (const r of options) {
      if (r.hazard) continue;
      const score = -threatAt(state, player, r.hex) - (enemies.length ? 0 : 0) - r.cost * 0.1;
      if (score > bestScore + 1e-9) {
        best = r.hex;
        bestScore = score;
      }
    }
    if (best) {
      const path = options.find((r) => eq(r.hex, best!))?.path ?? [];
      if (path.length > 0) out.push({ type: 'moveUnit', by: player, unit: u.id, path: [...path] });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Every gun a player could still fire this phase, as attacker refs. */
const gunsOf = (state: GameState, player: PlayerId): AttackerRef[] => {
  const refs: AttackerRef[] = [];
  for (const u of mine(state, player)) {
    if (!canStillFire(state, u) || isInertOgre(u, state.turn)) continue;
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

/** Every way of hurting the enemy: units, Ogre components, buildings. */
const targetsOf = (
  state: GameState,
  player: PlayerId,
): { ref: TargetRef; value: number; hex: Hex }[] => {
  const out: { ref: TargetRef; value: number; hex: Hex }[] = [];
  for (const e of enemiesOf(state, player)) {
    if (isOgre(e)) {
      const seen = new Set<string>();
      for (const w of e.weapons) {
        if (w.destroyed || seen.has(w.kind)) continue;
        seen.add(w.kind);
        const spec = OGRE_WEAPONS[w.kind];
        // A gun is worth what it threatens, and a missile most of all.
        const value = spec.vp + spec.attack * 4 + (w.kind === 'missile' && w.fired ? -20 : 0);
        out.push({ ref: { kind: 'ogreWeapon', unit: e.id, weapon: w.id }, value, hex: e.pos });
      }
      if (e.treads > 0) out.push({ ref: { kind: 'ogreTreads', unit: e.id }, value: 0, hex: e.pos });
    } else {
      out.push({ ref: { kind: 'unit', unit: e.id }, value: worth(e), hex: e.pos });
    }
  }
  for (const b of Object.values(state.buildings)) {
    if (b.destroyed || b.owner === player) continue;
    out.push({ ref: { kind: 'building', building: b.id }, value: 60, hex: b.pos });
  }
  return out;
};

interface Shot {
  readonly attackers: AttackerRef[];
  readonly target: TargetRef;
  readonly ev: number;
}

/**
 * The best shot available with the guns still loaded: for every target, the
 * strongest guns in range are stacked on it until the odds stop improving
 * the expected value, and the target with the best expected value wins.
 */
const bestShot = (
  state: GameState,
  map: GameMap,
  guns: readonly AttackerRef[],
  targets: readonly { ref: TargetRef; value: number; hex: Hex }[],
  preview: (
    attackers: readonly AttackerRef[],
    target: TargetRef,
  ) => {
    ok: boolean;
    odds: { kind: string; column?: string };
    treadAttack?: boolean;
    attackStrength: number;
    structureDamage?: number;
    defenseStrength: number;
  },
  overrun: boolean,
): Shot | null => {
  let best: Shot | null = null;
  for (const t of targets) {
    const inRange = guns
      .filter((g) => preview([g], t.ref).ok)
      .sort((a, b) => strengthOfRef(state, b) - strengthOfRef(state, a));
    if (inRange.length === 0) continue;

    // Treads are one gun at a time (7.13.2).
    const limit = t.ref.kind === 'ogreTreads' ? 1 : inRange.length;
    for (let n = 1; n <= limit; n++) {
      const attackers = inRange.slice(0, n);
      const p = preview(attackers, t.ref);
      if (!p.ok) continue;
      const ev = expectedValue(state, map, p, t, attackers, overrun);
      // Spend guns only where they earn their keep: each extra gun must add.
      if (!best || ev > best.ev + 0.01) best = { attackers, target: t.ref, ev };
    }
  }
  return best && best.ev > 0.4 ? best : null;
};

const expectedValue = (
  state: GameState,
  map: GameMap,
  p: {
    odds: { kind: string; column?: string };
    treadAttack?: boolean;
    attackStrength: number;
    structureDamage?: number;
    defenseStrength: number;
  },
  t: { ref: TargetRef; value: number; hex: Hex },
  attackers: readonly AttackerRef[],
  overrun: boolean,
): number => {
  void map;
  if (p.treadAttack) {
    const ogre = state.units[(t.ref as { unit: string }).unit];
    const hitOn = baseTerrain(terrainAt(map, t.hex, state.terrainOverrides)) === 'town' ? 6 : 5;
    const chance = (7 - hitOn) / 6;
    const treadsLost = Math.min(ogre && isOgre(ogre) ? ogre.treads : 0, p.attackStrength);
    // Treads are worth more the fewer are left: slowing a cybertank is the game.
    const scarcity =
      ogre && isOgre(ogre) ? 1 + (1 - ogre.treads / ogreType(ogre.typeId).treads) * 2 : 1;
    return chance * treadsLost * 1.6 * scarcity - attackers.length * 0.6;
  }
  if (t.ref.kind === 'building') {
    const done = (p.structureDamage ?? 0) >= p.defenseStrength;
    return (done ? 200 : (p.structureDamage ?? 0) * 3) - attackers.length * 1.0;
  }
  const odds = p.odds as { kind: 'none' | 'auto' | 'column'; column?: never };
  const chance = oddsChance(odds as never, overrun ? 'overrun' : 'normal');
  const px = chance.x / 6;
  const pd = chance.d / 6;
  const target = t.ref.kind === 'unit' ? state.units[t.ref.unit] : undefined;
  const infantry = target?.kind === 'unit' && unitClass(target.classId).kind === 'infantry';
  const dWorth =
    t.ref.kind === 'unit'
      ? infantry
        ? 0.45
        : target?.kind === 'unit' && target.disabled !== 'none'
          ? 1
          : 0.4
      : 0;
  return px * t.value + pd * t.value * dWorth - attackers.length * 0.8;
};

const planFire = (state: GameState, map: GameMap, player: PlayerId): Command[] => {
  const out: Command[] = [];
  const s = state;

  // The fleet overhead speaks first (Orbital Drop §6.01).
  if (s.scenarioData['orbitalStrikeSide'] === player) {
    const targets = targetsOf(s, player).filter((t) => t.ref.kind !== 'ogreTreads');
    for (let i = orbitalStrikesLeft(s).length - 1; i >= 0; i--) {
      let best: { target: TargetRef; ev: number } | null = null;
      for (const t of targets) {
        const p = previewOrbitalStrike(s, map, i, t.ref);
        if (!p.ok) continue;
        const ev =
          t.ref.kind === 'building'
            ? (p.structureDamage ?? 0) * 3
            : (oddsChance(p.odds).x / 6) * t.value;
        if (!best || ev > best.ev) best = { target: t.ref, ev };
      }
      if (best && best.ev > 2)
        out.push({ type: 'orbitalStrike', by: player, strike: i, target: best.target });
    }
  }

  // A loaded crawler looks for the hex where the blast pays.
  for (const crawler of loadedCrawlers(s, player)) {
    const aim = bestMissileAim(s, map, player, crawler);
    if (aim) out.push({ type: 'launchCruiseMissile', by: player, unit: crawler.id, target: aim });
  }

  // Then the guns, greedily, until nothing left is worth a shot.
  let guns = gunsOf(s, player);
  const spent = new Set<string>();
  const refKey = (r: AttackerRef): string => `${r.unit}:${r.weapon ?? ''}`;
  for (let i = 0; i < 60 && guns.length > 0; i++) {
    const targets = targetsOf(s, player);
    const shot = bestShot(
      s,
      map,
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
const bestMissileAim = (
  state: GameState,
  map: GameMap,
  player: PlayerId,
  crawler: Unit,
): Hex | null => {
  let best: { hex: Hex; value: number } | null = null;
  for (const h of allHexes(map)) {
    if (launchCheck(state, map, crawler, h)) continue;
    let value = 0;
    for (const u of Object.values(state.units)) {
      if (!onBoard(u)) continue;
      const d = distance(u.pos, h);
      if (d > 2) continue;
      const w = isOgre(u) ? ogreType(u.typeId).vp * 0.6 : worth(u);
      const factor = d === 0 ? 1 : d === 1 ? 0.55 : 0.25;
      value += (u.owner === player ? -1.5 : 1) * w * factor;
    }
    for (const b of Object.values(state.buildings)) {
      if (b.destroyed || distance(b.pos, h) > 1) continue;
      value += (b.owner === player ? -2 : 1) * 40;
    }
    if (!best || value > best.value) best = { hex: h, value };
  }
  void CRUISE_MISSILE;
  return best && best.value >= 30 ? best.hex : null;
};

// ---------------------------------------------------------------------------
// Overrun rounds
// ---------------------------------------------------------------------------

const planOverrun = (state: GameState, map: GameMap, player: PlayerId): Command[] => {
  const overrun = state.overrun!;
  if (overrun.step === 'dismount') return [{ type: 'endFireRound', by: player }];

  const side = overrun.attacker === player ? 'attacker' : 'defender';
  const other = side === 'attacker' ? 'defender' : 'attacker';
  const guns: AttackerRef[] = [];
  for (const u of overrunUnits(state, side)) {
    const p = overrun.participants.find((x) => x.unit === u.id);
    if (!p) continue;
    if (isOgre(u)) {
      for (const w of u.weapons) {
        if (
          isFireable(u, w) &&
          !p.weaponsFired.includes(w.id) &&
          !(w.kind === 'missileRack' && w.fired)
        ) {
          guns.push({ unit: u.id, weapon: w.id });
        }
      }
    } else if (!p.fired) {
      guns.push({ unit: u.id });
      if (u.kind === 'unit' && (unitClass(u.classId).ap ?? 0) > 0)
        guns.push({ unit: u.id, antipersonnel: true });
    }
  }
  const targets: { ref: TargetRef; value: number; hex: Hex }[] = [];
  for (const e of overrunUnits(state, other)) {
    if (isOgre(e)) {
      const seen = new Set<string>();
      for (const w of e.weapons) {
        if (w.destroyed || seen.has(w.kind)) continue;
        seen.add(w.kind);
        targets.push({
          ref: { kind: 'ogreWeapon', unit: e.id, weapon: w.id },
          value: OGRE_WEAPONS[w.kind].vp + OGRE_WEAPONS[w.kind].attack * 4,
          hex: e.pos,
        });
      }
      if (e.treads > 0)
        targets.push({ ref: { kind: 'ogreTreads', unit: e.id }, value: 0, hex: e.pos });
    } else {
      targets.push({ ref: { kind: 'unit', unit: e.id }, value: worth(e), hex: e.pos });
    }
  }
  if (side === 'attacker') {
    for (const b of Object.values(state.buildings)) {
      if (!b.destroyed && b.owner !== player && eq(b.pos, overrun.hex)) {
        targets.push({ ref: { kind: 'building', building: b.id }, value: 60, hex: b.pos });
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
      state,
      map,
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
// Exports for tests and the shell
// ---------------------------------------------------------------------------

export const aiSeatName = (state: GameState, player: PlayerId): string =>
  state.players[player]?.name ?? player;

export type { Building, OgreUnit };
export { withinRadius };
