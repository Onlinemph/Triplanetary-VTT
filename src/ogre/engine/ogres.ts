/**
 * Cybertanks: their components, their armament, and the Size Table.
 *
 * An Ogre is not a counter with three numbers on it. It is a *record sheet*:
 * "The capabilities of the Ogres are not shown on the counters. They change
 * throughout the game as the Ogre is damaged." (3.04.1) So this file describes
 * a starting inventory, and `types.ts` carries the wear.
 *
 * ## Provenance
 *
 * Every number below is transcribed from the **official Ogre Record Sheets**
 * (Steve Jackson Games, sheet dated 10/15/12), which print each cybertank's
 * full inventory: its guns with their attack, range and defence, its tread
 * count, its armour-unit cost, its Size, and the movement track. Victory
 * values come from 1.09 of the rulebook and Sizes agree with the Size Table.
 *
 * The Mark V, as a worked check on the transcription:
 *
 *     2 MAIN BATTERY      ATK 4  RNG 3  DEF 4
 *     6 SECONDARY         ATK 3  RNG 2  DEF 3
 *     12 ANTIPERSONNEL    ATK 1  RNG 1  DEF 1
 *     6 MISSILES          ATK 6  RNG 5  DEF 3
 *     60 TREAD UNITS      SIZE 8   25 AU   MOVE STARTS AT 3
 *
 * The Paneuropean cards (Pikeman, Legionnaire, Huscarl) are identical to their
 * Combine equivalents (Mark I, Mark III, Mark V) and are not duplicated here.
 */

import type { DamageResult } from './crt.js';

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** "Each Ogre has some combination of these components" (3.04.2). */
export type OgreWeaponKind =
  | 'main'
  | 'secondary'
  | 'ap'
  | 'missile'
  | 'missileRack'
  /** The Vulcan's manipulator arms, targeted separately at D2 (15.02). */
  | 'arm';

export interface OgreWeaponSpec {
  readonly kind: OgreWeaponKind;
  readonly name: string;
  readonly abbr: string;
  readonly attack: number;
  readonly range: number;
  readonly defense: number;
  /** Victory points for destroying one (1.09.1). */
  readonly vp: number;
  /** A one-shot weapon: fired or destroyed, it is gone (7.05.2). */
  readonly oneShot?: boolean;
  /** Effective only against infantry and D0 targets (7.05.1). */
  readonly antipersonnelOnly?: boolean;
}

export const OGRE_WEAPONS: Readonly<Record<OgreWeaponKind, OgreWeaponSpec>> = {
  main: {
    kind: 'main',
    name: 'Main battery',
    abbr: 'MB',
    attack: 4,
    range: 3,
    defense: 4,
    vp: 8,
  },
  secondary: {
    kind: 'secondary',
    name: 'Secondary battery',
    abbr: 'SB',
    attack: 3,
    range: 2,
    defense: 3,
    vp: 4,
  },
  ap: {
    kind: 'ap',
    name: 'Antipersonnel',
    abbr: 'AP',
    attack: 1,
    range: 1,
    defense: 1,
    vp: 1,
    antipersonnelOnly: true,
  },
  missile: {
    kind: 'missile',
    name: 'Missile',
    abbr: 'M',
    attack: 6,
    range: 5,
    defense: 3,
    vp: 1,
    oneShot: true,
  },
  missileRack: {
    // "An Ogre missile rack has no attack strength of its own. It can fire one
    // missile per turn as long as the Ogre has internal missiles remaining."
    // (7.05.3) The attack and range shown are the missile's, used when the rack
    // fires one.
    kind: 'missileRack',
    name: 'Missile rack',
    abbr: 'MR',
    attack: 6,
    range: 5,
    // The record sheets print the rack itself at DEF 4 — tougher than the
    // missile it launches, which is D3 and only vulnerable while mounted
    // externally.
    defense: 4,
    vp: 4,
  },
  arm: {
    // "The manipulator arms are intimidating, but they are not effective
    // weapons against anything faster or better armored than a human being.
    // Each arm is targeted separately, and has D2." (15.02)
    kind: 'arm',
    name: 'Manipulator arm',
    abbr: 'ARM',
    attack: 1,
    range: 1,
    defense: 2,
    vp: 4,
    antipersonnelOnly: true,
  },
};

