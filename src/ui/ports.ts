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
import type { GameOptions, GameState } from '@engine/types.js';
import type { RenderView } from '@render/renderer.js';

export type { RenderView };

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
}
