/**
 * The ship type table (rulebook p. 1).
 *
 * | Ship Type    | Combat | Fuel | Cargo | Cost |
 * |--------------|--------|------|-------|------|
 * | Transport    | 1D     | 10   | 50    | 10   |
 * | Packet       | 2      | 10   | 50    | 20   |
 * | Tanker       | 1D     | 50   | 0     | 10   |
 * | Liner        | 2D     | 10   | 0     | 50   |
 * | Corvette     | 2      | 20   | 5     | 40   |
 * | Corsair      | 4      | 20   | 10    | 80   |
 * | Frigate      | 8      | 20   | 40    | 150  |
 * | Dreadnaught  | 15     | 15   | 50    | 600  |
 * | Torch        | 8      | ∞    | 10    | 400  |
 * | Orbital Base | 16     | 0    | ∞     | 1000 |
 *
 * A `D` suffix means the strength is defensive only: those ships "may not
 * attack or counterattack".
 */

export type ShipClass =
  | 'transport'
  | 'packet'
  | 'tanker'
  | 'liner'
  | 'corvette'
  | 'corsair'
  | 'frigate'
  | 'dreadnaught'
  | 'torch'
  | 'orbitalBase'
  /**
   * Not a ship at all: an emplacement. "Robot guards may be emplaced to protect
   * a mine and its ore. If attacked, they have a combat value of 2, but only for
   * defense and counterattacks." Modelled as a counter because that is the only
   * way something can be shot at — a hex→owner map cannot be fought, and a claim
   * that cannot be fought for cannot be jumped.
   */
  | 'robotGuards';

export const UNLIMITED = Infinity;

export interface ShipClassDef {
  readonly id: ShipClass;
  readonly name: string;
  /** Doubles as both gun strength and structural resilience. */
  readonly combatStrength: number;
  /** The "D" suffix: strength counts for defence only. */
  readonly defensiveOnly: boolean;
  /**
   * May return fire but may never open it. Distinct from `defensiveOnly`, which
   * is the printed "D" and forbids counterattacking too: robot guards are rated
   * "only for defense and counterattacks", so they need the second of those and
   * not the first. No printed *ship* is in this category.
   */
  readonly counterattackOnly?: boolean;
  /** An emplacement rather than a hull: never moves, never bought as a ship. */
  readonly emplacement?: boolean;
  readonly fuelCapacity: number;
  readonly cargoCapacity: number;
  readonly cost: number;
  /**
   * Warships may perform the overload manoeuvre and may launch torpedoes.
   * Note that a packet is *not* a warship even though it can shoot: the
   * overload rule names "transports, packets, tankers, liners" as commercial.
   */
  readonly warship: boolean;
  /** One-line flavour text from the rulebook. */
  readonly blurb: string;
}

const def = (d: ShipClassDef): ShipClassDef => d;

export const SHIP_CLASSES: Readonly<Record<ShipClass, ShipClassDef>> = {
  transport: def({
    id: 'transport',
    name: 'Transport',
    combatStrength: 1,
    defensiveOnly: true,
    fuelCapacity: 10,
    cargoCapacity: 50,
    cost: 10,
    warship: false,
    blurb: 'A basic cargo ship with minimal defense and no weapons.',
  }),
  packet: def({
    id: 'packet',
    name: 'Packet',
    combatStrength: 2,
    defensiveOnly: false,
    fuelCapacity: 10,
    cargoCapacity: 50,
    cost: 20,
    warship: false,
    blurb: 'A transport with extra armor and a couple of railguns for self-defense.',
  }),
  tanker: def({
    id: 'tanker',
    name: 'Tanker',
    combatStrength: 1,
    defensiveOnly: true,
    fuelCapacity: 50,
    cargoCapacity: 0,
    cost: 10,
    warship: false,
    blurb: 'Nothing but drive, crew quarters, and fuel tanks - no weapons.',
  }),
  liner: def({
    id: 'liner',
    name: 'Liner',
    combatStrength: 2,
    defensiveOnly: true,
    fuelCapacity: 10,
    cargoCapacity: 0,
    cost: 50,
    warship: false,
    blurb: 'A specialized craft for carrying passengers.',
  }),
  corvette: def({
    id: 'corvette',
    name: 'Corvette',
    combatStrength: 2,
    defensiveOnly: false,
    fuelCapacity: 20,
    cargoCapacity: 5,
    cost: 40,
    warship: true,
    blurb: 'The smallest warship.',
  }),
  corsair: def({
    id: 'corsair',
    name: 'Corsair',
    combatStrength: 4,
    defensiveOnly: false,
    fuelCapacity: 20,
    cargoCapacity: 10,
    cost: 80,
    warship: true,
    blurb: 'A flexible mid-sized warship.',
  }),
  frigate: def({
    id: 'frigate',
    name: 'Frigate',
    combatStrength: 8,
    defensiveOnly: false,
    fuelCapacity: 20,
    cargoCapacity: 40,
    cost: 150,
    warship: true,
    blurb: 'A large warship.',
  }),
  dreadnaught: def({
    id: 'dreadnaught',
    name: 'Dreadnaught',
    combatStrength: 15,
    defensiveOnly: false,
    fuelCapacity: 15,
    cargoCapacity: 50,
    cost: 600,
    warship: true,
    blurb: 'An extremely large warship with a lot of armor and ordnance capacity.',
  }),
  torch: def({
    id: 'torch',
    name: 'Torch',
    combatStrength: 8,
    defensiveOnly: false,
    fuelCapacity: UNLIMITED,
    cargoCapacity: 10,
    cost: 400,
    warship: true,
    blurb: 'An experimental warship with unlimited fuel.',
  }),
  orbitalBase: def({
    id: 'orbitalBase',
    name: 'Orbital Base',
    combatStrength: 16,
    defensiveOnly: false,
    fuelCapacity: 0,
    cargoCapacity: UNLIMITED,
    cost: 1000,
    warship: true,
    blurb: 'A large structure, armed and armored, which also resupplies friendly ships.',
  }),
  robotGuards: def({
    id: 'robotGuards',
    name: 'Robot Guards',
    combatStrength: 2,
    // Not the printed "D": guards may return fire, which a D-suffix hull may not.
    defensiveOnly: false,
    counterattackOnly: true,
    emplacement: true,
    fuelCapacity: 0,
    cargoCapacity: 0,
    // Bought from the equipment catalogue at MCr 50, not from the shipyard.
    cost: 50,
    warship: false,
    blurb: 'An emplacement guarding a claim: combat value 2, for defence and return fire only.',
  }),
};

