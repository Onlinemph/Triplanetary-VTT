/**
 * The Triplanetary relay server.
 *
 * A thin WebSocket shell around {@link Room}, which holds all the rules logic.
 * Run it with:
 *
 *     npm run server                  # port 8787
 *     PORT=9000 SCENARIO=lateral-7 npm run server
 *
 * and point a client at `ws://host:port/?room=<id>&seat=<playerId>`.
 *
 * Rooms are created on first join, named by the `room` query parameter, and
 * seeded from `SCENARIO` / `SEED`. There is no persistence: a room lives as
 * long as the process. That is a deliberate stopping point rather than an
 * oversight — see docs/MULTIPLAYER.md for what durable rooms would need.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { DEFAULT_MAP } from '../src/engine/index.js';
import { buildScenario } from '../src/scenarios/index.js';
import {
  type ServerMsg,
  encode,
  frame,
  parseClientMsg,
} from '../src/net/protocol.js';
import { Room } from './room.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const SCENARIO = process.env['SCENARIO'] ?? 'bi-planetary';
const SEED = Number(process.env['SEED'] ?? 20370101);

interface Client {
  readonly socket: WebSocket;
  readonly id: string;
  room: Room | null;
  seat: string | null;
  alive: boolean;
}

const rooms = new Map<string, Room>();
const clients = new Set<Client>();

const roomFor = (id: string): Room => {
  const existing = rooms.get(id);
  if (existing) return existing;
  const created = new Room(id, buildScenario(SCENARIO, { seed: SEED }), DEFAULT_MAP);
  rooms.set(id, created);
  console.log(`[room ${id}] created from scenario "${SCENARIO}" seed ${SEED}`);
  return created;
};

const send = (client: Client, msg: ServerMsg): void => {
  if (client.socket.readyState === client.socket.OPEN) {
    client.socket.send(encode(msg));
  }
};

const peers = (room: Room): Client[] =>
  [...clients].filter((c) => c.room === room);

const broadcastRoster = (room: Room): void => {
  const roster = room.roster();
  for (const peer of peers(room)) send(peer, frame({ t: 'roster', roster }));
};

/**
 * Tell everyone in the room what just happened.
 *
 * The two modes differ only here. Open games get the command, which every
 * client replays onto its own copy; fog games get a per-client redacted
 * snapshot, because a client that could replay the command could also derive
 * everything the fog is meant to hide.
 */
const publish = (room: Room, cmd: Parameters<Room['accept']>[1], index: number): void => {
  for (const peer of peers(room)) {
    if (room.usesSnapshots) {
      send(peer, frame({ t: 'snapshot', index, state: room.viewFor(peer.seat) }));
    } else {
      send(peer, frame({ t: 'applied', cmd, index }));
    }
  }
};

const httpServer = createServer((req, res) => {
  // A tiny health endpoint, so a deploy can tell whether the process is up.
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: [...rooms.entries()].map(([id, room]) => ({
          id,
          scenario: room.scenarioId,
          turn: room.state.turn,
          commands: room.log.length,
          seats: room.roster(),
        })),
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const client: Client = {
    socket,
    id: url.searchParams.get('clientId') ?? `c${Math.random().toString(36).slice(2, 10)}`,
    room: null,
    seat: null,
    alive: true,
  };
  clients.add(client);

  socket.on('message', (raw: unknown) => {
    const msg = parseClientMsg(String(raw));
    if (!msg) return; // Unparseable frames are dropped in silence.

    if (msg.t === 'hello') {
      const room = roomFor(msg.room);
      client.room = room;
      client.seat = room.claimSeat(msg.seat, client.id);

      send(
        client,
        frame({
          t: 'welcome',
          room: msg.room,
          seat: client.seat,
          scenarioId: room.scenarioId,
          authoritativeSnapshots: room.usesSnapshots,
          roster: room.roster(),
        }),
      );
      // Bring the newcomer up to date, whichever mode we are in.
      send(
        client,
        frame({ t: 'snapshot', index: room.log.length, state: room.viewFor(client.seat) }),
      );
      broadcastRoster(room);
      console.log(
        `[room ${msg.room}] ${client.id} joined as ${client.seat ?? 'spectator'}`,
      );
      return;
    }

    const room = client.room;
    if (!room) return;

    if (msg.t === 'resync') {
      send(
        client,
        frame({ t: 'snapshot', index: room.log.length, state: room.viewFor(client.seat) }),
      );
      return;
    }

    if (msg.t === 'cmd') {
      const result = room.accept(client.seat, msg.cmd);
      if (!result.ok) {
        send(client, frame({ t: 'rejected', seq: msg.seq, reason: result.reason ?? 'refused' }));
        return;
      }
      publish(room, msg.cmd, result.index ?? room.log.length);
    }
  });

  socket.on('pong', () => {
    client.alive = true;
  });

  socket.on('close', () => {
    clients.delete(client);
    if (client.room) {
      client.room.releaseClient(client.id);
      broadcastRoster(client.room);
      console.log(`[room ${client.room.id}] ${client.id} left`);
    }
  });

  socket.on('error', () => {
    /* close handles cleanup */
  });
});

// Drop connections that stop answering, so their seats can be reclaimed.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`Triplanetary server listening on :${PORT}`);
  console.log(`  scenario "${SCENARIO}", seed ${SEED}`);
  console.log(`  ws://localhost:${PORT}/?room=<id>&seat=<playerId>`);
  console.log(`  http://localhost:${PORT}/health`);
});
