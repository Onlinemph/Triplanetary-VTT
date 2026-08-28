/**
 * The multiplayer seam.
 *
 * A `Transport` moves *commands* — never state. That is the whole trick behind
 * networked Triplanetary: the engine is a pure function of `(state, command)`
 * and every die roll goes through the seeded generator carried inside
 * `GameState`, so two clients that receive the same commands in the same order
 * compute byte-identical states. Nothing but a `Command` ever has to cross the
 * wire, and a peer that falls behind catches up by replaying the log.
 *
 * Three implementations ship here, in increasing order of ambition:
 *
 *  - `LocalTransport` — hot seat. Deliberately a no-op: the dispatching session
 *    has already applied the command, and echoing it back would apply it twice.
 *  - `BroadcastChannelTransport` — several tabs of the same browser, one player
 *    per tab. Real, working, and the cheapest way to test the fan-out path.
 *  - `WebSocketTransport` — a relay server. JSON frames, an outbound queue for
 *    when the socket is down, and reconnection with exponential backoff plus
 *    catch-up replay of the commands missed while away.
 *
 * `src/net` is the one place in the codebase allowed to touch browser globals,
 * timers and entropy. `src/engine` and `src/scenarios` stay pure.
 */

import type { Command, CommandType } from '@engine/commands.js';

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export type TransportKind = 'local' | 'websocket' | 'broadcast';

export interface Transport {
  /** Publish a locally-originated command to every other peer. */
  send(cmd: Command): void;
  /** Subscribe to commands from other peers. Returns an unsubscribe function. */
  onRemote(fn: (cmd: Command) => void): () => void;
  readonly kind: TransportKind;
  /** Release sockets, channels and timers. A closed transport stays closed. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the frame shapes change incompatibly. A relay refuses frames
 * it does not understand rather than guessing, because a half-understood
 * command log desynchronises every client on the table.
 */
export const PROTOCOL_VERSION = 1;

/** Sent once per connection so the relay can send back what we have missed. */
export interface JoinFrame {
  readonly t: 'join';
  readonly v: number;
  readonly from: string;
  readonly room: string;
  /** How many commands this client already holds; the relay sends the tail. */
  readonly since: number;
}

/** One command, from one peer. */
export interface CommandFrame {
  readonly t: 'cmd';
  readonly v: number;
  readonly from: string;
  /** Per-sender sequence number, for logging and duplicate detection. */
  readonly seq: number;
  readonly cmd: Command;
}

/** Catch-up: the slice of the authoritative log this client is missing. */
export interface LogFrame {
  readonly t: 'log';
  readonly v: number;
  readonly commands: readonly Command[];
}

export type Frame = JoinFrame | CommandFrame | LogFrame;

/**
 * Every member of the `Command` union, as a runtime table. Written as an
 * exhaustive `Record<CommandType, true>` so that adding a command to
 * `commands.ts` without listing it here is a compile error rather than a
 * silently dropped frame.
 */
const COMMAND_TYPES: Readonly<Record<CommandType, true>> = {
  plotCourse: true,
  setOptionalGravity: true,
  land: true,
  takeOff: true,
  declareRam: true,
  mineOre: true,
  emplaceEquipment: true,
  launchOrdnance: true,
  launchBaseTorpedo: true,
  attack: true,
  counterattack: true,
  declineCounterattack: true,
  firePlanetaryDefence: true,
  suppressHexside: true,
  demandSurrender: true,
  respondToSurrender: true,
  resupply: true,
  transferCargo: true,
  loot: true,
  capture: true,
  purchaseShip: true,
  purchaseEquipment: true,
  sellCargo: true,
  loadCargo: true,
  announceDestination: true,
  deliverCargo: true,
  purchaseGround: true,
  purchaseGarrison: true,
  declareInvasion: true,
  resolveGroundBattle: true,
  chooseRepair: true,
  chooseDevastatedSide: true,
  convertFleet: true,
  endPhase: true,
  concede: true,
};

const owns = (obj: object, prop: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, prop);

/**
 * Structural validation of anything arriving from the network. This is not a
 * legality check — the reducer decides legality, identically on every peer and
 * on the server — it only establishes that the value is shaped like a command
 * so a malformed frame cannot crash a client.
 */
export const isCommand = (value: unknown): value is Command => {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as { type?: unknown; by?: unknown };
  return typeof c.type === 'string' && typeof c.by === 'string' && owns(COMMAND_TYPES, c.type);
};

export const isFrame = (value: unknown): value is Frame => {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as { t?: unknown; v?: unknown };
  if (typeof f.v !== 'number' || f.v !== PROTOCOL_VERSION) return false;
  switch (f.t) {
    case 'join': {
      const j = value as JoinFrame;
      return (
        typeof j.from === 'string' && typeof j.room === 'string' && typeof j.since === 'number'
      );
    }
    case 'cmd': {
      const c = value as CommandFrame;
      return typeof c.from === 'string' && typeof c.seq === 'number' && isCommand(c.cmd);
    }
    case 'log': {
      const l = value as LogFrame;
      return Array.isArray(l.commands) && l.commands.every(isCommand);
    }
    default:
      return false;
  }
};

/** Parse a text frame, returning `null` rather than throwing on junk. */
export const parseFrame = (text: string): Frame | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isFrame(value) ? value : null;
};

