/**
 * The unit roster: every counter's printed statistics.
 *
 * ## Where these numbers come from, and which ones to check
 *
 * The Sixth Edition rulebook prints most unit statistics on the counters
 * themselves rather than in a table, so the rules *text* only pins some of them
 * down. Every value below is one of three things, and each entry's `note` says
 * which:
 *
 * - **Stated** in the rules text — "It has Attack 2, Range 8, Defense 1, and
 *   Movement 0" (14.01).
 * - **Forced** by a worked example. The Missile Tank's attack strength has to
 *   be 3, because 7.13.1 has one firing "on ... an AP gun at 3-1, or a main
 *   battery at 1-2", and no other value satisfies both.
 * - **Transcribed** from a published unit summary — for the armour units, the
 *   Ogre Miniatures conversion chart, whose distances are in inches at 2" to
 *   the hex. Every value it gives agrees with every worked example in the
 *   rules, which is the check that makes it trustworthy.
 *
 * A handful of units appear in none of the three and are still flagged
 * `unconfirmed`; they are collected in `docs/RULES-MAPPING.md`.
 *
 * This is the only file that needs editing to correct a statistic. Nothing else
 * in the engine hard-codes a unit's numbers.
 */

import type { Mobility } from './terrain.js';

export type UnitClassId =
  // Armour
  | 'HVY'
  | 'MSL'
  | 'LT'
  | 'SHVY'
  | 'HWZ'
  | 'MHWZ'
  | 'LAD'
  | 'GEV'
  | 'LGEV'
  | 'GEVPC'
  | 'MCRL'
  | 'CRL'
  // Structures and transport
  | 'CP'
  | 'MCP'
  | 'TK'
  | 'HT'
  // Infantry
  | 'INF'
  | 'MAR'
  | 'HWT'
  | 'CE';

export type StatName = 'attack' | 'range' | 'defense' | 'move' | 'secondMove' | 'size' | 'vp';

export interface UnitClass {
  readonly id: UnitClassId;
  readonly name: string;
  /** The abbreviation the rulebook uses, e.g. "HVY". Drawn on the counter. */
  readonly abbr: string;
  readonly kind: 'armor' | 'infantry' | 'transport' | 'structure';
  readonly mobility: Mobility;

  /** Attack strength. For infantry this is *per squad* — "Each squad is 1 attack strength point" (3.02). */
  readonly attack: number;
  /** "the maximum number of hexes at which that unit may attack" (7.02). */
  readonly range: number;
  /** Defence strength. For infantry this is per squad, so a 3-squad counter is D3 (3.02). */
  readonly defense: number;
  /** Movement points in the movement phase (5.01). */
  readonly move: number;
  /** "GEV units have two numbers separated by a dash ... they may move twice per turn" (3.01, 5.05). */
  readonly secondMove?: number;

  /** The `*` on the counter: "may divide that strength into two equal attacks" (7.02). */
  readonly splitAttack?: boolean;
  /**
   * Antipersonnel weapons. Only the Superheavy has them among non-Ogres, and
   * they "function exactly like Ogre AP weapons" (3.01) — including doubling
   * in an overrun and reducing infantry by a squad on entry (6.06).
   */
  readonly ap?: number;

  /** Size Table, p. 14: drives ram damage, water entry, and train capacity. */
  readonly size: number;
  /** Scenario cost in armour units (1.07). Light Tanks and LGEVs are 0.5. */
  readonly armorUnits: number;
  /** Victory points for destroying one (1.08). Infantry is per squad. */
  readonly vp: number;
  /** Infantry squads this unit can carry (5.11.1). */
  readonly carries?: number;

  /** Where the cited numbers come from. */
  readonly note: string;
  /** Statistics not derivable from the rules text — confirm against the counter. */
  readonly unconfirmed?: readonly StatName[];
}

/**
 * The roster.
 *
 * Ordering is the rulebook's: armour, then transport and structures, then
 * infantry.
 */
