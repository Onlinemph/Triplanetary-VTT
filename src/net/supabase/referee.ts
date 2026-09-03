/**
 * The referee: every rules decision an online table makes, and no I/O.
 *
 * This is `server/room.ts`'s idea again, and for the same reason: the rules
 * loop is the part worth testing, and it is worth testing without a database
 * anywhere near it. Everything here is a pure function from a stored table and
 * an order to the rows that ought to be written. The Edge Function reads, calls
 * one of these, and writes; it decides nothing.
 *
 * Three jobs:
 *
 *  - **Judge an order.** Check the seat against the command's claimed author,
 *    then hand it to the game's own reducer, which has the last word. Being
 *    correctly seated does not make an illegal move legal.
 *  - **Roll the dice.** The referee rolls, not the players; see the sealed die
 *    in `protocol.ts`. The seed it used goes into the log so the game stays
 *    reproducible.
 *  - **Say who may know what.** Redact per seat for a fog game; seal the
 *    generator for every game.
 *
 * It also plays the computer's seats, because a solo game over the wire is the
 * same game as a two-player one: the AI's orders go through this same judge, on
 * the same terms, and a client is never asked to drive an opponent it could
 * lie about.
 *
 * Which game is on the table, the fleet game or the ground game, is a
 * `KindRules` (see `../kinds.ts`). Every function here takes one, and defaults
 * to Triplanetary so a caller that never heard of the other game need not
 * mention it.
 */

import { type GameMap, type PlayerId, DEFAULT_MAP } from '../../engine/index.js';
import { commandIsAuthorised } from '../redact.js';
import {
  type AnyCommand,
  type AnyState,
  type GameKind,
  type KindRules,
  authorOf,
  triRules,
  type StateSummary,
} from '../kinds.js';
import type { GameStatus, LoggedCommand, SeatInfo, SeatKind, TableInfo } from './protocol.js';

// ---------------------------------------------------------------------------
// What the store holds
// ---------------------------------------------------------------------------

export interface SeatRow {
  readonly seat: PlayerId;
  readonly ordinal: number;
  readonly faction: string;
  readonly name: string;
  readonly kind: SeatKind;
  /** The account holding it, or `null` while it is open. */
  readonly userId: string | null;
  /** Epoch milliseconds of the last call from this seat, for presence. */
  readonly lastSeen: number | null;
}

/**
 * A table as the database keeps it.
 *
 * `state` is authoritative and its generator is always sealed: the referee
 * rolls with a fresh seed per command and never with this one, so the number
 * stored here is deliberately meaningless.
 */
export interface StoredGame {
  readonly id: string;
  readonly code: string;
  /** Which game's rules run here. Absent means the fleet game. */
  readonly kind?: GameKind;
  /** True when the table has a password. The hash itself never leaves the store. */
  readonly locked?: boolean;
  readonly scenarioId: string;
  readonly fog: boolean;
  readonly status: GameStatus;
  readonly state: AnyState;
  readonly commandCount: number;
  readonly seats: readonly SeatRow[];
  readonly hostId: string;
}

/** How long a seat stays "present" after its last call. */
export const PRESENCE_MS = 45_000;

export const kindOf = (game: Pick<StoredGame, 'kind'>): GameKind => game.kind ?? 'tri';

/**
 * The rules for a table. The fleet game is always to hand; any other kind
 * has to be supplied by the caller, which is how the browser avoids carrying
 * an engine it is not using.
 */
const rulesOf = (game: Pick<StoredGame, 'kind'>, map: GameMap, rules?: KindRules): KindRules => {
  const kind = kindOf(game);
  if (rules !== undefined) {
    if (rules.kind !== kind) {
      throw new Error(`rules for "${rules.kind}" offered to a "${kind}" table`);
    }
    return rules;
  }
  if (kind === 'tri') return triRules(map);
  throw new Error(`no rules supplied for a "${kind}" table`);
};

// ---------------------------------------------------------------------------
// Reading a table
// ---------------------------------------------------------------------------

export const seatOf = (game: StoredGame, userId: string | null): PlayerId | null => {
  if (userId === null) return null;
  return game.seats.find((s) => s.userId === userId)?.seat ?? null;
};