/** "For every tread unit destroyed ... 1 point" (1.09.1). */
export const TREAD_VP = 1;

// ---------------------------------------------------------------------------
// Ogre types
// ---------------------------------------------------------------------------

export type OgreTypeId =
  | 'MK1'
  | 'MK2'
  | 'MK3'
  | 'MK3B'
  | 'MK4'
  | 'MK5'
  | 'MK6'
  | 'FENCER'
  | 'FENCER_B'
  | 'DOPPELSOLDNER'
  | 'NINJA'
  | 'VULCAN';

export interface OgreType {
  readonly id: OgreTypeId;
  readonly name: string;
  /** Size Table, p. 14. Drives ramming, water entry and mine detection. */
  readonly size: number;
  /** "An Ogre begins the game with 3 movement points (4 for a Mark IV)" (5.06). */
  readonly baseMove: number;
  readonly treads: number;
  /** How many external weapons of each kind it starts with. */
  readonly weapons: Readonly<Partial<Record<OgreWeaponKind, number>>>;
  /**
   * "These are fired by a missile rack ... they cannot be targeted while inside
   * the Ogre." (3.04.2) Stored as a pool, not as individual components.
   */
  readonly internalMissiles: number;
  /** Cost in armour units when substituted for conventional forces (13.03). */
  readonly armorUnits: number;
  /** Victory points for destroying it (1.09). */
  readonly vp: number;
  readonly blurb: string;
  /** Where these numbers came from, so a correction has somewhere to start. */
  readonly note: string;
}

