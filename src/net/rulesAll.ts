/**
 * Every game the referee can run, by kind.
 *
 * For the Edge Function and the tests, which carry both engines anyway. The
 * browser resolves kinds lazily instead (see `main.ts`), so a fleet action
 * does not download the cratered map.
 */

import type { GameMap } from '../engine/index.js';
import { type GameKind, type KindRules, triRules } from './kinds.js';
import { OGRE_RULES } from './ogreRules.js';

export const rulesFor = (kind: GameKind, map?: GameMap): KindRules =>
  kind === 'ogre' ? OGRE_RULES : triRules(map);

export const isGameKind = (value: unknown): value is GameKind =>
  value === 'tri' || value === 'ogre';