export const tableInfo = (
  game: StoredGame,
  userId: string | null,
  now: number,
  rules?: KindRules,
): TableInfo => ({
  id: game.id,
  code: game.code,
  kind: kindOf(game),
  locked: game.locked ?? false,
  scenarioId: game.scenarioId,
  ...(rules ? described(game, rules) : {}),
  fog: game.fog,
  status: game.status,
  turn: game.state.turn,
  commandCount: game.commandCount,
  seats: [...game.seats]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s): SeatInfo => ({
      seat: s.seat,
      ordinal: s.ordinal,
      faction: s.faction,
      name: s.name,
      kind: s.kind,
      present: s.kind === 'computer' || (s.lastSeen !== null && now - s.lastSeen < PRESENCE_MS),
      mine: userId !== null && s.userId === userId,
    })),
});

/** What the referee can say about a table's setup that a lobby cannot work out itself. */
const described = (
  game: StoredGame,
  rules: KindRules,
): { title: string; brief: readonly string[] } => {
  const summary = rules.summary(game.state);
  return { title: summary.title, brief: summary.brief };
};

/**
 * A table's setup, changed from its lobby.
 *
 * The board is the new opening position; the roster is rebuilt from its
 * seats. Whoever held a seat keeps the one at the same ordinal — the host and
 * an early joiner stay where they were across a change of scenario — unless
 * that seat is now the computer's, in which case they are stood up. The host
 * must stay seated, so a host whose seat went to the computer takes the first
 * open one. Nothing here touches the store; the caller writes what comes back.
 */
export const reconfigure = (
  game: StoredGame,
  scenarioId: string,
  opening: AnyState,
  summary: StateSummary,
  computerOrdinals: readonly number[] | undefined,
  now: number,
):
  | { readonly ok: true; readonly game: StoredGame }
  | { readonly ok: false; readonly reason: string } => {
  if (game.status !== 'lobby') return { ok: false, reason: 'the table has already begun' };
  const computers = new Set(computerOrdinals ?? []);
  const seats: SeatRow[] = summary.playerOrder.map((id, ordinal): SeatRow => {
    const player = summary.players[id];
    const before = game.seats.find((s) => s.ordinal === ordinal);
    const held =
      before !== undefined &&
      before.kind === 'human' &&
      before.userId !== null &&
      !computers.has(ordinal);
    return {
      seat: id,
      ordinal,
      faction: player?.faction ?? id,
      name: held ? before.name : (player?.name ?? id),
      kind: computers.has(ordinal) ? 'computer' : held ? 'human' : 'open',
      userId: held ? before.userId : null,
      lastSeen: held ? (before.lastSeen ?? now) : null,
    };
  });
  if (!seats.some((s) => s.userId === game.hostId)) {
    const idx = seats.findIndex((s) => s.kind === 'open');
    if (idx < 0) return { ok: false, reason: 'the host needs a seat that is not the computer’s' };
    const was = game.seats.find((s) => s.userId === game.hostId);
    seats[idx] = {
      ...seats[idx]!,
      kind: 'human',
      userId: game.hostId,
      name: was?.name ?? seats[idx]!.name,
      lastSeen: now,
    };
  }
  return {
    ok: true,
    game: { ...game, scenarioId, fog: summary.fog, state: opening, commandCount: 0, seats },
  };
};

/**
 * The board as one seat is entitled to see it.
 *
 * Two filters, and the second applies to every game. `redact` removes what
 * fog hides; `seal` removes the generator, which no player may hold whether
 * the game is fogged or not.
 */
export const viewFor = (
  game: StoredGame,
  seat: PlayerId | null,
  map: GameMap = DEFAULT_MAP,
  rules?: KindRules,
): AnyState => {
  const r = rulesOf(game, map, rules);
  return r.seal(r.redact(game.state, seat));
};

/** Every seat's view, for the fog-of-war write-out. Spectators read `null`. */
export const viewsForAll = (
  game: StoredGame,
  map: GameMap = DEFAULT_MAP,
  rules?: KindRules,
): Record<string, AnyState> => {
  const out: Record<string, AnyState> = {};
  for (const s of game.seats) out[s.seat] = viewFor(game, s.seat, map, rules);
  return out;
};