export const OGRE_TYPES: Readonly<Record<OgreTypeId, OgreType>> = {
  MK1: {
    id: 'MK1',
    name: 'Ogre Mark I',
    size: 5,
    baseMove: 3,
    treads: 18,
    weapons: { main: 1, ap: 4 },
    internalMissiles: 0,
    armorUnits: 4,
    vp: 25,
    blurb:
      'An oversized heavy tank with a robot brain — a proof of concept that proved hard to kill, ' +
      'and the only Ogre small enough to move by conventional transport. Paneurope fielded a ' +
      'near-identical unit as the Pikeman.',
    note: 'Record sheet: 1 MB, 4 AP, 18 tread units, 4 AU, Size 5, move starts at 3. 25 VP (1.09).',
  },

  MK2: {
    id: 'MK2',
    name: 'Ogre Mark II',
    size: 6,
    baseMove: 3,
    treads: 30,
    weapons: { main: 1, secondary: 2, ap: 6 },
    internalMissiles: 0,
    armorUnits: 8,
    vp: 50,
    blurb:
      'The first Ogre mass-produced by the Combine. It worked well, but the demand for heavier ' +
      'armament soon replaced it with the Mark III.',
    note: 'Record sheet: 1 MB, 2 SB, 6 AP, 30 tread units, 8 AU, Size 6, move starts at 3. 50 VP (1.09).',
  },

  MK3: {
    id: 'MK3',
    name: 'Ogre Mark III',
    size: 7,
    baseMove: 3,
    treads: 45,
    weapons: { main: 1, secondary: 4, ap: 8, missile: 2 },
    internalMissiles: 0,
    armorUnits: 17,
    vp: 100,
    blurb:
      'The first really capable line-of-battle Ogre. Paneurope built it under the name ' +
      'Legionnaire after capturing the British facility that made them.',
    note: 'Record sheet: 1 MB, 4 SB, 8 AP, 2 external missiles, 45 tread units, 17 AU, Size 7, move starts at 3. 100 VP (1.09). The Legionnaire card is identical.',
  },

  MK3B: {
    id: 'MK3B',
    name: 'Ogre Mark III-B',
    size: 7,
    baseMove: 3,
    treads: 48,
    weapons: { main: 2, secondary: 4, ap: 8, missile: 4 },
    internalMissiles: 0,
    armorUnits: 20,
    vp: 120,
    blurb:
      'A Combine-only variant on a heavier chassis, carrying two main batteries instead of one.',
    note: 'Record sheet: 2 MB, 4 SB, 8 AP, 4 external missiles, 48 tread units, 20 AU, Size 7, move starts at 3. 120 VP (1.09).',
  },

  MK4: {
    id: 'MK4',
    name: 'Ogre Mark IV',
    size: 8,
    baseMove: 4,
    treads: 56,
    weapons: { main: 1, secondary: 2, ap: 8, missileRack: 3 },
    internalMissiles: 15,
    armorUnits: 25,
    vp: 150,
    blurb:
      'A large but lightly built raider: as expensive as a Mark V, faster, and meant to ' +
      'penetrate a position, empty its missile racks, and leave.',
    note: 'Record sheet: 1 MB, 2 SB, 8 AP, 3 missile racks, 15 internal missiles, 56 tread units, 25 AU, Size 8, move starts at 4 — the only Ogre that starts at 4 besides the Ninja and the Vulcan (5.06). 150 VP (1.09).',
  },

  MK5: {
    id: 'MK5',
    name: 'Ogre Mark V',
    size: 8,
    baseMove: 3,
    treads: 60,
    weapons: { main: 2, secondary: 6, ap: 12, missile: 6 },
    internalMissiles: 0,
    armorUnits: 25,
    vp: 150,
    blurb:
      'A very formidable all-around line-of-battle unit, and the biggest cybertank built in ' +
      'quantity. Paneurope built it as the Huscarl.',
    note: 'Record sheet: 2 MB, 6 SB, 12 AP, 6 external missiles, 60 tread units, 25 AU, Size 8, move starts at 3. Also reproduced in the rulebook, and 6.04 pins the tread track with a worked example at 41 → 40 treads. 150 VP (1.09).',
  },

  MK6: {
    id: 'MK6',
    name: 'Ogre Mark VI',
    size: 9,
    baseMove: 3,
    treads: 72,
    weapons: { main: 3, secondary: 6, ap: 16, missile: 6, missileRack: 3 },
    internalMissiles: 12,
    armorUnits: 40,
    vp: 240,
    blurb: 'The biggest Ogre ever to go into regular production. Comparatively few were built.',
    note: 'Record sheet: 3 MB, 6 SB, 16 AP, 6 external missiles, 3 missile racks, 12 internal missiles, 72 tread units, 40 AU, Size 9, move starts at 3. 240 VP (1.09).',
  },

  FENCER: {
    id: 'FENCER',
    name: 'Ogre Fencer',
    size: 8,
    baseMove: 3,
    treads: 48,
    weapons: { secondary: 2, ap: 8, missileRack: 4 },
    internalMissiles: 20,
    armorUnits: 22,
    vp: 130,
    blurb:
      'The first original Paneuropean design: no faster than a Mark V, but with four missile ' +
      'racks it was built for hit-and-run work. Weak up close.',
    note: 'Record sheet: 2 SB, 8 AP, 4 missile racks, 20 internal missiles, no main battery at all, 48 tread units, 22 AU, Size 8, move starts at 3. 130 VP (1.09).',
  },

  FENCER_B: {
    id: 'FENCER_B',
    name: 'Ogre Fencer-B',
    size: 8,
    baseMove: 3,
    treads: 48,
    // The up-gunned turret trades the Fencer's two light railguns for two main
    // batteries; the B has no secondary battery at all.
    weapons: { main: 2, ap: 8, missileRack: 4 },
    internalMissiles: 20,
    armorUnits: 23,
    vp: 140,
    blurb: 'An attempt to fix the Fencer’s close-range weakness with an up-gunned turret.',
    note: 'Record sheet: 2 MB, 8 AP, 4 missile racks, 20 internal missiles, no secondary battery, 48 tread units, 23 AU, Size 8, move starts at 3. 140 VP (1.09).',
  },

  DOPPELSOLDNER: {
    id: 'DOPPELSOLDNER',
    name: 'Ogre Doppelsoldner',
    size: 9,
    baseMove: 3,
    treads: 60,
    weapons: { main: 2, secondary: 8, ap: 12, missileRack: 6 },
    internalMissiles: 20,
    armorUnits: 40,
    vp: 240,
    blurb: 'The biggest Paneuropean cybertank, generally comparable to a Mark VI.',
    note: 'Record sheet: 2 MB, 8 SB, 12 AP, 6 missile racks, 20 internal missiles, 60 tread units, 40 AU, Size 9, move starts at 3. 240 VP (1.09).',
  },

  NINJA: {
    id: 'NINJA',
    name: 'Ogre Ninja',
    size: 7,
    baseMove: 4,
    treads: 40,
    weapons: { main: 1, secondary: 2, ap: 8, missile: 2, missileRack: 1 },
    internalMissiles: 4,
    armorUnits: 25,
    vp: 150,
    blurb:
      'A stealth cybertank that traded armament for speed and electronics. Hard to hit, and ' +
      'unmatched as a raider.',
    note: 'Record sheet and 14.02 agree: 1 MB, 2 SB, 8 AP, 2 external missiles, 1 missile rack, 4 internal missiles, 40 tread units, Size 7, move starts at 4. "25 AU or more" (13.03).',
  },

  VULCAN: {
    id: 'VULCAN',
    name: 'Ogre Vulcan',
    // "For purposes of size and ramming, treat it as a Mark III." (15.02)
    size: 7,
    baseMove: 4,
    treads: 48,
    weapons: { arm: 2, secondary: 2, ap: 6 },
    internalMissiles: 0,
    armorUnits: 25,
    vp: 150,
    blurb:
      'A repair and recovery cybertank on a Mark III-B chassis, with manipulator arms where the ' +
      'main batteries would be. Not built to fight.',
    note: 'Record sheet and 15.02 agree: 2 manipulator arms at D2, 2 SB, 6 AP, 48 tread units, move starts at 4. "25 AU or more"; worth 150 points or more by scenario.',
  },
};

