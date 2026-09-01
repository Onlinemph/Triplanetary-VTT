/**
 * Terrain: what it costs to enter, what it protects, and what it forbids.
 *
 * Section 5.08 of the rules does not have one terrain table. It has *five* —
 * one per kind of running gear — because a swamp that merely slows a Heavy Tank
 * will strand it permanently, while a GEV skims a stream but must stop at one.
 * So this file is organised the way the rulebook is: by mobility class first,
 * terrain second.
 *
 * Everything here is a pure function of (terrain, mobility). Nothing reads game
 * state, and nothing rolls a die — where the rules call for a die (swamp, and
 * GEVs in forest) the function reports *that a roll is needed* and the movement
 * module rolls it.
 */

// ---------------------------------------------------------------------------
// Terrain kinds
// ---------------------------------------------------------------------------

export type Terrain =
  /** "All units have their normal movement and combat abilities" (2.01.1). */
  | 'clear'
  /** "Hexes containing craters are impassable" (2.01.2). Fire passes over. */
  | 'crater'
  /** "Urban areas, which slow all units except infantry and protect all units" (2.01.3). */
  | 'town'
  /** "Wooded areas, which slow the movement of armor units and protect infantry" (2.01.4). */
  | 'forest'
  /** "Marshy wooded areas, which drastically reduce armor movement" (2.01.5). */
  | 'swamp'
  /** "Impassable to all units except infantry, GEV-type units, Ogres, and Superheavy Tanks" (2.01.6). */
  | 'water'
  /** A town or forest reduced to rubble; "most units treat as swamp" (2.01.8). */
  | 'rubble'
  /** Damaged town/forest: roads cut, "but has no other effect" (2.01.7). */
  | 'damagedTown'
  | 'damagedForest'
  /** "Beach is treated as ordinary clear terrain for all purposes" (2.01.9). */
  | 'beach';

/** Hexside features. "These affect movement between hexes" (2.02). */
export type SideFeature =
  /** "Only Ogres, Superheavy Tanks, and infantry may cross ridge hexsides" (2.02.1). */
  | 'ridge'
  /** "Streams delay the movement of most armor units" (2.02.2). */
  | 'stream'
  /** A beach hexside: the one place a GEV crosses the waterline without stopping. */
  | 'beach';

/** In-hex linear features. "Units on the road/railroad ignore all movement penalties" (2.03). */
export type Route = 'road' | 'rail';

export const TERRAIN_LABELS: Readonly<Record<Terrain, string>> = {
  clear: 'Clear',
  crater: 'Crater',
  town: 'Town',
  forest: 'Forest',
  swamp: 'Swamp',
  water: 'Water',
  rubble: 'Rubble',
  damagedTown: 'Damaged town',
  damagedForest: 'Damaged forest',
  beach: 'Beach',
};

/**
 * A damaged town is still a town, and a damaged forest still a forest: the
 * overlay "cuts roads and railroads but has no other effect" (2.01.7). Reduce
 * to the underlying kind before consulting any movement or defence rule.
 */
export const baseTerrain = (t: Terrain): Terrain =>
  t === 'damagedTown' ? 'town' : t === 'damagedForest' ? 'forest' : t === 'beach' ? 'clear' : t;

// ---------------------------------------------------------------------------
// Mobility classes
// ---------------------------------------------------------------------------

/**
 * The five running-gear families of 5.08, plus `immobile` for the guns and
 * structures that never move at all.
 *
 * `ogre` is deliberately separate from `heavyTracked` even though 5.08.3 lists
 * Ogres among heavy tracked units: within that section Ogres and Superheavies
 * are carved out again and again (ridges, rubble, water), and a class that has
 * to be special-cased in half its own rules is better modelled as its own
 * class. Superheavy Tanks use `ogre` too — "It is affected by terrain as though
 * it were an Ogre!" (3.01).
 */
export type Mobility =
  | 'infantry'
  | 'gev'
  | 'ogre'
  | 'heavyTracked'
  | 'lightTracked'
  | 'wheeled'
  | 'immobile'
  /** The train: "moves only along railroad hexes" (9.01). */
  | 'rail';

/** What entering a hex costs, and what it does to the unit that enters. */
export interface EntryCost {
  /** Movement points, or null when the hex may not be entered at all. */
  readonly cost: number | null;
  /** "It ends its movement for the turn when it enters such a hex." */
  readonly endsMovement: boolean;
  /**
   * The die the unit must roll on entering, if any.
   *
   * `disable` is recoverable ("A unit disabled by swamp may roll to recover");
   * `stuck` is not ("may not move for the rest of the game"). Both trigger on
   * a roll of 1 or 2.
   */
  readonly hazard: 'none' | 'disable' | 'stuck';
  /** Why the hex is closed, for the interface to explain a rejected move. */
  readonly reason?: string;
}

