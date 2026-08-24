/**
 * The contract between a browser and the referee.
 *
 * Online play needs one thing the peer relay cannot give: somebody at the table
 * who is not one of the players. On Supabase that somebody is an Edge Function
 * holding the service role — the only participant that can write the command
 * log, read the seed, or see the whole board. Everyone else is a client with a
 * seat and a JWT, and the database enforces what a seat may know.
 *
 * ## Everything goes through the referee
 *
 * There is exactly one mutating call, {@link PlayRequest}, and one place that
 * decides anything, `applyCommand`. A client may not insert a command; row
 * level security refuses it. That is what makes `by` mean something: a relay
 * takes the field on trust, and here the referee reads the seat off the JWT and
 * ignores what the frame claims.
 *
 * ## Two ways to hear what happened
 *
 * Unchanged from the WebSocket protocol, because the reasoning is the same:
 *
 *  - **Open information** — the referee appends the command to a log every seat
 *    may read, and each client replays it. Small rows, and determinism
 *    guarantees every client lands on the identical board.
 *  - **Fog of war** — the referee writes each seat its own redacted snapshot,
 *    because a client that could replay the command could also derive the very
 *    thing the fog exists to withhold.
 *
 * Both arrive over Realtime, and both survive a reconnect by reading the table.
 *
 * ## The sealed die
 *
 * One thing *is* new, and it is not optional once the table is open to
 * strangers. "The generator's entire state is a single 32-bit integer carried
 * inside `GameState`", so a client holding the state can roll the next die
 * before deciding whether to fire. Fog does not help: the number is inside the
 * fogged state.
 *
 * So the referee never rolls with the state's own generator. For each command
 * it draws a fresh, unguessable seed, applies the command with that, records
 * the seed in the log beside the command, and seals the stored state's
 * generator back to zero. Which gives both halves at once:
 *
 *  - **Unpredictable** — the seed for the next command does not exist until the
 *    command arrives, and comes from `crypto.getRandomValues`, not from
 *    anything a client holds.
 *  - **Reproducible** — the log records the seed it used, so replaying the log
 *    reproduces the game exactly, roll for roll. A game is still its starting
 *    position plus an ordered list of commands; the list simply carries its
 *    dice with it.
 */

import type { Command, GameState, PlayerId } from '../../engine/index.js';

/** Bumped when the shapes below change incompatibly. */
export const SUPABASE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * One accepted command, as the log stores it.
 *
 * `die` is the generator seed the referee rolled this command with. A client
 * replaying the log sets the state's generator to it before applying, which is
 * what makes the replay exact without ever telling the client what the *next*
 * roll will be.
 */