// ---------------------------------------------------------------------------
// Judging an order
// ---------------------------------------------------------------------------

export interface Accepted {
  readonly ok: true;
  readonly game: StoredGame;
  readonly logged: LoggedCommand;
  /** Per-seat snapshots to write, for a fog game. Empty for an open one. */
  readonly views: Record<string, AnyState>;
}

export interface Refused {
  readonly ok: false;
  readonly reason: string;
}

export type Judgement = Accepted | Refused;

/**
 * Apply one order on behalf of one seat.
 *
 * Three gates, in order, and the order matters. A spectator is turned away
 * before anything else looks at the command. A seated player may not act for
 * another seat: `commandIsAuthorised` is the check a relay cannot do, because
 * over a relay `by` is just a string somebody typed. And then the rules decide,
 * which is the only gate that knows anything about the game, including, in
 * the ground game, that a deployment step or an overrun hands the decision to
 * somebody other than the phasing player.
 *
 * `die` is the generator seed to roll this command with. The caller draws it
 * from a source no player can see; it is returned in `logged` so that replaying
 * the log reproduces the game roll for roll.
 */
export const judge = (
  game: StoredGame,
  seat: PlayerId | null,
  cmd: AnyCommand,
  die: number,
  map: GameMap = DEFAULT_MAP,
  rules?: KindRules,
): Judgement => {
  if (game.status === 'finished') return { ok: false, reason: 'this game is over' };
  if (game.status !== 'playing') return { ok: false, reason: 'this game has not started' };

  const by = authorOf(cmd);
  if (!commandIsAuthorised(seat, by)) {
    return {
      ok: false,
      reason:
        seat === null
          ? 'spectators may not issue commands'
          : `you hold the seat "${seat}" and may not act for "${by}"`,
    };
  }

  return resolve(game, cmd, die, rulesOf(game, map, rules));
};

/**
 * Apply a command that has already cleared the seat check.
 *
 * Split out because the referee's own computer seats have no seat check to
 * clear (they are the referee) but must be judged by the rules on exactly the
 * same terms as anybody else.
 */
const resolve = (game: StoredGame, cmd: AnyCommand, die: number, rules: KindRules): Judgement => {
  // Roll with the seed the caller drew, never with the stored one.
  const out = rules.apply(game.state, cmd, die);
  if (!out.ok) return { ok: false, reason: out.reason };

  const next: StoredGame = {
    ...game,
    // Seal it straight back: the stored generator must never be a number a
    // future roll depends on, or a leak of the state becomes a leak of the dice.
    state: rules.seal(out.state),
    commandCount: game.commandCount + 1,
    status: rules.summary(out.state).finished ? 'finished' : game.status,
  };
  return {
    ok: true,
    game: next,
    logged: { idx: next.commandCount, cmd, die: die >>> 0 },
    views: game.fog ? viewsForAll(next, DEFAULT_MAP, rules) : {},
  };
};

// ---------------------------------------------------------------------------
// The computer's seats
// ---------------------------------------------------------------------------

/**
 * Play out every order the computer's seats owe, one at a time.
 *
 * Run after each human order and when the game starts, so a solo table advances
 * without the browser being asked to drive an opponent. The AI decides against
 * the same view a person in that seat would get, and every order it gives is
 * judged by {@link resolve}, so it is refused on exactly the terms a person's
 * would be. An order the rules refuse is skipped rather than retried: the
 * ground game's planner may name a target the previous order destroyed, and
 * the plan still ends with the order that moves the game on.
 *
 * `dice` supplies a fresh seed per order. It is a function rather than a list
 * because the number of orders is not known until they are given.
 */
