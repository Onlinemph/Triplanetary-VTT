/**
 * Everything the referee decides that a database cannot change.
 *
 * `index.ts` is the half that cannot be run without Supabase: a JWT to read, a
 * service role to write with, an HTTP request to answer. This is the other half
 * — turning rows into a `StoredGame`, deciding which seats a new table opens
 * with, shaping a `SyncResponse` — and it is separated out for the same reason
 * `referee.ts` is separated from the Edge Function at all. None of it needs a
 * network, so none of it should need one to be checked.
 *
 * Nothing here reads the clock or draws randomness. `now` and the dice arrive as
 * arguments, which is what makes every function below a function.
 *
 * The engine reaches Deno through `../_shared/engine.js`, a bundle built by
 * `scripts/build-functions.mjs`. It is generated and not committed; see
 * `../_shared/README.md`.
 */

// See the note in `index.ts`: Deno needs pointing at the declaration file.
// @deno-types="../_shared/engine.d.ts"
import {
  type AnyCommand,
  type AnyState,
  type BuildSetup,
  type GameKind,
  type LoggedCommand,
  type StateSummary,
  type PlayerId,
  type SeatKind,
  type SeatRow,
  type StoredGame,
  type SyncResponse,
  type GameStatus,
  type KindRules,
  tableInfo,
  viewFor,
} from '../_shared/engine.js';

// ---------------------------------------------------------------------------
// Rows, as PostgREST hands them over
// ---------------------------------------------------------------------------

export interface GameRow {
  id: string;
  code: string;
  kind: GameKind;
  scenario_id: string;
  fog: boolean;
  status: GameStatus;
  turn: number;
  command_count: number;
  host_id: string;
}

export interface SecretRow {
  seed: number;
  options: Record<string, boolean>;
  fleets: Record<string, string[]>;
  state: AnyState;
  /** The table's password as the referee hashed it, or null for a code-only table. */
  password: string | null;
}

export interface SeatDbRow {
  seat: string;
  ordinal: number;
  faction: string;
  name: string;
  kind: SeatKind;
  user_id: string | null;
  last_seen: string | null;
}

/**
 * `last_seen` is a `timestamptz` on the way out and epoch milliseconds on the
 * way in, because `SeatRow.lastSeen` is a number and `PRESENCE_MS` does
 * arithmetic on it. The conversion is here rather than at each call site so
 * there is one place for the two representations to meet.
 */
export const seatFromDb = (row: SeatDbRow): SeatRow => ({
  seat: row.seat,
  ordinal: row.ordinal,
  faction: row.faction,
  name: row.name,
  kind: row.kind,
  userId: row.user_id,
  lastSeen: row.last_seen === null ? null : Date.parse(row.last_seen),
});

/**
 * The columns `save_seats` updates, and only those.
 *
 * `ordinal` and `faction` are absent on purpose: they are the scenario's, fixed
 * when the table opened, and a seat change has no business restating them.
 */
export const seatToDb = (seat: SeatRow): Record<string, unknown> => ({
  seat: seat.seat,
  name: seat.name,
  kind: seat.kind,
  user_id: seat.userId,
  last_seen: seat.lastSeen === null ? null : new Date(seat.lastSeen).toISOString(),
});

/** The full row, for the inserts that open a table. */
export const seatToInsert = (seat: SeatRow): Record<string, unknown> => ({
  ...seatToDb(seat),
  ordinal: seat.ordinal,
  faction: seat.faction,
});

export const storedGame = (
  game: GameRow,
  secret: SecretRow,
  seats: readonly SeatDbRow[],
): StoredGame => ({
  id: game.id,
  code: game.code,
  kind: game.kind,
  locked: secret.password !== null && secret.password !== '',
  scenarioId: game.scenario_id,
  fog: game.fog,
  status: game.status,
  state: secret.state,
  commandCount: game.command_count,
  seats: seats.map(seatFromDb),
  hostId: game.host_id,
});