const OPEN: EntryCost = { cost: 1, endsMovement: false, hazard: 'none' };
const closed = (reason: string): EntryCost => ({
  cost: null,
  endsMovement: false,
  hazard: 'none',
  reason,
});
const costing = (cost: number): EntryCost => ({ cost, endsMovement: false, hazard: 'none' });

/**
 * The cost for `mobility` to enter a hex of `terrain`, ignoring roads.
 *
 * Roads are applied by the caller, not here: "Units which enter a hex on the
 * road may ignore any movement penalties for the underlying terrain" (2.03.1)
 * is a rule about the *route taken between two hexes*, which this function
 * cannot see.
 */
export const entryCost = (terrain: Terrain, mobility: Mobility): EntryCost => {
  // "Hexes containing craters are impassable. No unit may move into or over a
  // crater." (2.01.2) — no exceptions, not even for Ogres.
  if (terrain === 'crater') return closed('craters are impassable');

  // A truck can pick its way through an intact town but not a burning one: the
  // Terrain Effects Table gives wheeled units "Cannot enter" for damaged town
  // and forest, where every other class simply treats them as the undamaged
  // terrain with the roads cut.
  if (mobility === 'wheeled' && (terrain === 'damagedTown' || terrain === 'damagedForest')) {
    return closed('wheeled vehicles cannot enter damaged terrain');
  }

  const t = baseTerrain(terrain);

  switch (mobility) {
    case 'immobile':
      return closed('this unit cannot move');

    // The train never enters a hex *as terrain*: it enters along a rail link,
    // which the movement module prices at one point like any route (9.01).
    case 'rail':
      return closed('the train keeps to the rails');

    // 5.08.1: "Infantry have no other terrain penalties; if they can legally
    // enter a hex at all, it costs them only one movement point."
    case 'infantry':
      return t === 'water' ? costing(2) : OPEN;

    // 5.08.2
    case 'gev':
      switch (t) {
        case 'forest':
        case 'swamp':
        case 'rubble':
          return { cost: 2, endsMovement: true, hazard: 'disable' };
        case 'town':
          // "Towns affect GEVs like forest or swamp, except that there is no
          // chance of the unit becoming disabled."
          return { cost: 2, endsMovement: true, hazard: 'none' };
        default:
          return OPEN;
      }

    // 5.08.3, Ogre/Superheavy half: ridges, rubble and water are all open, and
    // rubble is simply clear ground.
    case 'ogre':
      switch (t) {
        case 'town':
          return costing(2);
        case 'water':
          return costing(2);
        case 'swamp':
          return { cost: 2, endsMovement: true, hazard: 'stuck' };
        default:
          return OPEN;
      }

    // 5.08.3, everything else in the section: Heavy Tanks, Mobile Howitzers,
    // Missile Crawlers. "Streams and forests do not slow them."
    case 'heavyTracked':
      switch (t) {
        case 'town':
          return costing(2);
        case 'water':
          return closed('heavy tracked units cannot enter water');
        case 'swamp':
        case 'rubble':
          return { cost: 2, endsMovement: true, hazard: 'stuck' };
        default:
          return OPEN;
      }

    // 5.08.4: Light Tanks, Missile Tanks, Mobile CPs.
    case 'lightTracked':
      switch (t) {
        case 'water':
          return closed('light tracked units cannot enter water');
        case 'forest':
        case 'town':
          return costing(2);
        case 'swamp':
        case 'rubble':
          return { cost: 2, endsMovement: true, hazard: 'disable' };
        default:
          return OPEN;
      }

    // 5.08.5: the Truck. Note the inversion — a town is *cheaper* than open
    // ground, because off-road a truck is looking for streets.
    case 'wheeled':
      switch (t) {
        case 'town':
          return costing(2);
        case 'clear':
          return costing(4);
        default:
          return closed('wheeled vehicles cannot enter this terrain');
      }
  }
};

/**
 * Whether `mobility` may cross a hexside carrying `feature`, and what it costs
 * in delay.
 *
 * Streams never cost movement points — they cost a *phase*: "a unit coming to a
 * stream must stop and may not cross the stream until its next movement phase.
 * (In other words, the only way to cross a stream is to start the movement
 * phase next to it.)" (5.08.4)
 */
export interface SideCrossing {
  readonly allowed: boolean;
  /** The mover must have begun this movement phase adjacent to the side. */
  readonly requiresPhaseStart: boolean;
  readonly reason?: string;
}

