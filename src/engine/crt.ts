/**
 * Combat results tables (rulebook p. 6 and p. 16).
 *
 * Every table is transcribed verbatim as data so it can be read against the
 * printed rules, and every lookup is a pure function of (column, die roll).
 */

// ---------------------------------------------------------------------------
// Odds columns
// ---------------------------------------------------------------------------

export type OddsColumn = '1:4' | '1:2' | '1:1' | '2:1' | '3:1' | '4:1';

export const ODDS_COLUMNS: readonly OddsColumn[] = ['1:4', '1:2', '1:1', '2:1', '3:1', '4:1'];

const ODDS_VALUE: Readonly<Record<OddsColumn, number>> = {
  '1:4': 0.25,
  '1:2': 0.5,
  '1:1': 1,
  '2:1': 2,
  '3:1': 3,
  '4:1': 4,
};

/**
 * Reduce a raw attacker:defender strength ratio to a table column.
 *
 * "If rounding is necessary, it is always done in favor of the defender" — so we
 * take the *highest* column that does not exceed the true ratio. Attacks better
 * than 4:1 are treated as 4:1; attacks worse than 1:4 have no effect at all,
 * which we signal with `null`.
 */
export const oddsColumn = (attack: number, defence: number): OddsColumn | null => {
  if (attack <= 0) return null;
  if (defence <= 0) return '4:1';
  const ratio = attack / defence;
  if (ratio < ODDS_VALUE['1:4']) return null;

  let best: OddsColumn = '1:4';
  for (const col of ODDS_COLUMNS) {
    if (ODDS_VALUE[col] <= ratio + 1e-9) best = col;
  }
  return best;
};

// ---------------------------------------------------------------------------
// Damage results
// ---------------------------------------------------------------------------

/**
 * A damage result: `null` is no effect, a number is "disabled that many turns",
 * and `'E'` is elimination.
 */
export type DamageResult = number | 'E' | null;

const _ = null;

/** Gun combat damage table. Rows are die rolls 1-6, columns are odds. */
export const GUN_DAMAGE: Readonly<Record<OddsColumn, readonly DamageResult[]>> = {
  //        roll: 1   2   3   4   5   6
  '1:4': [_, _, _, _, _, 1],
  '1:2': [_, _, _, _, 2, 3],
  '1:1': [_, _, _, 2, 3, 4],
  '2:1': [_, _, 2, 3, 4, 5],
  '3:1': [_, 2, 3, 4, 5, 'E'],
  '4:1': [2, 3, 4, 5, 'E', 'E'],
};

export type OtherAttackKind = 'torpedo' | 'mine' | 'asteroid' | 'ram';

/** Torpedo / mine / asteroid / ram damage table. */
export const OTHER_DAMAGE: Readonly<Record<OtherAttackKind, readonly DamageResult[]>> = {
  //           roll: 1  2  3  4  5  6
  torpedo: [_, 1, 1, 1, 2, 3],
  mine: [_, _, _, _, 2, 2],
  asteroid: [_, _, _, _, 1, 2],
  ram: [_, _, 1, 1, 3, 5],
};

/**
 * Clamp a modified die roll to the table's range.
 *
 * "A die roll modified to less than 1 has no effect. A die roll modified to
 * more than 6 is 6."
 */
export const clampRoll = (roll: number): number | null => {
  if (roll < 1) return null;
  return roll > 6 ? 6 : roll;
};

export const gunDamage = (column: OddsColumn, modifiedRoll: number): DamageResult => {
  const roll = clampRoll(modifiedRoll);
  if (roll === null) return null;
  return GUN_DAMAGE[column][roll - 1] ?? null;
};

export const otherDamage = (kind: OtherAttackKind, modifiedRoll: number): DamageResult => {
  const roll = clampRoll(modifiedRoll);
  if (roll === null) return null;
  return OTHER_DAMAGE[kind][roll - 1] ?? null;
};

// ---------------------------------------------------------------------------
// Advanced combat system (rulebook p. 16)
// ---------------------------------------------------------------------------

/** Advanced system: number of hits scored, by odds column and die roll. */
export const GUN_TO_HIT: Readonly<Record<OddsColumn, readonly number[]>> = {
  //        roll: 1  2  3  4  5  6
  '1:4': [0, 0, 0, 0, 0, 1],
  '1:2': [0, 0, 0, 0, 1, 1],
  '1:1': [0, 0, 0, 1, 1, 2],
  '2:1': [0, 0, 1, 1, 2, 2],
  '3:1': [0, 1, 1, 2, 2, 3],
  '4:1': [1, 1, 2, 2, 3, 3],
};

/** Advanced system: number of hits scored by non-gun attacks. */
export const OTHER_TO_HIT: Readonly<Record<OtherAttackKind, readonly number[]>> = {
  //           roll: 1  2  3  4  5  6
  torpedo: [0, 1, 1, 1, 1, 3],
  mine: [0, 0, 0, 0, 1, 2],
  asteroid: [0, 0, 0, 0, 1, 2],
  ram: [0, 0, 1, 1, 2, 3],
};

export interface HitLocation {
  readonly weapon: number;
  readonly drive: number;
  readonly structure: number;
}

/**
 * Advanced system: where a single hit lands.
 *
 *   1 - 1 weapon D
 *   2 - 1 drive D
 *   3 - 1 structure D
 *   4 - 1 weapon D, 1 structure D
 *   5 - 1 weapon D, 1 drive D
 *   6 - 1 structure D, 1 drive D
 */
export const HIT_LOCATION: readonly HitLocation[] = [
  { weapon: 1, drive: 0, structure: 0 },
  { weapon: 0, drive: 1, structure: 0 },
  { weapon: 0, drive: 0, structure: 1 },
  { weapon: 1, drive: 0, structure: 1 },
  { weapon: 1, drive: 1, structure: 0 },
  { weapon: 0, drive: 1, structure: 1 },
];

export const hitLocation = (roll: number): HitLocation =>
  HIT_LOCATION[Math.max(0, Math.min(5, roll - 1))]!;

export const gunToHit = (column: OddsColumn, modifiedRoll: number): number => {
  const roll = clampRoll(modifiedRoll);
  if (roll === null) return 0;
  return GUN_TO_HIT[column][roll - 1] ?? 0;
};

export const otherToHit = (kind: OtherAttackKind, modifiedRoll: number): number => {
  const roll = clampRoll(modifiedRoll);
  if (roll === null) return 0;
  return OTHER_TO_HIT[kind][roll - 1] ?? 0;
};

// ---------------------------------------------------------------------------
// Die modifiers
// ---------------------------------------------------------------------------

/**
 * Range modifier: "Subtract 1 from the die roll for each hex of range
 * separating the attacker and the target."
 */
export const rangeModifier = (range: number): number => -range;

/**
 * Relative velocity modifier: "Subtract 1 from the combat die roll for each hex
 * of velocity difference greater than 2."
 */
export const velocityModifier = (relativeVelocity: number): number =>
  -Math.max(0, relativeVelocity - 2);

/**
 * A ship is destroyed once its accumulated disablement reaches D6 or more.
 * "if a ship which will be disabled for 3 more turns receives a D3 result, it
 * is destroyed."
 */
export const DESTRUCTION_THRESHOLD = 6;
