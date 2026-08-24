/**
 * The browser side of a Supabase table.
 *
 * `GameClient` in `../client.ts` does this job against a relay it opened
 * itself. Here there is no socket to own: the referee is an Edge Function that
 * answers one HTTP call, and what it decided arrives afterwards as rows on a
 * Realtime channel. The same shape as the relay client, over different
 * plumbing — sign in, sit down, give orders, hear what happened, and survive
 * the connection dropping in the middle of it.
 *
 * ## Nothing is applied optimistically
 *
 * `GameClient` applies a command the moment it sends it, because over a relay
 * the client's engine and the server's engine roll the same dice out of the
 * same seed. Here they cannot. "The referee draws a fresh, unguessable seed for
 * every command", and the client is not told what it was until the command has
 * been resolved, so an optimistic apply would be a guess at the dice. It would
 * also be wrong exactly when being wrong costs the most: showing a hit and
 * taking it back half a second later, on the one shot the game turned on. The
 * board therefore moves when the referee's row comes back carrying the die it
 * was rolled with, and not before.
 *
 * ## The next expected index
 *
 * Realtime is not a queue. A row can arrive twice, arrive late, or never arrive
 * at all while a laptop lid is shut, and a client that applies whatever turns up
 * ends with a board nobody else has — silently, which is the worst way for a
 * table to break. So every row's index is checked against the one this client
 * expects next:
 *
 *  - behind it — already applied, drop it;
 *  - exactly it — apply, with the die the row carries;
 *  - ahead of it — something was missed, so fetch the tail instead of applying
 *    out of order.
 *
 * A snapshot needs no such rule, because a snapshot is complete in itself: a fog
 * client adopts any view newer than the one it holds and asks no questions.
 *
 * ## The session becomes a view
 *
 * Both modes push state in through `GameSession.adoptSnapshot`, which turns the
 * session's undo and local replay off. That is right for an online table:
 * rewinding this client rewinds nothing at anybody else's, and the referee's log
 * is the only history that exists. The log the session can no longer keep is
 * kept here instead, with its dice, because that is the only form of it that
 * reproduces the game.
 *
 * ## No login form
 *
 * Two friends who want to fly a scenario should not have to make accounts
 * first, so the client signs in anonymously and plays under a name derived from
 * the account id. Anonymous is still authenticated, which is the part that
 * matters: the referee reads the seat off the JWT, and the policies grant `anon`
 * — a caller with no session at all — nothing whatsoever.
 */

import type { Command, GameState, PlayerId } from '../../engine/index.js';
import type { GameSession } from '../session.js';
import { isCommand } from '../transport.js';
import {
  type CreateRequest,
  type ErrorResponse,
  type LoggedCommand,
  type PlayRequest,
  type PlayResponse,
  type SeatInfo,
  type SyncResponse,
  type TableInfo,
  type TableResponse,
  TABLES,
  channelFor,
  request,
} from './protocol.js';
import { replayLog } from './referee.js';

// ---------------------------------------------------------------------------
// The slice of supabase-js this client uses
// ---------------------------------------------------------------------------

/**
 * What a Supabase client has to provide, and nothing more.
 *
 * Written as a narrow structural type rather than taking `SupabaseClient`
 * directly, for the reason `SocketLike` exists in `transport.ts`: a test has to
 * be able to hand this class an object it wrote by hand and drive it. A real
 * `SupabaseClient` satisfies this, and `tests/supabase-client.test.ts` asserts
 * so at compile time, so the narrowing cannot quietly drift from the library.
 */
export interface SupabaseLike {
  readonly functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): Promise<{ data: unknown; error: unknown }>;
  };
  readonly auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null } }>;
    signInAnonymously(): Promise<{
      data: { user: { id: string } | null };
      error: { message: string } | null;
    }>;
  };
  channel(name: string): ChannelLike;
  /** Unsubscribes *and* forgets the channel; `unsubscribe` alone leaks it. */
  removeChannel(channel: ChannelLike): Promise<unknown>;
}

