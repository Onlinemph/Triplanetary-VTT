/**
 * A game room: the authoritative rules loop, with no networking in it.
 *
 * Everything here is pure bookkeeping over the same engine the browser runs.
 * The room never trusts a client: it checks the seat against the command's
 * claimed author, then hands the command to `applyCommand`, which is the only
 * thing that decides whether a move is legal. A refusal returns the unchanged
 * state, so a hostile or buggy client cannot corrupt the game by trying.
 *
 * Keeping the transport out of this file is what makes it testable — the tests
 * drive a room directly, with no sockets involved.
 */

import {
  type Command,
  type GameState,
  type PlayerId,
  DEFAULT_MAP,
  applyCommand,
} from '../src/engine/index.js';
import type { GameMap } from '../src/engine/map.js';
import { redactState, commandIsAuthorised } from '../src/net/redact.js';
import type { RosterEntry } from '../src/net/protocol.js';

export interface Seat {
  readonly player: PlayerId;
  /** The client currently holding this seat, or null if nobody is connected. */
  clientId: string | null;
}

export interface AcceptResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** Index of the command in the authoritative log, when accepted. */
  readonly index?: number;
}

export class Room {
  readonly id: string;
  readonly map: GameMap;

  private current: GameState;
  private readonly commands: Command[] = [];
  private readonly seats = new Map<PlayerId, Seat>();

  constructor(id: string, initial: GameState, map: GameMap = DEFAULT_MAP) {
    this.id = id;
    this.current = initial;
    this.map = map;
    for (const player of initial.playerOrder) {
      this.seats.set(player, { player, clientId: null });
    }
  }

  get state(): GameState {
    return this.current;
  }

  get log(): readonly Command[] {
    return this.commands;
  }

  get scenarioId(): string {
    return this.current.scenarioId;
  }

  /**
   * Whether this room pushes snapshots instead of commands.
   *
   * Open-information games broadcast the command and let each client replay it,
   * which is both smaller and exactly reproducible. A fog-of-war game cannot:
   * replaying the command requires the hidden state that the client must not
   * have, so the server sends each client its own redacted view instead.
   */
  get usesSnapshots(): boolean {
    return this.current.options.fogOfWar;
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  /**
   * Claim a seat, or spectate.
   *
   * A seat held by a live connection is refused. A seat whose holder dropped is
   * reclaimable by the same `clientId`, which is what makes a reconnect after a
   * dead laptop lid resume the game rather than start a spectator session.
   */
  claimSeat(requested: PlayerId | null, clientId: string): PlayerId | null {
    if (requested === null) return null;
    const seat = this.seats.get(requested);
    if (!seat) return null;
    if (seat.clientId !== null && seat.clientId !== clientId) return null;
    seat.clientId = clientId;
    return seat.player;
  }

  /** Release whatever seat a client held, so it can be reclaimed. */
  releaseClient(clientId: string): void {
    for (const seat of this.seats.values()) {
      if (seat.clientId === clientId) seat.clientId = null;
    }
  }

  seatOf(clientId: string): PlayerId | null {
    for (const seat of this.seats.values()) {
      if (seat.clientId === clientId) return seat.player;
    }
    return null;
  }

  roster(): RosterEntry[] {
    return [...this.seats.values()].map((seat) => ({
      seat: seat.player,
      name: this.current.players[seat.player]?.name ?? seat.player,
      connected: seat.clientId !== null,
    }));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Apply a command on behalf of a seat.
   *
   * Two gates, in order: the seat must match the command's claimed author, and
   * the rules must accept it. The first is the one a relay cannot do; the
   * second is the same check the client already ran, repeated because a client
   * running the check is a convenience, not a guarantee.
   */
  accept(seat: PlayerId | null, cmd: Command): AcceptResult {
    if (!commandIsAuthorised(seat, cmd.by)) {
      return {
        ok: false,
        reason:
          seat === null
            ? 'spectators may not issue commands'
            : `you hold the seat "${seat}" and may not act for "${cmd.by}"`,
      };
    }

    const out = applyCommand(this.current, cmd, this.map);
    if (!out.result.ok) return { ok: false, reason: out.result.reason ?? 'refused' };

    this.current = out.state;
    this.commands.push(cmd);
    return { ok: true, index: this.commands.length };
  }

  /** The state a given seat is entitled to see. */
  viewFor(seat: PlayerId | null): GameState {
    return redactState(this.current, seat, this.map);
  }
}
