/**
 * The seams between the interface and everything it drives.
 *
 * The UI never imports the session, the renderer or the scenario table directly:
 * `src/main.ts` wires the concrete implementations to these structural ports and
 * hands them to `createApp`. Two reasons. It keeps the panels testable against a
 * hand-written stub, and it means the shell is written against a contract of its
 * own rather than against another module's incidental type names — if the
 * session or renderer signature drifts by an argument, one adapter in `main.ts`
 * absorbs it instead of thirty call sites.
 */

import type { Command, CommandResult } from '@engine/commands.js';
import type { Hex, Point } from '@engine/hex.js';
import type { GameMap } from '@engine/map.js';
import type { GameOptions, GameState, PlayerId } from '@engine/types.js';
import type { SeatInfo, TableInfo } from '@net/supabase/protocol.js';
import type { RenderView } from '@render/renderer.js';

// `TableInfo` and `SeatInfo` are re-exported rather than restated. They come
// from `protocol.ts`, which is the browser <-> referee contract itself and holds
// no implementation — the same standing as `RenderView`. A parallel pair of
// interfaces here would be a copy of a contract, and copies of contracts drift.
export type { RenderView, SeatInfo, TableInfo };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The subset of `GameSession` the interface uses. */
export interface SessionPort {
  /** Always the current state; re-read it after every dispatch. */
  readonly state: GameState;
  readonly map: GameMap;
  dispatch(cmd: Command): CommandResult;
  /** Fires after any state change. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  undo(): void;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * The camera and the chart. `RenderView` is the renderer's own overlay contract
 * — selection, the astrogation ghost, and which layers are lit — and the shell
 * builds one on every frame from its `UiState`.
 */
export interface RendererPort {
  render(state: GameState, view: RenderView): void;
  /** Client-space pixels (relative to the canvas) to a hex. */
  screenToHex(x: number, y: number): Hex;
  /** The inverse, in CSS pixels — used to pin DOM overlays to hexes. */
  hexToScreen(h: Hex): Point;
  panBy(dx: number, dy: number): void;
  /** `factor` > 1 zooms in, anchored on the given client-space point. */
  zoomAt(x: number, y: number, factor: number): void;
  /** Frame everything in play. */
  fitAll(state: GameState): void;
  /** Frame the whole chart disc, for when there is no game yet. */
  fitChart(): void;
  focusOn(h: Hex): void;
  /** Frame a set of hexes at a workable zoom (used to make a plot legible). */
  frameHexes(hexes: readonly Hex[], opts?: { minHexPx?: number; maxHexPx?: number }): void;
  /** Re-read the canvas' CSS size and device pixel ratio. */
  resize(): void;
  /** Screen edges hidden behind floating panels, in CSS pixels. */
  setViewInset(inset: { top: number; right: number; bottom: number; left: number }): void;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export interface ScenarioDescriptor {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly blurb: string;
  /** Either a turn count or a phrase like "short"; both are rendered. */
  readonly length: string | number;
  readonly description: string;
  /**
   * The seats at the table, in the order the scenario builds them.
   *
   * Seat *n* is `state.playerOrder[n]` in the built game — which is how the
   * picker can offer "human or computer" per seat without knowing the player ids
   * a scenario will mint.
   */
  readonly seats: readonly { readonly faction: string; readonly name: string }[];
  /**
   * The opening fleets this scenario prices in combat strength points, if any.
   *
   * Nova is the one that does: "Both the EastBloc and the WestBloc players select
   * fleets of 50 combat points each." Present here so the picker can offer the
   * buy screen without importing the scenario table.
   */
  readonly pointBuy?: {
    /** Budget per player id, and the faction name to show beside it. */
    readonly sides: readonly {
      readonly id: string;
      readonly name: string;
      readonly budget: number;
    }[];
    /** Hulls the scenario will sell, with what each costs in points. */
    readonly catalogue: readonly {
      readonly id: string;
      readonly name: string;
      readonly cost: number;
    }[];
  };
}

export interface ScenarioBuildOptions {
  readonly seed: number;
  readonly options: Partial<GameOptions>;
  /** Fleets bought on the point-buy screen, by player id. */
  readonly fleets?: Readonly<Record<string, readonly string[]>>;
}

/** Seat indices the computer plays, into `ScenarioDescriptor.seats`. */
export type ComputerSeats = readonly number[];

// ---------------------------------------------------------------------------
// Online play
// ---------------------------------------------------------------------------

/**
 * What the indicator says about the wire.
 *
 * Deliberately not the client's own `'closed' | 'connecting' | 'open'`. Those
 * are three states of a Realtime subscription; these are three things to tell a
 * player, and `main.ts` maps between them. A table that is merely reconnecting
 * is still a table, and saying "offline" about it would be a lie.
 */
export type LinkState = 'live' | 'reconnecting' | 'offline';

/** What the shell wants to hear about while it is sitting at a table. */
export interface TableEvents {
  /** The seat this client now holds, or `null` for a spectator. */
  onSeat?(seat: PlayerId | null): void;
  /** The roster, the status, the turn and the join code, all in one. */
  onTable?(table: TableInfo): void;
  onLink?(state: LinkState): void;
  /** Something the referee refused, in words worth showing a player. */
  onRefused?(reason: string): void;
}

/**
 * A table this client is sitting at.
 *
 * The session comes with it, because online the two are one thing: the referee
 * decides, and the session is the vessel its decisions are poured into. Nothing
 * the shell does to that session moves the board — every order leaves through
 * `send` and comes back as a state somebody else computed.
 */
export interface TablePort {
  readonly session: SessionPort;
  readonly seat: PlayerId | null;
  readonly table: TableInfo | null;
  readonly link: LinkState;
  /** True when this client opened the table, and so may start it. */
  readonly host: boolean;
  /** Close the lobby and begin. The referee refuses this from anyone but the host. */
  start(): Promise<void>;
  /** Move to another open seat, or stand up to watch with `null`. */
  sit(seat: PlayerId | null): Promise<void>;
  /** Give an order. False when the referee refused it. */
  send(cmd: Command): Promise<boolean>;
  /** Vacate the seat and stop listening. */
  leave(): Promise<void>;
  /** Stop listening without vacating, so the seat is still ours to resume. */
  close(): void;
}

export interface HostOptions extends ScenarioBuildOptions {
  readonly scenarioId: string;
  readonly computerSeats: ComputerSeats;
}

/**
 * Somewhere to play online, or the reason there is nowhere.
 *
 * The absent case is a value rather than a missing field because the interface
 * has something to say about it: a build with no credentials must explain why
 * the button is dead, not merely hide it and leave a player wondering.
 */
export type OnlinePort =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      /** Open a table and take the first seat. */
      host(opts: HostOptions, events: TableEvents): Promise<TablePort>;
      /**
       * Sit down at somebody's table. An omitted seat resumes the one this
       * account already holds and otherwise takes the lowest open one, which is
       * what makes following a link a single click and a reconnect a no-op.
       */
      join(code: string, seat: PlayerId | null | undefined, events: TableEvents): Promise<TablePort>;
      /** The link a friend follows to reach a table. */
      linkFor(code: string): string;
    };

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface AppDeps {
  readonly root: HTMLElement;
  readonly map: GameMap;
  readonly scenarios: readonly ScenarioDescriptor[];
  buildScenario(id: string, opts: ScenarioBuildOptions): GameState;
  createSession(state: GameState): SessionPort;
  createRenderer(canvas: HTMLCanvasElement, map: GameMap): RendererPort;
  /** Seed source for new games. Injected so the shell stays deterministic in tests. */
  randomSeed(): number;
  /** Online play. Omitted is the same as unavailable, with a generic reason. */
  readonly online?: OnlinePort;
  /** A join code off the address bar, so a link lands straight in the lobby. */
  readonly joinCode?: string | null;
}