export const UNIT_CLASSES: Readonly<Record<UnitClassId, UnitClass>> = {
  HVY: {
    id: 'HVY',
    name: 'Heavy Tank',
    abbr: 'HVY',
    kind: 'armor',
    mobility: 'heavyTracked',
    attack: 4,
    range: 2,
    defense: 3,
    move: 3,
    size: 3,
    armorUnits: 1,
    vp: 6,
    carries: 1,
    note: '4/2 is the rulebook’s own counter example (7.02); D3 from the spillover example (7.12); M3 from the unit summary (6" at 2" to the hex); heavy tracked per 5.08.3; Size 3 and 2-tread ram damage from the Size Table.',
  },

  MSL: {
    id: 'MSL',
    name: 'Missile Tank',
    abbr: 'MSL',
    kind: 'armor',
    mobility: 'lightTracked',
    attack: 3,
    range: 4,
    defense: 2,
    move: 2,
    size: 2,
    armorUnits: 1,
    vp: 6,
    note: 'Attack 3 is forced by 7.13.1 — a Missile Tank hits an AP gun (D1) at 3-1 and a main battery (D4) at 1-2, which only strength 3 satisfies. D2 from the spillover example (7.12). Range 4 and M2 from the unit summary (8" and 4" at 2" to the hex). Light tracked per 5.08.4.',
  },

  LT: {
    id: 'LT',
    name: 'Light Tank',
    abbr: 'LT',
    kind: 'armor',
    mobility: 'lightTracked',
    attack: 2,
    range: 2,
    defense: 2,
    move: 3,
    size: 1,
    armorUnits: 0.5,
    vp: 3,
    carries: 1,
    note: '2/2 D2 M3 from the unit summary. Half an armour unit (1.07), Size 1 and 1-tread ram (Size Table), light tracked (5.08.4), carries one squad (5.11.1).',
  },

  SHVY: {
    id: 'SHVY',
    name: 'Superheavy Tank',
    abbr: 'SHVY',
    kind: 'armor',
    // "It is affected by terrain as though it were an Ogre!" (3.01)
    mobility: 'ogre',
    attack: 6,
    range: 3,
    defense: 5,
    move: 3,
    splitAttack: true,
    ap: 2,
    size: 5,
    armorUnits: 2,
    vp: 12,
    carries: 2,
    note: '6*/3 and the split attack are quoted in 7.02 and 3.01; two AP at 1/1 and Move 3 from the Superheavy record sheet printed with optional rule 13.07; D5 from the unit summary, and consistent with 5.11.2 (a Howitzer’s 6 is "1-to-1" against it); Size 5 from the Size Table; two armour units per 1.07.',
  },

  HWZ: {
    id: 'HWZ',
    name: 'Howitzer',
    abbr: 'HWZ',
    kind: 'armor',
    mobility: 'immobile',
    attack: 6,
    range: 8,
    defense: 1,
    move: 0,
    size: 4,
    armorUnits: 2,
    vp: 12,
    note: 'Attack 6 is stated in the spillover example (7.12) and consistent with 7.13.1 (a Howitzer attacks an Ogre secondary, D3, at 2-1). Range 8 and D1 from the unit summary (16" at 2" to the hex) — a glass cannon that works by outranging everything an Ogre carries. Immobile — "a Howitzer or any disabled unit" is the rulebook’s definition of an immobile armour unit (6.02). Two armour units per 1.07.',
  },

  MHWZ: {
    id: 'MHWZ',
    name: 'Mobile Howitzer',
    abbr: 'MHWZ',
    kind: 'armor',
    mobility: 'heavyTracked',
    attack: 6,
    range: 6,
    defense: 1,
    move: 1,
    size: 4,
    armorUnits: 2,
    vp: 12,
    note: 'Move 1 is quoted in 5.09 ("a Mobile Howitzer (movement of 1)"); attack 6, range 6 and D1 from the unit summary (12" at 2" to the hex); heavy tracked per 5.08.3; Size 4 and 2-tread ram damage from 6.02 and the Size Table; two armour units per 1.07.',
  },

  LAD: {
    id: 'LAD',
    name: 'Light Artillery Drone',
    abbr: 'LAD',
    kind: 'armor',
    mobility: 'immobile',
    attack: 2,
    range: 8,
    defense: 1,
    move: 0,
    size: 1,
    armorUnits: 1,
    vp: 6,
    note: 'Fully stated: "It has Attack 2, Range 8, Defense 1, and Movement 0. It is considered a Size 1 unit when set up." (14.01)',
    unconfirmed: ['vp'],
  },

  GEV: {
    id: 'GEV',
    name: 'GEV',
    abbr: 'GEV',
    kind: 'armor',
    mobility: 'gev',
    attack: 2,
    range: 2,
    defense: 2,
    move: 4,
    secondMove: 3,
    size: 2,
    armorUnits: 1,
    vp: 6,
    note: 'Movement 4-3 is quoted in 5.05 and confirmed by the nine-hex road figure in 5.08.2. Attack 2 and D2 both fall out of the Example of Play (an Ogre main battery attacks a GEV at 2-1, a GEV attacks a main battery at 1-2, two secondaries make 3-1). Range 2 from the unit summary.',
  },

  LGEV: {
    id: 'LGEV',
    name: 'Light GEV',
    abbr: 'LGEV',
    kind: 'armor',
    mobility: 'gev',
    attack: 1,
    range: 2,
    defense: 1,
    move: 4,
    secondMove: 3,
    size: 1,
    armorUnits: 0.5,
    vp: 3,
    note: 'D1 is forced by the Example of Play — an Ogre main battery (attack 4) fires on an LGEV "at 4-to-1". 1/2 and M4-3 from the unit summary. Half an armour unit (1.07); Size 1 (Size Table); GEV movement and terrain rules (3.01).',
  },

  GEVPC: {
    id: 'GEVPC',
    name: 'GEV-PC',
    abbr: 'GEV-PC',
    kind: 'armor',
    mobility: 'gev',
    attack: 1,
    range: 2,
    defense: 2,
    move: 3,
    secondMove: 2,
    size: 3,
    armorUnits: 1,
    vp: 6,
    carries: 3,
    note: 'Attack 1 is forced by the ram example in 6.07.3 ("1 for the GEV-PC, which is then doubled by the ram to 2, plus 2 for the infantry"). Range 2, D2 and M3-2 from the unit summary. Carries three squads (3.01, 5.11.1); Size 3 (Size Table).',
  },

  MCRL: {
    id: 'MCRL',
    name: 'Missile Crawler',
    abbr: 'MCRL',
    kind: 'armor',
    // "It is affected by terrain as though it were a Heavy Tank." (3.01)
    mobility: 'heavyTracked',
    attack: 0,
    range: 0,
    defense: 2,
    move: 2,
    size: 4,
    armorUnits: 3,
    // 6 for the crawler plus 12 for the missile it still carries (1.08).
    vp: 18,
    note: 'No attack strength of its own — "it attacks by firing the missile" (3.01). Three armour units, "two for the Missile and one for the Crawler" (1.07). Size 4 (Size Table).',
    unconfirmed: ['defense', 'move'],
  },

  CRL: {
    id: 'CRL',
    name: 'Crawler',
    abbr: 'CRL',
    kind: 'armor',
    mobility: 'heavyTracked',
    attack: 0,
    range: 0,
    defense: 2,
    move: 2,
    size: 4,
    armorUnits: 0,
    vp: 6,
    note: 'A Missile Crawler that has fired: "can do no further damage, but is worth victory points to the enemy if destroyed" (3.01). Cannot be chosen at setup.',
    unconfirmed: ['defense', 'move'],
  },

  CP: {
    id: 'CP',
    name: 'Command Post',
    abbr: 'CP',
    kind: 'structure',
    mobility: 'immobile',
    attack: 0,
    range: 0,
    defense: 0,
    move: 0,
    size: 1,
    armorUnits: 0,
    vp: 0,
    note: 'Fully stated: "A basic CP has a defense of 0, and will be destroyed by any attack. (In a town hex, count a standard CP’s defense as 1.) CPs have no attack strength except when overrun; then they have a strength of 1." (3.05)',
    unconfirmed: ['size'],
  },

  MCP: {
    id: 'MCP',
    name: 'Mobile CP',
    abbr: 'MCP',
    kind: 'structure',
    mobility: 'lightTracked',
    attack: 0,
    range: 0,
    defense: 0,
    move: 1,
    size: 4,
    armorUnits: 1,
    vp: 6,
    note: 'Stated: "A tracked ‘command crawler’ with a movement of M1 ... It may be D0 or greater" (3.05.1); light tracked per 5.08.4; Size 4 (Size Table).',
  },

  TK: {
    id: 'TK',
    name: 'Truck',
    abbr: 'TK',
    kind: 'transport',
    mobility: 'wheeled',
    attack: 0,
    range: 0,
    defense: 0,
    move: 4,
    size: 1,
    armorUnits: 0,
    vp: 6,
    carries: 2,
    note: 'Stated: "It has no attack strength, and a defense strength of 0 – if attacked, it is automatically destroyed. In a town hex, and/or undergoing a spillover attack, it has a defense strength of 1. It can carry two squads of infantry." (3.03). Wheeled terrain costs are in 5.08.5.',
    unconfirmed: ['move', 'vp'],
  },

  HT: {
    id: 'HT',
    name: 'Hovertruck',
    abbr: 'HT',
    kind: 'transport',
    mobility: 'gev',
    attack: 0,
    range: 0,
    defense: 0,
    move: 4,
    secondMove: 3,
    size: 1,
    armorUnits: 0,
    vp: 2,
    carries: 2,
    note: '"A cargo-carrying hovercraft. It uses GEV movement and terrain rules. It can carry two squads of infantry." (3.03). 2 VP from 14.03. Size 1 (Size Table).',
    unconfirmed: ['move', 'secondMove', 'defense'],
  },

  INF: {
    id: 'INF',
    name: 'Infantry',
    abbr: 'INF',
    kind: 'infantry',
    mobility: 'infantry',
    attack: 1,
    range: 1,
    defense: 1,
    move: 2,
    size: 1,
    armorUnits: 1 / 3,
    vp: 2,
    note: 'Fully stated: "Each squad is 1 attack strength point, so a 3/1 infantry counter represents three squads" and "the defense strength of each infantry counter is equal to the number of squads" (3.02); "Infantry normally have M2" (5.08.1); 2 VP per squad (1.08); "A 3-squad counter is the equivalent of one armor unit" (3.02).',
  },

  MAR: {
    id: 'MAR',
    name: 'Marine Battlesuits',
    abbr: 'MAR',
    kind: 'infantry',
    mobility: 'infantry',
    attack: 1,
    range: 1,
    defense: 1,
    move: 2,
    size: 1,
    armorUnits: 1 / 3,
    vp: 4,
    note: '"treated for all purposes like regular infantry, except that they move and attack equally well on land and water, and have double defense in water hexes" (3.02.1); specialist infantry count double for cost and VP (1.07, 1.08).',
  },

  HWT: {
    id: 'HWT',
    name: 'Heavy Weapons Team',
    abbr: 'HWT',
    kind: 'infantry',
    mobility: 'infantry',
    attack: 1,
    range: 1,
    defense: 1,
    move: 2,
    size: 1,
    armorUnits: 1 / 3,
    vp: 4,
    note: 'Fully stated: a one-shot "heavy weapon attack at Attack Strength 3 and Range 4", plus "an inherent Attack 1 at Range 1"; 4 VP per squad (3.02.2).',
  },

  CE: {
    id: 'CE',
    name: 'Combat Engineers',
    abbr: 'CE',
    kind: 'infantry',
    mobility: 'infantry',
    attack: 1,
    range: 1,
    defense: 1,
    move: 2,
    size: 1,
    armorUnits: 1 / 3,
    vp: 4,
    note: 'Specialist infantry: "worth double victory points (i.e., 4 VP per squad)" and traded for regular infantry 2-for-1 (15.01).',
  },
};

