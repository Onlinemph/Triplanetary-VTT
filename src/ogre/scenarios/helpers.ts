/**
 * Deployment helpers shared by the scenarios.
 *
 * The rulebook hands the defender a budget and a map of legal areas and lets
 * them arrange it: "This is an example of a reasonably good defensive setup for
 * the basic scenario. This is an example to be used while learning the game,
 * NOT the only legal setup!" So these helpers build a *legal* arrangement from
 * a seed rather than the only one, and a new seed is a new battle plan.
 */

import { type Hex, key, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, areaOf, terrainAt } from '../engine/map.js';
import { type RngState, nextInt, shuffle } from '../engine/rng.js';
import { type UnitClassId, unitClass } from '../engine/units.js';
import {
  type ConventionalUnit,
  type GameState,
  type PlayerId,
  type SetupLimit,
  type SetupZone,
} from '../engine/types.js';
import { makeUnit, printedAttack, withUnit } from '../engine/state.js';

export interface Deployer {
  state: GameState;
  serial: number;
}

/** Hexes a unit may legally be set up in: on the map, and not a crater. */
export const openHexes = (map: GameMap, area?: 'north' | 'central' | 'south'): Hex[] =>
  allHexes(map).filter(
    (h) => terrainAt(map, h) !== 'crater' && (area === undefined || areaOf(map, h) === area),
  );

/** Free hexes, in a seeded order, so a deployment is reproducible but varied. */
export const shuffledOpenHexes = (
  rng: RngState,
  map: GameMap,
  area?: 'north' | 'central' | 'south',
): { rng: RngState; hexes: Hex[] } => {
  const res = shuffle(rng, openHexes(map, area));
  return { rng: res.state, hexes: res.items };
};

export const isFree = (state: GameState, h: Hex): boolean =>
  !Object.values(state.units).some((u) => !u.destroyed && u.pos.q === h.q && u.pos.r === h.r);

/** Place one counter on the first free hex of `hexes`, consuming it. */
export const place = (
  d: Deployer,
  owner: PlayerId,
  classId: UnitClassId,
  hexes: Hex[],
  squads = 1,
): ConventionalUnit | null => {
  while (hexes.length > 0) {
    const h = hexes.shift()!;
    if (!isFree(d.state, h)) continue;
    const id = `${owner}-${classId.toLowerCase()}-${d.serial++}`;
    const unit = makeUnit(id, owner, classId, h, squads);
    d.state = withUnit(d.state, unit);
    return unit;
  }
  return null;
};

/**
 * Split a squad total into counters of 3, 2 and 1, the way the counter mix
 * does: "Infantry counters are 2/1 on one side, and either 1/1 or 3/1 on the
 * other, for ease in splitting or recombining squads." (3.02)
 */
export const infantryCounters = (squads: number): number[] => {
  const out: number[] = [];
  let left = squads;
  while (left >= 3) {
    out.push(3);
    left -= 3;
  }
  if (left > 0) out.push(left);
  return out;
};

/**
 * Buy a mix of armour to a budget in armour units, favouring the four types of
 * the original game (1.05) and keeping the Howitzers — which cost double — to a
 * sensible battery.
 */
export const buyArmor = (
  rng: RngState,
  budget: number,
): { rng: RngState; units: UnitClassId[] } => {
  const units: UnitClassId[] = [];
  let left = budget;
  let s = rng;

  // A battery of howitzers first: they are the only thing that outranges an
  // Ogre's missiles, and every good defence has some.
  const howitzers = Math.max(1, Math.floor(budget / 12));
  for (let i = 0; i < howitzers && left >= 2; i++) {
    units.push('HWZ');
    left -= 2;
  }

  const line: UnitClassId[] = ['HVY', 'MSL', 'HVY', 'MSL', 'GEV'];
  let i = 0;
  while (left >= 1) {
    const pickResult = nextInt(s, 100);
    s = pickResult.state;
    // Roughly two thirds tanks, one third GEVs, with the order shuffled by the
    // seed so two games of the same scenario do not look identical.
    const cls = pickResult.value < 66 ? line[i % line.length]! : 'GEV';
    units.push(cls);
    left -= unitClass(cls).armorUnits;
    i++;
  }
  return { rng: s, units };
};

/** Total attack strength of a player's surviving units — the victory currency. */
export const attackStrengthOf = (state: GameState, player: PlayerId): number =>
  Object.values(state.units)
    .filter((u): u is ConventionalUnit => u.kind === 'unit' && !u.destroyed && u.owner === player)
    .reduce((n, u) => n + printedAttack(u), 0);

/**
 * The southernmost row: where an Ogre comes on. "The attacking player takes a
 * single Ogre Mark III and moves first, entering anywhere on the south end of
 * the map. It spends one movement point to enter its starting hex."
 */
export const southEdgeHexes = (map: GameMap): Hex[] =>
  allHexes(map).filter((h) => toOffset(h).row === map.rows && terrainAt(map, h) !== 'crater');

export const hexKeys = (hexes: readonly Hex[]): string[] => hexes.map(key);

// ---------------------------------------------------------------------------
// Deployment zones
// ---------------------------------------------------------------------------

/** A setup zone from a list of hexes, with any attack-strength ceilings. */
export const zone = (hexes: readonly Hex[], label: string, limits?: SetupLimit[]): SetupZone => ({
  hexes: hexKeys(hexes),
  label,
  ...(limits && limits.length > 0 ? { limits } : {}),
});

export const limit = (hexes: readonly Hex[], maxAttack: number, label: string): SetupLimit => ({
  hexes: hexKeys(hexes),
  maxAttack,
  label,
});

/**
 * Open the built board with a deployment step, if the caller asked for one.
 * `order` is who sets up first — the defender, in every printed scenario.
 */
export const withSetup = (
  state: GameState,
  wanted: boolean | undefined,
  order: readonly PlayerId[],
  zones: Readonly<Record<PlayerId, SetupZone>>,
): GameState => (wanted ? { ...state, setup: { order, index: 0, zones } } : state);