export const ogreType = (id: OgreTypeId): OgreType => OGRE_TYPES[id];

// ---------------------------------------------------------------------------
// The tread track
// ---------------------------------------------------------------------------

/**
 * How fast an Ogre still is, given how many tread units it has left.
 *
 * The rules describe this as a printed track rather than a formula: "Loss of
 * tread units slows the Ogre as shown on the record sheet. For instance, when a
 * Mark V is reduced to 40 tread units, its movement is reduced from 3 to 2."
 * (3.04.2) The Mark V's card shows four steps — 3, 2, 1, 0 — over 60 treads, so
 * each movement point is worth an equal share of the treads, and 6.04's worked
 * example pins the boundary exactly: 41 treads is still 3, 40 is 2.
 *
 * Generalising that to "each movement point costs `treads / baseMove` tread
 * units" reproduces the Mark V's card exactly and gives every other Ogre a
 * track of the right shape. An Ogre with no treads at all cannot move: "When
 * the Ogre's tread units are all gone, the Ogre can no longer move at all. It
 * can still fire at anything within range."
 */
export const movementForTreads = (type: OgreType, treads: number): number => {
  if (treads <= 0) return 0;
  const band = type.treads / type.baseMove;
  const move = Math.ceil(treads / band);
  return Math.max(1, Math.min(type.baseMove, move));
};

/** The tread totals at which the Ogre's movement drops, biggest first. */
export const treadTrack = (type: OgreType): readonly { treads: number; move: number }[] => {
  const out: { treads: number; move: number }[] = [];
  for (let move = type.baseMove; move >= 1; move--) {
    out.push({ treads: Math.ceil((type.treads * move) / type.baseMove), move });
  }
  out.push({ treads: 0, move: 0 });
  return out;
};

// ---------------------------------------------------------------------------
// The Size Table (p. 14)
// ---------------------------------------------------------------------------

