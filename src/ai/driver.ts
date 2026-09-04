/**
 * Running the computer's seats.
 *
 * `nextCommand` decides one order. This is the loop that keeps asking until the
 * computer has nothing left to say, applies each answer through the ordinary
 * reducer, and ends the phase when the floor is the computer's and it is done
 * with it.
 *
 * Three things it is careful about:
 *
 *  - **It plays through the front door.** Every order goes through
 *    `applyCommand`, so an illegal one is refused exactly as a human's would be
 *    and the state comes back unchanged. A refusal stops the loop rather than
 *    retrying: a policy that produces an order the rules reject is a bug to see,
 *    not to paper over.
 *  - **It does not see through walls.** With fog of war on, the policy is asked
 *    for its order against a *redacted* state — the same view the seat would get
 *    over the wire — while the order itself is applied to the real one.
 *  - **It answers when it is not its turn.** Return fire, a nuke's hexside and a
 *    surrender demand are decisions the rules hand to a player who is not
 *    phasing, so every computer seat is polled each step, not just the active
 *    one.
 *
 * Pure: no timers, no `Math.random`. A driver step is a function of the state,
 * which is what lets a solo game be replayed from its seed and command log just
 * like a two-player one.
 */

import {
  type Command,
  type GameMap,
  type GameState,
  type PlayerId,
  DEFAULT_MAP,
  activePlayer,
  applyCommand,
} from '../engine/index.js';
import { redactState } from '../net/redact.js';
import { nextCommand } from './index.js';

export interface DriveResult {
  readonly state: GameState;
  /** Every order the computer actually gave, in the order it gave them. */
  readonly commands: readonly Command[];
  /** Set when the loop stopped because an order was refused — always a bug. */
  readonly refused?: { readonly command: Command; readonly reason: string };
  /** Set when the loop hit its step budget, which is also a bug. */
  readonly exhausted?: boolean;
}

/** Is this seat played by the computer? */
export type SeatMap = ReadonlySet<PlayerId>;

export interface AiOrder {
  readonly by: PlayerId;
  readonly command: Command;
  /** The view the policy decided against — redacted when fog of war is on. */
  readonly view: GameState;
}

/**
 * The next thing a computer seat would do, decided but not applied.
 *
 * This is the seam the interface uses: the shell dispatches through its own
 * session — which logs, notifies and re-renders — rather than having the driver
 * apply commands behind its back. Tests and the batch driver below go through
 * {@link stepAi}, which is this plus `applyCommand`.
 *
 * Seats are polled in `playerOrder` so the choice never depends on the iteration
 * order of a set the caller happened to build differently. The closing
 * `endPhase` is included: a computer seat that has run out of orders yields the
 * floor, and that is an order like any other.
 */
export function aiCommand(
  state: GameState,
  seats: SeatMap,
  map: GameMap = DEFAULT_MAP,
): AiOrder | null {
  if (state.victory || seats.size === 0) return null;

  for (const player of state.playerOrder) {
    if (!seats.has(player)) continue;
    const view = state.options.fogOfWar ? redactState(state, player, map) : state;
    const command = nextCommand(view, player, map);
    if (command !== null) return { by: player, command, view };
  }

  // Nobody owes anything. If the floor is a computer seat's, it is finished with
  // this phase; otherwise a human is up and it is not ours to end.
  const active = activePlayer(state);
  if (!seats.has(active)) return null;
  if (state.players[active]?.eliminated === true) return null;
  return { by: active, command: { type: 'endPhase', by: active }, view: state };
}

export interface AiStep {
  readonly state: GameState;
  /** The order given, or `null` when the computer had nothing to do. */
  readonly command: Command | null;
  /** Whose order it was. */
  readonly by: PlayerId | null;
  /** The view the policy decided against — redacted when fog of war is on. */
  readonly view: GameState;
  readonly refused?: string;
}

/**
 * One order from the computer, applied.
 *
 * Split out from the loop so that a caller — a test, or a debugger — can see
 * each order alongside the exact state it was decided against. With fog of war
 * on, `view` is the redacted state, which is the only thing the policy saw; that
 * is what makes "did it act on something it could not see?" a question with an
 * answer.
 */
export function stepAi(state: GameState, seats: SeatMap, map: GameMap = DEFAULT_MAP): AiStep {
  const order = aiCommand(state, seats, map);
  if (order === null) return { state, command: null, by: null, view: state };

  const out = applyCommand(state, order.command, map);
  if (!out.result.ok) {
    return {
      state,
      command: order.command,
      by: order.by,
      view: order.view,
      refused: out.result.reason ?? 'refused',
    };
  }
  return { state: out.state, command: order.command, by: order.by, view: order.view };
}

/**
 * Is there anything for the computer to do right now?
 *
 * The interface asks this before handing the computer the wheel, so a human seat
 * is never left watching a spinner while nothing happens.
 */
export const aiHasMove = (state: GameState, seats: SeatMap, map: GameMap = DEFAULT_MAP): boolean =>
  aiCommand(state, seats, map) !== null;

/**
 * Play the computer's seats forward until a human is owed a decision.
 *
 * Stops on any of: a human seat holding the floor with nothing owed to a
 * computer seat, a decided game, a refused order, or the step budget. The budget
 * is generous enough that no honest position reaches it — it exists so a policy
 * bug shows up as a failing test rather than a hung tab.
 */
export function driveAi(
  state: GameState,
  seats: SeatMap,
  map: GameMap = DEFAULT_MAP,
  limit = 400,
): DriveResult {
  let s = state;
  const commands: Command[] = [];
  if (seats.size === 0) return { state: s, commands };

  for (let step = 0; step < limit; step += 1) {
    const out = stepAi(s, seats, map);
    if (out.refused !== undefined && out.command !== null) {
      return { state: s, commands, refused: { command: out.command, reason: out.refused } };
    }
    if (out.command === null) return { state: s, commands };
    s = out.state;
    commands.push(out.command);
  }

  return { state: s, commands, exhausted: true };
}
