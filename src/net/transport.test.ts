/**
 * Transport tests.
 *
 * These exercise the wire layer on its own — no engine, no reducer — with
 * hand-driven fakes standing in for `BroadcastChannel` and `WebSocket`, so the
 * queueing, echo-dropping and backoff behaviour is checked without a browser.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Command } from '@engine/commands.js';
import {
  type BroadcastChannelLike,
  type SocketLike,
  BroadcastChannelTransport,
  LocalTransport,
  PROTOCOL_VERSION,
  WebSocketTransport,
  isCommand,
  isFrame,
  parseFrame,
} from './transport.js';

const endPhase: Command = { type: 'endPhase', by: 'p1' };
const plot: Command = { type: 'plotCourse', by: 'p1', ship: 's1', endpoint: { q: 1, r: 0 } };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A shared bus that behaves like `BroadcastChannel`: senders do not self-hear. */
const makeBus = () => {
  const channels: FakeChannel[] = [];
  class FakeChannel implements BroadcastChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    postMessage(message: unknown): void {
      for (const other of channels) {
        if (other !== this && !other.closed) other.onmessage?.({ data: message });
      }
    }
    close(): void {
      this.closed = true;
    }
  }
  return {
    factory: (): BroadcastChannelLike => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    },
  };
};

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

// ---------------------------------------------------------------------------

describe('frame validation', () => {
  it('accepts well-formed commands', () => {
    expect(isCommand(endPhase)).toBe(true);
    expect(isCommand(plot)).toBe(true);
  });

  it('rejects junk, unknown types and prototype keys', () => {
    expect(isCommand(null)).toBe(false);
    expect(isCommand({ type: 'launchTheMissiles', by: 'p1' })).toBe(false);
    expect(isCommand({ type: 'toString', by: 'p1' })).toBe(false);
    expect(isCommand({ type: 'endPhase' })).toBe(false);
  });

  it('rejects frames from another protocol version', () => {
    expect(isFrame({ t: 'cmd', v: PROTOCOL_VERSION, from: 'a', seq: 0, cmd: endPhase })).toBe(true);
    expect(isFrame({ t: 'cmd', v: 99, from: 'a', seq: 0, cmd: endPhase })).toBe(false);
  });

  it('returns null for unparseable text rather than throwing', () => {
    expect(parseFrame('{oh no')).toBeNull();
    expect(parseFrame('{"t":"cmd"}')).toBeNull();
  });
});

describe('LocalTransport', () => {
  it('never echoes: the dispatching session has already applied the command', () => {
    const t = new LocalTransport();
    const seen: Command[] = [];
    t.onRemote((c) => seen.push(c));
    t.send(endPhase);
    expect(seen).toEqual([]);
    expect(t.kind).toBe('local');
    t.close();
  });
});

describe('BroadcastChannelTransport', () => {
  it('carries commands between tabs but not back to the sender', () => {
    const bus = makeBus();
    const a = new BroadcastChannelTransport({ factory: bus.factory, clientId: 'a' });
    const b = new BroadcastChannelTransport({ factory: bus.factory, clientId: 'b' });
    const atSeen: Command[] = [];
    const btSeen: Command[] = [];
    a.onRemote((c) => atSeen.push(c));
    b.onRemote((c) => btSeen.push(c));

    a.send(endPhase);
    expect(btSeen).toEqual([endPhase]);
    expect(atSeen).toEqual([]);

    b.send(plot);
    expect(atSeen).toEqual([plot]);
    a.close();
    b.close();
  });

  it('stops delivering once closed', () => {
    const bus = makeBus();
    const a = new BroadcastChannelTransport({ factory: bus.factory, clientId: 'a' });
    const b = new BroadcastChannelTransport({ factory: bus.factory, clientId: 'b' });
    const seen: Command[] = [];
    b.onRemote((c) => seen.push(c));
    b.close();
    a.send(endPhase);
    expect(seen).toEqual([]);
    a.close();
  });
});

