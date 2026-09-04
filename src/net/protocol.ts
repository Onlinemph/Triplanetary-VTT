/**
 * The client/server wire protocol.
 *
 * `transport.ts` carries a peer-to-peer relay protocol: clients echo commands
 * at each other and every client computes the state itself. That is enough for
 * a trusted table, and it is what `BroadcastChannelTransport` uses between tabs.
 * It is not enough for play over the internet, for two reasons the relay cannot
 * fix by itself:
 *
 *  - **`by` is just a string.** Nothing stops a client sending a command that
 *    claims to come from another player. Seats have to be assigned and checked
 *    somewhere only the server controls.
 *  - **Fog of war needs information the client never receives.** Hiding a
 *    counter in the renderer is not hiding it.
 *
 * So this protocol is server-authoritative. The server owns the one true
 * `GameState`, validates every command through the same `applyCommand` the
 * client uses, and tells clients what happened in one of two ways:
 *
 *  - **Open information:** it broadcasts the accepted *command*, and clients
 *    replay it. Small frames, and the engine's determinism guarantees every
 *    client lands on the identical state.
 *  - **Fog of war:** it sends each client a *redacted snapshot* instead,
 *    because the whole point is that clients must not be able to derive the
 *    hidden parts. Bigger frames, in exchange for secrets that are actually
 *    secret.
 *
 * Both modes reconnect the same way: ask for a snapshot and carry on.
 */

import type { Command, GameState, PlayerId } from '../engine/index.js';

export const SERVER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** First frame on every connection. */
export interface HelloMsg {
  readonly t: 'hello';
  readonly v: number;
  readonly room: string;
  /**
   * The seat this client wants. `null` asks to spectate. A seat already held by
   * a live connection is refused; a seat whose holder dropped may be reclaimed,
   * which is how reconnection works.
   */
  readonly seat: PlayerId | null;
  /** Opaque per-client identity, used to reclaim a seat after a drop. */
  readonly clientId: string;
}

/** A command the client wants applied. */
export interface CommandMsg {
  readonly t: 'cmd';
  readonly v: number;
  readonly cmd: Command;
  /** Client sequence number, echoed back so the sender can match rejections. */
  readonly seq: number;
}

/** Explicit resync request, after a drop or a detected divergence. */
export interface ResyncMsg {
  readonly t: 'resync';
  readonly v: number;
}

export type ClientMsg = HelloMsg | CommandMsg | ResyncMsg;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Answer to `hello`: who you are and what game this is. */
export interface WelcomeMsg {
  readonly t: 'welcome';
  readonly v: number;
  readonly room: string;
  /** The seat actually granted; `null` means spectator. */
  readonly seat: PlayerId | null;
  readonly scenarioId: string;
  /**
   * True when the server will push snapshots rather than commands, because the
   * scenario is playing with fog of war.
   */
  readonly authoritativeSnapshots: boolean;
  readonly roster: readonly RosterEntry[];
}

export interface RosterEntry {
  readonly seat: PlayerId;
  readonly name: string;
  readonly connected: boolean;
}

/** A command the server accepted. Broadcast in open-information games. */
export interface AppliedMsg {
  readonly t: 'applied';
  readonly v: number;
  readonly cmd: Command;
  /** Authoritative index of this command in the game's log. */
  readonly index: number;
}

/** The full state this client is entitled to see. */
export interface SnapshotMsg {
  readonly t: 'snapshot';
  readonly v: number;
  /** How many commands the authoritative log holds at this point. */
  readonly index: number;
  readonly state: GameState;
}

/** A command the server refused, sent only to whoever tried it. */
export interface RejectedMsg {
  readonly t: 'rejected';
  readonly v: number;
  readonly seq: number;
  readonly reason: string;
}

/** Seat occupancy changed. */
export interface RosterMsg {
  readonly t: 'roster';
  readonly v: number;
  readonly roster: readonly RosterEntry[];
}

export type ServerMsg = WelcomeMsg | AppliedMsg | SnapshotMsg | RejectedMsg | RosterMsg;

export type AnyMsg = ClientMsg | ServerMsg;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Structural check on an inbound frame.
 *
 * Deliberately shallow on `cmd` and `state`: the server hands commands straight
 * to `applyCommand`, which validates them against the rules far more strictly
 * than any shape check could, and refuses anything it does not like without
 * mutating state.
 */
export const parseClientMsg = (text: string): ClientMsg | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['v'] !== SERVER_PROTOCOL_VERSION) return null;

  switch (value['t']) {
    case 'hello':
      return typeof value['room'] === 'string' &&
        typeof value['clientId'] === 'string' &&
        (value['seat'] === null || typeof value['seat'] === 'string')
        ? (value as unknown as HelloMsg)
        : null;
    case 'cmd':
      return isRecord(value['cmd']) &&
        typeof (value['cmd'] as Record<string, unknown>)['type'] === 'string' &&
        typeof (value['cmd'] as Record<string, unknown>)['by'] === 'string' &&
        typeof value['seq'] === 'number'
        ? (value as unknown as CommandMsg)
        : null;
    case 'resync':
      return value as unknown as ResyncMsg;
    default:
      return null;
  }
};

export const parseServerMsg = (text: string): ServerMsg | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['v'] !== SERVER_PROTOCOL_VERSION) return null;
  const t = value['t'];
  if (
    t === 'welcome' ||
    t === 'applied' ||
    t === 'snapshot' ||
    t === 'rejected' ||
    t === 'roster'
  ) {
    return value as unknown as ServerMsg;
  }
  return null;
};

export const encode = (msg: AnyMsg): string => JSON.stringify(msg);

/** Stamp the protocol version onto an outgoing frame. */
export const frame = <T extends { t: string }>(msg: T): T & { v: number } => ({
  ...msg,
  v: SERVER_PROTOCOL_VERSION,
});
