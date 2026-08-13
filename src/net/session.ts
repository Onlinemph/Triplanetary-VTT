/**
 * The session facade.
 *
 * Everything above the engine — the shell, the panels, the renderer, a future
 * server — talks to the game through this object, and it does exactly four
 * things:
 *
 *  1. holds the current `GameState` and the immutable command log that produced
 *     it;
 *  2. pushes commands through `applyCommand`, which is the only code that may
 *     decide a rule;
 *  3. tells subscribers that something changed;
 *  4. hands locally-originated commands to a `Transport`, and applies the ones
 *     that arrive from other players.
 *
 * ## Why undo is a replay
 *
 * There is no inverse of "roll a die on the 2:1 column". Undo is therefore not
 * an inverse operation but a *re-derivation*: throw the current state away,
 * start again from the scenario's initial state, and replay the log with its
 * last entry removed. That is exact, because the engine is pure and every roll
 * comes out of the seeded generator carried inside `GameState`. The same
 * mechanism serves save/load, spectating and reconnection — see
 * `docs/MULTIPLAYER.md`.
 *
 * Replay is cheap at Triplanetary's scale. A long campaign session is a few
 * thousand commands, each one a handful of object spreads.
 */

import type { Command, CommandResult } from '@engine/commands.js';
import type { GameMap } from '@engine/map.js';
import { applyCommand } from '@engine/reducer.js';
import type { GameState } from '@engine/types.js';
import { type Transport, isCommand } from './transport.js';

export type SessionListener = (state: GameState, last?: Command) => void;

/** A command the engine refused, kept so the UI can explain a desync. */
export interface Rejection {
  readonly command: Command;
  readonly reason: string;
  /** Where it came from: our own UI, a peer, or a log being replayed. */
  readonly origin: 'local' | 'remote' | 'replay';
}

/** The on-disk / over-the-wire shape of a saved game. */
export interface SessionSnapshot {
  readonly format: 'triplanetary-session';
  readonly version: 1;
  readonly mapId: string;
  readonly scenarioId: string;
  /** Purely informational, so a save file is readable at a glance. */
  readonly turn: number;
  /** The scenario's starting position, before any command was applied. */
  readonly initial: GameState;
  /** Every accepted command, in order. Replaying these reproduces the game. */
  readonly commands: readonly Command[];
}