/** The Heavy Weapons Team's one-shot missile (3.02.2). */
export const HEAVY_WEAPON = { attack: 3, range: 4 } as const;

export const unitClass = (id: UnitClassId): UnitClass => UNIT_CLASSES[id];

export const isInfantryClass = (id: UnitClassId): boolean => UNIT_CLASSES[id].kind === 'infantry';

/**
 * The largest group infantry may form for defence.
 *
 * "All types of infantry can combine in groups of up to three squads for
 * defensive purposes. Any two squads can defend together at D2, and any three
 * squads can defend at D3." (3.02)
 */
export const MAX_SQUADS_PER_GROUP = 3;

/**
 * Every class a scenario may hand a player, in the order the rulebook lists
 * them. `CRL` is absent deliberately: "Crawlers cannot be chosen in the initial
 * setup" (3.01).
 */
export const SELECTABLE_CLASSES: readonly UnitClassId[] = [
  'HVY',
  'MSL',
  'LT',
  'SHVY',
  'HWZ',
  'MHWZ',
  'GEV',
  'LGEV',
  'GEVPC',
  'LAD',
  'MCRL',
  'TK',
  'HT',
];

/**
 * The four armour types of the original game.
 *
 * "While learning, things will move faster if the defense uses only infantry
 * and the four types of armor units in the original game: Heavy Tank, Missile
 * Tank, GEV, and (at double cost) Howitzer." (1.05)
 */
export const ORIGINAL_CLASSES: readonly UnitClassId[] = ['HVY', 'MSL', 'GEV', 'HWZ'];