/**
 * A per-connection identity, used only to drop our own echoes. It is not a
 * player id and carries no authority: a relay authenticates players, not tabs.
 */
export const newClientId = (random: () => number = Math.random): string =>
  `c${Date.now().toString(36)}${Math.floor(random() * 0xffffff).toString(36)}`;

// ---------------------------------------------------------------------------
// A shared listener set
// ---------------------------------------------------------------------------

class Fanout {
  private readonly listeners = new Set<(cmd: Command) => void>();

  add(fn: (cmd: Command) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(cmd: Command): void {
    // Copy first: a listener may dispatch, which may subscribe or unsubscribe.
    for (const fn of [...this.listeners]) fn(cmd);
  }

  clear(): void {
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Hot seat
// ---------------------------------------------------------------------------

/**
 * One screen, players taking turns. `send` is intentionally a no-op — the
 * session that dispatched the command has already applied it, so looping it
 * back would apply it twice and desynchronise the game from itself.
 */
export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  private readonly fanout = new Fanout();

  send(_cmd: Command): void {
    // Nothing to do: there is no peer.
  }

  onRemote(fn: (cmd: Command) => void): () => void {
    return this.fanout.add(fn);
  }

  close(): void {
    this.fanout.clear();
  }
}

// ---------------------------------------------------------------------------
// Same browser, several tabs
// ---------------------------------------------------------------------------

export interface BroadcastTransportOptions {
  /** Channel name; games with different names do not see each other. */
  readonly channel?: string;
  readonly clientId?: string;
  /** Injectable for tests and for non-browser hosts. */
  readonly factory?: (name: string) => BroadcastChannelLike;
}

/** The slice of `BroadcastChannel` this transport uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Multi-tab play on one machine: every tab holds the same command log and
 * computes the same state, so a second tab is a second player's screen.
 *
 * `BroadcastChannel` does not deliver a message to the object that posted it,
 * but it *does* deliver to other channel objects in the same document, so
 * frames still carry a sender id and we drop our own.
 */
export class BroadcastChannelTransport implements Transport {
  readonly kind = 'broadcast' as const;
  readonly clientId: string;

  private readonly fanout = new Fanout();
  private readonly channel: BroadcastChannelLike | null;
  private seq = 0;
  private closed = false;

  constructor(options: BroadcastTransportOptions = {}) {
    this.clientId = options.clientId ?? newClientId();
    const name = options.channel ?? 'triplanetary';
    const factory = options.factory ?? defaultBroadcastFactory;
    this.channel = factory ? factory(name) : null;
    if (this.channel) {
      this.channel.onmessage = (event) => this.receive(event.data);
    }
  }

  /** False when the host has no `BroadcastChannel`; sends then go nowhere. */
  get available(): boolean {
    return this.channel !== null;
  }

  send(cmd: Command): void {
    if (this.closed || !this.channel) return;
    const frame: CommandFrame = {
      t: 'cmd',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      seq: this.seq++,
      cmd,
    };
    this.channel.postMessage(frame);
  }

  onRemote(fn: (cmd: Command) => void): () => void {
    return this.fanout.add(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.fanout.clear();
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    // Structured clone means `data` is already a value, not text.
    const frame = isFrame(data) ? data : null;
    if (!frame) return;
    if (frame.t === 'cmd' && frame.from !== this.clientId) this.fanout.emit(frame.cmd);
    else if (frame.t === 'log') for (const cmd of frame.commands) this.fanout.emit(cmd);
  }
}

const defaultBroadcastFactory = ((): ((name: string) => BroadcastChannelLike) | null => {
  const ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  return ctor ? (name: string) => new ctor(name) : null;
})();

// ---------------------------------------------------------------------------
// A relay server
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The slice of `WebSocket` this transport uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WebSocketTransportOptions {
  /** Table identifier. One relay can host many games. */
  readonly room?: string;
  readonly clientId?: string;
  readonly protocols?: string | readonly string[];
  /** First reconnect delay, doubled on each failure. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly backoffFactor?: number;
  /** Connect eagerly. Off in tests, where the socket is driven by hand. */
  readonly autoConnect?: boolean;
  /**
   * Ask the relay for the whole log on every join instead of just the tail.
   * Pair this with `onLog` + `GameSession.replay` when the server's order is
   * authoritative and a client's optimistic ordering must be corrected.
   */
  readonly fullCatchUp?: boolean;
  readonly socketFactory?: (url: string, protocols?: string | readonly string[]) => SocketLike;
  readonly random?: () => number;
}

const OPEN = 1;

/**
 * Command relay over a WebSocket.
 *
 * The relay is deliberately dumb: it appends commands to a per-room log and
 * fans them out. It does not need to know the rules to keep a table in step —
 * though a server that *does* run the reducer gains authoritative validation
 * for free, which is what stops a modified client from plotting an illegal
 * course. See `docs/MULTIPLAYER.md`.
 *
 * Commands issued while the socket is down are queued rather than dropped, and
 * the join frame carries how many commands we already hold so the relay can
 * send back exactly the tail we missed. That makes a dropped connection a
 * replay problem, not a resync problem.
 */
export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const;
  readonly url: string;
  readonly room: string;
  readonly clientId: string;

  private readonly fanout = new Fanout();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly logListeners = new Set<(commands: readonly Command[]) => void>();
  private readonly queue: Command[] = [];
  private readonly options: Required<
    Pick<WebSocketTransportOptions, 'minBackoffMs' | 'maxBackoffMs' | 'backoffFactor' | 'random'>
  >;
  private readonly protocols: string | readonly string[] | undefined;
  private readonly socketFactory: (
    url: string,
    protocols?: string | readonly string[],
  ) => SocketLike;

  private readonly fullCatchUp: boolean;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private attempts = 0;
  private seq = 0;
  /** Commands this client holds, sent or received. Drives catch-up. */
  private known = 0;
  private closed = false;
  private statusValue: ConnectionStatus = 'idle';

  constructor(url: string, options: WebSocketTransportOptions = {}) {
    this.url = url;
    this.room = options.room ?? 'default';
    this.clientId = options.clientId ?? newClientId(options.random);
    this.protocols = options.protocols;
    this.options = {
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15000,
      backoffFactor: options.backoffFactor ?? 2,
      random: options.random ?? Math.random,
    };
    this.backoff = this.options.minBackoffMs;
    this.fullCatchUp = options.fullCatchUp === true;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    if (options.autoConnect !== false) this.connect();
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /** Number of commands queued because the socket is not open. */
  get pending(): number {
    return this.queue.length;
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.statusValue);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  send(cmd: Command): void {
    if (this.closed) return;
    this.known += 1;
    const sock = this.socket;
    if (sock && sock.readyState === OPEN) {
      const frame: CommandFrame = {
        t: 'cmd',
        v: PROTOCOL_VERSION,
        from: this.clientId,
        seq: this.seq++,
        cmd,
      };
      sock.send(JSON.stringify(frame));
    } else {
      // Hold it: the command is already applied locally, and the log has to
      // reach the relay in order for the other clients to stay in step.
      this.queue.push(cmd);
    }
  }

  onRemote(fn: (cmd: Command) => void): () => void {
    return this.fanout.add(fn);
  }

  /**
   * Subscribe to catch-up logs from the relay.
   *
   * Subscribing changes what happens to a `log` frame: instead of being fanned
   * out command by command, it is handed over whole and becomes the
   * subscriber's problem — the point being that the caller can pass it straight
   * to `GameSession.replay`, which recomputes the game from the scenario start
   * and so adopts the relay's ordering rather than the local optimistic one.
   * With no `onLog` subscriber, log frames are replayed command by command,
   * which is right for a client that only ever missed the tail.
   */
  onLog(fn: (commands: readonly Command[]) => void): () => void {
    this.logListeners.add(fn);
    return () => {
      this.logListeners.delete(fn);
    };
  }

  /** Open the socket, or reopen it after `close()`-free failures. */
  connect(): void {
    if (this.closed || this.socket) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let sock: SocketLike;
    try {
      sock = this.socketFactory(this.url, this.protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.onopen = () => this.handleOpen();
    sock.onmessage = (event) => this.handleMessage(event.data);
    sock.onclose = () => this.handleClose();
    sock.onerror = () => {
      // Errors are always followed by a close event; let that path retry.
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        // Already closing; nothing useful to do.
      }
    }
    this.setStatus('closed');
    this.fanout.clear();
    this.logListeners.clear();
    this.statusListeners.clear();
  }

  private handleOpen(): void {
    this.attempts = 0;
    this.backoff = this.options.minBackoffMs;
    this.setStatus('open');
    const join: JoinFrame = {
      t: 'join',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      room: this.room,
      since: this.fullCatchUp ? 0 : this.known - this.queue.length,
    };
    this.socket?.send(JSON.stringify(join));
    // Flush anything issued while we were away, in the order it was issued.
    const backlog = this.queue.splice(0, this.queue.length);
    for (const cmd of backlog) {
      const frame: CommandFrame = {
        t: 'cmd',
        v: PROTOCOL_VERSION,
        from: this.clientId,
        seq: this.seq++,
        cmd,
      };
      this.socket?.send(JSON.stringify(frame));
    }
  }

  private handleMessage(data: unknown): void {
    if (this.closed) return;
    const frame = typeof data === 'string' ? parseFrame(data) : isFrame(data) ? data : null;
    if (!frame) return;
    if (frame.t === 'cmd') {
      if (frame.from === this.clientId) return; // our own echo
      this.known += 1;
      this.fanout.emit(frame.cmd);
    } else if (frame.t === 'log') {
      // Catch-up after a reconnect. A subscriber to `onLog` takes the whole
      // slice and decides what to do with it (normally: replay it, adopting the
      // relay's ordering). Otherwise it is fanned out like any other command.
      if (this.logListeners.size > 0) {
        this.known = Math.max(this.known, frame.commands.length);
        for (const fn of [...this.logListeners]) fn(frame.commands);
        return;
      }
      for (const cmd of frame.commands) {
        this.known += 1;
        this.fanout.emit(cmd);
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.socket = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return;
    this.attempts += 1;
    this.setStatus('reconnecting');
    // Exponential backoff with jitter, so a relay restart does not bring every
    // client back in the same millisecond.
    const jitter = 0.5 + this.options.random() * 0.5;
    const delay = Math.min(this.backoff, this.options.maxBackoffMs) * jitter;
    this.backoff = Math.min(this.backoff * this.options.backoffFactor, this.options.maxBackoffMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.socket = null;
      this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    for (const fn of [...this.statusListeners]) fn(next);
  }
}

const defaultSocketFactory = (url: string, protocols?: string | readonly string[]): SocketLike => {
  const ctor = (
    globalThis as {
      WebSocket?: new (url: string, protocols?: string | string[]) => SocketLike;
    }
  ).WebSocket;
  if (!ctor) throw new Error('No WebSocket implementation in this host');
  if (protocols === undefined) return new ctor(url);
  return new ctor(url, typeof protocols === 'string' ? protocols : [...protocols]);
};
