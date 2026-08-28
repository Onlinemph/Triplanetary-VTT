/**
 * Which terrain table a unit reads.
 *
 * One line of indirection, in its own file, because both `movement.ts` and
 * `state.ts` need it and neither should import the other. An Ogre is always an
 * Ogre; everything else takes the class's mobility, which is where the
 * Superheavy's "affected by terrain as though it were an Ogre!" (3.01) is
 * recorded.
 */

import type { Mobility } from './terrain.js';
import { unitClass } from './units.js';
import { type Unit, isOgre } from './types.js';

export const mobilityOf = (u: Unit): Mobility =>
  isOgre(u) ? 'ogre' : unitClass(u.classId).mobility;
