/**
 * The Combat Results Table, and the odds ladder that feeds it.
 *
 * This is a transcription of the printed table (Section 7 of the Sixth Edition
 * rules) and the three sentences beneath it. Everything about how an Ogre
 * fight feels comes out of this file, so it is deliberately dumb: no game
 * state, no dice, just arithmetic and a lookup.
 */

/** "Three possible outcomes are shown on the Combat Results Table" (7.11). */
export type DamageResult = 'NE' | 'D' | 'X';

/** The five printed columns. */
export type OddsColumn = '1-2' | '1-1' | '2-1' | '3-1' | '4-1';

export const ODDS_COLUMNS: readonly OddsColumn[] = ['1-2', '1-1', '2-1', '3-1', '4-1'];

/**
 * The table itself, indexed `[column][die - 1]`.
 *
 *     Roll   1-2  1-1  2-1  3-1  4-1
 *       1    NE   NE   NE   D    D
 *       2    NE   NE   D    D    X
 *       3    NE   D    D    X    X
 *       4    NE   D    X    X    X
 *       5    D    X    X    X    X
 *       6    X    X    X    X    X
 */
export const CRT: Readonly<Record<OddsColumn, readonly DamageResult[]>> = {
  '1-2': ['NE', 'NE', 'NE', 'NE', 'D', 'X'],
  '1-1': ['NE', 'NE', 'D', 'D', 'X', 'X'],
  '2-1': ['NE', 'D', 'D', 'X', 'X', 'X'],
  '3-1': ['D', 'D', 'X', 'X', 'X', 'X'],
  '4-1': ['D', 'X', 'X', 'X', 'X', 'X'],
};

/**
 * What the odds ladder produced for a given attack.
 *
 * `none` and `auto` are not columns and never involve a die:
 *
 * > "Combat odds are always rounded off in favor of the defender. Attacks at
 * > less than 1 to 2 are always NE. Attacks at 5 to 1 or better are an
 * > automatic X."
 */
export type Odds =
  | { readonly kind: 'none' }
  | { readonly kind: 'auto' }
  | { readonly kind: 'column'; readonly column: OddsColumn };

export const NO_ATTACK: Odds = { kind: 'none' };
export const AUTO_KILL: Odds = { kind: 'auto' };

/**
 * Reduce a raw attack:defense ratio to the printed ladder, in the defender's
 * favour (7.10).
 *
 * Fractions are real here and must not be rounded away: spillover fire is "half
 * the strength (not rounded)" (7.12), and a disabled unit firing in an overrun
 * uses "half its printed attack strength (not rounded)" (8.02). So an attack
 * strength of 1.5 against defence 3 is a genuine 1-2, and 1.5 against 2 is
 * below 1-2 and therefore nothing at all.
 *
 * A defence strength of 0 is not a division by zero, it is a rule: "A basic CP
 * has a defense of 0, and will be destroyed by any attack" (3.05). Any attack
 * strength above zero is an automatic X.
 */
export const oddsFor = (attack: number, defense: number): Odds => {
  if (!(attack > 0)) return NO_ATTACK;
  if (defense <= 0) return AUTO_KILL;

  const ratio = attack / defense;
  if (ratio >= 5) return AUTO_KILL;
  if (ratio >= 4) return { kind: 'column', column: '4-1' };
  if (ratio >= 3) return { kind: 'column', column: '3-1' };
  if (ratio >= 2) return { kind: 'column', column: '2-1' };
  if (ratio >= 1) return { kind: 'column', column: '1-1' };
  if (ratio >= 0.5) return { kind: 'column', column: '1-2' };
  return NO_ATTACK;
};

/** Human-readable odds, as a player would announce them (7.08). */
export const describeOdds = (odds: Odds): string => {
  switch (odds.kind) {
    case 'none':
      return 'no effect';
    case 'auto':
      return '5 to 1 or better';
    case 'column':
      return odds.column.replace('-', ' to ');
  }
};

/**
 * How an attack's results are read off the table.
 *
 * - `normal`   — a plain attack in the fire phase.
 * - `spillover` — "each result on the CRT is taken down one step. A D result is
 *   read as NE, and an X is read as a D" (7.11.1).
 * - `overrun`  — "treat any D or X result to non-Ogre units as an X. Only a
 *   true X affects an Ogre" (7.11.2). The Ogre half of that sentence is
 *   handled by {@link applyToTarget}, not here.
 */
export type ResolutionMode = 'normal' | 'spillover' | 'overrun';

const DOWN: Readonly<Record<DamageResult, DamageResult>> = { NE: 'NE', D: 'NE', X: 'D' };
const UP: Readonly<Record<DamageResult, DamageResult>> = { NE: 'NE', D: 'X', X: 'X' };

/** Read the table. `roll` is a d6; it is ignored for `none`/`auto` odds. */
export const resolve = (
  odds: Odds,
  roll: number,
  mode: ResolutionMode = 'normal',
): DamageResult => {
  const raw: DamageResult =
    odds.kind === 'none' ? 'NE' : odds.kind === 'auto' ? 'X' : CRT[odds.column][roll - 1]!;

  switch (mode) {
    case 'normal':
      return raw;
    case 'spillover':
      return DOWN[raw];
    case 'overrun':
      return UP[raw];
  }
};

/**
 * Filter a result through what the *target* is able to suffer.
 *
 * Two units in the game shrug off the intermediate result entirely: "A D result
 * does not affect the train or Ogres" (7.11). Ogre weapons and tread units are
 * parts of an Ogre and inherit that, which is why stripping a cybertank takes
 * so many attacks — half the table does nothing at all.
 */
export const applyToTarget = (result: DamageResult, immuneToD: boolean): DamageResult =>
  immuneToD && result === 'D' ? 'NE' : result;

/**
 * The chance, in sixths, that an attack at these odds produces at least the
 * given result. Used by the interface to show a player what a shot is worth
 * before committing to it; the rules never ask for this.
 */
export const oddsChance = (
  odds: Odds,
  mode: ResolutionMode = 'normal',
): { ne: number; d: number; x: number } => {
  if (odds.kind === 'none') return { ne: 6, d: 0, x: 0 };
  if (odds.kind === 'auto') return { ne: 0, d: 0, x: 6 };
  let ne = 0;
  let d = 0;
  let x = 0;
  for (let roll = 1; roll <= 6; roll++) {
    const res = resolve(odds, roll, mode);
    if (res === 'NE') ne++;
    else if (res === 'D') d++;
    else x++;
  }
  return { ne, d, x };
};
