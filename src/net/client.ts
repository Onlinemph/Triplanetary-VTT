/**
 * The browser side of server-authoritative play.
 *
 * `WebSocketTransport` in `transport.ts` speaks the peer relay protocol: it
 * echoes commands between trusted clients. This one speaks the server protocol
 * in `protocol.ts` instead, which means the server decides what is legal and,
 * in a fog-of-war game, what each client is even allowed to know.
 *
 * The client keeps its local engine, because the UI needs it: previewing a
 * course, computing odds, and highlighting reachable hexes must all be instant
 * and cannot wait for a round trip. But the local engine is a *prediction*. The
 * server's answer always wins:
 *
 *  - a command the server accepts is applied locally (or, under fog, replaced
 *    wholesale by the snapshot the server sends back);
 *  - a command the server refuses is rolled back by replaying the log without
 *    it, which is exact because the engine is deterministic.
 */

import type { Command, GameState, PlayerId } from '../engine/index.js';
import type { GameSession } from './session.js';
import {
  type RosterEntry,
  type ServerMsg,
  encode,
  frame,
  parseServerMsg,
} from './protocol.js';

export interface GameClientOptions {
  readonly url: string;
  readonly room: string;
  /** The seat to ask for; `null` spectates. */
  readonly seat: PlayerId | null;
  /** Stable per-browser id, so a reconnect reclaims the same seat. */
  readonly clientId: string;
  /** Injected for tests; defaults to the global `WebSocket`. */
  readonly factory?: (url: string) => WebSocketLike;
  readonly maxRetries?: number;
}

/** The slice of `WebSocket` this client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  readyState: number;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface GameClientEvents {
  onSeat?: (seat: PlayerId | null) => void;
  onRoster?: (roster: readonly RosterEntry[]) => void;
  onConnection?: (state: ConnectionState) => void;
  /** A command this client sent that the server refused, with its reason. */
  onRejected?: (reason: string, cmd: Command | undefined) => void;
}

const OPEN = 1;

export class GameClient {
  private socket: WebSocketLike | null = null;
  private seq = 0;
  private retries = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Commands sent but not yet acknowledged, by sequence number. */
  private readonly pending = new Map<number, Command>();

  seat: PlayerId | null = null;
  roster: readonly RosterEntry[] = [];
  connection: ConnectionState = 'closed';
  /** True once the server says this room pushes snapshots (fog of war). */
  snapshotMode = false;

  constructor(
    private readonly session: GameSession,
    private readonly options: GameClientOptions,
    private readonly events: GameClientEvents = {},
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.setConnection('closed');
  }

  /**
   * Send a command, applying it locally first so the board responds at once.
   *
   * Under fog the local application is skipped: the client cannot compute the
   * true result without the hidden state, so it waits for the server's
   * snapshot rather than showing a guess it would have to take back.
   */
  send(cmd: Command): void {
    const seq = ++this.seq;
    this.pending.set(seq, cmd);
    if (!this.snapshotMode) this.session.dispatch(cmd);
    this.transmit(frame({ t: 'cmd', cmd, seq }));
  }

  // -------------------------------------------------------------------------
  // Wire
  // -------------------------------------------------------------------------

  private open(): void {
    this.setConnection('connecting');
    const url = `${this.options.url}?room=${encodeURIComponent(this.options.room)}&clientId=${encodeURIComponent(this.options.clientId)}`;
    const make =
      this.options.factory ??
      ((u: string) => new WebSocket(u) as unknown as WebSocketLike);

    let socket: WebSocketLike;
    try {
      socket = make(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.setConnection('open');
      this.transmit(
        frame({
          t: 'hello',
          room: this.options.room,
          seat: this.options.seat,
          clientId: this.options.clientId,
        }),
      );
    };
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = () => {
      this.setConnection('closed');
      this.scheduleRetry();
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private transmit(msg: unknown): void {
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(encode(msg as never));
    }
  }

  private receive(text: string): void {
    const msg = parseServerMsg(text);
    if (!msg) return;
    this.handle(msg);
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.seat = msg.seat;
        this.snapshotMode = msg.authoritativeSnapshots;
        this.roster = msg.roster;
        this.events.onSeat?.(msg.seat);
        this.events.onRoster?.(msg.roster);
        break;

      case 'roster':
        this.roster = msg.roster;
        this.events.onRoster?.(msg.roster);
        break;

      case 'snapshot':
        this.session.adoptSnapshot(msg.state as GameState);
        this.pending.clear();
        break;

      case 'applied':
        // Our own accepted commands were already applied optimistically.
        if (!this.consumePending(msg.cmd)) this.session.dispatch(msg.cmd);
        break;

      case 'rejected': {
        const cmd = this.pending.get(msg.seq);
        this.pending.delete(msg.seq);
        this.events.onRejected?.(msg.reason, cmd);
        // Our optimistic apply was wrong; ask for the truth rather than
        // guessing at a rollback.
        if (!this.snapshotMode && cmd) this.transmit(frame({ t: 'resync' }));
        break;
      }
    }
  }

  /**
   * Was this the echo of a command we sent optimistically? Matching on content
   * is enough: the server broadcasts commands in the order it accepted them.
   */
  private consumePending(cmd: Command): boolean {
    for (const [seq, mine] of this.pending) {
      if (JSON.stringify(mine) === JSON.stringify(cmd)) {
        this.pending.delete(seq);
        return true;
      }
    }
    return false;
  }

  private setConnection(next: ConnectionState): void {
    if (this.connection === next) return;
    this.connection = next;
    this.events.onConnection?.(next);
  }

  /** Reconnect with exponential backoff, capped, and only while wanted. */
  private scheduleRetry(): void {
    if (this.closed) return;
    const max = this.options.maxRetries ?? 8;
    if (this.retries >= max) return;
    const delay = Math.min(16_000, 500 * 2 ** this.retries);
    this.retries++;
    this.timer = setTimeout(() => this.open(), delay);
  }
}
