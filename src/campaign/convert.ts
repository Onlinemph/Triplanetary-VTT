/**
 * The conversion table between Triplanetary cargo and Ogre armour units —
 * item 4 on docs/CAMPAIGN.md's build list, and "the only genuinely new rule"
 * the campaign adds.
 *
 * It is one equivalence: **one cargo lot — ten tons of hold — lands one
 * armour unit of ground force.** Ogre already prices everything in armour
 * units (1.07: a Heavy Tank is one, a Howitzer two, three squads make one)
 * and Triplanetary already prices holds in tons, so the table is the exchange
 * rate and nothing else. At ten tons to the armour unit a transport's 50-ton
 * hold lands five armour units, and shipping a Mark V is a seventeen-lot
 * convoy operation — which is the campaign working as intended: a cybertank
 * on another world is a fleet-sized undertaking.
 *
 * A unit is indivisible, so loading is by whole units: each entry in a force
 * takes a whole number of lots (armour units rounded up), except infantry,
 * who pack three squads to the lot the way 3.02 packs three squads to the
 * counter. `splitByLots` is the one loading rule, used both for "what got
 * ashore" and "what turned back": walk the manifest heaviest first — the
 * decisive equipment goes on the surest bottoms — and land whole units while
 * they fit.
 */

import { groundEntry } from './data.js';

export const TONS_PER_LOT = 10;
export const SQUADS_PER_LOT = 3;

export type Force = Readonly<Record<string, number>>;

/** Armour units in a force, infantry at a third apiece (1.07, 3.02). */
export const armourUnitsOf = (force: Force): number => {
  let total = 0;
  for (const [id, count] of Object.entries(force)) {
    const entry = groundEntry(id);
    if (!entry) throw new Error(`"${id}" is not in the ground catalogue`);
    total += entry.armorUnits * count;
  }
  return total;
};

/** Lots one non-infantry unit of this type occupies. */
const lotsPerUnit = (id: string): number => {
  const entry = groundEntry(id);
  if (!entry) throw new Error(`"${id}" is not in the ground catalogue`);
  return Math.max(1, Math.ceil(entry.armorUnits));
};

/** Cargo lots a whole force needs afloat. */
export const lotsOf = (force: Force): number => {
  let total = 0;
  for (const [id, count] of Object.entries(force)) {
    if (count <= 0) continue;
    total += isSquads(id) ? Math.ceil(count / SQUADS_PER_LOT) : lotsPerUnit(id) * count;
  }
  return total;
};

/** Infantry are the one entry counted in squads rather than vehicles. */
const isSquads = (id: string): boolean => {
  const entry = groundEntry(id);
  if (!entry) throw new Error(`"${id}" is not in the ground catalogue`);
  return entry.armorUnits < 1;
};

/**
 * The manifest: which units ride which lots, heaviest first, ties broken by
 * id so the order is stable. This ordering *is* the campaign's loading
 * doctrine, and both halves of a split read it the same way — that is what
 * makes "delivered + returned + lost = shipped" hold unit by unit.
 */
export const manifestOf = (force: Force): readonly { id: string; count: number }[] =>
  Object.entries(force)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => {
      const heavier = (groundEntry(b)?.armorUnits ?? 0) - (groundEntry(a)?.armorUnits ?? 0);
      return heavier !== 0 ? heavier : a.localeCompare(b);
    })
    .map(([id, count]) => ({ id, count }));

export interface Split {
  readonly loaded: Force;
  readonly remainder: Force;
  readonly lotsUsed: number;
}

/**
 * Fill `budget` lots from a force, whole units only, manifest order.
 *
 * A unit whose lots no longer fit is skipped and the walk continues — the
 * squads at the end of the manifest fill the space a half-shipped Howitzer
 * cannot use. Infantry load three squads to a lot, and a final part-lot of
 * one or two squads still costs a whole lot, exactly as it does outbound.
 */
export const splitByLots = (force: Force, budget: number): Split => {
  const loaded: Record<string, number> = {};
  const remainder: Record<string, number> = {};
  let left = Math.max(0, Math.floor(budget));

  for (const { id, count } of manifestOf(force)) {
    if (isSquads(id)) {
      const squads = Math.min(count, left * SQUADS_PER_LOT);
      if (squads > 0) {
        loaded[id] = squads;
        left -= Math.ceil(squads / SQUADS_PER_LOT);
      }
      if (count - squads > 0) remainder[id] = count - squads;
      continue;
    }
    const per = lotsPerUnit(id);
    const units = Math.min(count, Math.floor(left / per));
    if (units > 0) {
      loaded[id] = units;
      left -= units * per;
    }
    if (count - units > 0) remainder[id] = count - units;
  }

  return { loaded, remainder, lotsUsed: Math.max(0, Math.floor(budget)) - left };
};

/** True when a force has nothing in it. */
export const forceIsEmpty = (force: Force): boolean => Object.values(force).every((n) => n <= 0);

/** A short human line: "Ogre Mark III ×1, HVY ×2, 7 squads". */
export const describeForce = (force: Force): string => {
  const parts = manifestOf(force).map(({ id, count }) =>
    isSquads(id) ? `${count} squad${count === 1 ? '' : 's'}` : `${id} ×${count}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'nothing';
};