export interface LoggedCommand {
  /** Position in the log, from 1. Gapless, and the game's canonical order. */
  readonly idx: number;
  readonly cmd: Command;
  readonly die: number;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * How a seat is being played.
 *
 * `computer` is a seat the referee plays itself, which is how a solo game and a
 * two-player game are the same game: the AI gives its orders through the same
 * call a person's browser uses, and the rules judge them identically.
 */
export type SeatKind = 'open' | 'human' | 'computer';

export interface SeatInfo {
  readonly seat: PlayerId;
  readonly ordinal: number;
  readonly faction: string;
  readonly name: string;
  readonly kind: SeatKind;
  /** True when a live browser has been heard from recently. */
  readonly present: boolean;
  /** True when this is the seat the caller holds. */
  readonly mine: boolean;
}

export type GameStatus = 'lobby' | 'playing' | 'finished';

export interface TableInfo {
  readonly id: string;
  /** The short code a friend types to join. */
  readonly code: string;
  readonly scenarioId: string;
  readonly fog: boolean;
  readonly status: GameStatus;
  readonly turn: number;
  /** How many commands the log holds. */
  readonly commandCount: number;
  readonly seats: readonly SeatInfo[];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Open a table. The caller takes the first seat and becomes the host. */
export interface CreateRequest {
  readonly action: 'create';
  readonly v: number;
  readonly scenarioId: string;
  readonly seed?: number;
  readonly options?: Record<string, boolean>;
  readonly fleets?: Readonly<Record<string, readonly string[]>>;
  /** Seat ordinals the computer should play. */
  readonly computerSeats?: readonly number[];
  readonly name?: string;
}

/** Sit down at a table, by code. */
export interface JoinRequest {
  readonly action: 'join';
  readonly v: number;
  readonly code: string;
  /** The seat wanted; omitted takes the first open one, `null` spectates. */
  readonly seat?: PlayerId | null;
  readonly name?: string;
}

/** Leave a seat so somebody else may take it. */
export interface LeaveRequest {
  readonly action: 'leave';
  readonly v: number;
  readonly gameId: string;
}

/** Close the lobby and begin. Host only. */
export interface StartRequest {
  readonly action: 'start';
  readonly v: number;
  readonly gameId: string;
}

/** Give an order. The only call that can change the board. */
export interface CommandRequest {
  readonly action: 'command';
  readonly v: number;
  readonly gameId: string;
  readonly cmd: Command;
  /**
   * Echoed back so a client can match a refusal to what it tried, exactly as
   * the WebSocket protocol's `seq` does.
   */
  readonly seq?: number;
}

/**
 * Catch up: everything this seat is entitled to, from `since` onwards.
 *
 * The reconnect path, and the first thing a client does after sitting down.
 */
export interface SyncRequest {
  readonly action: 'sync';
  readonly v: number;
  readonly gameId: string;
  /** The highest log index already held. Omit for everything. */
  readonly since?: number;
}

export type PlayRequest =
  CreateRequest | JoinRequest | LeaveRequest | StartRequest | CommandRequest | SyncRequest;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  readonly ok: false;
  readonly reason: string;
  /** Present when the referee refused a command, echoing `CommandRequest.seq`. */
  readonly seq?: number;
}

export interface TableResponse {
  readonly ok: true;
  readonly table: TableInfo;
  /** The seat the caller now holds, or `null` for a spectator. */
  readonly seat: PlayerId | null;
}

/**
 * What a seat is entitled to know right now.
 *
 * An open-information game gets `initial` plus the log and replays it; a fog
 * game gets `snapshot` and adopts it. Exactly one of the two is present, and
 * which one is not the client's choice — it is `TableInfo.fog`.
 */
export interface SyncResponse {
  readonly ok: true;
  readonly table: TableInfo;
  readonly seat: PlayerId | null;
  /** Open games: the starting position, with the die sealed. */
  readonly initial?: GameState;
  /** Open games: every command from `since + 1` on, with the die it used. */
  readonly log?: readonly LoggedCommand[];
  /** Fog games: this seat's redacted view of the board as it stands. */
  readonly snapshot?: GameState;
  /** The log index `snapshot` reflects, so a client can spot a stale row. */
  readonly index: number;
}

export interface AcceptedResponse {
  readonly ok: true;
  readonly index: number;
  readonly seq?: number;
}

export type PlayResponse = ErrorResponse | TableResponse | SyncResponse | AcceptedResponse;

// ---------------------------------------------------------------------------
// Shapes on the wire, validated
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural check on an inbound request.
 *
 * Deliberately shallow on `cmd`, for the same reason the WebSocket protocol is:
 * the referee hands it to `applyCommand`, which judges it against the rules far
 * more strictly than any shape check could, and refuses what it dislikes
 * without touching the state. What this *does* enforce is the envelope — the
 * action, the version, and the ids — because those decide which row gets
 * touched, and a malformed one should never reach the database.
 */
export const parsePlayRequest = (value: unknown): PlayRequest | null => {
  if (!isRecord(value)) return null;
  if (value['v'] !== SUPABASE_PROTOCOL_VERSION) return null;
  const str = (k: string): boolean => typeof value[k] === 'string' && value[k] !== '';

  switch (value['action']) {
    case 'create':
      return str('scenarioId') ? (value as unknown as CreateRequest) : null;
    case 'join':
      return str('code') ? (value as unknown as JoinRequest) : null;
    case 'leave':
    case 'start':
    case 'sync':
      return str('gameId') ? (value as unknown as PlayRequest) : null;
    case 'command':
      return str('gameId') &&
        isRecord(value['cmd']) &&
        typeof (value['cmd'] as Record<string, unknown>)['type'] === 'string'
        ? (value as unknown as CommandRequest)
        : null;
    default:
      return null;
  }
};

/** Stamp the protocol version onto an outgoing request. */
export const request = <T extends { action: string }>(msg: T): T & { v: number } => ({
  ...msg,
  v: SUPABASE_PROTOCOL_VERSION,
});

// ---------------------------------------------------------------------------
// Realtime channels
// ---------------------------------------------------------------------------

/**
 * The channel a table talks on.
 *
 * One per game, carrying row changes on `commands`, `views`, `seats` and
 * `games`. Row level security decides what actually arrives: a seat is sent its
 * own view row and nobody else's, and in a fog game the command log is not
 * readable at all.
 */
export const channelFor = (gameId: string): string => `game:${gameId}`;

/** Table names, in one place so the client and the migrations cannot drift. */
export const TABLES = {
  games: 'games',
  seats: 'seats',
  commands: 'commands',
  views: 'views',
} as const;
