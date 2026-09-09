/**
 * Weights learned by `scripts/tune-war.ts`. Generated; do not edit by hand —
 * run the tuner and commit what it writes.
 */

import type { WarWeights } from './weights.js';

export const WAR_TUNED: Partial<WarWeights> = {
  'target.planetary': 184,
  'target.asteroid': 35.7,
  'target.neutral': 1.21,
  'target.distance': 0.537,
  'target.range': 6.19,
  'target.guns': 15.1,
  'target.enemyStrength': 0.447,
  'target.nearest': 115,
  'target.committed': 72.3,
  'target.min': -12.3,
  'force.garrisonPrior': 33.4,
  'force.overmatch': 1.85,
  'force.reserve': 38,
  'force.infantry': 0.885,
  'force.heavy': 0.544,
  'force.missile': 1.13,
  'force.gev': 0.236,
  'force.howitzer': 0.703,
  'force.ogre': 0.721,
  'assault.commit': 0.912,
  'assault.escort': 3.39,
  'garrison.share': 0.221,
  'garrison.planetary': 52.4,
  'garrison.asteroid': 23.5,
  'garrison.threat': 6.65,
  'garrison.transports': 16.1,
  'garrison.reaction': 0.291,
  'garrison.infantry': 1.36,
  'garrison.armour': 1.9,
  'garrison.ogre': 0.984,
  'fleet.transports': 2.78,
  'fleet.escortStrength': 15.6,
  'fleet.reserve': 117,
  'repair.reserve': 44.7,
};

/** A note on the run that produced these, for the record. */
export const WAR_TUNED_NOTE =
  '8 generations, 208 wars of 60 days; reigning table vs the hand-set baseline +0.512 per war';