export interface PostgresChangeFilter {
  readonly event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly schema: string;
  readonly table?: string;
  readonly filter?: string;
}

export interface ChannelLike {
  /**
   * The payload is `unknown` on purpose. It is data off the network, and this
   * module treats it as such: the row is picked out and validated by hand, the
   * way `transport.ts` validates a frame. Typing it also keeps the interface
   * assignable from the library's overloaded `on`, whose payload type is
   * generic.
   */
  on(
    type: 'postgres_changes',
    filter: PostgresChangeFilter,
    callback: (payload: unknown) => void,
  ): ChannelLike;
  /** `status` is a plain string so a string enum from the library fits it. */
  subscribe(callback?: (status: string, err?: Error) => void): ChannelLike;
  unsubscribe(): Promise<unknown>;
}

/** The subscription states this client reacts to, from `REALTIME_SUBSCRIBE_STATES`. */
/**
 * How often a spectator asks for the board.
 *
 * Only a spectator: everybody with a seat is pushed their rows. Five seconds is
 * slow enough to be free and fast enough that watching a turn-based game does
 * not feel like reading a printout.
 */
const WATCH_MS = 5_000;

const SUBSCRIBED = 'SUBSCRIBED';
const DROPPED: readonly string[] = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

// ---------------------------------------------------------------------------
// Options and callbacks
// ---------------------------------------------------------------------------

export type TableConnection = 'closed' | 'connecting' | 'open';

export interface TableClientOptions {
  /** The Edge Function holding the service role. */
  readonly functionName?: string;
  /** The name to sit down under. Defaults to one made from the account id. */
  readonly name?: string;
  /** First resubscribe delay, doubled on each failure. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly backoffFactor?: number;
  readonly random?: () => number;
  /**
   * How long to wait for a row the referee has already told us it wrote before
   * going and fetching it. Realtime dropping one row is rarer than Realtime
   * dropping the whole channel, and much harder to notice.
   */
  readonly catchUpMs?: number;
}

export interface TableClientEvents {
  onSeat?: (seat: PlayerId | null) => void;
  /** The roster, and the table it belongs to: status, turn, join code. */
  onTable?: (table: TableInfo) => void;
  onConnection?: (state: TableConnection) => void;
  /** Something the referee refused, with the reason it gave. */
  onRejected?: (reason: string, cmd?: Command) => void;
}

/** Everything `create` needs; the protocol's request minus its envelope. */
export type CreateOptions = Omit<CreateRequest, 'action' | 'v'>;

// ---------------------------------------------------------------------------
// Reading what the network sends
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A Postgres `bigint` reaches JavaScript as a number from some encoders and a
 * string from others. `die` is a 32-bit seed and `idx` a log position, so both
 * are exact either way; what matters is not silently reading `NaN`.
 */
const numberOf = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** The changed row out of a `postgres_changes` payload. */
const rowOf = (payload: unknown): Record<string, unknown> | null => {
  if (!isRecord(payload)) return null;
  const row = payload['new'];
  return isRecord(row) ? row : null;
};

/**
 * Is this plausibly a `GameState`?
 *
 * Not a full validation — the engine would reject a malformed board on the
 * first command anyway. The case this actually catches is a Realtime row that
 * came through truncated, because a whole board is a large `jsonb` value and
 * the replication stream has a size limit. A client that adopted the truncated
 * half would render an empty map; one that notices asks for the row instead.
 */
const looksLikeState = (v: unknown): v is GameState =>
  isRecord(v) &&
  typeof v['turn'] === 'number' &&
  typeof v['scenarioId'] === 'string' &&
  isRecord(v['ships']) &&
  isRecord(v['players']) &&
  isRecord(v['rng']);

const loggedFrom = (row: Record<string, unknown>): LoggedCommand | null => {
  const idx = numberOf(row['idx']);
  const die = numberOf(row['die']);
  const cmd = row['cmd'];
  if (idx === null || die === null || !isCommand(cmd)) return null;
  return { idx, cmd, die: die >>> 0 };
};

