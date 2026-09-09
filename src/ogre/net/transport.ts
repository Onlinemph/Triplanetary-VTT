/**
 * Transports move commands, and nothing else.
 *
 * The whole networking design rests on one property of the engine:
 * `applyCommand` is pure and every die comes out of a generator whose state
 * lives inside `GameState`. Two clients that start from the same scenario seed
 * and apply the same commands in the same order compute byte-identical states,
 * including every combat result. So the network's only job is to agree on a
 * list:
 *
 *     scenario seed + ordered command log = the game
 *
 * A `Command` is a few hundred bytes of JSON, so a whole session is small
 * enough to resend in full on every reconnect — which is why catch-up, undo,
 * save/load and spectating are all the same mechanism.
 */

import { type Command, isCommand } from '../engine/commands.js';

export const PROTOCOL_VERSION = 1;

export type Frame =
  /** "I am joining this table and already hold `since` commands." */
  | {
      readonly t: 'join';
      readonly v: number;
      readonly from: string;
      readonly room: string;
      readonly since: number;
    }
  /** One command, already applied locally by the sender. */
  | {
      readonly t: 'cmd';
      readonly v: number;
      readonly from: string;
      readonly seq: number;
      readonly cmd: Command;
    }
  /** Catch-up: the slice of the log the client is missing. */
  | { readonly t: 'log'; readonly v: number; readonly commands: readonly Command[] };

export type ConnectionStatus = 'offline' | 'connecting' | 'online';

export interface Transport {
  /** Send one command to the other peers. */
  send(cmd: Command): void;
  /** Register the handler for commands arriving from elsewhere. */
  onCommand(fn: (cmd: Command) => void): void;
  /** Register the handler for a whole-log catch-up after a reconnect. */
  onLog(fn: (commands: readonly Command[]) => void): void;
  onStatus(fn: (status: ConnectionStatus) => void): void;
  /** How many commands this peer has already applied, for the join frame. */
  setLogLength(n: number): void;
  close(): void;
  readonly isLocal: boolean;
}

/** Hot seat: there is nobody to tell. */
export class LocalTransport implements Transport {
  readonly isLocal = true;
  send(): void {}
  onCommand(): void {}
  onLog(): void {}
  onStatus(fn: (status: ConnectionStatus) => void): void {
    fn('online');
  }
  setLogLength(): void {}
  close(): void {}
}

export const validateFrame = (value: unknown): Frame | null => {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as { t?: unknown; v?: unknown };
  if (f.v !== PROTOCOL_VERSION) return null;

  if (f.t === 'cmd') {
    const c = value as { from?: unknown; seq?: unknown; cmd?: unknown };
    if (typeof c.from !== 'string' || typeof c.seq !== 'number') return null;
    if (!isCommand(c.cmd)) return null;
    return value as Frame;
  }
  if (f.t === 'join') {
    const j = value as { from?: unknown; room?: unknown; since?: unknown };
    if (typeof j.from !== 'string' || typeof j.room !== 'string') return null;
    if (!Number.isInteger(j.since)) return null;
    return value as Frame;
  }
  if (f.t === 'log') {
    const l = value as { commands?: unknown };
    if (!Array.isArray(l.commands) || !l.commands.every(isCommand)) return null;
    return value as Frame;
  }
  return null;
};

/**
 * Several tabs of one browser, over `BroadcastChannel`.
 *
 * The cheapest way to exercise the fan-out path — it uses exactly the same code
 * path as a real network — and genuinely playable on one machine with two
 * monitors. Both tabs must start from the same seed; pass it in the URL.
 */
export class BroadcastChannelTransport implements Transport {
  readonly isLocal = false;
  private readonly channel: BroadcastChannel;
  private readonly id: string;
  private seq = 0;
  private handler: ((cmd: Command) => void) | null = null;

  constructor(opts: { channel: string; clientId: string }) {
    this.id = opts.clientId;
    this.channel = new BroadcastChannel(opts.channel);
    this.channel.onmessage = (event: MessageEvent) => {
      const frame = validateFrame(event.data);
      // Drop our own echo: `from` is a connection id, not a player id, and it
      // carries no authority whatsoever.
      if (!frame || frame.t !== 'cmd' || frame.from === this.id) return;
      this.handler?.(frame.cmd);
    };
  }

  send(cmd: Command): void {
    const frame: Frame = { t: 'cmd', v: PROTOCOL_VERSION, from: this.id, seq: this.seq++, cmd };
    this.channel.postMessage(frame);
  }
  onCommand(fn: (cmd: Command) => void): void {
    this.handler = fn;
  }
  onLog(): void {}
  onStatus(fn: (status: ConnectionStatus) => void): void {
    fn('online');
  }
  setLogLength(): void {}
  close(): void {
    this.channel.close();
  }
}
