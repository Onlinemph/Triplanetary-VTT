/**
 * The computer opponent's personality, as numbers.
 *
 * Every judgement the AI makes — where a counter ends its move, what is worth
 * a shot, when a cybertank rams, where a reserve comes on, what a cruise
 * missile is aimed at — is a sum of features, each multiplied by one of the
 * weights below. Nothing in `player.ts` carries a magic number of its own:
 * the table here is the whole of its taste, and the tuning harness in
 * `scripts/tune-ai.ts` searches it by playing thousands of games.
 *
 * Movement weights come in six flavours, one per role, because combined arms
 * is exactly the observation that a howitzer, a GEV and a cybertank want
 * different things from the same hex.
 */

import { isOgre, type Unit } from '../engine/types.js';
import { unitClass } from '../engine/units.js';

/** What a counter is *for*, tactically. */
export type Role = 'ogre' | 'armour' | 'gev' | 'infantry' | 'artillery' | 'support';

export const ROLES: readonly Role[] = ['ogre', 'armour', 'gev', 'infantry', 'artillery', 'support'];

export const roleOf = (u: Unit): Role => {
  if (isOgre(u)) return 'ogre';
  const cls = unitClass(u.classId);
  if (cls.kind === 'infantry') return 'infantry';
  if (cls.mobility === 'gev') return 'gev';
  if (cls.laser || cls.id === 'HWZ' || cls.id === 'MHWZ' || cls.id === 'LAD') return 'artillery';
  if (cls.kind === 'armor' && cls.attack > 0) return 'armour';
  return 'support';
};

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

const perRole = <P extends string>(
  prefix: P,
  value: number | Readonly<Record<Role, number>>,
  min: number,
  max: number,
  about: string,
): Record<`${P}.${Role}`, Spec> => {
  const out: Record<string, Spec> = {};
  for (const r of ROLES) {
    const v = typeof value === 'number' ? value : value[r];
    out[`${prefix}.${r}`] = spec(v, min, max, `${about} (${r})`);
  }
  return out as Record<`${P}.${Role}`, Spec>;
};

/**
 * Every weight, its shipped default, the range the tuner may search, and a
 * line on what it does. The defaults are the tuned values from
 * `tuned.ts` where one exists, otherwise the hand-set starting point.
 */