export const playComputerSeats = (
  game: StoredGame,
  dice: () => number,
  map: GameMap = DEFAULT_MAP,
  limit = 400,
  rules?: KindRules,
): { game: StoredGame; logged: LoggedCommand[]; views: Record<string, AnyState> } => {
  const r = rulesOf(game, map, rules);
  const computers = new Set(game.seats.filter((s) => s.kind === 'computer').map((s) => s.seat));
  const logged: LoggedCommand[] = [];
  let current = game;
  if (computers.size === 0 || current.status !== 'playing') {
    return { game: current, logged, views: {} };
  }

  let steps = 0;
  outer: for (let round = 0; round < limit; round += 1) {
    if (current.status !== 'playing') break;
    const orders = r.computerOrders(current.state, computers);
    if (orders.length === 0) break;
    let moved = false;
    for (const order of orders) {
      if (steps >= limit || current.status !== 'playing') break outer;
      steps += 1;
      const out = resolve(current, order, dice(), r);
      if (!out.ok) continue; // The board changed under the plan; the next order may still stand.
      moved = true;
      current = out.game;
      logged.push(out.logged);
    }
    // A plan the rules refused wholesale would loop forever; ask again only
    // when something changed.
    if (!moved) break;
  }

  return {
    game: current,
    logged,
    views: current.fog && logged.length > 0 ? viewsForAll(current, map, r) : {},
  };
};

// ---------------------------------------------------------------------------
// Catching up
// ---------------------------------------------------------------------------

/**
 * Replay a log onto a starting position.
 *
 * The audit path, and the one a client walks on every open-information sync.
 * Each entry carries the seed it was rolled with, so this reproduces the game
 * exactly, including the dice, from data that reveals nothing about the next
 * roll.
 */
export const replayLog = (
  initial: AnyState,
  log: readonly LoggedCommand[],
  map: GameMap = DEFAULT_MAP,
  rules: KindRules = triRules(map),
): { state: AnyState; failed: LoggedCommand | null } => {
  let state = initial;
  for (const entry of [...log].sort((a, b) => a.idx - b.idx)) {
    const out = rules.apply(state, entry.cmd, entry.die >>> 0);
    if (!out.ok) return { state, failed: entry };
    state = out.state;
  }
  return { state: rules.seal(state), failed: null };
};

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

export interface SeatChange {
  readonly ok: boolean;
  readonly reason?: string;
  readonly seats?: readonly SeatRow[];
  readonly seat?: PlayerId | null;
}

/**
 * Sit somebody down.
 *
 * A seat with a live holder is not available; one whose holder left is, which
 * is how a reconnect resumes a game rather than starting a spectator session.
 * Asking for no seat in particular takes the lowest open one, so the common
 * case, a friend following a link, is a single click.
 */
export const takeSeat = (
  game: StoredGame,
  userId: string,
  wanted: PlayerId | null | undefined,
  name: string | undefined,
  now: number,
): SeatChange => {
  const already = game.seats.find((s) => s.userId === userId);
  if (already && (wanted === undefined || wanted === already.seat)) {
    return { ok: true, seats: touch(game.seats, already.seat, now), seat: already.seat };
  }
  if (wanted === null) return { ok: true, seats: game.seats, seat: null };

  // Changing seats mid-game is a fog attack wearing a reconnect's clothes. The
  // referee keeps a fresh snapshot in `views` for every seat, vacated ones
  // included, so an opponent who steps away leaves their board sitting in a
  // chair anybody may sit in: hop across, read it, hop back, and the only trace
  // is a flicker in the roster. Before the game starts there is nothing in
  // those rows to read, which is the whole of the difference.
  if (already && game.status !== 'lobby') {
    return { ok: false, reason: 'you cannot change seats once the game has started' };
  }

  const open = [...game.seats]
    .sort((a, b) => a.ordinal - b.ordinal)
    .filter((s) => s.kind !== 'computer' && (s.userId === null || s.userId === userId));
  const target = wanted === undefined ? open[0] : open.find((s) => s.seat === wanted);
  if (!target) {
    return {
      ok: false,
      reason: wanted === undefined ? 'this table is full' : 'that seat is taken',
    };
  }

  const seats = game.seats.map((s) => {
    if (s.seat === target.seat) {
      return {
        ...s,
        userId,
        kind: 'human' as SeatKind,
        name: name && name.trim() !== '' ? name.trim() : s.name,
        lastSeen: now,
      };
    }
    // One account, one seat: taking a new one vacates the old. `lastSeen` has
    // to go with it. Presence is "somebody is sitting here and we heard from
    // them", and a vacated seat that keeps its timestamp shows a green dot over
    // an empty chair for the next PRESENCE_MS.
    return s.userId === userId
      ? { ...s, userId: null, kind: 'open' as SeatKind, lastSeen: null }
      : s;
  });
  return { ok: true, seats, seat: target.seat };
};