const isPlayResponse = (v: unknown): v is PlayResponse => {
  if (!isRecord(v)) return false;
  if (v['ok'] === true) return true;
  return v['ok'] === false && typeof v['reason'] === 'string';
};

/**
 * Which of the three success shapes came back.
 *
 * They are distinguished by what they carry, not by a tag: only a sync response
 * has both the table and the log index it reflects, and only an accepted
 * command has an index without a table.
 */
const isSyncResponse = (v: PlayResponse): v is SyncResponse => v.ok && 'table' in v && 'index' in v;

const isTableResponse = (v: PlayResponse): v is TableResponse => v.ok && 'table' in v;

const refused = (reason: string): ErrorResponse => ({ ok: false, reason });

/**
 * A refusal the Edge Function sent with a non-2xx status.
 *
 * `functions.invoke` turns any non-2xx into an error and throws the body away,
 * keeping the `Response` on `error.context`. The referee's reason is in that
 * body, and a reason is the entire value of a refusal to the player, so it is
 * worth digging out.
 */
const refusalFrom = async (error: unknown): Promise<ErrorResponse | null> => {
  if (!isRecord(error)) return null;
  const context = error['context'];
  if (!isRecord(context) || typeof context['json'] !== 'function') return null;
  try {
    const body: unknown = await (context as { json: () => Promise<unknown> }).json();
    return isPlayResponse(body) && !body.ok ? body : null;
  } catch {
    // A body that is not JSON tells us nothing the message does not.
    return null;
  }
};

