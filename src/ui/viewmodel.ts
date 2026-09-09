/**
 * The interface's own state, and the verb list the panels use to change it.
 *
 * Strictly separate from `GameState`: nothing here is ever sent over the wire or
 * replayed. Selection, panel collapse, view toggles and half-built orders live
 * here; anything that changes the game goes out as a `Command` through
 * `Actions.dispatch`.
 */

import type { Command } from '@engine/commands.js';
import type { Hex, HexSide } from '@engine/hex.js';
import type { GameMap } from '@engine/map.js';
import type { GameState, OrdnanceKind, PlayerId, ShipId } from '@engine/types.js';

export interface ViewFlags {
  readonly gravity: boolean;
  readonly detection: boolean;
  readonly history: boolean;
  /**
   * Advance automatically through phases in which nobody can do anything.
   *
   * A convenience, never a rule: the phase still happens and everything the
   * sequence of play does inside it still runs. What is dropped is the prompt.
   */
  readonly autoSkip: boolean;
}

/** Which bottom sheet is showing on a narrow screen. */
export type Sheet = 'fleet' | 'ship' | 'log';

export interface UiState {
  readonly selected: ShipId | null;
  /** Combat phase: ships pooling their strength into the next attack. */
  readonly attackers: readonly ShipId[];
  /** Combat phase: everything being shot at. */
  readonly targets: readonly ShipId[];
  /** Limited attack — "a ship may always attack with less than its rated strength". */
  readonly limitedStrength: number | null;
  /** Astrogation: is the two-hex overload manoeuvre armed? */
  readonly overload: boolean;
  /** The endpoint under the cursor, previewed but not committed. */
  readonly hoverEndpoint: Hex | null;
  readonly hoverHex: Hex | null;
  /** Hexes to pulse on the map (log hover, order feedback). */
  readonly flash: readonly Hex[];
  readonly flags: ViewFlags;
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly sheet: Sheet;
  readonly collapsedPlayers: readonly PlayerId[];
  /** Astrogation: picking a hexside to land on. */
  readonly landingPicker: boolean;
  /** Ordnance: aiming a torpedo, which may accelerate on its launch turn only. */
  readonly aiming: OrdnanceKind | null;
  /** Transient toast under the top bar. */
  readonly notice: Notice | null;
}

export interface Notice {
  readonly text: string;
  readonly tone: 'info' | 'good' | 'warn' | 'bad';
  readonly id: number;
}

export const INITIAL_UI: UiState = {
  selected: null,
  attackers: [],
  targets: [],
  limitedStrength: null,
  overload: false,
  hoverEndpoint: null,
  hoverHex: null,
  flash: [],
  // Auto-skip on by default: a phase with nothing in it is a click that
  // changes nothing, and the toggle is there for anyone who wants the beat.
  flags: { gravity: true, detection: false, history: true, autoSkip: true },
  leftOpen: true,
  rightOpen: true,
  sheet: 'fleet',
  collapsedPlayers: [],
  landingPicker: false,
  aiming: null,
  notice: null,
};

/**
 * Everything a panel may ask the shell to do. Panels never touch the session,
 * the renderer or `UiState` directly.
 */
export interface Actions {
  /** Select a ship (or clear). `focus` recentres the map on it. */
  select(id: ShipId | null, focus?: boolean): void;
  /** Move the selection through the current player's ships. */
  cycle(delta: number): void;
  toggleAttacker(id: ShipId): void;
  toggleTarget(id: ShipId): void;
  clearCombatSelection(): void;
  setLimitedStrength(n: number | null): void;
  setOverload(on: boolean): void;
  hoverEndpoint(h: Hex | null): void;
  /** Commit a course, warning first if it is fatal and warnings are enabled. */
  plot(endpoint: Hex): void;
  setLandingPicker(on: boolean): void;
  land(side: HexSide): void;
  setAiming(kind: OrdnanceKind | null): void;
  /** Send a command. Returns false and shows the rejection reason if refused. */
  dispatch(cmd: Command): boolean;
  endPhase(): void;
  undo(): void;
  toggleFlag(flag: keyof ViewFlags): void;
  togglePanel(side: 'left' | 'right'): void;
  togglePlayerGroup(id: PlayerId): void;
  setSheet(sheet: Sheet): void;
  flash(hexes: readonly Hex[]): void;
  focusOn(h: Hex): void;
  zoom(factor: number): void;
  fit(): void;
  notify(text: string, tone?: Notice['tone']): void;
  /** Re-run every panel's `update` — for panels that keep a local draft. */
  refresh(): void;
  openHelp(): void;
  openScenarios(): void;
  newGame(): void;
}

/** Everything a panel is given on each update. */
export interface Ctx {
  readonly state: GameState;
  readonly map: GameMap;
  readonly ui: UiState;
  readonly act: Actions;
  /** The player whose eyes we render through — the active player in hotseat play. */
  readonly viewer: PlayerId;
}

export interface Panel {
  readonly el: HTMLElement;
  update(ctx: Ctx): void;
}

// ---------------------------------------------------------------------------
// Small immutable helpers over UiState collections
// ---------------------------------------------------------------------------

export const toggleIn = <T>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
