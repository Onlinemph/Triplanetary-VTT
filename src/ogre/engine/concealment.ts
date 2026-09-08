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
import { type GameMap, inBounds, terrainAt } from './map.js';
import { describeOdds, oddsFor, resolve } from './crt.js';
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
  onBoard,
  setupActor,
  unitsAt,
} from './types.js';
import { defenseOf, destroyUnit, log, unitName, updateOgre, withUnit } from './state.js';
import { zoneOf } from './setup.js';
import { unitClass } from './units.js';
import { applyDamageToUnit, checkOgreDeath } from './combat.js';

/**
 * Provisional numbers for 13.04, chosen to play sensibly against the rest
 * of the CRT: a minefield attacks a conventional unit at strength 4, and
 * takes 2 tread units off a cybertank on a roll of 4 or better.
 */
export const MINEFIELD = {
  attack: 4,
  ogreTreads: 2,
  ogreTreadRoll: 4,
} as const;

/** Any of the three rules is on: the table has secrets, and needs a referee. */
export const hasHiddenInformation = (options: GameOptions): boolean =>
  options.camouflage === true || (options.dummies ?? 0) > 0 || (options.minefields ?? 0) > 0;

// ---------------------------------------------------------------------------
// Minefields
// ---------------------------------------------------------------------------

export const minesOf = (state: GameState): readonly Minefield[] => state.mines ?? [];

export const mineAt = (state: GameState, h: Hex): Minefield | undefined =>
  minesOf(state).find((m) => eq(m.pos, h));

/** Minefields still to be laid by this side, during the setup. */
export const minefieldsLeft = (state: GameState, player: PlayerId): number =>
  state.setup?.mines?.[player] ?? 0;

/**
 * Lay one minefield during the setup, in the layer's own zone, on ground a
 * unit could stand on, one to a hex.
 */
export const layMinefield = (
  state: GameState,
  map: GameMap,
  by: PlayerId,
  at: Hex,
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
  if (mineAt(state, at)) return { state, ok: false, reason: 'that hex is mined already' };

  const id = `mine-${by}-${minesOf(state).length + 1}`;
  const mine: Minefield = { id, owner: by, pos: at, revealed: false };
  const next: GameState = {
    ...state,
    mines: [...minesOf(state), mine],
    setup: { ...state.setup, mines: { ...(state.setup.mines ?? {}), [by]: left - 1 } },
  };
  return { state: next, ok: true };
};

/** Take a minefield off the map: cleared by engineers (15), or for a test. */
export const removeMinefield = (state: GameState, id: string): GameState => ({
  ...state,
  mines: minesOf(state).filter((m) => m.id !== id),
});

/**
 * The first hex on a path where an enemy minefield would stop the mover,
 * or -1. The mover's own side's mines do not count: it knows where they
 * are. Hidden mines count too — that is the point — so this is asked of the
 * true state by the reducer, never of a view.
 */
export const mineStopOn = (state: GameState, mover: Unit, path: readonly Hex[]): number => {
  for (let i = 0; i < path.length; i++) {
    const m = mineAt(state, path[i]!);
    if (m && m.owner !== mover.owner) return i;
  }
  return -1;
};

/**
 * A unit has entered a mined hex: the minefield is revealed and attacks.
 *
 * Conventional units take a CRT attack at `MINEFIELD.attack` against their
 * defence in the hex; a cybertank loses tread units on a die roll, the
 * shape of every other tread hit in the game.
 */
export const tripMinefield = (state: GameState, map: GameMap, unitId: UnitId): GameState => {
  const unit = state.units[unitId];
  if (!unit || !onBoard(unit)) return state;
  const mine = mineAt(state, unit.pos);
  if (!mine || mine.owner === unit.owner) return state;

  let next: GameState = {
    ...state,
    mines: minesOf(state).map((m) => (m.id === mine.id ? { ...m, revealed: true } : m)),
  };
  next = revealUnit(next, unitId);
  const label = unitName(unit);

  if (isOgre(unit)) {
    const die = rollDie(next.rng);
    next = { ...next, rng: die.state };
    if (die.value >= MINEFIELD.ogreTreadRoll) {
      const lost = Math.min(unit.treads, MINEFIELD.ogreTreads);
      next = updateOgre(next, unitId, (o) => ({ treads: o.treads - lost }));
      next = log(
        next,
        'bad',
        `${label} runs onto a minefield — rolled ${die.value}: ${lost} tread unit${lost === 1 ? '' : 's'} destroyed.`,
        [unit.pos],
      );
      next = checkOgreDeath(next, { kind: 'ogreTreads', unit: unitId }, mine.owner);
    } else {
      next = log(next, 'warn', `${label} runs onto a minefield — rolled ${die.value}: no effect.`, [
        unit.pos,
      ]);
    }
    return next;
  }

  const defense = defenseOf(next, map, unit);
  const odds = oddsFor(MINEFIELD.attack, defense);
  if (odds.kind === 'none') {
    return log(next, 'warn', `${label} runs onto a minefield, which cannot hurt it.`, [unit.pos]);
  }
  const die = rollDie(next.rng);
  next = { ...next, rng: die.state };
  const result = odds.kind === 'auto' ? 'X' : resolve(odds, die.value, 'normal');
  next = log(
    next,
    result === 'X' ? 'bad' : result === 'D' ? 'warn' : 'info',
    `${label} runs onto a minefield: ${describeOdds(odds)}` +
      (odds.kind === 'auto' ? ' — automatic' : ` — rolled ${die.value}`) +
      `: ${result === 'X' ? 'destroyed' : result === 'D' ? 'disabled' : 'no effect'}.`,
    [unit.pos],
  );
  if (result !== 'NE') next = applyDamageToUnit(next, unitId, result, mine.owner);
  return next;
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
 * 13.05: a counter that ends a movement phase next to an enemy has been
 * seen — whichever of them moved. Asked as each movement phase closes. A
 * dummy sees nothing: there is nobody in it to look.
 */
export const spotAdjacent = (state: GameState, _mover: PlayerId): GameState => {
  let next = state;
  const all = Object.values(state.units).filter(onBoard);
  for (const u of all) {
    if (!u.concealed) continue;
    const seen = all.some((s) => s.owner !== u.owner && !isDummy(s) && distance(s.pos, u.pos) <= 1);
    if (seen) next = revealUnit(next, u.id, ' An enemy is next to it.');
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
    if (isDummy(u) || (state.options.camouflage === true && canBeConcealed(u))) {
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
