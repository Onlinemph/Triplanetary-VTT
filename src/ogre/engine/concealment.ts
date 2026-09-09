/**
 * Hidden information: minefields (13.04), camouflage (13.05) and dummy
 * counters (13.06).
 *
 * Ogre in its basic form has none, and the whole engine is built on that:
 * every client holds the whole state and recomputes it from the log. These
 * three optional rules are the exception, and this module is where the
 * secret lives and where it is kept.
 *
 * ## The rules, as implemented
 *
 * Each is implemented from its *shape* rather than transcribed, and the
 * numbers are provisional — flagged in `MINEFIELD` and in
 * `docs/OGRE-RULES-MAPPING.md` for correction against the printed text.
 *
 *  - **Minefields.** A side with a setup zone may lay `options.minefields`
 *    minefield markers in it while its counters go down, secretly. The first
 *    enemy unit to enter a mined hex stops there and is attacked at
 *    `MINEFIELD.attack` on the CRT (an Ogre loses tread units instead); the
 *    minefield is then revealed and stays, attacking every later enemy
 *    entrant, until combat engineers clear it. The side that laid it passes
 *    freely: it knows where they are.
 *  - **Camouflage.** With `options.camouflage`, every counter that moves is
 *    concealed once the counters are down (a post or a laser is a fixed
 *    installation everybody knows the site of). The enemy sees a `?` in the
 *    hex — which side, not what — until the counter fires, is fired on, rams,
 *    is rammed or overrun, is under a blast, or ends a movement phase next to
 *    an enemy. Moving by itself does not show it: a counter that could only
 *    keep its secret by standing still would keep it for one turn.
 *  - **Dummies.** `options.dummies` counters per side, class `DUM`, placed
 *    and moved like any other, concealed like any other, and nothing at all:
 *    the moment one is revealed it is removed. A shot at one is spent.
 *
 * ## Who sees what
 *
 * {@link redactOgreState} is the view a seat receives: its own counters and
 * mines whole, the enemy's concealed counters as `UNK` stand-ins with the
 * same id, owner and hex, the enemy's unrevealed mines gone. It is what the
 * referee sends each seat at a table with any of these options on, and what
 * the computer decides against, so that nobody — the computer included —
 * plans on what it could not see.
 */

import { type Hex, distance, eq, key } from './hex.js';
import { type GameMap, inBounds, isRouteHex, terrainAt } from './map.js';
import { rollDie } from './rng.js';
import {
  type ConventionalUnit,
  type GameOptions,
  type GameState,
  type Minefield,
  type PlayerId,
  type Unit,
  type UnitId,
  isOgre,
  isPallet,
  onBoard,
  setupActor,
  unitsAt,
} from './types.js';
import { destroyUnit, log, unitName, updateOgre, withUnit } from './state.js';
import { zoneOf } from './setup.js';
import { unitClass } from './units.js';
import { ogreType } from './ogres.js';
import { applyDamageToUnit, checkOgreDeath } from './combat.js';

/**
 * 13.04, as printed. A mine is not a gun: it does not attack on the Combat
 * Results Table at all.
 *
 * "If a mine is on a road, it explodes when any unit enters that hex on the
 * road, but is unaffected if a unit enters the hex without using the road. If
 * a mine is not on a road, it explodes only on a die roll of 6 (5 or 6 for an
 * Ogre). Mines that fail to go off are unaffected, but by entering the hex,
 * the opposing player learns that it is mined.
 *
 * A mine explosion affects only the unit setting it off. Armor units are
 * destroyed; infantry is reduced by 1 squad; an Ogre rolls 1 die and loses
 * that many tread units. The mine itself is destroyed."
 */
export const MINEFIELD = {
  /** Off a road, a mine goes off on this roll or better. */
  trigger: 6,
  /** An Ogre is heavy enough to set one off on a 5 as well. */
  ogreTrigger: 5,
  /**
   * "If an Ogre voluntarily enters a mined hex, the mine goes off only on a
   * roll of a 6, instead of the usual 5 or 6." (13.04.1) — for a cybertank
   * whose detection equipment warned it first.
   */
  ogreVoluntaryTrigger: 6,
} as const;

/** Any of the three rules is on: the table has secrets, and needs a referee. */
export const hasHiddenInformation = (options: GameOptions): boolean =>
  options.camouflage === true || (options.dummies ?? 0) > 0 || (options.minefields ?? 0) > 0;

// ---------------------------------------------------------------------------
// Minefields
// ---------------------------------------------------------------------------

export const minesOf = (state: GameState): readonly Minefield[] => state.mines ?? [];

/**
 * A cybertank that knows what it is driving over (13.04.1).
 *
 * "All Ninjas, Vulcans, and cybertanks of size 8 or greater have
 * state-of-the-art detection equipment, giving them advanced awareness of
 * mines and other hidden units."
 */