export const shipClass = (id: ShipClass): ShipClassDef => SHIP_CLASSES[id];

/** Commercial ships may not perform the overload manoeuvre (rulebook p. 4). */
export const isCommercial = (id: ShipClass): boolean =>
  id === 'transport' || id === 'packet' || id === 'tanker' || id === 'liner';

/** Only warships may launch torpedoes (rulebook p. 6). */
export const canLaunchTorpedoes = (id: ShipClass): boolean => SHIP_CLASSES[id].warship;

/** Ships with a "D" strength may neither attack nor counterattack. */
export const canAttack = (id: ShipClass): boolean => !SHIP_CLASSES[id].defensiveOnly;

/** May open fire — as opposed to merely returning it. */
export const mayInitiateAttack = (id: ShipClass): boolean =>
  canAttack(id) && SHIP_CLASSES[id].counterattackOnly !== true;

/** An emplacement: it never moves, and it is never bought from a shipyard. */
export const isEmplacement = (id: ShipClass): boolean => SHIP_CLASSES[id].emplacement === true;

/** Non-warships are restricted to carrying a single nuke at a time. */
export const nukeLimit = (id: ShipClass): number => (SHIP_CLASSES[id].warship ? Infinity : 1);

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

export type CargoKind =
  | 'mine'
  | 'torpedo'
  | 'nuke'
  | 'scanners'
  | 'pmGrapples'
  | 'automatedMine'
  | 'robotGuards'
  | 'ore'
  | 'ctShard'
  | 'orbitalBase'
  | 'passengers'
  | 'freight'
  | 'megacredits';

export interface CargoDef {
  readonly kind: CargoKind;
  readonly name: string;
  /** Mass in tons; consumes hold capacity. */
  readonly mass: number;
  /** Purchase cost in MCr; `null` where the scenario sets the price. */
  readonly cost: number | null;
  readonly remarks?: string;
}

export const CARGO: Readonly<Record<CargoKind, CargoDef>> = {
  mine: { kind: 'mine', name: 'Mine', mass: 10, cost: 10 },
  torpedo: { kind: 'torpedo', name: 'Torpedo', mass: 20, cost: 20 },
  nuke: { kind: 'nuke', name: 'Nuke', mass: 20, cost: 300 },
  scanners: {
    kind: 'scanners',
    name: 'Scanners',
    mass: 0,
    cost: 30,
    remarks: 'Navigation at Clandestine.',
  },
  pmGrapples: {
    kind: 'pmGrapples',
    name: 'PM Grapples',
    mass: 10,
    cost: 40,
    remarks: 'To handle CT shards.',
  },
  automatedMine: {
    kind: 'automatedMine',
    name: 'Automated Mine',
    mass: 10,
    cost: 5,
    remarks: 'To dig ore.',
  },
  robotGuards: {
    kind: 'robotGuards',
    name: 'Robot Guards',
    mass: 10,
    cost: 50,
    remarks: 'To protect mines and ore. Combat value 2, defensive only.',
  },
  ore: { kind: 'ore', name: 'Ore', mass: 1, cost: null },
  ctShard: { kind: 'ctShard', name: 'CT Shard', mass: 10, cost: null },
  orbitalBase: {
    kind: 'orbitalBase',
    name: 'Orbital Base',
    mass: 50,
    cost: 1000,
    remarks: 'May be carried only by a transport or packet.',
  },
  passengers: { kind: 'passengers', name: 'Passengers', mass: 0, cost: null },
  freight: { kind: 'freight', name: 'Freight', mass: 10, cost: null },
  megacredits: {
    kind: 'megacredits',
    name: 'MegaCredits',
    mass: 1,
    cost: null,
    remarks: 'One ton of cargo space per MCr (Interplanetary War).',
  },
};