describe('WebSocketTransport', () => {
  const build = (): { socket: FakeSocket; transport: WebSocketTransport } => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport('ws://relay.test/game', {
      room: 'table-1',
      clientId: 'me',
      socketFactory: () => socket,
      random: () => 0.5,
    });
    return { socket, transport };
  };

  it('announces itself on open and sends commands as frames', () => {
    const { socket, transport } = build();
    socket.open();
    const [join] = socket.frames();
    expect(join).toMatchObject({ t: 'join', room: 'table-1', from: 'me', since: 0 });

    transport.send(endPhase);
    expect(socket.frames()[1]).toMatchObject({ t: 'cmd', from: 'me', seq: 0, cmd: endPhase });
    transport.close();
  });

  it('queues commands while the socket is down and flushes them on open', () => {
    const { socket, transport } = build();
    transport.send(endPhase);
    transport.send(plot);
    expect(transport.pending).toBe(2);
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(transport.pending).toBe(0);
    const frames = socket.frames();
    expect(frames[0]).toMatchObject({ t: 'join', since: 0 });
    expect(frames[1]).toMatchObject({ cmd: endPhase });
    expect(frames[2]).toMatchObject({ cmd: plot });
    transport.close();
  });

  it('drops its own echo and delivers everyone else', () => {
    const { socket, transport } = build();
    socket.open();
    const seen: Command[] = [];
    transport.onRemote((c) => seen.push(c));

    socket.deliver({ t: 'cmd', v: PROTOCOL_VERSION, from: 'me', seq: 0, cmd: endPhase });
    expect(seen).toEqual([]);

    socket.deliver({ t: 'cmd', v: PROTOCOL_VERSION, from: 'you', seq: 0, cmd: plot });
    expect(seen).toEqual([plot]);
    transport.close();
  });

  it('replays a catch-up log in order', () => {
    const { socket, transport } = build();
    socket.open();
    const seen: Command[] = [];
    transport.onRemote((c) => seen.push(c));
    socket.deliver({ t: 'log', v: PROTOCOL_VERSION, commands: [plot, endPhase] });
    expect(seen).toEqual([plot, endPhase]);
    transport.close();
  });

  it('hands the whole log to an onLog subscriber instead of fanning it out', () => {
    const { socket, transport } = build();
    socket.open();
    const seen: Command[] = [];
    const logs: (readonly Command[])[] = [];
    transport.onRemote((c) => seen.push(c));
    transport.onLog((log) => logs.push(log));
    socket.deliver({ t: 'log', v: PROTOCOL_VERSION, commands: [plot, endPhase] });
    expect(logs).toEqual([[plot, endPhase]]);
    expect(seen).toEqual([]);
    transport.close();
  });

  it('asks for the whole log when fullCatchUp is set', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport('ws://relay.test/game', {
      clientId: 'me',
      fullCatchUp: true,
      socketFactory: () => socket,
    });
    transport.send(endPhase);
    socket.open();
    expect(socket.frames()[0]).toMatchObject({ t: 'join', since: 0 });
    transport.close();
  });

  it('reconnects with growing backoff and asks only for what it missed', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = new WebSocketTransport('ws://relay.test/game', {
      clientId: 'me',
      minBackoffMs: 100,
      backoffFactor: 2,
      random: () => 1,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    sockets[0]!.open();
    transport.send(endPhase);
    expect(transport.status).toBe('open');

    sockets[0]!.drop();
    expect(transport.status).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    // Still down: the next attempt waits twice as long.
    sockets[1]!.drop();
    vi.advanceTimersByTime(150);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(60);
    expect(sockets).toHaveLength(3);

    sockets[2]!.open();
    const [join] = sockets[2]!.frames() as [{ since: number }];
    // One command was sent and acknowledged before the drop.
    expect(join.since).toBe(1);
    transport.close();
    vi.useRealTimers();
  });

  it('stays closed after close()', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = new WebSocketTransport('ws://relay.test/game', {
      minBackoffMs: 10,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    sockets[0]!.open();
    transport.close();
    expect(transport.status).toBe('closed');
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });
});