const CROSS_FREELY: SideCrossing = { allowed: true, requiresPhaseStart: false };

export const sideCrossing = (
  feature: SideFeature | undefined,
  mobility: Mobility,
  onRoute: boolean,
): SideCrossing => {
  if (!feature) return CROSS_FREELY;

  // A bridge is a road or rail crossing the side; "A bridge hex is like any
  // other road hex for movement purposes" (5.07).
  if (onRoute) return CROSS_FREELY;

  switch (feature) {
    case 'beach':
      return CROSS_FREELY;
    case 'ridge':
      // 2.02.1
      return mobility === 'ogre' || mobility === 'infantry'
        ? CROSS_FREELY
        : { allowed: false, requiresPhaseStart: false, reason: 'ridges block this unit' };
    case 'stream':
      switch (mobility) {
        case 'infantry':
        case 'heavyTracked':
        case 'ogre':
          // "Streams and forests do not slow them" (5.08.3); infantry are not
          // mentioned in 5.08.1 at all, so they are unaffected.
          return CROSS_FREELY;
        case 'lightTracked':
        case 'gev':
          return { allowed: true, requiresPhaseStart: true };
        case 'wheeled':
          return {
            allowed: false,
            requiresPhaseStart: false,
            reason: 'trucks cannot ford streams',
          };
        case 'immobile':
          return { allowed: false, requiresPhaseStart: false, reason: 'this unit cannot move' };
        case 'rail':
          // Off a bridge there is no rail, and the case above already let a
          // bridge through.
          return { allowed: false, requiresPhaseStart: false, reason: 'the train keeps to the rails' };
      }
  }
};

/**
 * A GEV "must end its movement phase at the edge of the water, and may not move
 * onto (or leave) the water until its next movement phase, as though it were
 * crossing a stream" (5.08.2) — unless it uses a beach hexside.
 */
export const gevWaterlineStops = (
  from: Terrain,
  to: Terrain,
  side: SideFeature | undefined,
): boolean => {
  if (side === 'beach') return false;
  const a = baseTerrain(from) === 'water';
  const b = baseTerrain(to) === 'water';
  return a !== b;
};

// ---------------------------------------------------------------------------
// Terrain effects on combat (7.14)
// ---------------------------------------------------------------------------

/**
 * The defence multiplier terrain gives a unit standing in it.
 *
 * "Forest, swamp, and rubble hexes double the defense strength of infantry.
 * They do not affect the defense strength of other units." (7.14.1)
 *
 * "Town hexes triple the defense strength of infantry, and double the defense
 * strength of all other units." (7.14.2)
 *
 * A unit on a road still gets it: "A unit on the road gets the full defensive
 * bonus of the terrain in its hex" (7.14.3) — which is why this function takes
 * no route argument.
 */
export const defenseMultiplier = (terrain: Terrain, isInfantry: boolean): number => {
  switch (baseTerrain(terrain)) {
    case 'town':
      return isInfantry ? 3 : 2;
    case 'forest':
    case 'swamp':
    case 'rubble':
      return isInfantry ? 2 : 1;
    default:
      return 1;
  }
};

/** "A town hex gives a D0 unit a defense of 1" (7.14.2). */
export const townFloorsZeroDefense = (terrain: Terrain): boolean => baseTerrain(terrain) === 'town';

/**
 * "When Ogre treads are the target in a town, they are destroyed only on a roll
 * of 6." (7.14.2) — the one place the CRT is bypassed by terrain.
 */
export const treadHitRollIn = (terrain: Terrain): number =>
  baseTerrain(terrain) === 'town' ? 6 : 5;

/** Raised terrain that blocks a standard Laser's line of fire (12.02). */
export const blocksLaser = (terrain: Terrain): boolean => {
  switch (baseTerrain(terrain)) {
    case 'forest':
    case 'swamp':
    case 'town':
    case 'rubble':
      return true;
    default:
      return false;
  }
};

/**
 * Terrain that a Laser Tower can fire *over* but not *into* (12.03), and the
 * same list that hides a unit from a tower.
 */
export const hidesFromLaserTower = blocksLaser;

/**
 * What a town or forest hex becomes when it takes a damage result (13.01).
 * Anything else keeps its type; only the route through it is cut.
 */
export const degradeTerrain = (t: Terrain): Terrain => {
  switch (t) {
    case 'town':
      return 'damagedTown';
    case 'forest':
      return 'damagedForest';
    case 'damagedTown':
    case 'damagedForest':
      return 'rubble';
    default:
      return t;
  }
};
