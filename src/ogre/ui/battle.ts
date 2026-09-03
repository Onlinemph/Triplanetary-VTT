/**
 * The Ogre battle view: the companion game's whole shell, embeddable.
 *
 * This is OGRE-VTT's `ui/app.ts` with the application chrome pruned away —
 * no scenario picker, no address-bar doors — leaving the part that *is* the
 * game: panels, pointer and keyboard bindings, and the one-way loop
 *
 *     command → session.dispatch → subscribe → render(panels + map)
 *
 * The interface decides nothing. Every legality question — where a unit may
 * go, what a shot is worth, whether a ram is allowed — is asked of the ported
 * engine (`reachable`, `previewAttack`, `canRam`), and every change leaves as
 * a `Command`. It mounts into a host element the Triplanetary shell provides,
 * owns its own listeners for exactly as long as it is mounted, and plays any
 * of the ported scenarios. The ending depends on what was fought: a campaign
 * battle ends with a `BattleResult` handed to whoever is waiting for it — the
 * war room in this browser, or a token for one running somewhere else — and a
 * printed scenario ends with the verdict alone.
 *
 * A seat may be the computer's: the view asks the AI for its plan whenever
 * the decision is the computer's and dispatches it an order at a time, so a
 * human watching sees the moves land. Every accepted order is also reported
 * out through `onProgress`, which is how the shell autosaves a battle.
 */

import { type Hex, eq, label as hexLabel } from '../engine/hex.js';
import { terrainAt } from '../engine/map.js';
import { TERRAIN_LABELS } from '../engine/terrain.js';
import { OGRE_WEAPONS, movementForTreads, ogreType } from '../engine/ogres.js';
import { TRAIN_MAX_SPEED, unitClass } from '../engine/units.js';
import { describeOdds, oddsChance } from '../engine/crt.js';
import {
  type AttackerRef,
  type Building,
  type GameState,
  type OgreUnit,
  type PlayerId,
  type TargetRef,
  type Unit,
  type UnitId,
  PHASE_LABELS,
  activePlayer,
  isInertOgre,
  isOgre,
  onBoard,
  setupActor,
  unitsAt,
} from '../engine/types.js';
import { isFireable, movementAllowance, unitName } from '../engine/state.js';
import { reachable } from '../engine/movement.js';
import {
  canStillFire,
  orbitalStrikesLeft,
  previewAttack,
  previewOrbitalStrike,
} from '../engine/combat.js';
import { canRam } from '../engine/ram.js';
import {
  canOverrun,
  overrunActor,
  overrunStrength,
  overrunUnits,
  previewOverrunAttack,
} from '../engine/overrun.js';
import { legalSetupHexes, limitStatus, zoneOf } from '../engine/setup.js';
import { reactionTurn, reserveEntryHexes, reservesOf } from '../engine/reserves.js';
import { CRUISE_MISSILE, launchCheck } from '../engine/missiles.js';
import type { Command } from '../engine/commands.js';
import type { BattleResult, OrderOfBattle } from '../../campaign/orders.js';
import { type ReachHint, type RenderView, EMPTY_VIEW, MapRenderer } from '../render/renderer.js';
import { GameSession } from '../net/session.js';
import { LANDING, mapOf, scenarioById } from '../scenarios/index.js';
import { readBattleResult } from '../campaign/result.js';
import { aiPlan, decisionKey } from '../ai/player.js';
import { button, el, row, setChildren } from './dom.js';
import '../ogre.css';

/**
 * What to fight. A campaign order carries its ending with it — the result
 * must go somewhere — while a printed scenario is just a game: it ends with
 * a verdict and the door.
 */
export type OgreBattleSource =
  | {
      readonly kind: 'order';
      readonly order: OrderOfBattle;
      /**
       * The primary way home when a war room in this browser is waiting on
       * this battle ("Report to the campaign"); null shows the result token
       * instead, for a battle whose campaign runs somewhere else.
       */
      readonly reportLabel: string | null;
      /** Takes the finished battle's result home. */
      onResult(result: BattleResult): void;
      /** The pasteable token a result travels as, for the null-label ending. */
      resultToken(result: BattleResult): string;
    }
  | {
      readonly kind: 'scenario';
      /** One of the ported scenarios' ids; an unknown id falls back to The Landing. */
      readonly id: string;
      readonly seed: number;
      /** A custom battle's order of battle: the forces, the map and the terms. */
      readonly order?: OrderOfBattle;
    };

/**
 * A battle fought at a refereed table. The board is the referee's: the view
 * adopts every snapshot it sends, and an order leaves for the referee instead
 * of the local session. The local engine still answers every *question*
 * (where a unit may go, what a shot is worth), because the referee runs the
 * same engine and the answer is the same.
 */
export interface OnlineBattle {
  /** The seat this browser holds; null when watching. */
  readonly seat: PlayerId | null;
  readonly board: {
    readonly state: unknown;
    subscribe(fn: () => void): () => void;
  };
  /** Give an order to the referee. Resolves false when it was refused. */
  send(cmd: Command): Promise<boolean>;
}

export interface OgreBattleOptions {
  /** Where to mount. The view covers it while the battle is open. */
  readonly host: HTMLElement;
  readonly battle: OgreBattleSource;
  /** Present when the battle is fought at a refereed table. */
  readonly online?: OnlineBattle;
  /** Seats the computer plays, by player id. */
  readonly ai?: readonly PlayerId[];
  /**
   * Open with the deployment step (default true). A resumed battle must be
   * built the way it was first built, so the flag travels with the save.
   */
  readonly setup?: boolean;
  /** A saved command log to replay onto the freshly built board. */
  readonly resume?: readonly Command[];
  /** Called with the accepted log after every change; the shell autosaves it. */
  onProgress?(log: readonly Command[], info: BattleProgress): void;
  /** Leave without a result. The battle can be fought again from the start. */
  onExit(): void;
}

/** What the shell needs to know about a battle to describe its save. */
export interface BattleProgress {
  readonly scenarioName: string;
  readonly turn: number;
  readonly finished: boolean;
}

export interface OgreBattle {
  destroy(): void;
  /** The seats the computer holds, for the shell's save. */
  readonly ai: readonly PlayerId[];
}

interface UiState {
  selected: UnitId | null;
  hover: Hex | null;
  attackers: AttackerRef[];
  target: TargetRef | null;
  /** A reserve being brought on: the next click on the entry edge places it. */
  placing: UnitId | null;
  /** An orbital strike chosen: the next enemy clicked is its target. */
  strike: number | null;
  /** A loaded crawler aiming: the next hex clicked is where the missile goes. */
  aiming: UnitId | null;
  showHexNumbers: boolean;
  helpOpen: boolean;
}

