/**
 * `GameSession` — the only object the shell holds.
 *
 * It owns the current state, the accepted-command log, the subscriber list,
 * and, optionally, a `Transport`. Undo and save/load are the same mechanism as
 * multiplayer catch-up, because all three are "replay this list of commands
 * from the scenario's starting position".
 */

import type { Command, CommandResult } from '../engine/commands.js';
import type { GameMap } from '../engine/map.js';
import type { GameState } from '../engine/types.js';
import { type VictoryCheck, applyCommand } from '../engine/reducer.js';
import { type Transport, LocalTransport } from './transport.js';

export interface RefusedCommand {
  readonly cmd: Command;
  readonly reason: string;
  readonly origin: 'local' | 'remote' | 'replay';
}

export interface SessionOptions {
  readonly transport?: Transport;
  readonly victoryCheck?: VictoryCheck;
}

export class GameSession {
  readonly map: GameMap;

  private current: GameState;
  private readonly initial: GameState;
  private readonly commands: Command[] = [];
  private readonly subscribers = new Set<() => void>();
  private readonly refusals: RefusedCommand[] = [];
  private readonly transport: Transport;
  private readonly victoryCheck?: VictoryCheck;

  constructor(initial: GameState, map: GameMap, opts: SessionOptions = {}) {
    this.initial = initial;
    this.current = initial;
    this.map = map;
    this.transport = opts.transport ?? new LocalTransport();
    this.victoryCheck = opts.victoryCheck;

    this.transport.onCommand((cmd) => this.receive(cmd));
    this.transport.onLog((log) => this.replay(log));
  }

  get state(): GameState {
    return this.current;
  }

  get log(): readonly Command[] {
    return this.commands;
  }

  get refused(): readonly RefusedCommand[] {
    return this.refusals;
  }

  /**
   * Undo is local-only.
   *
   * Rewinding one client's log while the others keep theirs would desynchronise
   * the table. A networked game that wants take-backs needs an explicit
   * protocol — a rollback frame every client honours — and a social rule about
   * who may ask. The primitive is here (`replay`); the agreement is not, so the
   * button is disabled rather than being quietly wrong.
   */
  get canUndo(): boolean {
    return this.transport.isLocal && this.commands.length > 0;
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Apply a command locally and, if it is accepted, pass it on. */
  dispatch(cmd: Command): CommandResult {
    const { state, result } = applyCommand(this.current, cmd, this.map, this.victoryCheck);
    if (!result.ok) {
      this.note({ cmd, reason: result.reason, origin: 'local' });
      return result;
    }
    this.current = state;
    this.commands.push(cmd);
    this.transport.setLogLength(this.commands.length);
    this.transport.send(cmd);
    this.notify();
    return result;
  }

  /** A command from another peer. Rejections here mean the tables disagree. */
  private receive(cmd: Command): void {
    const { state, result } = applyCommand(this.current, cmd, this.map, this.victoryCheck);
    if (!result.ok) {
      // Surface it; do not swallow it. A remote rejection means this client and
      // the sender no longer agree about the state, and the fix is a resync.
      this.note({ cmd, reason: result.reason, origin: 'remote' });
      return;
    }
    this.current = state;
    this.commands.push(cmd);
    this.transport.setLogLength(this.commands.length);
    this.notify();
  }

  /** Recompute the whole game from the scenario start. Exact, by construction. */
  replay(commands: readonly Command[]): void {
    let state = this.initial;
    const accepted: Command[] = [];
    for (const cmd of commands) {
      const step = applyCommand(state, cmd, this.map, this.victoryCheck);
      if (!step.result.ok) {
        this.note({ cmd, reason: step.result.reason, origin: 'replay' });
        continue;
      }
      state = step.state;
      accepted.push(cmd);
    }
    this.current = state;
    this.commands.length = 0;
    this.commands.push(...accepted);
    this.transport.setLogLength(this.commands.length);
    this.notify();
  }

  undo(): void {
    if (!this.canUndo) return;
    this.replay(this.commands.slice(0, -1));
  }

  /**
   * A save file is the starting position plus the log, not a serialised state.
   * It is a few kilobytes, and it replays exactly.
   */
  serialise(): string {
    return JSON.stringify({ v: 1, initial: this.initial, log: this.commands });
  }

  static deserialise(text: string, map: GameMap, opts: SessionOptions = {}): GameSession {
    const parsed = JSON.parse(text) as { initial: GameState; log: Command[] };
    const session = new GameSession(parsed.initial, map, opts);
    session.replay(parsed.log);
    return session;
  }

  close(): void {
    this.transport.close();
  }

  private note(entry: RefusedCommand): void {
    this.refusals.push(entry);
    if (this.refusals.length > 12) this.refusals.shift();
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }
}
