/**
 * The quick table: online play with nothing deployed.
 *
 * Its companion is `supabase/quick/schema.sql`, one file pasted into a
 * dashboard, and the division of labour between them is the whole design.
 * Postgres does the three things a browser cannot do for itself — put the
 * moves in an order everyone agrees on, roll a die nobody can see coming, and
 * tell the other tab something happened. Everything else happens here, because
 * every browser already has the entire rulebook.
 *
 * That is what makes this mode cheap. `client.ts` talks to a referee that
 * holds the board; this talks to a table that holds a *list*. A game is its
 * scenario, its seed and an ordered list of commands — so a list plus the
 * scenario is the game, and any browser can rebuild it.
 *
 * ## What it does not do, said once and plainly
 *
 * It does not judge moves. `applyCommand` runs here, on the proposer's own
 * machine, and Postgres stores what it is handed. A player who edits their
 * copy can write a move the rules forbid, and the other browsers will refuse
 * to apply it and say the table has drifted — but refusing after the fact is
 * not the same as never accepting it. The refereed mode in `client.ts` is the
 * one that never accepts it, and it costs a deployment.
 *
 * It also does not do fog of war, and the database refuses to host it rather
 * than letting this module pretend. The move list rebuilds the board including
 * the ships the fog is hiding, so there is nowhere here to keep a secret.
 *
 * ## Drift
 *
 * Each move is stored with a fingerprint of the board the sender ended up
 * with. A browser that applies the same move and computes something else knows
 * — immediately, and before it shows anybody a wrong board — that the two
 * copies have parted company. It re-reads the whole list and rebuilds from the
 * scenario, which is always possible, because the list is the game.
 */

import { buildScenario } from '../../scenarios/index.js';
import {
  type Command,
  type GameState,
  type PlayerId,
  DEFAULT_MAP,
  applyCommand,
} from '../../engine/index.js';
import type { GameMap } from '../../engine/map.js';
import { sealDie } from '../redact.js';
import type { GameSession } from '../session.js';
import type { ChannelLike } from './client.js';

// ---------------------------------------------------------------------------
// The slice of supabase-js this needs
// ---------------------------------------------------------------------------

/**
 * Narrow, and structural, for the reason `SupabaseLike` is: a test has to be
 * able to hand this an object it wrote by hand. Note there is no `auth` here —
 * a quick table has no accounts. The password is the whole gate.
 */
export interface QuickLike {
  /**
   * `PromiseLike`, not `Promise`, and the difference is not pedantry.
   * supabase-js returns a query builder that is awaitable but is not a promise
   * — it has no `catch` and no `finally` — so demanding a `Promise` here would
   * make the real client fail to satisfy this interface while every hand-written
   * test double sailed through. Which is the wrong way round.
   */
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  channel(name: string): ChannelLike;
  removeChannel(channel: ChannelLike): PromiseLike<unknown>;
}

// ---------------------------------------------------------------------------
// Shapes the database hands back
// ---------------------------------------------------------------------------

export interface QuickMove {
  readonly idx: number;
  readonly seat: PlayerId;
  readonly cmd: Command;
  readonly die: number;
  readonly hash: string | null;
}

export interface QuickSeat {
  readonly name: string;
  readonly at: string;
}

export interface QuickTableInfo {
  readonly code: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly setup: QuickSetup;
  readonly seats: Readonly<Record<string, QuickSeat>>;
  readonly turn: number;
}

/** What `buildScenario` needs to reproduce the host's opening position. */
export interface QuickSetup {
  readonly seed?: number;
  readonly options?: Record<string, boolean>;
  readonly fleets?: Readonly<Record<string, readonly string[]>>;
}

export interface QuickListing {
  readonly code: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly turn: number;
  readonly seats: number;
  readonly updatedAt: string;
}

export interface QuickEvents {
  readonly onTable?: (table: QuickTableInfo) => void;
  readonly onSeat?: (seat: PlayerId | null) => void;
  readonly onRefused?: (reason: string) => void;
  /** The two copies disagreed. Already resynchronised by the time this fires. */
  readonly onDrift?: (atIndex: number) => void;
  readonly onLink?: (state: 'live' | 'connecting' | 'offline') => void;
}

// ---------------------------------------------------------------------------
// Fingerprinting a board
// ---------------------------------------------------------------------------