const messageOf = (error: unknown): string => {
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return 'the referee could not be reached';
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class TableClient {
  private readonly settings: Required<
    Pick<
      TableClientOptions,
      'functionName' | 'minBackoffMs' | 'maxBackoffMs' | 'backoffFactor' | 'random' | 'catchUpMs'
    >
  >;

  private chosenName: string | null;
  private account: string | null = null;

  private game: string | null = null;
  private info: TableInfo | null = null;
  private mySeat: PlayerId | null = null;
  private link: TableConnection = 'closed';

  /**
   * The referee's starting position, for an open-information game only. Null in
   * a fog game, and the flag this client reads to know which it is playing:
   * without a starting position there is nothing to replay a command onto.
   */
  private origin: GameState | null = null;
  private entries: LoggedCommand[] = [];
  /** The board this client believes in, sealed exactly as the referee stores it. */
  private board: GameState | null = null;
  /** The highest log index applied here. */
  private applied = 0;
  /** The highest log index the referee has admitted to, applied or not. */
  private announced = 0;

  private channel: ChannelLike | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private catchUp: ReturnType<typeof setTimeout> | null = null;
  /** Set only while this client holds no seat; see `startWatching`. */
  private watch: ReturnType<typeof setInterval> | null = null;
  private backoff: number;
  private attempts = 0;
  private closed = false;
  private seq = 0;

  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  constructor(
    private readonly supabase: SupabaseLike,
    private readonly session: GameSession,
    options: TableClientOptions = {},
    private readonly events: TableClientEvents = {},
  ) {
    this.settings = {
      functionName: options.functionName ?? 'game',
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      backoffFactor: options.backoffFactor ?? 2,
      random: options.random ?? Math.random,
      catchUpMs: options.catchUpMs ?? 2_000,
    };
    this.chosenName = options.name ?? null;
    this.backoff = this.settings.minBackoffMs;
  }

  // -- Reading --------------------------------------------------------------

  get seat(): PlayerId | null {
    return this.mySeat;
  }

  get table(): TableInfo | null {
    return this.info;
  }

  get roster(): readonly SeatInfo[] {
    return this.info?.seats ?? [];
  }

  get gameId(): string | null {
    return this.game;
  }

  get connection(): TableConnection {
    return this.link;
  }

  get userId(): string | null {
    return this.account;
  }

  /** True once this client is being fed snapshots rather than commands. */
  get snapshotMode(): boolean {
    return this.board !== null && this.origin === null;
  }

  /** The highest log index this client has applied. */
  get index(): number {
    return this.applied;
  }

  /**
   * The log, with the dice. Empty in a fog game, where the client is not
   * allowed the commands that produced the board it is looking at.
   */
  get history(): readonly LoggedCommand[] {
    return this.entries;
  }

  /**
   * The name this client plays under.
   *
   * Anonymous accounts have no name to offer, so one is made from the account
   * id. Two strangers at the same table then read as "Pilot 4F2K" and "Pilot
   * 9QX1" rather than as two identical blanks.
   */
  get name(): string {
    if (this.chosenName !== null && this.chosenName.trim() !== '') return this.chosenName.trim();
    const id = (this.account ?? '').replace(/-/g, '');
    return id === '' ? 'Pilot' : `Pilot ${id.slice(0, 4).toUpperCase()}`;
  }

  setName(name: string): void {
    this.chosenName = name;
  }

  // -- Sitting down ---------------------------------------------------------

  /**
   * Get an account, making an anonymous one if there is none.
   *
   * Idempotent, and called by everything that talks to the referee, because the
   * JWT is what the referee reads the seat off; without one every call is a
   * spectator's.
   */
  async signIn(): Promise<string> {
    if (this.account !== null) return this.account;
    const current = await this.supabase.auth.getSession();
    const existing = current.data.session?.user.id ?? null;
    if (existing !== null && existing !== '') {
      this.account = existing;
      return existing;
    }
    const fresh = await this.supabase.auth.signInAnonymously();
    const id = fresh.data.user?.id ?? null;
    if (id === null || id === '') {
      throw new Error(`could not sign in: ${fresh.error?.message ?? 'no session came back'}`);
    }
    this.account = id;
    return id;
  }

  async create(options: CreateOptions): Promise<TableInfo> {
    await this.signIn();
    const res = await this.call(
      request({ action: 'create', ...options, name: options.name ?? this.name }),
    );
    return this.enter(res);
  }

  async join(code: string, seat?: PlayerId | null): Promise<TableInfo> {
    await this.signIn();
    const res = await this.call(request({ action: 'join', code, seat, name: this.name }));
    return this.enter(res);
  }

  /** Close the lobby and begin. The referee refuses this from anyone but the host. */
  async start(): Promise<void> {
    const gameId = this.requireGame();
    const res = await this.call(request({ action: 'start', gameId }));
    if (!res.ok) throw new Error(res.reason);
    await this.sync();
  }

  /**
   * Stand up, and stop watching. The seat is left open for somebody else, so
   * there is nothing further to hear about; a client that wants to spectate
   * joins again with a `null` seat.
   */
  async leave(): Promise<void> {
    const gameId = this.game;
    if (gameId === null) return;
    try {
      await this.call(request({ action: 'leave', gameId }));
    } finally {
      this.close();
      this.game = null;
      this.info = null;
      this.setSeat(null);
    }
  }

  // -- Playing --------------------------------------------------------------

  /**
   * Give an order.
   *
   * Deliberately does not touch the board. See the module comment: the die this
   * command will be rolled with does not exist yet, so there is nothing honest
   * to show until the referee's row comes back. Returns whether the referee
   * took it; a refusal also reaches `onRejected` with the reason.
   */
  async send(cmd: Command): Promise<boolean> {
    const gameId = this.game;
    if (gameId === null) {
      this.events.onRejected?.('not at a table', cmd);
      return false;
    }
    const seq = ++this.seq;
    const res = await this.call(request({ action: 'command', gameId, cmd, seq }));
    if (!res.ok) {
      this.events.onRejected?.(res.reason, cmd);
      return false;
    }
    // The answer says how long the log now is. If the row for it has not turned
    // up shortly, Realtime lost it and the table would otherwise sit still.
    if ('index' in res && typeof res.index === 'number') {
      this.announced = Math.max(this.announced, res.index);
      this.armCatchUp();
    }
    return true;
  }

  /**
   * Fetch everything this seat is entitled to and apply it.
   *
   * Serialised: two syncs in flight can land out of order, and the loser would
   * install an older board than the one already showing. A request arriving
   * while one is running sets a flag and the loop goes round again.
   */
  sync(): Promise<void> {
    if (this.syncing !== null) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = this.pump();
    return this.syncing;
  }

  /** Stop listening. The session and the Supabase client are the caller's. */
  close(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    if (this.catchUp !== null) clearTimeout(this.catchUp);
    this.catchUp = null;
    this.dropChannel();
    this.stopWatching();
    this.setConnection('closed');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireGame(): string {
    const gameId = this.game;
    if (gameId === null) throw new Error('not at a table');
    return gameId;
  }

  private async enter(res: PlayResponse): Promise<TableInfo> {
    if (!res.ok) throw new Error(res.reason);
    if (!isTableResponse(res)) throw new Error('the referee did not say which table');
    this.closed = false;
    this.game = res.table.id;
    this.setSeat(res.seat);
    this.setTable(res.table);
    this.listen();
    // Sync now rather than waiting for the subscription to come up: the channel
    // may never come up, and a lobby that renders nothing is worse than one
    // that renders and then stops updating.
    await this.sync();
    return this.info ?? res.table;
  }

  private async call(body: PlayRequest): Promise<PlayResponse> {
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await this.supabase.functions.invoke(this.settings.functionName, {
        // Spread rather than passed through: the library asks for a plain
        // record, and a request is an interface, which has no index signature.
        body: { ...body },
      }));
    } catch (err) {
      return refused(messageOf(err));
    }
    if (error != null) {
      return (await refusalFrom(error)) ?? refused(messageOf(error));
    }
    return isPlayResponse(data) ? data : refused('the referee sent something unreadable');
  }

  // -- Sync -----------------------------------------------------------------

  private async pump(): Promise<void> {
    try {
      do {
        this.syncAgain = false;
        await this.fetch();
      } while (this.syncAgain && !this.closed);
    } finally {
      this.syncing = null;
    }
  }

  /**
   * One round trip. `since` is what we already hold, so an open game normally
   * gets an empty tail back and a fog game gets its current view.
   */
  private async fetch(from?: number): Promise<void> {
    const gameId = this.game;
    if (gameId === null) return;
    const since = from ?? (this.origin === null ? 0 : this.applied);
    const res = await this.call(request({ action: 'sync', gameId, since }));
    if (!res.ok) {
      this.events.onRejected?.(res.reason);
      return;
    }
    if (!isSyncResponse(res)) return;
    const complete = this.absorb(res);
    // The tail did not join onto what we hold. Ask for the whole thing once,
    // which is the only other move available and always works.
    if (!complete && since > 0) await this.fetch(0);
  }

  /**
   * Take a sync response. Returns false when what came back does not join onto
   * what this client holds, and the caller should ask for everything.
   */
  private absorb(res: SyncResponse): boolean {
    this.setSeat(res.seat);
    this.setTable(res.table);
    this.announced = Math.max(this.announced, res.index);

    if (res.snapshot !== undefined) {
      this.adoptSnapshot(res.snapshot, res.index);
      return true;
    }

    // A full sync — the starting position and a log that begins at the start of
    // the game. The referee only sends `initial` for `since === 0`, but the
    // index is checked here too: replaying a *tail* onto the opening board
    // would silently reset the game to turn one while every counter reported
    // being caught up, which is the worst shape a desynchronisation can take.
    const tail = [...(res.log ?? [])].sort((a, b) => a.idx - b.idx);
    if (res.initial !== undefined && (tail[0]?.idx ?? 1) === 1) {
      const log = tail;
      const { state, failed } = replayLog(res.initial, log, this.session.map);
      this.origin = res.initial;
      this.board = state;
      if (failed !== null) {
        // The referee's log does not replay here. Either this build's rules
        // differ from the referee's or the log is not what it claims; say so
        // rather than showing a board no other player has.
        this.entries = log.filter((e) => e.idx < failed.idx);
        this.applied = failed.idx - 1;
        this.session.adoptSnapshot(state);
        this.events.onRejected?.('the log does not replay in this build', failed.cmd);
        return true;
      }
      this.entries = log;
      // What was actually replayed, not what the referee said its log length
      // was. `index` is read from `games.command_count` several awaits before
      // the log is, so a command committing in that window makes the two
      // disagree — and trusting `index` there re-applies a command already in
      // the board. `announced` is separately kept at the maximum, so a referee
      // running ahead still reads as a gap and re-syncs, which is the safe way
      // round.
      this.applied = log[log.length - 1]?.idx ?? 0;
      this.session.adoptSnapshot(state);
      return true;
    }

    if (this.board === null) return false; // A tail with nothing to apply it to.
    return this.applyTail(tail, res.index);
  }

  private applyTail(log: readonly LoggedCommand[], index: number): boolean {
    for (const entry of [...log].sort((a, b) => a.idx - b.idx)) {
      if (entry.idx <= this.applied) continue;
      if (entry.idx !== this.applied + 1) return false;
      if (!this.applyLogged(entry)) return false;
    }
    // The referee says the log is longer than what it just sent us.
    return this.applied >= index;
  }

  /**
   * Apply one logged command, rolled with the die the referee rolled it with.
   *
   * Through `replayLog` rather than a private copy of the same three lines: it
   * is the function the referee itself replays with, and a client that reseeded
   * the generator its own way would be a second implementation of the one rule
   * the whole audit trail rests on.
   */
  private applyLogged(entry: LoggedCommand): boolean {
    const board = this.board;
    if (board === null) return false;
    const { state, failed } = replayLog(board, [entry], this.session.map);
    if (failed !== null) {
      this.events.onRejected?.('the referee accepted a command this build refuses', entry.cmd);
      return false;
    }
    this.board = state;
    this.entries.push(entry);
    this.applied = entry.idx;
    this.announced = Math.max(this.announced, entry.idx);
    this.session.adoptSnapshot(state);
    return true;
  }

  /**
   * Take a redacted view whole.
   *
   * The command log is dropped with it: a fog client cannot hold the commands
   * that produced this board, because replaying them would need the very thing
   * the fog withholds.
   */
  private adoptSnapshot(state: GameState, index: number): void {
    this.origin = null;
    this.entries = [];
    this.board = state;
    this.applied = index;
    this.session.adoptSnapshot(state);
  }

  // -- Rows -----------------------------------------------------------------

  private onCommandRow(payload: unknown): void {
    if (this.closed) return;
    const row = rowOf(payload);
    const entry = row === null ? null : loggedFrom(row);
    if (entry === null) {
      // A row we cannot read is still evidence the log moved.
      void this.sync();
      return;
    }
    this.announced = Math.max(this.announced, entry.idx);
    if (entry.idx <= this.applied) return; // Realtime can deliver the same row twice.
    if (this.origin === null) {
      // No starting position, so nothing to replay onto: this is a fog table
      // and the board arrives as a view, not as a command.
      void this.sync();
      return;
    }
    if (entry.idx !== this.applied + 1) {
      // A gap. Applying this now would put a command out of order and quietly
      // desynchronise the table, so catch up properly instead.
      void this.sync();
      return;
    }
    if (!this.applyLogged(entry)) void this.sync();
  }

  private onViewRow(payload: unknown): void {
    if (this.closed) return;
    const row = rowOf(payload);
    if (row === null) return;
    // Row level security sends a seat only its own view; this is the belt to
    // that braces, and costs one comparison.
    const seat = row['seat'];
    if (typeof seat === 'string' && this.mySeat !== null && seat !== this.mySeat) return;

    const state = row['state'];
    if (!looksLikeState(state)) {
      void this.sync();
      return;
    }
    const idx = numberOf(row['idx']);
    if (idx !== null && idx <= this.applied) return; // A view older than the one we hold.
    this.announced = Math.max(this.announced, idx ?? this.applied + 1);
    this.adoptSnapshot(state, idx ?? this.applied + 1);
  }

  // -- Realtime -------------------------------------------------------------

  private listen(): void {
    const gameId = this.game;
    if (gameId === null || this.closed) return;
    this.dropChannel();
    this.setConnection('connecting');

    const scoped = `game_id=eq.${gameId}`;
    const channel = this.supabase
      .channel(channelFor(gameId))
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: TABLES.commands, filter: scoped },
        (payload) => this.onCommandRow(payload),
      )
      // Not UPDATE alone: a seat's view row is inserted the first time the
      // referee writes it, and a client listening only for updates would miss
      // its own opening position.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLES.views, filter: scoped },
        (payload) => this.onViewRow(payload),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLES.seats, filter: scoped },
        () => {
          void this.sync();
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: TABLES.games, filter: `id=eq.${gameId}` },
        () => {
          void this.sync();
        },
      )
      .subscribe((status) => this.onSubscribeStatus(status));

    this.channel = channel;
  }

  private onSubscribeStatus(status: string): void {
    if (this.closed) return;
    if (status === SUBSCRIBED) {
      this.attempts = 0;
      this.backoff = this.settings.minBackoffMs;
      this.setConnection('open');
      // A seatless watcher is subscribed to a stream that will never carry a
      // row, because row level security answers "membership" and they have
      // none. They have to ask instead.
      if (this.mySeat === null) this.startWatching();
      // Whatever happened while the channel was down happened; the rows for it
      // will not be replayed, so read them.
      void this.sync();
      return;
    }
    if (DROPPED.includes(status)) {
      this.setConnection('closed');
      this.scheduleResubscribe();
    }
  }

  /**
   * Come back with exponential backoff and jitter, exactly as `transport.ts`
   * does and for the same reason: a Realtime restart drops every client at
   * once, and they must not all return in the same millisecond.
   *
   * There is no attempt cap. A player who shuts the lid over lunch should find
   * the table still there, and the delay tops out at `maxBackoffMs` anyway.
   */
  private scheduleResubscribe(): void {
    if (this.closed || this.retry !== null) return;
    this.attempts += 1;
    const jitter = 0.5 + this.settings.random() * 0.5;
    const delay = Math.min(this.backoff, this.settings.maxBackoffMs) * jitter;
    this.backoff = Math.min(this.backoff * this.settings.backoffFactor, this.settings.maxBackoffMs);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.listen();
    }, delay);
  }

  private armCatchUp(): void {
    if (this.closed || this.catchUp !== null) return;
    this.catchUp = setTimeout(() => {
      this.catchUp = null;
      if (this.applied < this.announced) void this.sync();
    }, this.settings.catchUpMs);
  }

  private dropChannel(): void {
    const channel = this.channel;
    this.channel = null;
    if (channel !== null) void this.supabase.removeChannel(channel);
    this.stopWatching();
  }

  // -- Watching without a seat ----------------------------------------------

  /**
   * Poll, but only for a spectator.
   *
   * Realtime is not a broadcast: a row reaches a subscriber only if row level
   * security would let that subscriber select it, and every policy in
   * `0002_policies.sql` is built on "membership grants a read". A caller with no
   * seat is a member of nothing, so the channel subscribes cleanly and then
   * stays silent forever — a board frozen at the moment they arrived, under an
   * indicator reading "live".
   *
   * The Edge Function will still answer a spectator's `sync`, deliberately, so
   * the fix is to ask. It is the one place in this client that polls, and it is
   * the one place that has to.
   */
  private startWatching(): void {
    if (this.watch !== null || this.closed) return;
    this.watch = setInterval(() => void this.sync(), WATCH_MS);
  }

  private stopWatching(): void {
    if (this.watch === null) return;
    clearInterval(this.watch);
    this.watch = null;
  }

  // -- Notifying ------------------------------------------------------------

  private setSeat(seat: PlayerId | null): void {
    if (seat !== null) this.stopWatching();
    if (this.mySeat === seat) return;
    this.mySeat = seat;
    this.events.onSeat?.(seat);
  }

  private setTable(table: TableInfo): void {
    this.info = table;
    this.events.onTable?.(table);
  }

  private setConnection(next: TableConnection): void {
    if (this.link === next) return;
    this.link = next;
    this.events.onConnection?.(next);
  }
}
