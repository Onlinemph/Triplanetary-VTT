/**
 * Two games, one referee.
 *
 * Everything the online table does — judge an order, roll the dice, seat
 * players, replay a log — is the same for a fleet action over Mars and a
 * cybertank on the cratered map. What differs is the engine underneath, and
 * `KindRules` is that difference written down once: how to build a starting
 * board, how to apply an order with a given die, what to hide from a seat,
 * what the computer's seats owe, and how to read the turn off the state.
 *
 * The referee, the client and the Edge Function all speak to a `KindRules`
 * and never to an engine. Triplanetary's rules live here because everything
 * imports them; the Ogre rules live in `ogreRules.ts` so a browser that has
 * not opened the ground game does not carry its engine.
 */

import {
  type Command as TriCommand,
  type GameMap,
  type GameState as TriState,
  type PlayerId,
  DEFAULT_MAP,
  applyCommand as triApply,
  activePlayer,
} from '../engine/index.js';
import { type BuildOptions, buildScenario, scenarioById } from '../scenarios/index.js';
import { dropData } from '../scenarios/orbitalDrop.js';
import type { BattleResult, OrderOfBattle } from '../campaign/orders.js';
import { aiCommand } from '../ai/driver.js';
import type { GameState as OgreState } from '../ogre/engine/types.js';
import type { Command as OgreCommand } from '../ogre/engine/commands.js';
import { redactState, sealDie } from './redact.js';

export type GameKind = 'tri' | 'ogre';

/**
 * The ground game's scenarios, by id.
 *
 * Written out rather than read off the Ogre scenario table, because the point
 * of the table is that it is loaded on demand — importing it here to answer
 * "is this one of ours?" would pull the whole ground engine into the first
 * bundle a player downloads. `tests/supabase-ogre.test.ts` checks this list
 * against the real table, so a scenario added there and forgotten here fails
 * a test rather than a hand-off.
 */
export const GROUND_SCENARIO_IDS: readonly string[] = [
  'mark-iii-attack',
  'mark-v-attack',
  'crossing',
  'landing',
  'assault',
  'assault-green',
  'assault-asteroid',
  'custom',
];

/** Whether an id names a battle in the ground game. */
export const isGroundScenario = (id: string): boolean => GROUND_SCENARIO_IDS.includes(id);

/** A board of either game. The referee reads `turn` and `rng` off both. */
export type AnyState = TriState | OgreState;
export type AnyCommand = TriCommand | OgreCommand;

/** What a table is opened with: the seed, and whatever the scenario reads. */
export interface BuildSetup {
  readonly seed: number;
  readonly options?: Record<string, boolean> | undefined;
  readonly fleets?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly order?: unknown;
}

/** The referee's reading of a board, whichever game it belongs to. */
export interface StateSummary {
  readonly turn: number;
  readonly finished: boolean;
  readonly fog: boolean;
  readonly playerOrder: readonly PlayerId[];
  readonly players: Readonly<Record<PlayerId, { readonly name: string; readonly faction: string }>>;
  /** The scenario's name, for a lobby that has no engine to ask. */
  readonly title: string;
  /** Lines describing the setup: the map, the forces, the terms. */
  readonly brief: readonly string[];
}

export type Applied =
  { readonly ok: true; readonly state: AnyState } | { readonly ok: false; readonly reason: string };

export interface KindRules {
  readonly kind: GameKind;
  hasScenario(id: string): boolean;
  /** Throws on a setup the scenario dislikes; the caller answers "bad request". */
  build(scenarioId: string, setup: BuildSetup): AnyState;
  /** Apply one order, rolled with `die`, never with the generator in the state. */
  apply(state: AnyState, cmd: AnyCommand, die: number): Applied;
  /** The state with its generator sealed, so a leak of the board is not a leak of the dice. */
  seal(state: AnyState): AnyState;
  /** The board as one seat may see it. Identity for a game with no hidden information. */
  redact(state: AnyState, seat: PlayerId | null): AnyState;
  /** The orders the computer's seats owe right now, in the order to give them. Empty when none. */
  computerOrders(state: AnyState, computers: ReadonlySet<PlayerId>): readonly AnyCommand[];
  summary(state: AnyState): StateSummary;
  /**
   * A battle this board is waiting on — the frozen sky's ground battle — to
   * be fought at a child table. Null when nothing is pending.
   */
  handoff?(state: AnyState): OrderOfBattle | null;
  /** A finished battle's result, for the table that was waiting on it. */
  settle?(state: AnyState): BattleResult | null;
  /** The order that hands a child table's result back to this board. */
  settleCommand?(state: AnyState, result: BattleResult): AnyCommand;
}

/** Who an order claims to be from. Both games put it in the same place. */
export const authorOf = (cmd: AnyCommand): PlayerId => (cmd as { by: PlayerId }).by;

// ---------------------------------------------------------------------------
// Triplanetary
// ---------------------------------------------------------------------------

export const triRules = (map: GameMap = DEFAULT_MAP): KindRules => ({
  kind: 'tri',
  hasScenario: (id) => scenarioById(id) !== undefined,
  build: (id, setup) =>
    buildScenario(id, {
      seed: setup.seed,
      options: setup.options as BuildOptions['options'],
      fleets: setup.fleets as BuildOptions['fleets'],
      order: setup.order as BuildOptions['order'],
    }),
  apply: (state, cmd, die) => {
    const out = triApply(
      { ...(state as TriState), rng: { seed: die >>> 0 } },
      cmd as TriCommand,
      map,
    );
    return out.result.ok
      ? { ok: true, state: out.state }
      : { ok: false, reason: out.result.reason ?? 'refused' };
  },
  seal: (state) => sealDie(state as TriState),
  redact: (state, seat) => redactState(state as TriState, seat, map),
  computerOrders: (state, computers) => {
    const order = aiCommand(state as TriState, computers, map);
    return order === null ? [] : [order.command];
  },
  handoff: (state) => {
    const s = state as TriState;
    return s.scenarioId === 'orbital-drop' ? dropData(s).pendingGround : null;
  },
  settleCommand: (state, result) =>
    ({
      type: 'resolveGroundBattle',
      by: activePlayer(state as TriState),
      result,
    }) as AnyCommand,
  summary: (state) => {
    const s = state as TriState;
    const players: Record<PlayerId, { name: string; faction: string }> = {};
    for (const id of s.playerOrder) {
      const p = s.players[id];
      players[id] = { name: p?.name ?? id, faction: p?.faction ?? id };
    }
    const def = scenarioById(s.scenarioId);
    return {
      title: def?.name ?? s.scenarioId,
      brief: [],
      turn: s.turn,
      finished: Boolean(s.victory),
      fog: s.options.fogOfWar,
      playerOrder: s.playerOrder,
      players,
    };
  },
});

export const TRI_RULES: KindRules = triRules();