export const WEIGHT_SPEC = {
  // --- Movement: the end-of-move score of a hex ---------------------------
  'move.goalAttacker': spec(10, 2, 30, 'Per hex of ground toward the objective, attacking'),
  'move.goalDefender': spec(4, 0, 20, 'Per hex of ground toward the nearest enemy, defending'),
  'move.edge': spec(12, 2, 30, 'Per hex toward the exit edge, when leaving is the goal'),
  'move.inReachCap': spec(80, 20, 200, 'Cap on the worth of targets a hex puts in reach'),
  'move.hazardStuck': spec(40, 0, 100, 'Against a hex that may bog the unit down'),
  'move.hazardDisable': spec(12, 0, 60, 'Against a hex that may disable the unit'),
  'move.ogreWater': spec(30, 0, 100, 'Against a cybertank ending in water'),
  'move.crowd': spec(3, 0, 15, 'Against sharing a hex with a friend'),
  'move.ogreDefense': spec(
    12,
    4,
    30,
    'What a cybertank counts as its defence when weighing threat',
  ),
  'move.threatAttacker': spec(1.5, 0, 6, 'Enemy fire reaching the hex next phase, attacking'),
  'move.mobileThreat': spec(
    0.5,
    0,
    1,
    'How much of a gun that must move first to reach the hex counts',
  ),
  'move.missileThreat': spec(
    1,
    0,
    1,
    'How much of a cybertank’s one-shot missiles count as threat',
  ),
  'move.threatDefender': spec(4, 0, 10, 'Enemy fire reaching the hex next phase, defending'),
  ...perRole('move.goal', 1, 0, 3, 'Appetite for progress toward the goal'),
  ...perRole('move.threat', 1, 0, 3, 'Fear of enemy fire, per point per point of own defence'),
  ...perRole('move.inReach', 0.25, 0, 1, 'Per point of target worth the hex puts in range'),
  ...perRole('move.kill', 0.3, 0, 2, 'Per point of expected kill value from the hex this turn'),
  ...perRole('move.cover', 6, 0, 20, 'Per point of terrain defence multiplier above one'),
  ...perRole(
    'move.standoff',
    { ogre: 0, armour: 6, gev: 3, infantry: 0, artillery: 6, support: 3 },
    0,
    15,
    'Against ending closer to the enemy than own range allows',
  ),
  ...perRole(
    'move.screen',
    0,
    0,
    10,
    'Against standing off the line between the enemy and what we guard',
  ),
  ...perRole('move.block', 0, 0, 20, 'For standing on the enemy cybertank’s shortest road'),

  // --- The second (GEV) movement phase -----------------------------------
  'second.threat': spec(
    1,
    0,
    4,
    'Per point of expected loss where the GEV ends: odds of being killed, times own worth',
  ),
  'second.cost': spec(0.1, 0, 1, 'Per movement point spent getting away'),
  'second.kill': spec(
    0.3,
    0,
    2,
    'Per point of expected kill value from where the GEV ends, next turn',
  ),
  'second.cover': spec(0, 0, 10, 'Per point of cover where the GEV ends'),

  // --- Ramming and overrunning --------------------------------------------
  'ram.cp': spec(1000, 200, 2000, 'Worth of running over a command post'),
  'ram.ogre': spec(10, 0, 60, 'Worth of ramming another cybertank'),
  'ram.ogreOverrun': spec(20, 0, 80, 'Worth of overrunning a hex with a cybertank in it'),
  'ram.infantryOverrun': spec(6, 0, 40, 'Worth of overrunning infantry, per counter'),
  'ram.armour': spec(2, 0, 6, 'Worth of ramming armour, per victory point'),
  'ram.treadReserve': spec(0.3, 0, 0.6, 'Fraction of treads below which armour is not rammed'),
  'ram.toward': spec(4, 0, 20, 'For a ram that carries the cybertank toward its goal'),
  'ram.boxed': spec(30, 0, 80, 'For a ram that opens the only road'),
  'ram.away': spec(6, 0, 20, 'Per hex a ram takes the cybertank away from its goal'),
  'ram.min': spec(8, 0, 30, 'Worth below which nothing is rammed'),

  // --- Fire: what a target is worth and what a shot costs -----------------
  'fire.worthAttack': spec(3, 0, 10, 'Target worth per point of its attack strength'),
  'fire.worthLaser': spec(30, 0, 100, 'Extra worth of a laser'),
  'fire.worthCp': spec(400, 100, 1000, 'Worth of a command post'),
  'fire.ogreMain': spec(8, 0, 30, 'Worth of a main battery'),
  'fire.ogreSecondary': spec(4, 0, 30, 'Worth of a secondary battery'),
  'fire.ogreMissile': spec(1, 0, 30, 'Worth of an external missile still mounted'),
  'fire.ogreRack': spec(4, 0, 30, 'Worth of a missile rack'),
  'fire.ogreAp': spec(1, 0, 10, 'Worth of an antipersonnel gun'),
  'fire.ogreArm': spec(1, 0, 10, 'Worth of a manipulator arm'),
  'fire.ogreWeaponAttack': spec(4, 0, 12, 'Ogre weapon worth per point of its attack strength'),
  'fire.ogreMissileFired': spec(20, 0, 40, 'Less worth for a missile already fired'),
  'fire.tread': spec(1.6, 0, 6, 'Per tread unit expected to be destroyed'),
  'fire.treadScarcity': spec(
    2,
    0,
    6,
    'Treads are worth more the fewer are left, up to this much more',
  ),
  'fire.treadGunCost': spec(0.6, 0, 3, 'Cost of a gun spent on treads'),
  'fire.buildingDone': spec(200, 0, 600, 'Worth of finishing a building'),
  'fire.buildingSp': spec(3, 0, 12, 'Per structure point knocked off a building'),
  'fire.buildingGunCost': spec(1, 0, 4, 'Cost of a gun spent on a building'),
  'fire.buildingValue': spec(60, 0, 200, 'Worth of a building as a strike or missile target'),
  'fire.disableInfantry': spec(0.45, 0, 1, 'A disable on infantry, as a fraction of a kill'),
  'fire.disableArmour': spec(0.4, 0, 1, 'A disable on armour, as a fraction of a kill'),
  'fire.disableDisabled': spec(1, 0, 1.5, 'A disable on something already disabled'),
  'fire.gunCost': spec(0.8, 0, 4, 'Cost of adding one more gun to a shot'),
  'fire.missileCost': spec(0, 0, 30, 'Extra cost of spending a one-shot missile'),
  'fire.threatRelief': spec(0, 0, 5, 'Per point of the target’s attack that reaches our units'),
  'fire.min': spec(0.4, 0, 5, 'Expected value below which nobody fires'),

  // --- Orbital strikes ------------------------------------------------------
  'strike.buildingSp': spec(3, 0, 12, 'Per structure point a strike would knock off'),
  'strike.min': spec(2, 0, 20, 'Expected value below which a strike is held'),

  // --- Cruise missiles ----------------------------------------------------
  'cm.ogreVp': spec(0.6, 0, 2, 'A cybertank under the blast, per victory point'),
  'cm.ownLoss': spec(1.5, 0, 4, 'Our own units under the blast, per point of worth'),
  'cm.building': spec(40, 0, 200, 'An enemy building under the blast'),
  'cm.ownBuilding': spec(2, 0, 6, 'Our own building under the blast, as a multiple'),
  'cm.ring1': spec(0.55, 0, 1, 'Worth at one hex from the aim point'),
  'cm.ring2': spec(0.25, 0, 1, 'Worth at two hexes from the aim point'),
  'cm.min': spec(30, 0, 150, 'Blast worth below which the missile stays on the crawler'),

  // --- Reserves ------------------------------------------------------------
  'reserve.goal': spec(1, 0, 3, 'Per hex of the entry hex toward the objective'),
  'reserve.threat': spec(0, 0, 3, 'Enemy fire reaching the entry hex'),

  // --- Deployment ------------------------------------------------------------
  'deploy.goal': spec(1, -3, 5, 'Per hex toward the objective (attacking) or own post (defending)'),
  'deploy.front': spec(0, -5, 5, 'Per hex toward where the enemy comes from'),
  'deploy.cover': spec(1, 0, 8, 'Per point of cover on the setup hex'),
  'deploy.spread': spec(1, 0, 8, 'Against setting up beside a friend'),
} as const;