export const detectsMines = (u: Unit): boolean => {
  if (!isOgre(u)) return false;
  const t = ogreType(u.typeId);
  return t.id === 'NINJA' || t.id === 'VULCAN' || t.size >= 8;
};

export const mineAt = (state: GameState, h: Hex): Minefield | undefined =>
  minesOf(state).find((m) => eq(m.pos, h));

/** Minefields still to be laid by this side, during the setup. */
export const minefieldsLeft = (state: GameState, player: PlayerId): number =>
  state.minesLeft?.[player] ?? 0;

/**
 * Lay one minefield during the setup, in the layer's own zone, on ground a
 * unit could stand on, one to a hex.
 */
export const layMinefield = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  at: Hex,
  onRoad?: boolean,
): { state: GameState; ok: boolean; reason?: string } => {
  if (!state.setup) return { state, ok: false, reason: 'minefields are laid while setting up' };
  if (setupActor(state) !== by) return { state, ok: false, reason: 'it is not your setup' };
  const left = minefieldsLeft(state, by);
  if (left <= 0) return { state, ok: false, reason: 'no minefields left to lay' };
  const zone = zoneOf(state, by);
  if (!zone || !zone.hexes.includes(key(at))) {
    return { state, ok: false, reason: `minefields go inside ${zone?.label ?? 'your area'}` };
  }
  if (!inBounds(map, at)) return { state, ok: false, reason: 'that hex is off the map' };
  const terrain = terrainAt(map, at, state.terrainOverrides);
  if (terrain === 'crater' || terrain === 'water') {
    return { state, ok: false, reason: 'a minefield needs ground' };
  }
  // "Any number of mines may be placed in a hex, and only one goes off at a
  // time." (13.04) — so no one-to-a-hex rule.

  const id = `mine-${by}-${minesOf(state).length + 1}`;
  // "recording the hex numbers and whether they are on the road" (13.04): the
  // layer's choice, and only a choice where there is a road to be on.
  const mine: Minefield = {
    id,
    owner: by,
    pos: at,
    revealed: false,
    onRoad: isRouteHex(map, at) && onRoad !== false,
  };
  const next: GameState = {
    ...state,
    mines: [...minesOf(state), mine],
    minesLeft: { ...(state.minesLeft ?? {}), [by]: left - 1 },
  };
  return { state: next, ok: true };
};

/**
 * Plant a mine during play, where a Sapper stands (15.03.1).
 *
 * The setup's zone rules do not apply — engineers work where they are — but
 * the scenario's allowance does: "If mines are available in the scenario, any
 * Sapper may attempt to place a mine, as per Section 13.04."
 */
export const plantMinefield = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  at: Hex,
  onRoad?: boolean,
): GameState => {
  const left = minefieldsLeft(state, by);
  if (left <= 0) return state;
  const id = `mine-${by}-${minesOf(state).length + 1}`;
  const mine: Minefield = {
    id,
    owner: by,
    pos: at,
    revealed: false,
    onRoad: isRouteHex(map, at) && onRoad !== false,
  };
  return {
    ...state,
    mines: [...minesOf(state), mine],
    minesLeft: { ...(state.minesLeft ?? {}), [by]: left - 1 },
  };
};

/** Take a minefield off the map: cleared by engineers (15), or for a test. */
export const removeMinefield = (state: GameState, id: string): GameState => ({
  ...state,
  mines: minesOf(state).filter((m) => m.id !== id),
});

/**
 * The first hex on a path holding an enemy mine, or -1.
 *
 * The mover's own side's mines do not count: it knows where they are. Hidden
 * mines do — that is the point — so this is asked of the true state by the
 * reducer, never of a view. Whether the mine actually goes off is
 * {@link tripMinefield}'s question; the mover stops here either way, which the
 * rules do not say in so many words but which costs nothing: an armour unit
 * that sets one off is destroyed, and one that does not has still found the
 * field the hard way.
 */
export const mineStopOn = (state: GameState, mover: Unit, path: readonly Hex[]): number => {
  for (let i = 0; i < path.length; i++) {
    const m = mineAt(state, path[i]!);
    if (m && m.owner !== mover.owner) return i;
  }
  return -1;
};

/**
 * A unit has entered a mined hex (13.04).
 *
 * "If a mine is on a road, it explodes when any unit enters that hex on the
 * road, but is unaffected if a unit enters the hex without using the road. If
 * a mine is not on a road, it explodes only on a die roll of 6 (5 or 6 for an
 * Ogre). Mines that fail to go off are unaffected, but by entering the hex,
 * the opposing player learns that it is mined.
 *
 * A mine explosion affects only the unit setting it off. Armor units are
 * destroyed; infantry is reduced by 1 squad; an Ogre rolls 1 die and loses
 * that many tread units. The mine itself is destroyed. A mine explosion on a
 * bridge hex destroys it; a mine explosion on a road or railroad creates a
 * road cut."
 *
 * `onRoad` says whether the mover came in along the road, which decides
 * whether a road mine is under it at all.
 */
