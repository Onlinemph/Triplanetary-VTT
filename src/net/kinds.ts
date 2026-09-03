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
} from '../engine/index.js';
import { type BuildOptions, buildScenario, scenarioById } from '../scenarios/index.js';
import { aiCommand } from '../ai/driver.js';
import type { GameState as OgreState } from '../ogre/engine/types.js';
import type { Command as OgreCommand } from '../ogre/engine/commands.js';
import { redactState, sealDie } from './redact.js';

export type GameKind = 'tri' | 'ogre';

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
  summary: (state) => {
    const s = state as TriState;
    const players: Record<PlayerId, { name: string; faction: string }> = {};
    for (const id of s.playerOrder) {
      const p = s.players[id];
      players[id] = { name: p?.name ?? id, faction: p?.faction ?? id };
    }
    return {
      turn: s.turn,
      finished: Boolean(s.victory),
      fog: s.options.fogOfWar,
      playerOrder: s.playerOrder,
      players,
    };
  },
});

export const TRI_RULES: KindRules = triRules();
