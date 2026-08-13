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
}

export interface ScenarioBuildOptions {
  readonly seed: number;
  readonly options: Partial<GameOptions>;
}

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