export type WeightKey = keyof typeof WEIGHT_SPEC;
export type Weights = Readonly<Record<WeightKey, number>>;

export const WEIGHT_KEYS = Object.keys(WEIGHT_SPEC) as WeightKey[];

/** The hand-set starting point, before any tuning. */
export const BASE_WEIGHTS: Weights = Object.fromEntries(
  WEIGHT_KEYS.map((k) => [k, WEIGHT_SPEC[k].value]),
) as Record<WeightKey, number>;

/** A full table from a partial one, the rest filled from `base`. */
export const withWeights = (partial: Partial<Weights>, base: Weights = BASE_WEIGHTS): Weights =>
  ({ ...base, ...partial }) as Weights;

/** The table as a vector in `WEIGHT_KEYS` order, for the tuner. */
export const toVector = (w: Weights): number[] => WEIGHT_KEYS.map((k) => w[k]);

export const fromVector = (v: readonly number[]): Weights =>
  Object.fromEntries(WEIGHT_KEYS.map((k, i) => [k, v[i] ?? WEIGHT_SPEC[k].value])) as Record<
    WeightKey,
    number
  >;

/** Clamp a table into the ranges the spec allows. */
export const clampWeights = (w: Weights): Weights =>
  Object.fromEntries(
    WEIGHT_KEYS.map((k) => [k, Math.min(WEIGHT_SPEC[k].max, Math.max(WEIGHT_SPEC[k].min, w[k]))]),
  ) as Record<WeightKey, number>;

// The shipped defaults: the hand-set table with the tuner's findings laid over.
import { TUNED } from './tuned.js';

export const DEFAULT_WEIGHTS: Weights = withWeights(TUNED, BASE_WEIGHTS);