/**
 * A cheap, stable digest of the things a divergence would show up in.
 *
 * Deliberately not a hash of the whole state. Two engines at the same version
 * produce byte-identical states, so hashing everything would work — and would
 * also fire on a field that differs harmlessly, like a narration string that
 * gained a comma between releases. What is hashed here is the board: whose
 * turn, which phase, and where every ship is with what left in it. Those are
 * the facts a wrong move actually corrupts.
 */
export const fingerprint = (state: GameState): string => {
  const ships = Object.keys(state.ships)
    .sort()
    .map((id) => {
      const s = state.ships[id];
      if (!s) return id;
      return [
        id,
        s.pos.q,
        s.pos.r,
        s.velocity.q,
        s.velocity.r,
        s.fuel,
        s.disabled,
        s.destroyed ? 1 : 0,
      ].join(':');
    });
  const text = [state.turn, state.phase, state.activePlayerIndex, ...ships].join('|');

  // FNV-1a. Not a security primitive and not used as one — this only has to
  // notice an accident, and both sides compute it the same way.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const RETRY_MS = 2_000;
const RENEW_MS = 60_000;

interface Held {
  readonly code: string;
  readonly password: string;
  readonly info: QuickTableInfo;
}

export class QuickTable {
  private held: Held | null = null;
  private channel: ChannelLike | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;
  private log: QuickMove[] = [];
  private initial: GameState | null = null;
  private mine: PlayerId | null = null;
  private catching = false;
  private closed = false;

  /**
   * A per-browser secret, made once and never sent anywhere but the seat
   * calls. It is what stops somebody who has the table password from playing
   * your ships — the password gets you to the table, this gets you the chair.
   */
  private readonly key: string;

  constructor(
    private readonly supabase: QuickLike,
    private readonly session: GameSession,
    private readonly events: QuickEvents = {},
    private readonly who: string = 'Player',
    private readonly map: GameMap = DEFAULT_MAP,
    key?: string,
  ) {
    this.key = key ?? randomKey();
  }

  get seat(): PlayerId | null {
    return this.mine;
  }

  get table(): QuickTableInfo | null {
    return this.held?.info ?? null;
  }

  get index(): number {
    return this.log[this.log.length - 1]?.idx ?? 0;
  }

  // -------------------------------------------------------------------------
  // Opening a table
  // -------------------------------------------------------------------------

  async list(limit = 40): Promise<readonly QuickListing[]> {
    return (await this.rpc('tri_list', { p_limit: limit })) as QuickListing[];
  }

  /**
   * Open a table for this scenario and sit down at it.
   *
   * The setup is frozen here and never sent again: a joiner rebuilds the
   * opening position from it, so a host who could change it afterwards would
   * be changing a board other people had already played on.
   */
  async host(opts: {
    scenarioId: string;
    setup?: QuickSetup;
    password: string;
    name?: string;
    listed?: boolean;
  }): Promise<string> {
    const code = (await this.rpc('tri_host', {
      p_password: opts.password,
      p_scenario: opts.scenarioId,
      p_setup: opts.setup ?? {},
      p_name: opts.name ?? '',
      p_listed: opts.listed ?? true,
    })) as string;
    await this.join(code, opts.password);
    // And sit down in it. Opening a table does not seat you — the database has
    // no idea who asked — so a host who was not seated here could watch their
    // own game and give no orders at all.
    await this.sitAnywhere();
    return code;
  }

  /** Sit down at somebody's table, or come back to your own. */
  async join(code: string, password: string): Promise<QuickTableInfo> {
    const opened = (await this.rpc('tri_open', {
      p_code: code.trim().toUpperCase(),
      p_password: password,
    })) as QuickTableInfo & { moves: QuickMove[] };

    this.held = { code: opened.code, password, info: strip(opened) };
    this.initial = sealDie(
      buildScenario(opened.scenarioId, {
        ...(opened.setup.seed === undefined ? {} : { seed: opened.setup.seed }),
        ...(opened.setup.options === undefined ? {} : { options: opened.setup.options }),
        ...(opened.setup.fleets === undefined ? {} : { fleets: opened.setup.fleets }),
      } as Parameters<typeof buildScenario>[1]),
    );
    this.log = [];
    // Adopt the opening position *before* folding in any moves. `absorb` walks
    // forward from the board already in hand and returns early when there is
    // nothing to fold, so a table nobody has moved at yet would otherwise leave
    // the session showing the placeholder scenario it was constructed with —
    // the right board only appearing once somebody played.
    this.rebuild();
    this.absorb(opened.moves ?? []);
    this.events.onTable?.(this.held.info);
    await this.listen();
    return this.held.info;
  }

  /**
   * Take the lowest side nobody is in.
   *
   * There is no referee here to hand out chairs and no lobby to wait in, so
   * sitting down is something the client has to do for itself — and a player
   * who is not sitting anywhere cannot give a single order. A claim older than
   * the database's five minutes counts as empty, matching what `tri_sit` will
   * actually allow rather than what the roster happens to list.
   */
  async sitAnywhere(): Promise<PlayerId | null> {
    const held = this.require();
    const stale = Date.now() - 5 * 60_000;
    for (const seat of this.session.state.playerOrder) {
      const claim = held.info.seats[seat];
      const at = claim === undefined ? null : Date.parse(claim.at);
      if (claim === undefined || Number.isNaN(at) || (at ?? 0) < stale) {
        await this.sit(seat);
        return seat;
      }
    }
    return null;
  }

  /** Take a side. Omitting one gives up whatever this browser was holding. */
  async sit(seat: PlayerId | null): Promise<void> {
    const held = this.require();
    if (seat === null) {
      await this.rpc('tri_stand', {
        p_code: held.code,
        p_password: held.password,
        p_key: this.key,
      });
      this.mine = null;
    } else {
      await this.rpc('tri_sit', {
        p_code: held.code,
        p_password: held.password,
        p_seat: seat,
        p_key: this.key,
        p_name: this.who,
      });
      this.mine = seat;
      this.keepSeat();
    }
    this.events.onSeat?.(this.mine);
    await this.refresh();
  }

  // -------------------------------------------------------------------------
  // Playing
  // -------------------------------------------------------------------------

  /**
   * Give an order.
   *
   * Applied locally first — not for speed, but because the fingerprint sent
   * with it *is* the result of applying it. An order the rules refuse never
   * leaves this browser, which is the difference between this mode being loose
   * and being broken: the table trusts each player to run the rules, and this
   * is where running them happens.
   */
  async send(cmd: Command): Promise<boolean> {
    const held = this.require();
    if (this.mine === null) {
      this.events.onRefused?.('You are not sitting at this table.');
      return false;
    }

    const signed = { ...cmd, by: this.mine } as Command;
    const applied = applyCommand({ ...this.session.state, rng: { seed: 0 } }, signed, this.map);
    if (!applied.result.ok) {
      this.events.onRefused?.(applied.result.reason ?? 'The rules do not allow that.');
      return false;
    }

    const answer = (await this.rpc('tri_play', {
      p_code: held.code,
      p_password: held.password,
      p_seat: this.mine,
      p_key: this.key,
      p_cmd: signed,
      p_after: this.index,
      // Computed after the fact: the die comes from Postgres, so the board
      // this browser predicted is not the board the move produces. The
      // fingerprint that matters is written on catch-up, below.
      p_hash: null,
      p_turn: this.session.state.turn,
    })) as { ok: boolean; reason?: string; index: number; die: number };

    if (!answer.ok) {
      // Somebody moved first. Not an error — read their move and try again.
      await this.catchUp();
      this.events.onRefused?.('Somebody else moved first — the board has caught up.');
      return false;
    }

    await this.catchUp();
    return true;
  }

  /** Take the table back to just before a move. */
  async undo(fromIndex = this.index): Promise<void> {
    const held = this.require();
    if (fromIndex < 1) return;
    await this.rpc('tri_undo', {
      p_code: held.code,
      p_password: held.password,
      p_from: fromIndex,
    });
    this.log = this.log.filter((m) => m.idx < fromIndex);
    this.rebuild();
  }

  async leave(): Promise<void> {
    if (this.held && this.mine !== null) await this.sit(null);
    this.close();
  }

  close(): void {
    this.closed = true;
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    if (this.channel) void this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.events.onLink?.('offline');
  }

  // -------------------------------------------------------------------------
  // Keeping up
  // -------------------------------------------------------------------------

  /**
   * Fold new moves into the board.
   *
   * Incremental where it can be — applying one move to the state already in
   * hand — and a full rebuild from the scenario when a fingerprint disagrees
   * or a move arrives out of order. The rebuild is always available and always
   * correct, which is the property that makes the cheap path safe to attempt.
   */
  private absorb(moves: readonly QuickMove[]): void {
    const fresh = [...moves].filter((m) => m.idx > this.index).sort((a, b) => a.idx - b.idx);
    if (fresh.length === 0) return;

    // A gap means we missed something — Realtime dropped a frame, or two
    // arrived at once. Only a re-read can close it.
    if (fresh[0] !== undefined && fresh[0].idx !== this.index + 1) {
      this.log.push(...fresh);
      this.rebuild();
      return;
    }

    let state = this.session.state;
    for (const move of fresh) {
      const out = applyCommand({ ...state, rng: { seed: move.die >>> 0 } }, move.cmd, this.map);
      if (!out.result.ok) {
        // The sender played something these rules refuse. Rebuilding will not
        // rescue it, but it will land this browser on the same board as
        // everyone who also refused it, which is the honest answer.
        this.log.push(...fresh);
        this.events.onDrift?.(move.idx);
        this.rebuild();
        return;
      }
      state = out.state;
      this.log.push(move);
      if (move.hash !== null && move.hash !== fingerprint(state)) {
        this.events.onDrift?.(move.idx);
        this.rebuild();
        return;
      }
    }
    this.session.adoptSnapshot(sealDie(state));
  }

  /** From the scenario, through every move. Slower, and never wrong. */
  private rebuild(): void {
    if (!this.initial) return;
    let state = this.initial;
    for (const move of [...this.log].sort((a, b) => a.idx - b.idx)) {
      const out = applyCommand({ ...state, rng: { seed: move.die >>> 0 } }, move.cmd, this.map);
      if (!out.result.ok) break;
      state = out.state;
    }
    this.session.adoptSnapshot(sealDie(state));
  }

  private async catchUp(): Promise<void> {
    const held = this.held;
    if (!held || this.catching) return;
    this.catching = true;
    try {
      const moves = (await this.rpc('tri_since', {
        p_code: held.code,
        p_password: held.password,
        p_since: this.index,
      })) as QuickMove[];
      this.absorb(moves);
    } finally {
      this.catching = false;
    }
  }

  private async refresh(): Promise<void> {
    const held = this.held;
    if (!held) return;
    const opened = (await this.rpc('tri_open', {
      p_code: held.code,
      p_password: held.password,
    })) as QuickTableInfo & { moves: QuickMove[] };
    this.held = { ...held, info: strip(opened) };
    this.events.onTable?.(this.held.info);
    this.absorb(opened.moves ?? []);
  }

  private keepSeat(): void {
    if (this.renew) clearInterval(this.renew);
    // The claim goes stale after five minutes of silence, so say something
    // every minute. A closed tab stops saying it and the chair frees itself.
    this.renew = setInterval(() => {
      if (this.held && this.mine !== null) void this.sit(this.mine).catch(() => undefined);
    }, RENEW_MS);
  }

  private async listen(): Promise<void> {
    const held = this.require();
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.events.onLink?.('connecting');

    const channel = this.supabase.channel(`quick:${held.code}`);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tri_moves', filter: `code=eq.${held.code}` },
        () => {
          // The payload carries the row, but taking the move from it would
          // trust a stream that can drop and reorder. It is a doorbell: the
          // answer always comes from `tri_since`.
          void this.catchUp().catch(() => undefined);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.events.onLink?.('live');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.events.onLink?.('connecting');
          if (!this.closed) setTimeout(() => void this.listen().catch(() => undefined), RETRY_MS);
        }
      });
    this.channel = channel;
  }

  // -------------------------------------------------------------------------

  private require(): Held {
    if (!this.held) throw new Error('there is no table open');
    return this.held;
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.supabase.rpc(fn, args);
    if (error) throw new Error(readable(error.message));
    return data;
  }
}

// ---------------------------------------------------------------------------

const strip = (t: QuickTableInfo & { moves?: unknown }): QuickTableInfo => ({
  code: t.code,
  name: t.name,
  scenarioId: t.scenarioId,
  setup: t.setup,
  seats: t.seats ?? {},
  turn: t.turn,
});

/**
 * Postgres wraps a `raise exception` in its own prose before PostgREST wraps
 * that in JSON. The messages in `schema.sql` are written for a player to read,
 * so the wrapping comes off.
 */
const readable = (message: string): string =>
  message.replace(/^.*?(?:ERROR|error):\s*/i, '').trim() || message;

const randomKey = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};