export const SNAPSHOT_FORMAT = 'triplanetary-session';
export const SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON that survives a torch ship
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify(Infinity)` is `null`, and a torch ship's fuel capacity is
 * genuinely infinite ("Torchships have unlimited fuel"), so a naive round trip
 * would refuel every torch in the game with `NaN`. Non-finite numbers are
 * therefore encoded as sentinel strings and restored on the way back in.
 */
const POS_INF = '__Infinity__';
const NEG_INF = '__-Infinity__';
const NOT_A_NUMBER = '__NaN__';

const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value !== 'number') return value;
  if (value === Number.POSITIVE_INFINITY) return POS_INF;
  if (value === Number.NEGATIVE_INFINITY) return NEG_INF;
  if (Number.isNaN(value)) return NOT_A_NUMBER;
  return value;
};

const reviver = (_key: string, value: unknown): unknown => {
  if (value === POS_INF) return Number.POSITIVE_INFINITY;
  if (value === NEG_INF) return Number.NEGATIVE_INFINITY;
  if (value === NOT_A_NUMBER) return Number.NaN;
  return value;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class GameSession {
  private readonly initialState: GameState;
  private readonly gameMap: GameMap;
  private currentState: GameState;
  private commands: Command[] = [];
  private readonly listeners = new Set<SessionListener>();
  private readonly rejections: Rejection[] = [];

  private transport: Transport | null = null;
  private unsubscribeTransport: (() => void) | null = null;

  constructor(initial: GameState, map: GameMap, transport?: Transport) {
    this.initialState = initial;
    this.currentState = initial;
    this.gameMap = map;
    if (transport) this.attach(transport);
  }

  // -- Reading ------------------------------------------------------------

  get state(): GameState {
    return this.currentState;
  }

  get map(): GameMap {
    return this.gameMap;
  }

  /** The scenario's starting position. Undo and replay rewind to here. */
  get initial(): GameState {
    return this.initialState;
  }

  get history(): readonly Command[] {
    return this.commands;
  }

  /** Commands the engine refused, newest last. Empty in a healthy game. */
  get refused(): readonly Rejection[] {
    return this.rejections;
  }

  /**
   * Undo rewinds *this* client's log. With a peer attached, the other clients'
   * logs cannot be rewound with it, so undo would desynchronise the table and
   * is refused. Hot-seat play — the common case — has no such problem.
   */
  get canUndo(): boolean {
    return this.commands.length > 0 && (this.transport === null || this.transport.kind === 'local');
  }

  // -- Writing ------------------------------------------------------------

  /**
   * Apply a command. Rejected commands leave the state untouched, are not
   * logged, and are not published to peers — a client that guessed wrong about
   * legality must not make the rest of the table guess with it.
   */
  dispatch(cmd: Command): CommandResult {
    return this.apply(cmd, 'local');
  }

  /**
   * Ask what a command *would* do without doing it. Safe because the engine is
   * pure: the trial state, including the die rolls it consumed, is discarded.
   */
  probe(cmd: Command): CommandResult {
    return applyCommand(this.currentState, cmd, this.gameMap).result;
  }

  subscribe(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Drop the last accepted command by replaying the log without it. */
  undo(): void {
    if (!this.canUndo) return;
    this.rerun(this.commands.slice(0, -1));
  }

  /** Rewind to the scenario start, discarding the log. */
  reset(): void {
    this.rerun([]);
  }

  /**
   * Replace the log wholesale and recompute the state from the scenario start.
   * This is how a save file is loaded and how a reconnecting client catches up.
   */
  replay(commands: readonly Command[]): void {
    this.rerun(commands);
  }

  // -- Transport ----------------------------------------------------------

  /** Attach a peer. Replaces any previous one; commands already applied stay. */
  attach(transport: Transport): void {
    this.detach();
    this.transport = transport;
    this.unsubscribeTransport = transport.onRemote((cmd) => this.receive(cmd));
  }

  /** Stop listening to the peer. The transport itself is the caller's to close. */
  detach(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.transport = null;
  }

  get peer(): Transport | null {
    return this.transport;
  }

  /** Release listeners and detach. Does not close a transport we do not own. */
  close(): void {
    this.detach();
    this.listeners.clear();
  }

  // -- Serialisation ------------------------------------------------------

  /**
   * A save is the starting position plus the command log — not the current
   * state. Storing the log means a save can be replayed, audited, resumed by a
   * different client, or handed to a server that re-validates every move.
   */
  serialise(): string {
    const snapshot: SessionSnapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      mapId: this.initialState.mapId,
      scenarioId: this.initialState.scenarioId,
      turn: this.currentState.turn,
      initial: this.initialState,
      commands: this.commands,
    };
    return JSON.stringify(snapshot, replacer, 2);
  }

  static deserialise(json: string, map: GameMap): GameSession {
    const snapshot = parseSnapshot(json);
    if (snapshot.mapId !== map.id) {
      throw new Error(`Saved game is for map "${snapshot.mapId}" but this build has "${map.id}"`);
    }
    const session = new GameSession(snapshot.initial, map);
    session.replay(snapshot.commands);
    return session;
  }

  // -- Internals ----------------------------------------------------------

  /** A command from another player: apply it, but do not send it back out. */
  private receive(cmd: Command): void {
    if (!isCommand(cmd)) return;
    this.apply(cmd, 'remote');
  }

  /**
   * The single write path. `origin` is passed explicitly rather than held in a
   * flag, because a subscriber may dispatch while being notified — and a local
   * command issued from inside a remote command's notification still has to
   * reach the peers.
   */
  private apply(cmd: Command, origin: Rejection['origin']): CommandResult {
    const { state, result } = applyCommand(this.currentState, cmd, this.gameMap);
    if (!result.ok) {
      this.refuse(cmd, result.reason ?? 'rejected', origin);
      return result;
    }
    this.currentState = state;
    this.commands.push(cmd);
    // Publish before notifying: peers should not wait on our repaint.
    if (origin === 'local') this.transport?.send(cmd);
    this.notify(cmd);
    return result;
  }

  private refuse(command: Command, reason: string, origin: Rejection['origin']): void {
    // A peer's command that we refuse means the two logs no longer agree. Keep
    // the last few so the UI can say so instead of drifting silently.
    this.rejections.push({ command, reason, origin });
    if (this.rejections.length > 32) this.rejections.shift();
  }

  /**
   * Recompute the whole game from the scenario start. One notification at the
   * end: subscribers care that the state moved, not how many steps it took.
   */
  private rerun(commands: readonly Command[]): void {
    let state = this.initialState;
    const accepted: Command[] = [];
    for (const cmd of commands) {
      const step = applyCommand(state, cmd, this.gameMap);
      if (step.result.ok) {
        state = step.state;
        accepted.push(cmd);
      } else {
        // Only reachable if a log was edited by hand or produced by a different
        // build: the engine is deterministic, so a command that was legal once
        // is legal on every replay.
        this.refuse(cmd, step.result.reason ?? 'rejected on replay', 'replay');
      }
    }
    this.currentState = state;
    this.commands = accepted;
    const last = accepted[accepted.length - 1];
    this.notify(last);
  }

  private notify(last?: Command): void {
    // Copy: a listener may subscribe or unsubscribe while being notified.
    for (const fn of [...this.listeners]) fn(this.currentState, last);
  }
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

export const parseSnapshot = (json: string): SessionSnapshot => {
  const value: unknown = JSON.parse(json, reviver);
  if (typeof value !== 'object' || value === null) {
    throw new Error('Saved game is not an object');
  }
  const snap = value as Partial<SessionSnapshot>;
  if (snap.format !== SNAPSHOT_FORMAT) {
    throw new Error('Not a Triplanetary saved game');
  }
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported save version ${String(snap.version)}`);
  }
  if (typeof snap.initial !== 'object' || snap.initial === null) {
    throw new Error('Saved game has no starting position');
  }
  if (!Array.isArray(snap.commands) || !snap.commands.every(isCommand)) {
    throw new Error('Saved game has a malformed command log');
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    mapId: typeof snap.mapId === 'string' ? snap.mapId : snap.initial.mapId,
    scenarioId: typeof snap.scenarioId === 'string' ? snap.scenarioId : snap.initial.scenarioId,
    turn: typeof snap.turn === 'number' ? snap.turn : snap.initial.turn,
    initial: snap.initial,
    commands: snap.commands,
  };
};