export const tripMinefield = (
  state: GameState,
  map: GameMap,
  unitId: UnitId,
  usedRoad = true,
): GameState => {
  const unit = state.units[unitId];
  if (!unit || !onBoard(unit)) return state;
  const mine = mineAt(state, unit.pos);
  if (!mine || mine.owner === unit.owner) return state;
  const label = unitName(unit);

  // A road mine under a unit that came across country is simply not under it.
  if (mine.onRoad === true && !usedRoad) return state;

  let next = revealUnit(state, unitId);

  // Does it go off?
  let fires: boolean;
  let rolled = 0;
  if (mine.onRoad === true) {
    fires = true;
  } else {
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    rolled = die.value;
    const trigger = !isOgre(unit)
      ? MINEFIELD.trigger
      : // "All Ninjas, Vulcans, and cybertanks of size 8 or greater have
        // state-of-the-art detection equipment ... If an Ogre voluntarily
        // enters a mined hex, the mine goes off only on a roll of a 6, instead
        // of the usual 5 or 6." (13.04.1)
        detectsMines(unit)
        ? MINEFIELD.ogreVoluntaryTrigger
        : MINEFIELD.ogreTrigger;
    fires = die.value >= trigger;
  }

  if (!fires) {
    // "Mines that fail to go off are unaffected, but by entering the hex, the
    // opposing player learns that it is mined."
    next = {
      ...next,
      mines: minesOf(next).map((m) => (m.id === mine.id ? { ...m, revealed: true } : m)),
    };
    return log(
      next,
      'warn',
      `${label} finds a minefield — rolled ${String(rolled)}: nothing goes off, but the field is on the map now.`,
      [unit.pos],
    );
  }

  // "The mine itself is destroyed."
  next = removeMinefield(next, mine.id);
  // "A mine explosion on a road or railroad creates a road cut."
  if (isRouteHex(map, unit.pos) && !(next.routesCut ?? []).includes(key(unit.pos))) {
    next = { ...next, routesCut: [...(next.routesCut ?? []), key(unit.pos)] };
  }

  if (isOgre(unit)) {
    // "an Ogre rolls 1 die and loses that many tread units"
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    const lost = Math.min(unit.treads, die.value);
    next = updateOgre(next, unitId, (o) => ({ treads: o.treads - lost }));
    next = log(
      next,
      'bad',
      `${label} sets off a mine: ${String(lost)} tread unit${lost === 1 ? '' : 's'} gone.`,
      [unit.pos],
    );
    return checkOgreDeath(next, { kind: 'ogreTreads', unit: unitId }, mine.owner);
  }

  if (unit.kind === 'unit' && unitClass(unit.classId).kind === 'infantry') {
    // "infantry is reduced by 1 squad"
    next = log(next, 'bad', `${label} sets off a mine: a squad is gone.`, [unit.pos]);
    return applyDamageToUnit(next, unitId, 'D', mine.owner);
  }

  // "Armor units are destroyed."
  next = log(next, 'bad', `${label} sets off a mine and is destroyed.`, [unit.pos]);
  return destroyUnit(next, unitId, 'mined', mine.owner);
};

// ---------------------------------------------------------------------------
// Camouflage and dummies
// ---------------------------------------------------------------------------

export const isDummy = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'DUM';

/** A stand-in in somebody's view: the counter is there, its face is not. */
export const isUnknown = (u: Unit): boolean => u.kind === 'unit' && u.classId === 'UNK';

export const isConcealed = (u: Unit): boolean => u.concealed === true;

/**
 * Turn a counter face up. A dummy is nothing at all, and is removed the
 * moment it is seen; the log says so, because the side that shot at it
 * deserves to know what it spent the shot on.
 */
export const revealUnit = (state: GameState, id: UnitId, why = ''): GameState => {
  const u = state.units[id];
  if (!u || !onBoard(u) || !u.concealed) return state;
  let next = withUnit(state, { ...u, concealed: false } as Unit);
  if (isDummy(u)) {
    next = destroyUnit(next, id, 'a dummy, revealed');
    return log(next, 'info', `The counter at ${labelOf(u.pos)} was a dummy.${why}`, [u.pos]);
  }
  // Riders came face up with their vehicle.
  for (const rider of Object.values(next.units)) {
    if (rider.kind === 'unit' && rider.ridingOn === id && rider.concealed) {
      next = withUnit(next, { ...rider, concealed: false });
    }
  }
  return log(next, 'info', `${unitName(u)} is revealed at ${labelOf(u.pos)}.${why}`, [u.pos]);
};

