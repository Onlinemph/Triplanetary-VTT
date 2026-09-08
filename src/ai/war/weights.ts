/**
 * The general staff's temperament, as numbers.
 *
 * The computer's war in Orbital Drop is decided above the pilot: which base
 * to take, how much to spend on the force that takes it, what to keep at home,
 * when the wave is complete enough to declare, and whether a worn cybertank is
 * worth the shop. Each of those is a weighted sum of readings of the board,
 * and every weight is here — `staff.ts` carries no number of its own, which
 * is what lets `scripts/tune-war.ts` search the table by playing the war
 * against itself.
 *
 * The fleet's flying — routes, fuel, fights, prizes — is the pilot's
 * (`src/ai/index.ts`) and is not tuned here. The staff hands the pilot
 * errands; the pilot flies them.
 */

interface Spec {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly about: string;
}

const spec = (value: number, min: number, max: number, about: string): Spec => ({
  value,
  min,
  max,
  about,
});

export const WAR_WEIGHT_SPEC = {
  // --- Choosing a target ------------------------------------------------------
  'target.planetary': spec(120, 20, 300, 'Worth of a planetary base as a target'),
  'target.asteroid': spec(60, 10, 200, 'Worth of an asteroid base as a target'),
  'target.neutral': spec(1.1, 0.5, 2, 'Multiplier for a base nobody owns: militia and no more'),
  'target.distance': spec(2, 0, 10, 'Against each hex between the wave and the target'),
  'target.range': spec(
    12,
    0,
    40,
    'Against each hex of the trip beyond what a transport’s tanks can fly',
  ),
  'target.guns': spec(15, 0, 80, 'Against a base whose planetary guns are still live'),
  'target.enemyStrength': spec(
    3,
    0,
    15,
    'Against each point of enemy strength within reach of the target',
  ),
  'target.nearest': spec(120, 0, 300, 'For the world a wave in flight is nearest to'),
  'target.committed': spec(
    80,
    0,
    200,
    'For the base an invasion has already been declared against',
  ),
  'target.min': spec(0, -100, 150, 'Score below which no invasion is mounted'),

  // --- The landing force ------------------------------------------------------
  'force.garrisonPrior': spec(
    25,
    0,
    80,
    'MCr of garrison an enemy base is assumed to hold beyond its militia',
  ),
  'force.overmatch': spec(
    1.6,
    0.8,
    3,
    'Landing worth wanted, as a multiple of the defence expected',
  ),
  'force.reserve': spec(40, 0, 200, 'MCr the treasury keeps back from any landing purchase'),
  'force.infantry': spec(1, 0, 3, 'Appetite for infantry squads in a landing'),
  'force.heavy': spec(1, 0, 3, 'Appetite for heavy tanks in a landing'),
  'force.missile': spec(0.8, 0, 3, 'Appetite for missile tanks in a landing'),
  'force.gev': spec(0.5, 0, 3, 'Appetite for GEVs in a landing'),
  'force.howitzer': spec(0.3, 0, 3, 'Appetite for howitzers in a landing'),
  'force.ogre': spec(
    0.4,
    0,
    3,
    'Appetite for shipping a Mark III in modules, when the hulls allow',
  ),

  // --- Mounting the assault ------------------------------------------------------
  'assault.commit': spec(
    0.75,
    0.3,
    1,
    'Share of the wave’s worth that must be in orbit before declaring',
  ),
  'assault.escort': spec(
    2,
    0,
    10,
    'Warship strength wanted overhead before declaring against live guns',
  ),

  // --- Garrisons ----------------------------------------------------------------
  'garrison.share': spec(0.3, 0, 0.8, 'Share of military worth the staff will hold in garrisons'),
  'garrison.planetary': spec(
    30,
    0,
    120,
    'MCr of garrison a planetary base wants when nothing threatens it',
  ),
  'garrison.asteroid': spec(
    12,
    0,
    80,
    'MCr of garrison an asteroid base wants when nothing threatens it',
  ),
  'garrison.threat': spec(4, 0, 15, 'MCr more per point of enemy strength seen near the base'),
  'garrison.transports': spec(20, 0, 60, 'MCr more per enemy transport seen near the base'),
  'garrison.reaction': spec(
    0.3,
    0,
    0.5,
    'Share of a garrison held off the map as the reaction force',
  ),
  'garrison.infantry': spec(1, 0, 3, 'Appetite for infantry in a garrison'),
  'garrison.armour': spec(1, 0, 3, 'Appetite for armour in a garrison'),
  'garrison.ogre': spec(0.5, 0, 3, 'Appetite for a garrison cybertank'),

  // --- The fleet ------------------------------------------------------------------
  'fleet.transports': spec(3, 1, 6, 'Transports wanted before the yard is asked for another'),
  'fleet.escortStrength': spec(
    10,
    0,
    30,
    'Warship strength wanted before the yard is asked for another',
  ),
  'fleet.reserve': spec(120, 0, 400, 'MCr the treasury keeps back before commissioning a hull'),

  // --- Repairs -------------------------------------------------------------------
  'repair.reserve': spec(
    30,
    0,
    150,
    'MCr the treasury keeps back before a cybertank goes to the shop',
  ),
} as const;

export type WarWeightKey = keyof typeof WAR_WEIGHT_SPEC;
export type WarWeights = Readonly<Record<WarWeightKey, number>>;

export const WAR_WEIGHT_KEYS = Object.keys(WAR_WEIGHT_SPEC) as WarWeightKey[];

/** The hand-set starting point, before any tuning. */
export const BASE_WAR_WEIGHTS: WarWeights = Object.fromEntries(
  WAR_WEIGHT_KEYS.map((k) => [k, WAR_WEIGHT_SPEC[k].value]),
) as Record<WarWeightKey, number>;

/** A full table from a partial one, the rest filled from `base`. */
export const withWarWeights = (
  partial: Partial<WarWeights>,
  base: WarWeights = BASE_WAR_WEIGHTS,
): WarWeights => ({ ...base, ...partial }) as WarWeights;

/** The table as a vector in `WAR_WEIGHT_KEYS` order, for the tuner. */
export const warToVector = (w: WarWeights): number[] => WAR_WEIGHT_KEYS.map((k) => w[k]);

export const warFromVector = (v: readonly number[]): WarWeights =>
  Object.fromEntries(
    WAR_WEIGHT_KEYS.map((k, i) => [k, v[i] ?? WAR_WEIGHT_SPEC[k].value]),
  ) as Record<WarWeightKey, number>;

/** Clamp a table into the ranges the spec allows. */
export const clampWarWeights = (w: WarWeights): WarWeights =>
  Object.fromEntries(
    WAR_WEIGHT_KEYS.map((k) => [
      k,
      Math.min(WAR_WEIGHT_SPEC[k].max, Math.max(WAR_WEIGHT_SPEC[k].min, w[k])),
    ]),
  ) as Record<WarWeightKey, number>;

// The shipped defaults: the hand-set table with the tuner's findings laid over.
import { WAR_TUNED } from './tuned.js';

export const DEFAULT_WAR_WEIGHTS: WarWeights = withWarWeights(WAR_TUNED, BASE_WAR_WEIGHTS);