/**
 * Only the seats that actually moved.
 *
 * Sending the whole roster back would work — `save_seats` refuses to write rows
 * the caller does not hold — but every row sent is a row rewritten, and every
 * row rewritten is a Realtime event to everybody at the table saying nothing
 * happened.
 */
export const changedSeats = (before: readonly SeatRow[], after: readonly SeatRow[]): SeatRow[] => {
  const was = new Map(before.map((s) => [s.seat, s]));
  return after.filter((s) => {
    const old = was.get(s.seat);
    return (
      old === undefined ||
      old.userId !== s.userId ||
      old.kind !== s.kind ||
      old.name !== s.name ||
      old.lastSeen !== s.lastSeen
    );
  });
};

export const changedSeatsToDb = (changed: readonly SeatRow[]): Record<string, unknown>[] =>
  changed.map(seatToDb);

// ---------------------------------------------------------------------------
// Opening a table
// ---------------------------------------------------------------------------

/**
 * The scenario's setup arguments, from values a client chose.
 *
 * The one place the request's own JSON reaches the engine, and the narrowing is
 * written down here rather than at the two call sites so the trust boundary has
 * a name. `fleets` is the reason a cast is needed at all: the protocol carries
 * hull names as plain strings, because a browser has no business being trusted
 * to spell a `ShipClass` — `buildScenario` is what knows the catalogue, and it
 * throws on a name that is not in it. The caller catches that and refuses the
 * request; nothing downstream ever sees an invented hull.
 */
export const setupFrom = (
  seed: number,
  options: Record<string, boolean> | undefined,
  fleets: Readonly<Record<string, readonly string[]>> | undefined,
  order?: unknown,
): BuildSetup => ({
  seed,
  options,
  fleets,
  // A campaign order of battle rides the same trust boundary as the fleets:
  // arbitrary JSON until the scenario has looked at it, and the scenario
  // throws on one it dislikes.
  order,
});

const trimmed = (name: string | undefined): string | null => {
  const t = (name ?? '').trim();
  return t === '' ? null : t;
};

/**
 * The roster a freshly built scenario implies.
 *
 * Seat order is `state.playerOrder`, which is the same order the scenario's
 * `playerTemplates` are written in — that correspondence is the scenario
 * table's documented contract ("seat *n* here is `state.playerOrder[n]`"), and
 * it is what makes `CreateRequest.computerSeats` a list of ordinals rather than
 * a list of names the client would have to guess.
 *
 * The host takes the first seat the computer is not playing. A table where the
 * computer plays every seat is legal and leaves the host a spectator: it is a
 * demonstration, and refusing it would be an opinion rather than a rule.
 */
export const openingSeats = (
  summary: StateSummary,
  computerOrdinals: readonly number[] | undefined,
  hostId: string,
  hostName: string | undefined,
  now: number,
): SeatRow[] => {
  const computers = new Set(computerOrdinals ?? []);
  const rows = summary.playerOrder.map((id, ordinal): SeatRow => {
    const player = summary.players[id];
    return {
      seat: id,
      ordinal,
      faction: player?.faction ?? id,
      name: player?.name ?? id,
      kind: computers.has(ordinal) ? 'computer' : 'open',
      userId: null,
      lastSeen: null,
    };
  });

  const host = rows.find((r) => r.kind === 'open');
  if (host === undefined) return rows;
  return rows.map((r) =>
    r === host
      ? {
          ...r,
          kind: 'human' as SeatKind,
          userId: hostId,
          name: trimmed(hostName) ?? r.name,
          lastSeen: now,
        }
      : r,
  );
};

/**
 * Can this table begin?
 *
 * A seat nobody holds is a seat that will never move, and a game with one is
 * stuck the moment the turn reaches it. The rule is therefore not "enough
 * players" — the scenario already decided how many that is — but "no seat left
 * empty", which the host resolves either by waiting or by handing the seat to
 * the computer.
 */