export const createOgreBattle = (opts: OgreBattleOptions): OgreBattle => {
  const root = el('div', { class: 'ogre-app' });
  opts.host.appendChild(root);

  const battle = opts.battle;
  // An order names its own scenario — The Landing for the old campaign,
  // The Assault for Orbital Drop — and an unknown name falls back to the
  // landing rather than crashing a battle that already has its forces.
  const scenario =
    battle.kind === 'order'
      ? (scenarioById(battle.order.scenarioId) ?? LANDING)
      : (scenarioById(battle.id) ?? LANDING);
  const withSetup = opts.setup ?? true;
  const online = opts.online ?? null;
  const opening: GameState = online
    ? (online.board.state as GameState)
    : battle.kind === 'order'
      ? scenario.build({ seed: battle.order.seed, order: battle.order, setup: withSetup })
      : scenario.build({ seed: battle.seed, order: battle.order, setup: withSetup });
  // The board this game is on: a custom battle names its own, so it is read
  // off the opening position rather than assumed from the scenario.
  const map = mapOf(scenario, opening);
  const session = new GameSession(opening, map, {
    victoryCheck: scenario.checkVictory,
  });
  if (online) session.adoptSnapshot(online.board.state as GameState);
  else if (opts.resume && opts.resume.length > 0) session.replay(opts.resume);
  // Every snapshot the referee sends replaces the board; the session's
  // subscribers (below) redraw from it.
  const boardUnsub = online
    ? online.board.subscribe(() => session.adoptSnapshot(online.board.state as GameState))
    : () => {};

  const aiSeats = new Set<PlayerId>(opts.ai ?? []);

  const ui: UiState = {
    selected: null,
    hover: null,
    attackers: [],
    target: null,
    placing: null,
    strike: null,
    aiming: null,
    showHexNumbers: false,
    helpOpen: false,
  };

  /** Two-step guard on the Leave button: a battle is not closed by a slip. */
  let leaveArmed = false;

  // ---------------------------------------------------------------------
  // Chrome
  // ---------------------------------------------------------------------

  const canvas = el('canvas', { class: 'map' });
  const topbar = el('header', { class: 'topbar' });
  const ordersPanel = el('aside', { class: 'panel orders' });
  const logPanel = el('aside', { class: 'panel logbook' });
  const modal = el('div', { class: 'modal hidden' });
  const toast = el('div', { class: 'toast hidden' });

  setChildren(
    root,
    el('div', { class: 'shell' }, topbar, canvas, ordersPanel, logPanel, toast),
    modal,
  );

  let toastTimer = 0;
  const say = (text: string, bad = false): void => {
    toast.textContent = text;
    toast.className = `toast ${bad ? 'bad' : ''}`.trim();
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 3200);
  };

  // The renderer is built once the canvas is in the document, so its first
  // measurement is of a real box rather than a detached one.
  const renderer = new MapRenderer(canvas, map);

  // ---------------------------------------------------------------------
  // Derived reads
  // ---------------------------------------------------------------------

  /**
   * Whose decision it is right now.
   *
   * Almost always the phasing player — but deployment goes side by side
   * before the first turn, and an overrun hands initiative to the side that
   * is firing: "The defender has the first fire round" (8.04). The whole
   * shell has to follow it or the panels offer the wrong units.
   */
  const me = (): string =>
    setupActor(session.state) ?? overrunActor(session.state) ?? activePlayer(session.state);

  /** The computer holds this seat; the panels watch rather than offer. */
  /** Whether the decision at hand is this browser's to make. */
  const mine = (): boolean => (online ? online.seat === me() : true);
  /**
   * True when the seat deciding is not this player's: the computer's at a
   * local table, or anyone else's at an online one. The board is then read
   * only — orders are refused before they are formed.
   */
  const computerTurn = (): boolean => aiSeats.has(me()) || !mine();

  const selectedUnit = (): Unit | null => {
    if (!session || !ui.selected) return null;
    const u = session.state.units[ui.selected];
    return u && onBoard(u) ? u : null;
  };

  const reachHints = (): ReachHint[] => {
    const s = session;
    const u = selectedUnit();
    if (!s || !u || u.owner !== me() || s.state.setup) return [];
    if (s.state.phase !== 'movement' && s.state.phase !== 'gevMovement') return [];
    return reachable(s.state, s.map, u).map((r) => ({
      hex: r.hex,
      cost: r.cost,
      hazard: r.hazard,
    }));
  };

  /**
   * Hexes the selection can charge into — rammed or overrun, whichever set of
   * rules this game is using. The two are alternatives, never both (6.00).
   * A building alone in a hex is a ram target too (11.04.3).
   */
  const ramHints = (): Hex[] => {
    const s = session;
    const u = selectedUnit();
    if (!s || !u || u.owner !== me() || s.state.setup) return [];
    if (s.state.phase !== 'movement' && s.state.phase !== 'gevMovement') return [];
    if (s.state.overrun) return [];
    const out: Hex[] = [];
    const candidates: Hex[] = [];
    for (const other of Object.values(s.state.units)) {
      if (!onBoard(other) || other.owner === u.owner) continue;
      candidates.push(other.pos);
    }
    if (!s.state.options.overrunCombat) {
      for (const b of Object.values(s.state.buildings)) {
        if (!b.destroyed && b.owner !== u.owner) candidates.push(b.pos);
      }
    }
    for (const h of candidates) {
      if (out.some((x) => eq(x, h))) continue;
      const allowed = s.state.options.overrunCombat
        ? canOverrun(s.state, s.map, u, h).ok
        : canRam(s.state, s.map, u, h).ok;
      if (allowed) out.push(h);
    }
    return out;
  };

  const pathTo = (h: Hex): Hex[] | null => {
    const s = session;
    const u = selectedUnit();
    if (!s || !u) return null;
    const found = reachable(s.state, s.map, u).find((r) => eq(r.hex, h));
    return found ? [...found.path] : null;
  };

  /** Hexes to light up as somewhere to put something down. */
  const zoneHints = (): { zone: Hex[]; limit: Hex[] } => {
    const s = session.state;
    if (s.setup) {
      const u = selectedUnit();
      if (u && u.owner === me()) {
        const legal = legalSetupHexes(s, session.map, u);
        const z = zoneOf(s, u.owner);
        const limited = new Set((z?.limits ?? []).flatMap((l) => l.hexes));
        return {
          zone: legal,
          limit: legal.filter((h) => limited.has(`${h.q},${h.r}`)),
        };
      }
      const z = zoneOf(s, me());
      if (!z) return { zone: [], limit: [] };
      const all = z.hexes.map(parseHexKey);
      const limited = new Set((z.limits ?? []).flatMap((l) => l.hexes));
      return { zone: all, limit: all.filter((h) => limited.has(`${h.q},${h.r}`)) };
    }
    if (ui.placing) {
      const u = s.units[ui.placing];
      return u
        ? { zone: reserveEntryHexes(s, session.map, u), limit: [] }
        : { zone: [], limit: [] };
    }
    return { zone: [], limit: [] };
  };

  const parseHexKey = (k: string): Hex => {
    const comma = k.indexOf(',');
    return { q: Number(k.slice(0, comma)), r: Number(k.slice(comma + 1)) };
  };

  const buildingAt = (h: Hex): Building | undefined =>
    Object.values(session.state.buildings).find((b) => !b.destroyed && eq(b.pos, h));

  // ---------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------

  let dragging = false;
  let dragMoved = false;
  let lastPointer = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 1 || event.button === 2 || event.shiftKey) {
      dragging = true;
      dragMoved = false;
      lastPointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragging && renderer) {
      const dx = event.clientX - lastPointer.x;
      const dy = event.clientY - lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      lastPointer = { x: event.clientX, y: event.clientY };
      renderer.panBy(dx, dy);
      draw();
      return;
    }
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    const h = renderer.screenToHex(event.clientX - rect.left, event.clientY - rect.top);
    if (!ui.hover || !eq(ui.hover, h)) {
      ui.hover = h;
      draw();
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (dragging) {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
      if (dragMoved) return;
    }
    if (event.button !== 0) return;
    if (!renderer || !session) return;
    const rect = canvas.getBoundingClientRect();
    onClickHex(renderer.screenToHex(event.clientX - rect.left, event.clientY - rect.top));
  });

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!renderer) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      renderer.zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
      draw();
    },
    { passive: false },
  );

  /** Zoom about the middle of the board, for the topbar buttons. */
  const zoomBy = (factor: number): void => {
    if (!renderer) return;
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(rect.width / 2, rect.height / 2, factor);
    draw();
  };

  const onClickHex = (h: Hex): void => {
    const s = session;
    if (!s) return;
    if (computerTurn()) {
      // Looking is fine; the decision is the computer's.
      selectAt(h);
      return;
    }
    const here = unitsAt(s.state, h);
    const mine = here.filter((u) => u.owner === me());
    const phase = s.state.phase;

    // --- Deployment: pick up a counter, put it down --------------------
    if (s.state.setup) {
      const selected = selectedUnit();
      if (selected && selected.owner === me() && mine.every((u) => u.id !== selected.id)) {
        if (zoneOf(s.state, me())?.hexes.includes(`${h.q},${h.r}`)) {
          dispatch({ type: 'placeUnit', by: me(), unit: selected.id, at: h });
          return;
        }
      }
      selectAt(h);
      return;
    }

    // --- A reserve coming on --------------------------------------------
    if (ui.placing) {
      const unit = s.state.units[ui.placing];
      if (unit) dispatch({ type: 'deployReserve', by: me(), unit: unit.id, at: h });
      ui.placing = null;
      draw();
      return;
    }

    // --- A cruise missile being aimed ------------------------------------
    if (ui.aiming) {
      const unit = s.state.units[ui.aiming];
      if (unit) dispatch({ type: 'launchCruiseMissile', by: me(), unit: unit.id, target: h });
      ui.aiming = null;
      draw();
      return;
    }

    // Everything in an overrun happens in one hex, so the panel lists the
    // combatants rather than asking the player to click a stack of counters.
    if (s.state.overrun) return;

    if (phase === 'fire') {
      const held = mine.find((u) => u.id === ui.selected);
      if (mine.length > 0 && !held) {
        // Of a stack, pick up the counter that still has a shot in it.
        const shooter = mine.find((u) => canStillFire(s.state, u)) ?? mine[0]!;
        ui.selected = shooter.id;
        ui.target = null;
        ui.attackers = defaultAttackers(shooter);
        draw();
        return;
      }
      if (held && !isOgre(held) && canStillFire(s.state, held)) {
        // The counter was picked up to move; clicking it again in the fire
        // phase puts it in the attack, as picking it up fresh would have.
        if (!ui.attackers.some((a) => a.unit === held.id)) {
          ui.attackers = [...ui.attackers, { unit: held.id }];
          draw();
        }
        return;
      }
      const choices = targetsAt(h);
      if (choices.length > 0) {
        // Another click on the same hex moves on to the next thing in it:
        // the counters in turn, then the building they stand on.
        const current = choices.findIndex((t) => sameThing(t, ui.target));
        ui.target = choices[(current + 1) % choices.length]!;
        draw();
      }
      return;
    }

    // Movement phases.
    const selected = selectedUnit();
    if (selected && selected.owner === me()) {
      if (ramHints().some((r) => eq(r, h))) {
        dispatch(
          s.state.options.overrunCombat
            ? { type: 'overrun', by: me(), unit: selected.id, target: h }
            : { type: 'ram', by: me(), unit: selected.id, target: h },
        );
        return;
      }
      const path = pathTo(h);
      if (path && path.length > 0) {
        dispatch({ type: 'moveUnit', by: me(), unit: selected.id, path });
        return;
      }
    }
    selectAt(h);
  };

  /** Cycle the selection through the counters in a hex, own side first. */
  const selectAt = (h: Hex): void => {
    const here = unitsAt(session.state, h);
    const own = here.filter((u) => u.owner === me());
    if (own.length > 0) {
      const current = own.findIndex((u) => u.id === ui.selected);
      ui.selected = own[(current + 1) % own.length]!.id;
    } else if (here.length > 0) {
      ui.selected = here[0]!.id;
    } else {
      ui.selected = null;
    }
    draw();
  };

  /** The counter just picked up goes into the queue — if it can still shoot. */
  const defaultAttackers = (u: Unit): AttackerRef[] => {
    if (isOgre(u) || !canStillFire(session.state, u)) return [];
    return [{ unit: u.id }];
  };

  /**
   * Everything in a hex the player may shoot at: each enemy counter, then
   * the building they stand on. An Ogre is offered by its treads; the panel
   * narrows that to a weapon.
   */
  const targetsAt = (h: Hex): TargetRef[] => {
    const out: TargetRef[] = unitsAt(session.state, h)
      .filter((u) => u.owner !== me())
      .map((t) =>
        isOgre(t)
          ? ({ kind: 'ogreTreads', unit: t.id } as const)
          : ({ kind: 'unit', unit: t.id } as const),
      );
    const building = buildingAt(h);
    if (building && building.owner !== me()) out.push({ kind: 'building', building: building.id });
    return out;
  };

  /** True when two target references point at the same counter or building. */
  const sameThing = (a: TargetRef, b: TargetRef | null): boolean => {
    if (!b || a.kind === 'terrain' || b.kind === 'terrain') return false;
    if (a.kind === 'building' || b.kind === 'building') {
      return a.kind === 'building' && b.kind === 'building' && a.building === b.building;
    }
    return a.unit === b.unit;
  };

  /** Where the current target stands, so the panel can list its neighbours. */
  const targetHex = (state: GameState, t: TargetRef): Hex | null => {
    if (t.kind === 'terrain') return t.hex;
    if (t.kind === 'building') return state.buildings[t.building]?.pos ?? null;
    const u = state.units[t.unit];
    return u ? u.pos : null;
  };

  /**
   * When the target's hex holds more than one thing to shoot at — a counter
   * on a building, a stack — a row of chips lets the player choose, since a
   * click can only land on the top of the pile.
   */
  const hexTargetChips = (state: GameState): HTMLElement | null => {
    const t = ui.target;
    if (!t) return null;
    const h = targetHex(state, t);
    if (!h) return null;
    const choices = targetsAt(h);
    if (choices.length < 2) return null;
    return el(
      'div',
      { class: 'chips targets' },
      ...choices.map((c) =>
        button(
          c.kind === 'building'
            ? `the ${state.buildings[c.building]?.kind ?? 'building'}`
            : c.kind === 'terrain'
              ? hexLabel(c.hex)
              : unitName(state.units[c.unit]!),
          () => {
            ui.target = c;
            draw();
          },
          { class: sameThing(c, t) ? 'chip on' : 'chip' },
        ),
      ),
    );
  };

  const dispatch = (cmd: Command): boolean => {
    if (online) {
      // The referee decides; its answer arrives as a snapshot or a refusal.
      // Only a plainly illegal order is caught here, so a slip is explained
      // at once rather than after a round trip.
      const check = previewLocally(cmd);
      if (check !== null) {
        say(check, true);
        return false;
      }
      void online.send(cmd).then((ok) => {
        if (!ok && !destroyed) say('The referee refused that order.', true);
      });
      return true;
    }
    const result = session.dispatch(cmd);
    if (!result.ok) say(result.reason, true);
    draw();
    return result.ok;
  };

  /**
   * Ask the local engine whether an order is legal without keeping the
   * result: a throwaway session on a copy of the board. Null means it passed.
   */
  const previewLocally = (cmd: Command): string | null => {
    const probe = new GameSession(structuredClone(session.state), map, {
      victoryCheck: scenario.checkVictory,
    });
    const result = probe.dispatch(cmd);
    return result.ok ? null : result.reason;
  };

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        endPhase();
        break;
      case 'u':
        undo();
        break;
      case 'h':
        ui.helpOpen = !ui.helpOpen;
        draw();
        break;
      case '#':
        ui.showHexNumbers = !ui.showHexNumbers;
        draw();
        break;
      case 'f':
        renderer?.fitMap();
        draw();
        break;
      case 'Escape':
        ui.selected = null;
        ui.target = null;
        ui.attackers = [];
        ui.placing = null;
        ui.strike = null;
        ui.aiming = null;
        ui.helpOpen = false;
        draw();
        break;
      default:
        break;
    }
  };
  window.addEventListener('keydown', onKeyDown);

  /** The one button that moves the game on, whatever it is waiting for. */
  const endPhase = (): void => {
    if (computerTurn()) return;
    ui.attackers = [];
    ui.target = null;
    ui.placing = null;
    ui.strike = null;
    ui.aiming = null;
    const s = session.state;
    if (s.setup) dispatch({ type: 'finishSetup', by: me() });
    else if (s.overrun) dispatch({ type: 'endFireRound', by: me() });
    else dispatch({ type: 'endPhase', by: me() });
  };

  const undo = (): void => {
    if (!session.canUndo) return;
    session.undo();
    // A take-back may hand the decision to the computer; let it think again.
    aiPlanned = null;
    draw();
  };

  const onWindowResize = (): void => {
    resize();
    draw();
  };
  window.addEventListener('resize', onWindowResize);

  const resize = (): void => {
    renderer?.resize();
    renderer?.setViewInset({ top: 56, right: 300, bottom: 0, left: 300 });
  };

  // ---------------------------------------------------------------------
  // The computer's seats
  // ---------------------------------------------------------------------

  /** The plan being worked through, and the decision it was made for. */
  let aiPlanned: { key: string; commands: Command[] } | null = null;
  let aiTimer = 0;
  let destroyed = false;

  /**
   * Whenever the decision is the computer's, take the next order from its
   * plan a beat later — long enough to see, short enough not to wait for.
   * A stale plan (the phase moved on, an overrun began) is thrown away and
   * asked for afresh; a refused order is skipped; an empty plan falls back
   * to whatever moves the game on, so a computer seat never stalls.
   */
  const scheduleAi = (): void => {
    window.clearTimeout(aiTimer);
    // At a refereed table the referee plays the computer's seats.
    if (online || destroyed || session.state.victory || !computerTurn()) return;
    // Deployment is thirty small decisions; the turns are the ones worth watching.
    aiTimer = window.setTimeout(stepAi, session.state.setup ? 60 : 240);
  };

  const stepAi = (): void => {
    if (destroyed || session.state.victory || !computerTurn()) return;
    const player = me();
    const k = decisionKey(session.state);
    if (!aiPlanned || aiPlanned.key !== k) {
      aiPlanned = { key: k, commands: aiPlan(session.state, session.map, player) };
    }
    for (let guard = 0; guard < 400; guard++) {
      const cmd = aiPlanned.commands.shift();
      if (!cmd) {
        // Nothing left to say: move the game on.
        const s = session.state;
        const fallback: Command = s.setup
          ? { type: 'finishSetup', by: player }
          : s.overrun
            ? { type: 'endFireRound', by: player }
            : { type: 'endPhase', by: player };
        const result = session.dispatch(fallback);
        if (!result.ok) aiPlanned = null;
        draw();
        return;
      }
      const result = session.dispatch(cmd);
      if (result.ok) {
        draw();
        return;
      }
      // Refused: the board changed under the plan. Try the next order.
    }
  };

  // ---------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------

  const draw = (): void => {
    const state = session.state;
    const zones = zoneHints();
    const aimAt = ui.aiming && ui.hover ? ui.hover : null;
    const view: RenderView = {
      ...EMPTY_VIEW,
      selected: ui.selected,
      hover: ui.hover,
      reachable: reachHints(),
      ramTargets: ramHints(),
      fireTargets: state.phase === 'fire' && !state.setup ? fireTargets(state) : [],
      attackers: ui.attackers.map((a) => a.unit),
      focus: state.overrun ? [state.overrun.hex] : [],
      zone: zones.zone,
      zoneLimit: zones.limit,
      aim: aimAt,
      showHexNumbers: ui.showHexNumbers,
      viewer: me(),
    };
    renderer.render(state, view);
    renderTopbar(state);
    renderOrders(state);
    renderLog(state);
    renderModal(state);
    scheduleAi();
  };

  const fireTargets = (state: GameState): UnitId[] => {
    const shooters = ui.attackers.length > 0 ? ui.attackers : shootersFromSelection();
    if (shooters.length === 0) return [];
    const out: UnitId[] = [];
    for (const t of Object.values(state.units)) {
      if (!onBoard(t) || t.owner === me()) continue;
      const target: TargetRef = isOgre(t)
        ? { kind: 'ogreTreads', unit: t.id }
        : { kind: 'unit', unit: t.id };
      if (previewAttack(state, session!.map, shooters, target).ok) out.push(t.id);
    }
    return out;
  };

  const shootersFromSelection = (): AttackerRef[] => {
    const u = selectedUnit();
    if (!u || u.owner !== me()) return [];
    if (isOgre(u)) return [];
    return canStillFire(session!.state, u) ? [{ unit: u.id }] : [];
  };

  // ---------------------------------------------------------------------
  // Topbar
  // ---------------------------------------------------------------------

  const renderTopbar = (state: GameState): void => {
    const actor = me();
    const player = state.players[actor]!;
    const phaseText = state.setup
      ? `Deployment — ${player.name}`
      : state.overrun
        ? `Overrun — ${state.overrun.firing} firing`
        : PHASE_LABELS[state.phase];
    const advance = state.setup ? 'Ready ␣' : state.overrun ? 'End fire round ␣' : 'End phase ␣';
    setChildren(
      topbar,
      el(
        'div',
        { class: 'brand' },
        el('span', { class: 'brand-mark' }, 'OGRE'),
        el('span', { class: 'brand-sub' }, scenario.name),
      ),
      el(
        'div',
        { class: 'turnline' },
        el('span', { class: 'turn' }, state.setup ? 'Setup' : `Turn ${state.turn}`),
        el(
          'span',
          { class: 'player', style: `--accent:${player.color}` },
          `${player.name}${aiSeats.has(actor) ? ' · computer' : online && !mine() ? ' · their move' : ''}`,
        ),
        el('span', { class: 'phase' }, phaseText),
      ),
      el(
        'div',
        { class: 'controls' },
        button(advance, endPhase, {
          class: 'primary',
          disabled: computerTurn(),
          title: computerTurn()
            ? online && !mine()
              ? 'Waiting on the other seat'
              : 'The computer is playing this seat'
            : 'Advance (space)',
        }),
        button('Undo', undo, { disabled: !session?.canUndo, title: 'Local games only' }),
        button('+', () => zoomBy(1.25), { class: 'zoom', title: 'Zoom in' }),
        button('−', () => zoomBy(1 / 1.25), { class: 'zoom', title: 'Zoom out' }),
        button('Fit', () => {
          renderer?.fitMap();
          draw();
        }),
        button('Help', () => {
          ui.helpOpen = true;
          draw();
        }),
        button(
          leaveArmed && !state.victory ? 'Really leave?' : 'Leave battle',
          () => {
            // A finished battle may be left freely; an unfinished one asks
            // twice, because leaving discards the board — the order can be
            // fought again, but from the start.
            if (state.victory || leaveArmed) {
              opts.onExit();
              return;
            }
            leaveArmed = true;
            say('Leaving keeps the save. Press again to leave.', true);
            draw();
          },
          { title: 'An unfinished battle is saved in this browser' },
        ),
      ),
    );
  };

  // ---------------------------------------------------------------------
  // Orders panel
  // ---------------------------------------------------------------------

  const renderOrders = (state: GameState): void => {
    if (computerTurn()) {
      setChildren(
        ordersPanel,
        el(
          'div',
          { class: 'panel-head' },
          el('h2', {}, 'Orders'),
          el('span', { class: 'hint' }, 'The computer is thinking.'),
        ),
        el(
          'p',
          { class: 'empty' },
          `${state.players[me()]?.name ?? me()} is played by the computer. Watch the log; your turn comes next.`,
        ),
        selectedUnit() ? unitCard(state, selectedUnit()!) : null,
      );
      return;
    }
    if (state.setup) {
      setChildren(ordersPanel, ...setupPanel(state));
      return;
    }
    if (state.overrun) {
      setChildren(ordersPanel, ...overrunPanel(state));
      return;
    }
    const u = selectedUnit();
    const blocks: HTMLElement[] = [];

    blocks.push(
      el(
        'div',
        { class: 'panel-head' },
        el('h2', {}, state.phase === 'fire' ? 'Fire' : 'Orders'),
        el('span', { class: 'hint' }, phaseHint(state)),
      ),
    );

    // Orders that belong to the side rather than a counter.
    const reserves = reservePanel(state);
    if (reserves) blocks.push(reserves);
    const strikes = strikePanel(state);
    if (strikes) blocks.push(strikes);

    if (!u) {
      blocks.push(el('p', { class: 'empty' }, 'Click a counter to select it.'));
    } else {
      blocks.push(unitCard(state, u));
      if (isOgre(u)) blocks.push(ogreSheet(u));
      if (state.phase === 'fire' && u.owner === me()) {
        if (u.kind === 'unit' && u.classId === 'MCRL') blocks.push(missilePanel(state, u));
        else blocks.push(firePanel(state, u));
      }
      if ((state.phase === 'movement' || state.phase === 'gevMovement') && u.owner === me()) {
        blocks.push(movePanel(state, u));
      }
    }

    const hexInfo = hexCard(state);
    if (hexInfo) blocks.push(hexInfo);
    setChildren(ordersPanel, ...blocks);
  };

  const phaseHint = (state: GameState): string => {
    switch (state.phase) {
      case 'recovery':
        return 'Disabled units come back; press space.';
      case 'movement':
        return 'Move, ram, or drive over infantry.';
      case 'fire':
        return 'Pick guns, then a target.';
      case 'gevMovement':
        return 'GEVs move a second time.';
    }
  };

  // --- Deployment ---------------------------------------------------------

  const setupPanel = (state: GameState): HTMLElement[] => {
    const actor = me();
    const z = zoneOf(state, actor);
    const u = selectedUnit();
    const blocks: HTMLElement[] = [];
    blocks.push(
      el(
        'div',
        { class: 'panel-head' },
        el('h2', {}, 'Deployment'),
        el('span', { class: 'hint' }, `${state.players[actor]?.name ?? actor} sets up.`),
      ),
    );
    blocks.push(
      el(
        'section',
        { class: 'card' },
        el(
          'p',
          { class: 'note' },
          `Your counters are down in ${z?.label ?? 'your area'}, as the scenario dealt them. ` +
            'Click one, then a lit hex to move it there; drop it on a friend to swap. ' +
            'Press Ready when the line is set.',
        ),
        ...limitStatus(state, actor).map((l) =>
          row(
            `In ${l.label}`,
            `${l.used} of ${l.max} attack points`,
            l.used > l.max ? 'bad' : l.used === l.max ? 'warn' : '',
          ),
        ),
        button('Ready', endPhase, { class: 'primary' }),
      ),
    );
    if (u) blocks.push(unitCard(state, u));
    else blocks.push(el('p', { class: 'empty' }, 'Click one of your counters to pick it up.'));
    const hexInfo = hexCard(state);
    if (hexInfo) blocks.push(hexInfo);
    return blocks;
  };

  // --- Reserves (Orbital Drop §3.03) ----------------------------------------

  const reservePanel = (state: GameState): HTMLElement | null => {
    const held = reservesOf(state, me());
    if (held.length === 0) return null;
    const turn = reactionTurn(state);
    const may = state.phase === 'movement' && state.turn >= turn;
    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Reaction force')),
      el(
        'p',
        { class: 'note' },
        may
          ? 'Dispersed away from the base when the alarm sounded, and racing back: pick a unit, then a lit hex on your edge. It arrives with its move spent.'
          : `${held.length} unit${held.length === 1 ? '' : 's'} off the map, entering from your edge from turn ${turn}` +
              (state.phase === 'movement' ? '.' : ' — during the movement phase.'),
      ),
      may
        ? el(
            'div',
            { class: 'chips' },
            ...held.map((r) =>
              button(
                unitName(r),
                () => {
                  ui.placing = ui.placing === r.id ? null : r.id;
                  ui.selected = null;
                  draw();
                },
                { class: ui.placing === r.id ? 'chip on' : 'chip' },
              ),
            ),
          )
        : el('p', { class: 'dim' }, held.map(unitName).join(', ')),
    );
  };

  // --- Orbital fire support (Orbital Drop §6.01) ---------------------------

  const strikePanel = (state: GameState): HTMLElement | null => {
    if (state.scenarioData['orbitalStrikeSide'] !== me()) return null;
    const left = orbitalStrikesLeft(state);
    if (left.length === 0) return null;
    const inFire = state.phase === 'fire';
    const kids: HTMLElement[] = [
      el(
        'p',
        { class: 'note' },
        inFire
          ? 'Each warship overhead owes one strike: its combat strength, any target, any range. Choose a strike, then click the target.'
          : 'Warships overhead, each owing one strike in your fire phase.',
      ),
      el(
        'div',
        { class: 'chips' },
        ...left.map((strength, i) =>
          button(
            `Strike ${strength}`,
            () => {
              ui.strike = ui.strike === i ? null : i;
              draw();
            },
            { class: ui.strike === i ? 'chip on' : 'chip', disabled: !inFire },
          ),
        ),
      ),
    ];
    if (inFire && ui.strike !== null && ui.target) {
      const preview = previewOrbitalStrike(state, session.map, ui.strike, ui.target);
      const targetUnit =
        ui.target.kind === 'unit' ||
        ui.target.kind === 'ogreWeapon' ||
        ui.target.kind === 'ogreTreads'
          ? state.units[ui.target.unit]
          : undefined;
      const chips = hexTargetChips(state);
      if (chips) kids.push(chips);
      if (targetUnit && isOgre(targetUnit)) kids.push(targetChoice(targetUnit));
      if (!preview.ok) {
        kids.push(el('p', { class: 'empty bad' }, preview.reason ?? 'not a legal strike'));
      } else {
        const chance = oddsChance(preview.odds);
        const strike = ui.strike;
        const target = ui.target;
        kids.push(
          el(
            'div',
            { class: 'shot' },
            row('Odds', describeOdds(preview.odds)),
            preview.structureDamage !== undefined
              ? row('Damage', `${preview.structureDamage} structure points`)
              : row('Chance', `${chance.x}/6 destroyed · ${chance.d}/6 disabled`),
            button(
              'Call the strike',
              () => {
                dispatch({ type: 'orbitalStrike', by: me(), strike, target });
                ui.strike = null;
                ui.target = null;
                draw();
              },
              { class: 'primary' },
            ),
          ),
        );
      }
    } else if (inFire && ui.strike !== null) {
      kids.push(el('p', { class: 'empty' }, 'Now click the target.'));
    }
    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Fleet overhead')),
      ...kids,
    );
  };

  // --- Cruise missiles (Section 10) ------------------------------------------

  const missilePanel = (state: GameState, u: Unit): HTMLElement => {
    const why = ui.hover ? launchCheck(state, session.map, u, ui.hover) : null;
    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Cruise missile')),
      el(
        'p',
        { class: 'note' },
        `One nuclear-armed missile. It flies ${CRUISE_MISSILE.speed} hexes a turn straight at the hex ` +
          'you name; only a laser with a line of sight can stop it. Ground zero is total, and the ' +
          'blast reaches two hexes out — including onto your own side.',
      ),
      u.kind === 'unit' && u.firedThisPhase
        ? el('p', { class: 'empty' }, 'This crawler has launched.')
        : button(
            ui.aiming === u.id ? 'Cancel' : 'Aim the missile',
            () => {
              ui.aiming = ui.aiming === u.id ? null : u.id;
              draw();
            },
            { class: ui.aiming === u.id ? '' : 'primary' },
          ),
      ui.aiming === u.id
        ? el(
            'p',
            { class: 'empty' },
            why ? why : 'Click the hex to fire at. The rings show the blast.',
          )
        : null,
    );
  };

  const unitCard = (state: GameState, u: Unit): HTMLElement => {
    const owner = state.players[u.owner]!;
    const rows: HTMLElement[] = [];
    if (isOgre(u)) {
      const type = ogreType(u.typeId);
      rows.push(row('Treads', `${u.treads} / ${type.treads}`));
      rows.push(row('Movement', `${movementForTreads(type, u.treads)} (base ${type.baseMove})`));
      rows.push(row('Size', String(type.size)));
      if (u.activatesOn !== undefined && state.turn < u.activatesOn) {
        rows.push(row('Assembling', `activates on turn ${u.activatesOn}`, 'warn'));
      }
    } else {
      const cls = unitClass(u.classId);
      if (cls.attack > 0) {
        rows.push(
          row(
            'Attack / range',
            `${cls.attack * (cls.kind === 'infantry' ? u.squads : 1)}${cls.splitAttack ? '*' : ''} / ${cls.laser ? 'line of sight' : cls.range}`,
          ),
        );
      }
      rows.push(row('Defence', String(cls.defense * (cls.kind === 'infantry' ? u.squads : 1))));
      if (cls.mobility === 'rail') {
        rows.push(row('Speed', `${u.trainSpeed ?? 0} of ${TRAIN_MAX_SPEED}`));
      } else {
        rows.push(
          row(
            'Movement',
            cls.secondMove != null ? `${cls.move}-${cls.secondMove}` : String(cls.move),
          ),
        );
      }
      if (cls.kind === 'infantry') rows.push(row('Squads', String(u.squads)));
      if (u.classId === 'MCRL') rows.push(row('Cruise missile', 'loaded', 'warn'));
      if (u.disabled !== 'none')
        rows.push(row('Status', u.disabled === 'combat' ? 'Disabled' : 'Bogged down', 'warn'));
      if (u.stuck) rows.push(row('Status', 'Stuck for the game', 'bad'));
    }
    rows.push(row('Hex', hexLabel(u.pos)));

    return el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head', style: `--accent:${owner.color}` },
        el('span', { class: 'swatch' }),
        el('strong', {}, unitName(u)),
        el('span', { class: 'dim' }, owner.name),
      ),
      ...rows,
    );
  };

  const ogreSheet = (u: OgreUnit): HTMLElement => {
    const groups: HTMLElement[] = [];
    const kinds = ['main', 'secondary', 'missileRack', 'missile', 'arm', 'ap'] as const;
    for (const kind of kinds) {
      const all = u.weapons.filter((w) => w.kind === kind);
      if (all.length === 0) continue;
      const spec = OGRE_WEAPONS[kind];
      const pips = all.map((w) =>
        el('span', {
          class:
            `pip ${w.destroyed ? 'gone' : w.fired && kind === 'missile' ? 'spent' : w.fired ? 'used' : ''}`.trim(),
          title: w.destroyed ? 'destroyed' : w.fired ? 'fired this turn' : 'ready',
        }),
      );
      groups.push(
        el(
          'div',
          { class: 'weapon-row' },
          el('span', { class: 'weapon-name' }, spec.name),
          el('span', { class: 'weapon-stat' }, `${spec.attack}/${spec.range} D${spec.defense}`),
          el('span', { class: 'pips' }, ...pips),
        ),
      );
    }
    if (u.internalMissiles > 0) {
      groups.push(row('Internal missiles', String(u.internalMissiles)));
    }
    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Record sheet')),
      ...groups,
      el(
        'p',
        { class: 'note' },
        'An Ogre is destroyed only when every fireable weapon and every tread unit is gone.',
      ),
    );
  };

  const movePanel = (state: GameState, u: Unit): HTMLElement => {
    const allowance = movementAllowance(u, state.phase, state.options);
    const spent = u.moveUsed;
    const rams = ramHints();
    const infantryHere = unitsAt(state, u.pos).filter(
      (o) => o.owner !== u.owner && o.kind === 'unit' && unitClass(o.classId).kind === 'infantry',
    );
    const inert = isInertOgre(u, state.turn);
    const train = u.kind === 'unit' && u.classId === 'TRAIN';

    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Movement')),
      inert
        ? el(
            'p',
            { class: 'note ram' },
            `Still assembling: an inert hull until turn ${(u as OgreUnit).activatesOn}. It cannot move, ram or fire, and any D result against it is an X.`,
          )
        : null,
      row('Points', `${Math.max(0, allowance - spent)} of ${allowance} left`),
      u.movementEnded ? row('Stopped', 'this unit has ended its move', 'warn') : null,
      train
        ? el(
            'div',
            { class: 'chips' },
            button(
              'Brake',
              () => dispatch({ type: 'setTrainSpeed', by: me(), unit: u.id, change: -1 }),
              { class: 'chip', disabled: (u.trainSpeed ?? 0) <= 0 || !!u.trainSpeedSet },
            ),
            button(
              'Open up',
              () => dispatch({ type: 'setTrainSpeed', by: me(), unit: u.id, change: 1 }),
              {
                class: 'chip',
                disabled: (u.trainSpeed ?? 0) >= TRAIN_MAX_SPEED || !!u.trainSpeedSet,
              },
            ),
          )
        : null,
      rams.length > 0
        ? el(
            'p',
            { class: 'note ram' },
            `${rams.length} hex${rams.length === 1 ? '' : 'es'} may be ` +
              `${state.options.overrunCombat ? 'overrun' : 'rammed'} — the dashed ones.`,
          )
        : null,
      ...infantryHere.map((inf) =>
        button(`Grind ${unitName(inf)}`, () =>
          dispatch({ type: 'reduceInfantry', by: me(), unit: u.id, target: inf.id }),
        ),
      ),
    );
  };

  // ---------------------------------------------------------------------
  // Fire
  // ---------------------------------------------------------------------

  const firePanel = (state: GameState, u: Unit): HTMLElement => {
    const kids: HTMLElement[] = [];

    if (isOgre(u) && isInertOgre(u, state.turn)) {
      kids.push(
        el(
          'p',
          { class: 'note ram' },
          `Still assembling: this hull cannot fire until turn ${u.activatesOn}.`,
        ),
      );
    } else if (isOgre(u)) {
      // A Mark V has twenty-six weapons. Listing them one per checkbox is
      // accurate and unusable, so the panel groups them by kind and asks how
      // many of each to commit — which is also how a player thinks about it
      // ("both secondaries on the GEV").
      kids.push(
        el('p', { class: 'note' }, 'Choose how many of each gun to fire, then click a target.'),
      );
      const kinds = ['main', 'secondary', 'missileRack', 'missile', 'arm', 'ap'] as const;
      for (const kind of kinds) {
        const ready = u.weapons.filter((w) => w.kind === kind && isFireable(u, w) && !w.fired);
        if (ready.length === 0) continue;
        const spec = OGRE_WEAPONS[kind];
        const chosen = ui.attackers.filter((a) => ready.some((w) => w.id === a.weapon)).length;

        const setCount = (n: number): void => {
          const clamped = Math.max(0, Math.min(ready.length, n));
          const others = ui.attackers.filter((a) => !ready.some((w) => w.id === a.weapon));
          ui.attackers = [
            ...others,
            ...ready.slice(0, clamped).map((w) => ({ unit: u.id, weapon: w.id })),
          ];
          draw();
        };

        kids.push(
          el(
            'div',
            { class: `gunline ${chosen > 0 ? 'on' : ''}`.trim() },
            el(
              'div',
              { class: 'gun-id' },
              el('span', { class: 'gun-name' }, spec.name),
              el('span', { class: 'gun-stat' }, `${spec.attack}/${spec.range}`),
            ),
            el(
              'div',
              { class: 'stepper' },
              button('−', () => setCount(chosen - 1), {
                class: 'step',
                disabled: chosen === 0,
              }),
              el('span', { class: 'count' }, `${chosen} of ${ready.length}`),
              button('+', () => setCount(chosen + 1), {
                class: 'step',
                disabled: chosen >= ready.length,
              }),
              button('All', () => setCount(ready.length), { class: 'step wide' }),
            ),
          ),
        );
      }
      const total = ui.attackers.reduce((n, a) => {
        const w = u.weapons.find((x) => x.id === a.weapon);
        return n + (w ? OGRE_WEAPONS[w.kind].attack : 0);
      }, 0);
      if (total > 0) kids.push(row('Combined strength', String(total)));
    } else if (canStillFire(state, u)) {
      const on = ui.attackers.some((a) => a.unit === u.id);
      kids.push(
        button(on ? 'Remove from the attack' : 'Add to the attack', () => {
          ui.attackers = on
            ? ui.attackers.filter((a) => a.unit !== u.id)
            : [...ui.attackers, { unit: u.id }];
          draw();
        }),
      );
    } else {
      kids.push(el('p', { class: 'empty' }, 'This unit has already fired this turn.'));
    }

    if (ui.attackers.length > 0) {
      kids.push(
        el(
          'div',
          { class: 'queue' },
          `${ui.attackers.length} gun${ui.attackers.length === 1 ? '' : 's'} queued`,
          button(
            'Clear',
            () => {
              ui.attackers = [];
              draw();
            },
            { class: 'link' },
          ),
        ),
      );
    }

    const target = ui.target;
    if (target && ui.attackers.length > 0) {
      const targetUnit =
        target.kind === 'terrain' || target.kind === 'building' ? null : state.units[target.unit];
      const chips = hexTargetChips(state);
      if (chips) kids.push(el('h3', {}, 'Target'), chips);
      if (targetUnit && isOgre(targetUnit)) {
        kids.push(el('h3', {}, `Aim at ${unitName(targetUnit)}`));
        kids.push(targetChoice(targetUnit));
      }
      kids.push(shotCard(state, target));
    } else if (ui.attackers.length > 0) {
      kids.push(el('p', { class: 'empty' }, 'Now click an enemy counter — or a building.'));
    }

    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('strong', {}, 'Attack')),
      ...kids,
    );
  };

  /**
   * "Any unit firing on an Ogre must specify the target it is attacking: either
   * one specific weapon or the Ogre's tread units." (7.13)
   */
  const targetChoice = (ogre: OgreUnit): HTMLElement => {
    const options: HTMLElement[] = [
      button(
        'Treads',
        () => {
          ui.target = { kind: 'ogreTreads', unit: ogre.id };
          draw();
        },
        {
          class: ui.target?.kind === 'ogreTreads' ? 'chip on' : 'chip',
        },
      ),
    ];
    const seen = new Set<string>();
    for (const w of ogre.weapons) {
      if (w.destroyed) continue;
      const spec = OGRE_WEAPONS[w.kind];
      const tag = `${spec.abbr}`;
      const first = !seen.has(tag);
      seen.add(tag);
      if (!first) continue;
      const remaining = ogre.weapons.filter((x) => x.kind === w.kind && !x.destroyed).length;
      options.push(
        button(
          `${spec.abbr} ×${remaining} (D${spec.defense})`,
          () => {
            const next = ogre.weapons.find((x) => x.kind === w.kind && !x.destroyed);
            if (next) ui.target = { kind: 'ogreWeapon', unit: ogre.id, weapon: next.id };
            draw();
          },
          {
            class: aimedAt(ogre, w.kind) ? 'chip on' : 'chip',
          },
        ),
      );
    }
    return el('div', { class: 'chips' }, ...options);
  };

  /** True when the current target is one of this Ogre's weapons of that kind. */
  const aimedAt = (ogre: OgreUnit, kind: string): boolean => {
    const t = ui.target;
    if (!t || t.kind !== 'ogreWeapon' || t.unit !== ogre.id) return false;
    return ogre.weapons.find((w) => w.id === t.weapon)?.kind === kind;
  };

  const shotCard = (state: GameState, target: TargetRef): HTMLElement => {
    const preview = previewAttack(state, session!.map, ui.attackers, target);
    if (!preview.ok) {
      return el('p', { class: 'empty bad' }, preview.reason ?? 'not a legal shot');
    }
    const chance = oddsChance(preview.odds);
    return el(
      'div',
      { class: 'shot' },
      target.kind === 'building'
        ? row('Target', `the ${state.buildings[target.building]?.kind ?? 'building'}`)
        : null,
      row('Odds', preview.treadAttack ? '1 to 1 (treads)' : describeOdds(preview.odds)),
      row('Strength', `${preview.attackStrength} against ${preview.defenseStrength}`),
      preview.treadAttack
        ? row(
            'On a hit',
            `${preview.attackStrength} tread units, on a ${preview.treadHitOn === 6 ? '6' : '5 or 6'}`,
          )
        : preview.structureDamage !== undefined
          ? row('Damage', `${preview.structureDamage} structure points, no roll`)
          : row(
              'Chance',
              `${chance.x}/6 destroyed · ${chance.d}/6 disabled · ${chance.ne}/6 nothing`,
            ),
      button(
        'Fire',
        () => {
          dispatch({ type: 'attack', by: me(), attackers: ui.attackers, target });
          ui.attackers = [];
          ui.target = null;
        },
        { class: 'primary' },
      ),
    );
  };

  // ---------------------------------------------------------------------
  // Overrun
  // ---------------------------------------------------------------------

  const overrunPanel = (state: GameState): HTMLElement[] => {
    const overrun = state.overrun!;
    const actor = overrunActor(state)!;
    const mySide = actor === overrun.attacker ? 'attacker' : 'defender';
    const mine = overrunUnits(state, mySide);
    const theirs = overrunUnits(state, mySide === 'attacker' ? 'defender' : 'attacker');
    const blocks: HTMLElement[] = [];

    blocks.push(
      el(
        'div',
        { class: 'panel-head' },
        el('h2', {}, 'Overrun'),
        el(
          'span',
          { class: 'hint' },
          overrun.step === 'dismount'
            ? 'Riders may get off before the shooting starts.'
            : `Round ${overrun.round} — ${mySide === 'defender' ? 'you fire first' : 'your round'}.`,
        ),
      ),
    );

    blocks.push(
      el(
        'section',
        { class: 'card' },
        el(
          'p',
          { class: 'note' },
          'At this range a disabled result is a kill. Infantry, Ogre weapons and Superheavy ' +
            'antipersonnel guns fire at double strength; disabled units at half.',
        ),
        row('Attackers', String(overrunUnits(state, 'attacker').length)),
        row('Defenders', String(overrunUnits(state, 'defender').length)),
      ),
    );

    if (overrun.step === 'dismount') {
      const riders = mine.filter((u) => u.kind === 'unit' && u.ridingOn);
      blocks.push(
        el(
          'section',
          { class: 'card' },
          el('div', { class: 'card-head' }, el('strong', {}, 'Dismount')),
          riders.length === 0
            ? el('p', { class: 'empty' }, 'Nobody is riding anything.')
            : el(
                'div',
                {},
                ...riders.map((r) =>
                  button(`Drop ${unitName(r)} off`, () =>
                    dispatch({ type: 'dismount', by: actor, unit: r.id }),
                  ),
                ),
              ),
          button('Begin the exchange', () => dispatch({ type: 'endFireRound', by: actor }), {
            class: 'primary',
          }),
        ),
      );
      return blocks;
    }

    // --- Guns -------------------------------------------------------------
    const gunBlocks: HTMLElement[] = [];
    for (const u of mine) {
      if (isOgre(u)) {
        const kinds = ['main', 'secondary', 'missileRack', 'missile', 'arm', 'ap'] as const;
        for (const kind of kinds) {
          const ready = u.weapons.filter((w) => w.kind === kind && isFireable(u, w) && !w.fired);
          if (ready.length === 0) continue;
          const spec = OGRE_WEAPONS[kind];
          const chosen = ui.attackers.filter((a) => ready.some((w) => w.id === a.weapon)).length;
          const setCount = (n: number): void => {
            const clamped = Math.max(0, Math.min(ready.length, n));
            const others = ui.attackers.filter((a) => !ready.some((w) => w.id === a.weapon));
            ui.attackers = [
              ...others,
              ...ready.slice(0, clamped).map((w) => ({ unit: u.id, weapon: w.id })),
            ];
            draw();
          };
          gunBlocks.push(
            el(
              'div',
              { class: `gunline ${chosen > 0 ? 'on' : ''}`.trim() },
              el(
                'div',
                { class: 'gun-id' },
                el('span', { class: 'gun-name' }, spec.name),
                el('span', { class: 'gun-stat' }, `${spec.attack * 2} at point-blank`),
              ),
              el(
                'div',
                { class: 'stepper' },
                button('−', () => setCount(chosen - 1), { class: 'step', disabled: chosen === 0 }),
                el('span', { class: 'count' }, `${chosen} of ${ready.length}`),
                button('+', () => setCount(chosen + 1), {
                  class: 'step',
                  disabled: chosen >= ready.length,
                }),
              ),
            ),
          );
        }
        continue;
      }

      const refs: { label: string; ref: AttackerRef }[] = [
        { label: unitName(u), ref: { unit: u.id } },
      ];
      if (u.kind === 'unit' && (unitClass(u.classId).ap ?? 0) > 0) {
        refs.push({
          label: `${unitName(u)} — antipersonnel`,
          ref: { unit: u.id, antipersonnel: true },
        });
      }
      for (const { label, ref } of refs) {
        const on = ui.attackers.some(
          (a) => a.unit === ref.unit && !!a.antipersonnel === !!ref.antipersonnel,
        );
        const strength = overrunStrength(u, ref);
        if (strength <= 0) continue;
        gunBlocks.push(
          el(
            'label',
            { class: `check ${on ? 'on' : ''}`.trim() },
            el('input', {
              type: 'checkbox',
              checked: on,
              onChange: () => {
                ui.attackers = on
                  ? ui.attackers.filter(
                      (a) => !(a.unit === ref.unit && !!a.antipersonnel === !!ref.antipersonnel),
                    )
                  : [...ui.attackers, ref];
                draw();
              },
            }),
            `${label} — ${strength}`,
          ),
        );
      }
    }

    blocks.push(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('strong', {}, 'Your guns')),
        ...(gunBlocks.length > 0
          ? gunBlocks
          : [el('p', { class: 'empty' }, 'Everything of yours has fired this round.')]),
      ),
    );

    // --- Targets ----------------------------------------------------------
    const targetChips = theirs.map((t) =>
      button(
        unitName(t),
        () => {
          ui.target = isOgre(t) ? { kind: 'ogreTreads', unit: t.id } : { kind: 'unit', unit: t.id };
          draw();
        },
        {
          class: ui.target && 'unit' in ui.target && ui.target.unit === t.id ? 'chip on' : 'chip',
        },
      ),
    );
    // A building in the contested hex is a target for the attackers (11.04.2).
    if (mySide === 'attacker') {
      for (const b of Object.values(state.buildings)) {
        if (b.destroyed || b.owner === actor || !eq(b.pos, overrun.hex)) continue;
        targetChips.push(
          button(
            `the ${b.kind}`,
            () => {
              ui.target = { kind: 'building', building: b.id };
              draw();
            },
            {
              class:
                ui.target?.kind === 'building' && ui.target.building === b.id ? 'chip on' : 'chip',
            },
          ),
        );
      }
    }

    const targetUnit = ui.target && 'unit' in ui.target ? state.units[ui.target.unit] : undefined;

    blocks.push(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('strong', {}, 'Target')),
        el('div', { class: 'chips' }, ...targetChips),
        targetUnit && isOgre(targetUnit) ? targetChoice(targetUnit) : null,
        ui.target && ui.attackers.length > 0 ? overrunShot(state, ui.target) : null,
      ),
    );

    // --- Ramming, and ending the round -----------------------------------
    const rammable =
      overrun.round === 1
        ? mine.filter((u) => theirs.some((t) => !isInfantry(t)) && canRamInOverrun(u))
        : [];

    blocks.push(
      el(
        'section',
        { class: 'card' },
        ...rammable.flatMap((u) =>
          theirs
            .filter((t) => !isInfantry(t))
            .map((t) =>
              button(`${unitName(u)} rams ${unitName(t)}`, () =>
                dispatch({ type: 'overrunRam', by: actor, unit: u.id, target: t.id }),
              ),
            ),
        ),
        button(
          'End fire round',
          () => {
            ui.attackers = [];
            ui.target = null;
            dispatch({ type: 'endFireRound', by: actor });
          },
          { class: 'primary' },
        ),
      ),
    );

    return blocks;
  };

  const isInfantry = (u: Unit): boolean =>
    u.kind === 'unit' && unitClass(u.classId).kind === 'infantry';

  /** Only Ogres and Superheavies ram at the end of a fire round in practice. */
  const canRamInOverrun = (u: Unit): boolean =>
    isOgre(u) || (u.kind === 'unit' && u.classId === 'SHVY');

  const overrunShot = (state: GameState, target: TargetRef): HTMLElement => {
    const preview = previewOverrunAttack(state, session!.map, ui.attackers, target);
    if (!preview.ok) return el('p', { class: 'empty bad' }, preview.reason ?? 'not a legal shot');
    const chance = oddsChance(preview.odds, preview.treadAttack ? 'normal' : 'overrun');
    return el(
      'div',
      { class: 'shot' },
      row('Odds', preview.treadAttack ? '1 to 1 (treads)' : describeOdds(preview.odds)),
      row('Strength', `${preview.attackStrength} against ${preview.defenseStrength}`),
      preview.treadAttack
        ? row('On a hit', `${preview.attackStrength} tread units, on a 5 or 6`)
        : preview.structureDamage !== undefined
          ? row('Damage', `${preview.structureDamage} structure points, no roll`)
          : row('Chance', `${chance.x}/6 destroyed · ${chance.ne}/6 nothing`),
      button(
        'Fire',
        () => {
          dispatch({
            type: 'overrunAttack',
            by: overrunActor(state)!,
            attackers: ui.attackers,
            target,
          });
          ui.attackers = [];
          ui.target = null;
        },
        { class: 'primary' },
      ),
    );
  };

  const hexCard = (state: GameState): HTMLElement | null => {
    if (!ui.hover || !session) return null;
    const terrain = terrainAt(session.map, ui.hover, state.terrainOverrides);
    const here = unitsAt(state, ui.hover);
    const building = Object.values(state.buildings).find((b) => eq(b.pos, ui.hover!));
    return el(
      'section',
      { class: 'card thin' },
      row('Hex', hexLabel(ui.hover)),
      row('Terrain', TERRAIN_LABELS[terrain]),
      here.length > 0 ? row('Holds', here.map(unitName).join(', ')) : null,
      building
        ? row(
            'Building',
            building.destroyed
              ? `${building.kind}, destroyed`
              : `${building.kind}, ${building.structurePoints} SP`,
          )
        : null,
    );
  };

  // ---------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------

  const renderLog = (state: GameState): void => {
    const entries = state.log.slice(-90).reverse();
    setChildren(
      logPanel,
      el(
        'div',
        { class: 'panel-head' },
        el('h2', {}, 'Battle log'),
        el('span', { class: 'hint' }, `${state.log.length} entries`),
      ),
      el(
        'ol',
        { class: 'log' },
        ...entries.map((entry) =>
          el(
            'li',
            {
              class: `log-${entry.severity}`,
              onPointerEnter: () => {
                if (entry.focus?.[0]) {
                  ui.hover = entry.focus[0];
                  draw();
                }
              },
            },
            el('span', { class: 'log-turn' }, `T${entry.turn}`),
            entry.text,
          ),
        ),
      ),
    );
  };

  // ---------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------

  const renderModal = (state: GameState): void => {
    if (state.victory) {
      renderVictory(state);
      return;
    }
    if (ui.helpOpen) {
      renderHelp();
      return;
    }
    modal.className = 'modal hidden';
  };

  const renderVictory = (state: GameState): void => {
    const v = state.victory!;
    const names = v.winners.map((w) => state.players[w]?.name ?? w).join(' and ');
    modal.className = 'modal';

    // A campaign battle ends with somewhere for its result to go. When the
    // war room in this browser is waiting on it, one button hands it over;
    // otherwise — the order came as a token from a campaign running somewhere
    // else — the result leaves the way the order arrived. A printed scenario
    // owes nobody anything: the verdict is the whole ending.
    const result = battle.kind === 'order' ? readBattleResult(state, session.log) : null;
    const extras: (HTMLElement | null)[] = [];
    const actions: HTMLElement[] = [];

    if (result && battle.kind === 'order' && battle.reportLabel !== null) {
      actions.push(button(battle.reportLabel, () => battle.onResult(result), { class: 'primary' }));
    } else if (result && battle.kind === 'order') {
      const token = battle.resultToken(result);
      const box = el('textarea', { class: 'battle-token' });
      box.value = token;
      box.readOnly = true;
      box.rows = 3;
      box.addEventListener('focus', () => box.select());
      extras.push(
        el(
          'p',
          {},
          'This was a campaign battle. Copy the result and paste it back into the war room it came from.',
        ),
        box,
      );
      actions.push(
        button(
          'Copy the result',
          () => {
            const clipboard = navigator.clipboard;
            if (!clipboard) {
              box.select();
              say('Select the token and copy it by hand.', true);
              return;
            }
            clipboard.writeText(token).then(
              () => say('Result copied. Paste it into the campaign.'),
              () => {
                box.select();
                say('Select the token and copy it by hand.', true);
              },
            );
          },
          { class: 'primary' },
        ),
      );
    }

    actions.push(button('Leave the battle', () => opts.onExit()));

    setChildren(
      modal,
      el(
        'div',
        { class: 'sheet' },
        el('h1', {}, `${names} win`),
        el('p', { class: 'lede' }, v.reason),
        el('p', { class: 'dim' }, `A ${v.level} victory.`),
        ...extras,
        el('div', { class: 'sheet-actions' }, ...actions),
      ),
    );
  };

  const renderHelp = (): void => {
    modal.className = 'modal';
    setChildren(
      modal,
      el(
        'div',
        { class: 'sheet wide' },
        el('h1', {}, 'How this plays'),
        el('h3', {}, scenario.name),
        ...scenario.briefing.split('\n\n').map((p) => el('p', {}, p)),
        el('ul', {}, ...scenario.victoryConditions.map((c) => el('li', {}, c))),
        el('h3', {}, 'Before the first turn'),
        el(
          'p',
          {},
          'The scenario deals a legal setup; the deployment step lets each side rearrange it ' +
            'inside its printed area — the defender first, then the attacker choosing where to ' +
            'come on. Press Ready to keep what you have.',
        ),
        el('h3', {}, 'The turn'),
        el(
          'ol',
          { class: 'steps' },
          el(
            'li',
            {},
            el('strong', {}, 'Recovery. '),
            'Units disabled before the last enemy turn come back. Units bogged down in swamp, rubble or forest roll to get free.',
          ),
          el(
            'li',
            {},
            el('strong', {}, 'Movement. '),
            'Move, ram, or drive over infantry. Ramming interrupts movement and resolves at once. Reserves enter here, from the reaction turn on.',
          ),
          el(
            'li',
            {},
            el('strong', {}, 'Fire. '),
            'Every unit and every Ogre weapon may fire once. Any number may combine on one target. Orbital strikes and cruise missiles are called here.',
          ),
          el(
            'li',
            {},
            el('strong', {}, 'GEV second movement. '),
            'GEV-type units move again after combat. There is no second fire phase.',
          ),
        ),
        el('h3', {}, 'Shooting an Ogre'),
        el(
          'p',
          {},
          'An Ogre is never one target. Name a weapon, and an X destroys it — a D does nothing at all. ' +
            'Or name the treads, which ignore the odds table entirely: one unit at a time, always 1 to 1, ' +
            'and a 5 or 6 costs the Ogre tread units equal to your attack strength. In a town, only a 6.',
        ),
        el('h3', {}, 'Things that catch people out'),
        el(
          'ul',
          {},
          el(
            'li',
            {},
            'Craters are impassable to everything, an Ogre included. Fire passes over them.',
          ),
          el(
            'li',
            {},
            'A heavy tracked unit that enters swamp may be stuck there for the rest of the game.',
          ),
          el(
            'li',
            {},
            'A GEV that enters forest, swamp, rubble or town stops dead and forfeits its second move.',
          ),
          el(
            'li',
            {},
            'Odds round in the defender’s favour. 5 to 1 is automatic; worse than 1 to 2 does nothing.',
          ),
          el(
            'li',
            {},
            'Ramming is how an Ogre clears a path — and it costs tread units every time.',
          ),
          el(
            'li',
            {},
            'An Ogre that shipped in modules is an inert hull until it finishes assembling: it cannot act, and any D against it is an X.',
          ),
          el(
            'li',
            {},
            'A cruise missile flies straight at the hex you name and takes everything at ground zero with it — the blast reaches two hexes, friend or foe.',
          ),
        ),
        el('h3', {}, 'Keys'),
        el(
          'ul',
          { class: 'keys' },
          el('li', {}, el('kbd', {}, 'space'), ' end phase / ready'),
          el('li', {}, el('kbd', {}, 'u'), ' undo'),
          el('li', {}, el('kbd', {}, 'f'), ' fit the map'),
          el('li', {}, el('kbd', {}, '#'), ' hex numbers'),
          el('li', {}, el('kbd', {}, 'esc'), ' clear the selection'),
          el('li', {}, el('kbd', {}, 'shift'), ' + drag to pan, wheel to zoom'),
        ),
        el(
          'div',
          { class: 'sheet-actions' },
          button(
            'Back to the battle',
            () => {
              ui.helpOpen = false;
              draw();
            },
            { class: 'primary' },
          ),
        ),
      ),
    );
  };

  // Kick off: the board is already built, so mount, measure, subscribe, and
  // hand back the teardown. Every listener taken here is returned in
  // `destroy`, because this view is a guest in somebody else's shell.
  const unsubscribe = session.subscribe(() => {
    opts.onProgress?.(session.log, {
      scenarioName: scenario.name,
      turn: session.state.turn,
      finished: session.state.victory !== null,
    });
    draw();
  });
  // The same console hook the standalone app offers, under its own name:
  // `ogreBattle.session.serialise()` is a complete, replayable bug report.
  (window as unknown as { ogreBattle?: unknown }).ogreBattle = {
    session,
    scenario,
    // For scripted play-tests: where a hex sits on screen right now.
    hexToScreen: (h: Hex) => renderer.hexToScreen(h),
  };
  resize();
  draw();

  return {
    ai: [...aiSeats],
    destroy: () => {
      destroyed = true;
      window.clearTimeout(aiTimer);
      unsubscribe();
      boardUnsub();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      window.clearTimeout(toastTimer);
      delete (window as unknown as { ogreBattle?: unknown }).ogreBattle;
      root.remove();
    },
  };
};
