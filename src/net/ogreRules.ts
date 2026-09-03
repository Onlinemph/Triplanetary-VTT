/**
 * The ground game, as the referee sees it.
 *
 * Ogre is the easier of the two to referee: no hidden information, so every
 * seat sees the whole board and the log streams as commands; strictly one
 * player acting at a time, with the reducer itself refusing anybody else —
 * the deployment step and an overrun both hand the decision to somebody
 * other than the phasing player, and `applyCommand` already asks the right
 * question. The referee need only know who that is, to say which seat the
 * computer owes orders for.
 */

import type { PlayerId } from '../engine/index.js';
import type { OrderOfBattle } from '../campaign/orders.js';
import { type GameState as OgreState, activePlayer, setupActor } from '../ogre/engine/types.js';
import type { Command as OgreCommand } from '../ogre/engine/commands.js';
import { applyCommand } from '../ogre/engine/reducer.js';
import { overrunActor } from '../ogre/engine/overrun.js';
import { scenarioById } from '../ogre/scenarios/index.js';
import { aiPlan } from '../ogre/ai/player.js';
import type { AnyState, KindRules } from './kinds.js';

/** Whose decision the board is waiting on. */
export const actorOf = (state: OgreState): PlayerId =>
  setupActor(state) ?? overrunActor(state) ?? activePlayer(state);

export const ogreRules = (): KindRules => ({
  kind: 'ogre',
  hasScenario: (id) => scenarioById(id) !== undefined,
  build: (id, setup) => {
    const def = scenarioById(id);
    if (!def) throw new Error(`unknown Ogre scenario "${id}"`);
    return def.build({
      seed: setup.seed >>> 0,
      setup: true,
      ...(setup.order !== undefined ? { order: setup.order as OrderOfBattle } : {}),
    });
  },
  apply: (state, cmd, die) => {
    const s = state as OgreState;
    const def = scenarioById(s.scenarioId);
    if (!def) return { ok: false, reason: `the scenario "${s.scenarioId}" is not in this build` };
    const out = applyCommand(
      { ...s, rng: { seed: die >>> 0 } },
      cmd as OgreCommand,
      def.map,
      def.checkVictory,
    );
    return out.result.ok
      ? { ok: true, state: out.state }
      : { ok: false, reason: out.result.reason ?? 'refused' };
  },
  seal: (state) => {
    const s = state as OgreState;
    return s.rng.seed === 0 ? s : { ...s, rng: { seed: 0 } };
  },
  redact: (state) => state,
  computerOrders: (state, computers) => {
    const s = state as OgreState;
    if (s.victory) return [];
    const who = actorOf(s);
    if (!computers.has(who)) return [];
    const def = scenarioById(s.scenarioId);
    return def ? aiPlan(s, def.map, who) : [];
  },
  summary: (state) => {
    const s = state as OgreState;
    const players: Record<PlayerId, { name: string; faction: string }> = {};
    for (const id of s.playerOrder) {
      const p = s.players[id];
      players[id] = { name: p?.name ?? id, faction: p?.faction ?? id };
    }
    return {
      turn: s.turn,
      finished: s.victory !== null,
      fog: false,
      playerOrder: s.playerOrder,
      players,
    };
  },
});

export const OGRE_RULES: KindRules = ogreRules();

/** Convenience for the shell: the board, typed. */
export const asOgreState = (state: AnyState): OgreState => state as OgreState;