/** Every concealed counter in a hex, face up. */
export const revealAt = (state: GameState, h: Hex, why = ''): GameState => {
  let next = state;
  for (const u of unitsAt(state, h)) next = revealUnit(next, u.id, why);
  return next;
};

/** Every concealed counter within `radius` of a hex, face up: a blast, a strike. */
export const revealWithin = (state: GameState, h: Hex, radius: number): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (onBoard(u) && u.concealed && distance(u.pos, h) <= radius) next = revealUnit(next, u.id);
  }
  return next;
};

/**
 * A move, and what it gives away.
 *
 * "As soon as any camouflaged unit moves or fires, or as soon as an enemy unit
 * moves through or fires on its hex, the ? marker is replaced by the real
 * unit." (13.05) So a counter that moves has shown itself, and a counter whose
 * hex somebody walked through has been found. A dummy "is removed when an
 * enemy unit moves through or fires on its hex" (13.06), which `revealUnit`
 * does for it.
 *
 * Standing still is what camouflage is for: nothing else uncovers a counter.
 */
export const revealOnMove = (
  state: GameState,
  moverId: UnitId,
  path: readonly Hex[],
): GameState => {
  const mover = state.units[moverId];
  let next = mover?.concealed ? revealUnit(state, moverId, ' It moved.') : state;
  if (!mover) return next;
  for (const h of path) {
    for (const u of Object.values(next.units)) {
      if (!onBoard(u) || !u.concealed || u.owner === mover.owner) continue;
      if (u.pos.q === h.q && u.pos.r === h.r) {
        next = revealUnit(next, u.id, ' The enemy came through its hex.');
      }
    }
  }
  return next;
};

/**
 * Everything a side owns goes face down as the counters finish going down:
 * with camouflage on, every counter; with dummies, the dummies at least.
 */
export const concealAll = (state: GameState): GameState => {
  let next = state;
  for (const u of Object.values(state.units)) {
    if (!onBoard(u)) continue;
    // "LADs still on a pallet can also be placed as part of a defensive setup.
    // Small, stealthy, and powered down, they are very hard to detect." (14.01)
    // That one needs no option turned on.
    if (isPallet(u) || isDummy(u) || (state.options.camouflage === true && canBeConcealed(u))) {
      next = withUnit(next, { ...u, concealed: true } as Unit);
    }
  }
  return next;
};

/**
 * What camouflage covers: the counters that move. A command post, a laser,
 * a laser tower are fixed installations everybody knows the site of — and
 * the objective of a scenario has to be on the map for the scenario to be
 * one.
 */
const canBeConcealed = (u: Unit): boolean => {
  if (isOgre(u)) return true;
  const cls = unitClass(u.classId);
  return !(cls.kind === 'structure' && cls.mobility === 'immobile');
};

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** The stand-in a viewer sees for a concealed enemy counter. */
const unknownFor = (u: Unit): ConventionalUnit => ({
  kind: 'unit',
  id: u.id,
  owner: u.owner,
  classId: 'UNK',
  pos: u.pos,
  squads: 1,
  disabled: 'none',
  disabledAt: -1,
  stuck: false,
  pendingHazard: null,
  moveUsed: 0,
  secondMoveUsed: 0,
  phaseStart: u.pos,
  onRouteAllPhase: true,
  movementEnded: false,
  firedThisPhase: false,
  squadsFired: 0,
  heavyWeaponFired: false,
  mountedThisTurn: false,
  destroyed: false,
  concealed: true,
});

/**
 * The board as one seat may see it. `viewer` null is a spectator, who sees
 * what both sides have shown and nothing either is hiding.
 *
 * Identity when nothing is hidden: a table without these options keeps
 * every property the open board had, replay included.
 */
export const redactOgreState = (state: GameState, viewer: PlayerId | null): GameState => {
  if (!hasHiddenInformation(state.options)) return state;

  const units: Record<UnitId, Unit> = {};
  for (const [id, u] of Object.entries(state.units)) {
    const own = viewer !== null && u.owner === viewer;
    if (own || !u.concealed || !onBoard(u)) {
      units[id] = u;
      continue;
    }
    // A concealed rider is inside a concealed vehicle: one `?`, not two.
    if (u.kind === 'unit' && u.ridingOn) continue;
    units[id] = unknownFor(u);
  }

  const mines = minesOf(state).filter((m) => m.revealed || (viewer !== null && m.owner === viewer));

  return { ...state, units, mines };
};

const labelOf = (h: Hex): string => `${h.q},${h.r}`;