export const readyToStart = (game: StoredGame): string | null => {
  if (game.status === 'finished') return 'this game is over';
  if (game.status !== 'lobby') return 'this game has already started';
  const empty = game.seats.filter((s) => s.kind === 'open');
  if (empty.length > 0) {
    return `${empty.map((s) => s.faction).join(', ')} ${
      empty.length === 1 ? 'is' : 'are'
    } still empty; fill the seat or give it to the computer`;
  }
  return null;
};

// ---------------------------------------------------------------------------
// The log, on the way to the database
// ---------------------------------------------------------------------------

/**
 * `by` is stored as its own column as well as inside `cmd`.
 *
 * Duplication, and worth it: it is the column an audit reads, and the one an
 * index would go on. The referee is the only writer and it takes both from the
 * same object, so they cannot disagree.
 */
export const logRow = (entry: LoggedCommand): Record<string, unknown> => ({
  idx: entry.idx,
  by: entry.cmd.by,
  cmd: entry.cmd,
  die: entry.die,
});

/** A row of the `commands` table, back in the shape the protocol describes. */
export const loggedFromDb = (row: {
  idx: number;
  cmd: AnyCommand;
  die: number;
}): LoggedCommand => ({
  idx: row.idx,
  cmd: row.cmd,
  die: Number(row.die),
});

// ---------------------------------------------------------------------------
// Dice and codes
// ---------------------------------------------------------------------------

/**
 * A generator seed from four unguessable bytes.
 *
 * The whole sealed-die argument rests on this number not being derivable from
 * anything a client holds, which is why the bytes come from
 * `crypto.getRandomValues` at the call site rather than from the state's own
 * generator. Taking it apart into a pure function is what lets the shift and
 * the mask be checked without a source of randomness in the room.
 */
export const dieFrom = (bytes: Uint8Array): number =>
  (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>>
  0;

// ---------------------------------------------------------------------------
// Answering a sync
// ---------------------------------------------------------------------------

/**
 * What this seat is entitled to, in the shape `SyncResponse` describes.
 *
 * "Exactly one of the two is present, and which one is not the client's choice
 * — it is `TableInfo.fog`." So the branch is on the stored game and nothing
 * else, and the caller loads only whichever half it turns out to need. A null
 * `open` for a game that is not fogged is the one exception, and it is a
 * fallback rather than a choice: it means the caller could not rebuild the
 * starting position, and a board somebody can still play is better than a log
 * with nothing to replay it onto.
 *
 * `initial` is sealed on the way out. It is the scenario's opening position,
 * rebuilt from the seed, and the generator it carries is the one the *setup*
 * left behind — a number that predicts nothing, but a number a player would be
 * entitled to assume predicts something. Replay does not need it either: every
 * entry in the log carries the seed it was rolled with.
 */
export const syncResponse = (
  game: StoredGame,
  seat: PlayerId | null,
  userId: string | null,
  now: number,
  open: { initial: AnyState | null; log: readonly LoggedCommand[] } | null,
  rules: KindRules,
): SyncResponse => {
  // The join code is what turns a game id into a seat, and "membership, not
  // knowledge, grants a read" is the rule the whole schema is built on. A
  // caller who reached this table by holding its id is not a member, so they do
  // not get the invitation: an id that leaks into a screenshot, a bug report or
  // a console log would otherwise be a standing offer of a chair.
  const full = tableInfo(game, userId, now);
  const table = seat === null ? { ...full, code: '' } : full;

  if (game.fog || open === null) {
    return {
      ok: true,
      table,
      seat,
      snapshot: viewFor(game, seat, undefined, rules),
      index: game.commandCount,
    };
  }
  return {
    ok: true,
    table,
    seat,
    // Absent on a tail sync, so the client can tell "here is the whole game"
    // from "here is what you missed" without inspecting indexes.
    ...(open.initial === null ? {} : { initial: rules.seal(open.initial) }),
    log: open.log,
    index: game.commandCount,
  };
};