/**
 * Ram damage by attacker size, transcribed from the Size Table.
 *
 * The table has three damage columns — against an Ogre, against a building, and
 * against the train — and the entries are of three different kinds: a flat
 * number of tread units, a number of dice to roll and total, or a combat odds
 * ratio. They are kept apart here rather than unified, because the rules use
 * them in three different places.
 */
export interface RamProfile {
  /** Tread units an Ogre loses when this unit rams it (6.07.2), if flat. */
  readonly treadsToOgre?: number;
  /** Dice rolled and totalled for tread damage, for Size 5 and up (6.05). */
  readonly diceToOgre?: number;
  /** Dice rolled for Structure Point damage to a building (11.04.3). */
  readonly diceToBuilding?: number;
  /** Odds of the attack a ram makes on a train counter (9.05); 'X' destroys it. */
  readonly train?: '1-2' | '1-1' | 'X';
}

/**
 * Keyed by Size. Sizes 1-4 are conventional units and do flat tread damage;
 * Size 5 and up roll dice. "An Ogre which rams a larger Ogre loses five tread
 * units. An Ogre which rams a smaller Ogre, or one the same size, loses three
 * tread units." (6.05) is handled by {@link ogreRamsOgreSelfLoss}.
 */
export const SIZE_TABLE: Readonly<Record<number, RamProfile>> = {
  1: { treadsToOgre: 1, train: '1-2' },
  2: { treadsToOgre: 1, diceToBuilding: 1, train: '1-2' },
  3: { treadsToOgre: 1, diceToBuilding: 1, train: '1-2' },
  4: { treadsToOgre: 1, train: '1-2' },
  5: { diceToOgre: 1, diceToBuilding: 2, train: 'X' },
  6: { diceToOgre: 1, diceToBuilding: 2, train: 'X' },
  7: { diceToOgre: 2, diceToBuilding: 3, train: 'X' },
  8: { diceToOgre: 4, diceToBuilding: 5, train: 'X' },
  9: { diceToOgre: 6, diceToBuilding: 7, train: 'X' },
};

/**
 * The Heavy Tank and the standard GEV are the two exceptions the Size Table
 * carries in its own rows rather than by size: a Heavy Tank does 2 tread units
 * (not 1) when it rams an Ogre, and a GEV — alone among Size 2 units — makes a
 * 1-to-1 attack on the train rather than a 1-to-2.
 */
export const ramProfileFor = (size: number, classId?: string): RamProfile => {
  const base = SIZE_TABLE[size] ?? { treadsToOgre: 1 };
  if (classId === 'HVY') return { ...base, treadsToOgre: 2 };
  if (classId === 'GEV') return { ...base, train: '1-1' };
  if (classId === 'HWZ') return { train: undefined };
  return base;
};

/**
 * What the *ramming* Ogre pays.
 *
 * "An Ogre which rams a larger Ogre loses five tread units. An Ogre which rams
 * a smaller Ogre, or one the same size, loses three tread units." (6.05)
 */
export const ogreRamsOgreSelfLoss = (attackerSize: number, targetSize: number): number =>
  targetSize > attackerSize ? 5 : 3;

/**
 * "An Ogre loses two tread units for ramming a Heavy Tank or MHWZ, and one
 * tread unit for ramming any other armor unit. Exception: A Superheavy rammed
 * by an Ogre suffers an immediate 1-1 attack. The Ogre loses three tread
 * units." (6.02)
 */
export const ogreRamsArmorSelfLoss = (classId: string): number => {
  if (classId === 'SHVY') return 3;
  if (classId === 'HVY' || classId === 'MHWZ') return 2;
  return 1;
};

/**
 * "Any immobile armor unit (a Howitzer or any disabled unit) is destroyed if
 * rammed. Any armor unit except a Superheavy is disabled on a die roll of 1-3,
 * and destroyed on a die roll of 4-6." (6.02)
 */
export const ogreRamResult = (roll: number): DamageResult => (roll <= 3 ? 'D' : 'X');
