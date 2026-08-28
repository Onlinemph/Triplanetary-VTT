/**
 * The campaign's own tables: the map of objectives, the procurement lists, and
 * the victory line.
 *
 * The campaign lives in this repository — beside the online play that lets a
 * contested transfer actually be contested by somebody on another machine —
 * and the fiction is the one the design picked because Ogre's own preface
 * supplies it: the Last War is fought over resources, and the resources are
 * not all on Earth. Terra is deliberately *not* an objective — the ground war
 * there is the stalemate both sides are trying to break — so the campaign is
 * fought over the off-world sites, every one of which is a body on this
 * game's chart, because a site the space game cannot fly to is a site the
 * campaign cannot contest.
 *
 * Prices are in production points (PP). The scale is 3 PP per MCr 10 of
 * shipping and 3 PP per Ogre armour unit — chosen so that both catalogues
 * land on whole numbers (an infantry squad, a third of an armour unit, is
 * exactly 1 PP) and so that a cybertank and a frigate cost the same order of
 * magnitude, which is the campaign's actual claim: fleets and ground forces
 * compete for the same industry.
 *
 * The ship catalogue is derived from this engine's own ship table. The ground
 * catalogue is the campaign's copy of the other game's prices — armour-unit
 * costs transcribed from OGRE-VTT's unit and record-sheet tables (rulebook
 * 1.07 and the printed record sheets) — because the campaign owns the
 * conversion between the two vocabularies and neither game engine needs to
 * know the other's exists.
 */

import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';

export type CampaignSideId = 'combine' | 'paneuro';

export interface CampaignSideDef {
  readonly id: CampaignSideId;
  readonly name: string;
  readonly faction: string;
  readonly color: string;
}

export const CAMPAIGN_SIDES: Readonly<Record<CampaignSideId, CampaignSideDef>> = {
  combine: {
    id: 'combine',
    name: 'Combine',
    faction: 'North American Combine',
    color: '#b83b3b',
  },
  paneuro: {
    id: 'paneuro',
    name: 'Paneurope',
    faction: 'Paneuropean Federation',
    color: '#3f7fd0',
  },
};

export const otherSide = (side: CampaignSideId): CampaignSideId =>
  side === 'combine' ? 'paneuro' : 'combine';

// ---------------------------------------------------------------------------
// The map of objectives
// ---------------------------------------------------------------------------

export interface SiteDef {
  /** Also the body id on the chart — that identity is the join. */
  readonly id: string;
  readonly name: string;
  /** Production points per campaign turn, to whoever holds it. */
  readonly production: number;
}

/** Each side's opening hold, and the garrison already dug in there. */
export interface OpeningHold {
  readonly holder: CampaignSideId;
  readonly garrison: Readonly<Record<string, number>>;
}

export const SITES: readonly SiteDef[] = [
  { id: 'luna', name: 'Luna', production: 6 },
  { id: 'venus', name: 'Venus', production: 9 },
  { id: 'mars', name: 'Mars', production: 9 },
  { id: 'mercury', name: 'Mercury', production: 3 },
  { id: 'ceres', name: 'Ceres', production: 6 },
  { id: 'io', name: 'Io', production: 3 },
  { id: 'ganymede', name: 'Ganymede', production: 3 },
  { id: 'callisto', name: 'Callisto', production: 6 },
];

export const siteDef = (id: string): SiteDef | undefined => SITES.find((s) => s.id === id);

/**
 * The opening position: each side holds an inner-system prize and an outpost,
 * with the Belt and the small moons unclaimed and worth going for.
 */
export const OPENING_HOLDS: Readonly<Record<string, OpeningHold>> = {
  luna: { holder: 'combine', garrison: { INF: 6, HVY: 2 } },
  venus: { holder: 'combine', garrison: { INF: 9, MSL: 2 } },
  mars: { holder: 'paneuro', garrison: { INF: 9, HVY: 2 } },
  callisto: { holder: 'paneuro', garrison: { INF: 6, GEV: 2 } },
};

/** Total production on the map — the pie the war is over. */
export const TOTAL_PRODUCTION = SITES.reduce((n, s) => n + s.production, 0);

/**
 * The victory line: hold two thirds of the map's production at the end of a
 * consolidation and the other side's war economy cannot recover. Holding
 * every site is a complete victory.
 */
export const VICTORY_PRODUCTION = Math.ceil((TOTAL_PRODUCTION * 2) / 3);

/** What each side starts the war with, beyond its garrisons. */
export const OPENING_PRODUCTION = 30;
export const OPENING_FLEET: Readonly<Record<string, number>> = { transport: 2, corvette: 2 };
export const OPENING_GROUND: Readonly<Record<string, number>> = { INF: 6, HVY: 2 };

// ---------------------------------------------------------------------------
// Procurement: ships
// ---------------------------------------------------------------------------

export interface ShipEntry {
  readonly id: ShipClass;
  readonly name: string;
  readonly pp: number;
  /** Cargo lots this hull can lift — see convert.ts for what a lot is. */
  readonly lots: number;
}

const hull = (id: ShipClass): ShipEntry => ({
  id,
  name: SHIP_CLASSES[id].name,
  // MCr 10 → 3 PP, straight off the ship table this engine already carries.
  pp: Math.round((SHIP_CLASSES[id].cost * 3) / 10),
  lots: Number.isFinite(SHIP_CLASSES[id].cargoCapacity)
    ? Math.floor(SHIP_CLASSES[id].cargoCapacity / 10)
    : 0,
});

/** The hulls the campaign will buy. Derived from the engine's own table. */
export const SHIP_CATALOGUE: readonly ShipEntry[] = [
  hull('transport'),
  hull('tanker'),
  hull('corvette'),
  hull('corsair'),
  hull('frigate'),
  hull('dreadnaught'),
];

export const shipEntry = (id: string): ShipEntry | undefined =>
  SHIP_CATALOGUE.find((s) => s.id === id);

// ---------------------------------------------------------------------------
// Procurement: ground forces
// ---------------------------------------------------------------------------

export interface GroundEntry {
  /** A `UnitClassId` or `OgreTypeId` — the vocabulary Ogre's Landing speaks. */
  readonly id: string;
  readonly name: string;
  readonly pp: number;
  /** Armour units apiece (Ogre 1.07); infantry are counted per squad. */
  readonly armorUnits: number;
}

const unit = (id: string, name: string, armorUnits: number): GroundEntry => ({
  id,
  name,
  pp: Math.round(armorUnits * 3),
  armorUnits,
});

/**
 * What the ground factories sell, priced in armour units transcribed from the
 * Ogre game's own tables: a squad is a third of an armour unit ("A 3-squad
 * counter is the equivalent of one armor unit", 3.02), the vehicles are 1.07's
 * costs, and the two cybertanks carry the armour-unit values printed on their
 * record sheets (17 AU for a Mark III, 25 for a Mark V). The set is
 * restricted to units whose cost triples to a whole number of PP, which
 * happens to be the classic mix.
 */
export const GROUND_CATALOGUE: readonly GroundEntry[] = [
  unit('INF', 'Infantry squad', 1 / 3),
  unit('HVY', 'Heavy Tank', 1),
  unit('MSL', 'Missile Tank', 1),
  unit('GEV', 'GEV', 1),
  unit('HWZ', 'Howitzer', 2),
  unit('SHVY', 'Superheavy Tank', 2),
  unit('MK3', 'Ogre Mark III', 17),
  unit('MK5', 'Ogre Mark V', 25),
];

export const groundEntry = (id: string): GroundEntry | undefined =>
  GROUND_CATALOGUE.find((g) => g.id === id);