/**
 * Take a seat back, whoever holds it.
 *
 * The password proved the caller belongs at this table; the seat's name says
 * which chair is theirs. Whoever was sitting there, most likely the caller's
 * own previous browser, is dropped, and any other seat the caller held is
 * vacated. Only a table with a password may do this: on a code-only table the
 * code is public knowledge and this would be a way to take anybody's seat.
 */
export const reclaimSeat = (
  game: StoredGame,
  userId: string,
  wanted: PlayerId,
  name: string | undefined,
  now: number,
): SeatChange => {
  if (!(game.locked ?? false)) {
    return { ok: false, reason: 'this table has no password, so a seat cannot be reclaimed' };
  }
  const target = game.seats.find((s) => s.seat === wanted);
  if (!target) return { ok: false, reason: 'no such seat' };
  if (target.kind === 'computer') return { ok: false, reason: 'the computer holds that seat' };
  const seats = game.seats.map((s) => {
    if (s.seat === wanted) {
      return {
        ...s,
        userId,
        kind: 'human' as SeatKind,
        name: name && name.trim() !== '' ? name.trim() : s.name,
        lastSeen: now,
      };
    }
    return s.userId === userId
      ? { ...s, userId: null, kind: 'open' as SeatKind, lastSeen: null }
      : s;
  });
  return { ok: true, seats, seat: wanted };
};

/** Stand up, leaving the seat for somebody else. Computer seats are not held. */
export const leaveSeat = (game: StoredGame, userId: string): readonly SeatRow[] =>
  game.seats.map((s) =>
    s.userId === userId ? { ...s, userId: null, kind: 'open' as SeatKind, lastSeen: null } : s,
  );

const touch = (seats: readonly SeatRow[], seat: PlayerId, now: number): SeatRow[] =>
  seats.map((s) => (s.seat === seat ? { ...s, lastSeen: now } : s));

/** Mark a seat as heard from, for the presence dot in the roster. */
export const seenNow = (
  game: StoredGame,
  seat: PlayerId | null,
  now: number,
): readonly SeatRow[] => (seat === null ? game.seats : touch(game.seats, seat, now));

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * A table's password, as the store keeps it: `v1$<salt>$<sha-256>`, the salt
 * fresh per table. Not a slow hash, deliberately: a join costs a throttled
 * round trip to the referee, which is the defence against guessing, and a
 * game password among friends is not a bank vault. Web Crypto, so the same
 * code runs in Deno and in a test.
 */
const HASH_VERSION = 'v1';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const digest = async (salt: string, password: string): Promise<string> => {
  const data = new TextEncoder().encode(`${salt} ${password}`);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `${HASH_VERSION}$${salt}$${await digest(salt, password)}`;
};

/**
 * True when `given` opens a table whose stored password is `stored`. A table
 * with none opens to anything.
 */
export const verifyPassword = async (stored: string | null, given: string): Promise<boolean> => {
  if (stored === null || stored === '') return true;
  const [version, salt, hash] = stored.split('$');
  if (version !== HASH_VERSION || salt === undefined || hash === undefined) return false;
  return (await digest(salt, given)) === hash;
};

/** Empty means no password. */
export const wantsPassword = (password: string | undefined): boolean =>
  typeof password === 'string' && password !== '';

// ---------------------------------------------------------------------------
// Join codes
// ---------------------------------------------------------------------------

/**
 * The alphabet a join code is read aloud in.
 *
 * No `0/O`, no `1/I/L`: a code exists to be typed from somebody else's screen
 * or repeated down a phone, and the characters people confuse are the ones to
 * leave out.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** Build a code from a caller-supplied source of randomness. */
export const codeFrom = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
};

export const isCode = (value: string): boolean =>
  value.length === CODE_LENGTH && [...value].every((c) => CODE_ALPHABET.includes(c));
