/**
 * The application shell.
 *
 * Owns the DOM skeleton, the interface's own state, the pointer and keyboard
 * bindings, and the one-way flow that keeps them in step:
 *
 *     command -> session.dispatch -> subscribe -> render(panels + map)
 *
 * Nothing here decides a rule. Every legality question is asked of the engine
 * (`previewPlot`, `previewAttack`, `canLaunch`, `canResupplyAt`) and every change
 * leaves as a `Command`, so the shell is replaceable and the game is not.
 */

import { type Hex, type HexSide, distance, eq, length as hexLength, sub } from '@engine/hex.js';
import { isDetected, visibleShips } from '@engine/detection.js';
import {
  hasScanners,
  movementData,
  predictedEndpoint,
  previewPlot,
  reachableEndpoints,
} from '@engine/movement.js';
import { torpedoAimEndpoints, torpedoAimOptions } from '@engine/ordnance.js';
import { SHIP_CLASSES } from '@engine/ships.js';
import {
  type GameOptions,
  type PlayerId,
  type Ship,
  type ShipId,
  DEFAULT_OPTIONS,
  activePlayer,
  areAllied,
  liveShips,
  controllerOf,
} from '@engine/types.js';
import type { PlotOption, PlotPreview } from '@engine/movement.js';
import { button, el, fill } from './components/dom.js';
import { icon } from './components/glyphs.js';
import { type Overlay, openModal } from './components/modal.js';
import type { AppDeps, RenderView, RendererPort, SessionPort } from './ports.js';
import { createCombatPanel } from './panels/combat.js';
import { createFleetPanel } from './panels/fleet.js';
import { createInspector } from './panels/inspector.js';
import { createLogPanel } from './panels/logpanel.js';
import { openHelpDrawer } from './panels/help.js';
import { openScenarioPicker } from './panels/scenarioPicker.js';
import { createTopBar } from './panels/topbar.js';
import {
  type Actions,
  type Ctx,
  type Notice,
  type Panel,
  type Sheet,
  type UiState,
  type ViewFlags,
  INITIAL_UI,
  toggleIn,
} from './viewmodel.js';

const DRAG_THRESHOLD_PX = 4;
const NOTICE_MS = 5000;

export interface App {
  readonly el: HTMLElement;
  /** Mount, wire the input handlers, and open the scenario picker. */
  start(): void;
  /** Tear down listeners — used by tests and hot reload. */
  destroy(): void;
}

export const createApp = (deps: AppDeps): App => {
  // --- DOM skeleton --------------------------------------------------------

  const canvas = el('canvas', {
    class: 'map',
    id: 'map',
    tabindex: '0',
    'aria-label': 'Chart',
  });
  // Log-hover highlights are DOM, not canvas: they are interface feedback, not
  // part of the chart, and pinning them with `hexToScreen` keeps the renderer
  // free of transient UI state.
  const flashLayer = el('div', { class: 'flash-layer', 'aria-hidden': 'true' });
  const overlays = el('div', { class: 'overlays' });
  const noticeHost = el('div', {
    class: 'notice-host',
    role: 'status',
    'aria-live': 'polite',
  });

  const fleet = createFleetPanel();
  const inspector = createInspector();
  const combat = createCombatPanel();
  const logPanel = createLogPanel();
  const topBar = createTopBar(() => scenarioName());

  const rightPanel = el(
    'aside',
    { class: 'panel panel-right', 'aria-label': 'Ship inspector' },
    inspector.el,
    combat.el,
  );

  const sheetTabs = el(
    'nav',
    { class: 'sheet-tabs', 'aria-label': 'Panels' },
    ...(['fleet', 'ship', 'log'] as const).map((s) =>
      button({
        label: s === 'fleet' ? 'Fleet' : s === 'ship' ? 'Ship' : 'Log',
        variant: 'quiet',
        class: `sheet-tab sheet-tab-${s}`,
        onClick: () => act.setSheet(s),
      }),
    ),
  );

  const root = el(
    'div',
    { class: 'app' },
    canvas,
    flashLayer,
    topBar.el,
    noticeHost,
    fleet.el,
    rightPanel,
    logPanel.el,
    sheetTabs,
    overlays,
  );

  const panels: readonly Panel[] = [topBar, fleet, inspector, combat, logPanel];

  // --- Mutable shell state -------------------------------------------------

  let session: SessionPort | null = null;
  let renderer: RendererPort | null = null;
  let unsubscribe: (() => void) | null = null;
  let ui: UiState = { ...INITIAL_UI };
  let scenarioId = deps.scenarios[0]?.id ?? '';
  let gameOptions: GameOptions = { ...DEFAULT_OPTIONS };
  let seed = deps.randomSeed();
  let helpOverlay: Overlay | null = null;
  let pickerOverlay: Overlay | null = null;
  let noticeTimer = 0;
  let noticeSeq = 0;
  let victoryShown = false;
  let turnKey = '';
  let frame = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scenarioName = (): string =>
    deps.scenarios.find((s) => s.id === scenarioId)?.name ?? 'Triplanetary';

  // --- Selection helpers ---------------------------------------------------

  const selectedShip = (): Ship | undefined => {
    if (!session || !ui.selected) return undefined;
    const s = session.state.ships[ui.selected];
    return s && !s.destroyed ? s : undefined;
  };

  /** The ships the active player may give orders to, in a stable order. */
  const commandable = (): Ship[] => {
    if (!session) return [];
    const me = activePlayer(session.state);
    return liveShips(session.state)
      .filter((s) => controllerOf(s) === me)
      .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  };

  const visibleAt = (h: Hex): Ship[] => {
    if (!session) return [];
    const state = session.state;
    const me = activePlayer(state);
    const pool = state.options.fogOfWar ? visibleShips(state, me) : liveShips(state);
    return pool.filter((s) => eq(s.pos, h));
  };

  /**
   * Endpoints the selected ship may plot, honouring the overload arming switch.
   * Memoised: this is asked for on every pointer move, and each answer traces a
   * course through up to nineteen candidate hexes.
   */
  let plotCache: { key: string; options: PlotOption[] } | null = null;

  const plotOptions = (): PlotOption[] => {
    const ship = selectedShip();
    if (!session || !ship) return [];
    const state = session.state;
    if (state.phase !== 'astrogation') return [];
    if (controllerOf(ship) !== activePlayer(state)) return [];

    // A ship committed to landing or blasting off has already spent its turn's
    // one decision; offering it a course would only earn a rejection.
    const md = movementData(state);
    if (md.landing[ship.id] !== undefined || md.takeoff.includes(ship.id)) return [];

    const cacheKey = [
      ship.id,
      state.turn,
      state.activePlayerIndex,
      ship.fuel,
      ship.plottedAccel,
      ship.acceptedOptionalGravity.join('|'),
      ship.overloadAvailable,
      ui.overload,
    ].join(':');
    if (plotCache && plotCache.key === cacheKey) return plotCache.options;

    const all = reachableEndpoints(state, ship, session.map);
    const options = ui.overload ? all : all.filter((o) => o.accel < 2);
    plotCache = { key: cacheKey, options };
    return options;
  };

  const aimEndpoints = (): Hex[] => {
    const ship = selectedShip();
    if (!session || !ship || ui.aiming !== 'torpedo') return [];
    return torpedoAimEndpoints(session.state, ship, session.map);
  };

  // --- Actions -------------------------------------------------------------

  const setUi = (patch: Partial<UiState>): void => {
    ui = { ...ui, ...patch };
    render();
  };

  const act: Actions = {
    select(id, focus = false) {
      ui = {
        ...ui,
        selected: id,
        landingPicker: false,
        aiming: null,
        overload: false,
        hoverEndpoint: null,
      };
      if (focus && id && session) {
        const ship = session.state.ships[id];
        if (ship) {
          // During astrogation, frame the decision rather than the ship: the
          // coast point and every hex a burn can reach. Fitted to the whole
          // chart those endpoints are a few pixels across, which is why the
          // plotting step reads as "nothing happened" until you zoom in by hand.
          const plot =
            session.state.phase === 'astrogation'
              ? reachableEndpoints(session.state, ship, session.map)
              : [];
          if (plot.length > 0) {
            renderer?.frameHexes([ship.pos, ...plot.map((o) => o.endpoint)]);
          } else {
            renderer?.focusOn(ship.pos);
          }
        }
      }
      render();
    },

    cycle(delta) {
      const list = commandable();
      if (list.length === 0) return;
      const at = list.findIndex((s) => s.id === ui.selected);
      const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
      const index = (((from + delta) % list.length) + list.length) % list.length;
      const next = list[index];
      if (next) act.select(next.id, true);
    },

    toggleAttacker(id) {
      setUi({ attackers: toggleIn(ui.attackers, id) });
    },

    toggleTarget(id) {
      setUi({ targets: toggleIn(ui.targets, id) });
    },

    clearCombatSelection() {
      setUi({ attackers: [], targets: [], limitedStrength: null });
    },

    setLimitedStrength(n) {
      setUi({ limitedStrength: n });
    },

    setOverload(on) {
      setUi({ overload: on });
    },

    hoverEndpoint(h) {
      const same =
        (h === null && ui.hoverEndpoint === null) ||
        (h !== null && ui.hoverEndpoint !== null && eq(h, ui.hoverEndpoint));
      if (!same) setUi({ hoverEndpoint: h });
    },

    plot(endpoint) {
      const ship = selectedShip();
      if (!session || !ship) return;
      const state = session.state;
      const base = predictedEndpoint(state, ship, session.map);
      // A two-hex change *is* the overload manoeuvre; arming it is the only
      // choice the player makes, so the flag follows the distance.
      const overload = distance(base, endpoint) === 2;
      const preview = previewPlot(state, ship, endpoint, session.map, overload);

      const fatal = fatalReason(preview, session, ship);
      if (fatal && state.options.confirmFatalPlots) {
        confirmFatal(fatal, () => commitPlot(ship.id, endpoint, overload));
        return;
      }
      commitPlot(ship.id, endpoint, overload);
    },

    setLandingPicker(on) {
      setUi({ landingPicker: on });
    },

    land(side: HexSide) {
      if (!session) return;
      const ship = selectedShip();
      if (!ship) return;
      const ok = act.dispatch({
        type: 'land',
        by: activePlayer(session.state),
        ship: ship.id,
        side,
      });
      if (ok) setUi({ landingPicker: false });
    },

    setAiming(kind) {
      setUi({ aiming: kind });
    },

    dispatch(cmd) {
      if (!session) return false;
      const result = session.dispatch(cmd);
      if (!result.ok) {
        act.notify(result.reason ?? 'That order was refused.', 'bad');
        return false;
      }
      return true;
    },

    endPhase() {
      if (!session) return;
      act.dispatch({ type: 'endPhase', by: activePlayer(session.state) });
    },

    undo() {
      if (!session) return;
      session.undo();
      render();
    },

    toggleFlag(flag: keyof ViewFlags) {
      setUi({ flags: { ...ui.flags, [flag]: !ui.flags[flag] } });
    },

    togglePanel(side) {
      setUi(side === 'left' ? { leftOpen: !ui.leftOpen } : { rightOpen: !ui.rightOpen });
    },

    togglePlayerGroup(id: PlayerId) {
      setUi({ collapsedPlayers: toggleIn(ui.collapsedPlayers, id) });
    },

    setSheet(sheet: Sheet) {
      setUi({ sheet });
    },

    flash(hexes) {
      setUi({ flash: [...hexes] });
    },

    focusOn(h) {
      renderer?.focusOn(h);
      render();
    },

    zoom(factor) {
      const rect = canvas.getBoundingClientRect();
      renderer?.zoomAt(rect.width / 2, rect.height / 2, factor);
      render();
    },

    fit() {
      if (!renderer) return;
      if (session) renderer.fitAll(session.state);
      else renderer.fitChart();
      render();
    },

    notify(text, tone = 'info') {
      if (!text) {
        render();
        return;
      }
      const notice: Notice = { text, tone, id: ++noticeSeq };
      ui = { ...ui, notice };
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        if (ui.notice?.id === notice.id) setUi({ notice: null });
      }, NOTICE_MS);
      render();
    },

    refresh() {
      render();
    },

    openHelp() {
      if (helpOverlay) {
        helpOverlay.close();
        return;
      }
      helpOverlay = openHelpDrawer(overlays, () => {
        helpOverlay = null;
      });
    },

    openScenarios() {
      act.newGame();
    },

    newGame() {
      if (pickerOverlay) return;
      pickerOverlay = openScenarioPicker(
        overlays,
        deps.scenarios,
        { id: scenarioId, options: gameOptions, seed },
        (result) => {
          pickerOverlay = null;
          startScenario(result.id, result.opts.seed, result.opts.options);
        },
        session !== null,
        () => {
          pickerOverlay = null;
        },
      );
    },
  };

  // --- Plot helpers --------------------------------------------------------

  const commitPlot = (ship: ShipId, endpoint: Hex, overload: boolean): void => {
    if (!session) return;
    const ok = act.dispatch({
      type: 'plotCourse',
      by: activePlayer(session.state),
      ship,
      endpoint,
      ...(overload ? { overload: true } : {}),
    });
    if (ok) setUi({ hoverEndpoint: null });
  };

  const fatalReason = (preview: PlotPreview, s: SessionPort, ship: Ship): string | null => {
    if (preview.crashesInto) {
      const body = s.map.body(preview.crashesInto);
      return `This course intersects the printed disc of ${body?.name ?? preview.crashesInto}. The ship is destroyed.`;
    }
    if (preview.exitsMap) {
      // "Any ship whose final course places it off the map is considered eliminated."
      return 'The arrowhead falls off the chart, and a ship whose final course places it off the map is eliminated.';
    }
    // "Only ships possessing scanners may enter those hexes. Other ships are destroyed."
    if (preview.denseAsteroids.length > 0 && !hasScanners(s.state, ship)) {
      return 'This course crosses the dense asteroids around Clandestine, and this ship has no scanners.';
    }
    return null;
  };

  const confirmFatal = (reason: string, onConfirm: () => void): void => {
    openModal(overlays, {
      title: 'Confirm course',
      body: el('p', { class: 'help-p', text: reason }),
      actions: [
        { label: 'Cancel', variant: 'quiet', onClick: () => undefined },
        { label: 'Plot it anyway', variant: 'danger', onClick: onConfirm },
      ],
    });
  };

  // --- Hex interaction -----------------------------------------------------

  const handleHexClick = (h: Hex): void => {
    if (!session) return;
    const state = session.state;
    const ship = selectedShip();

    // Astrogation: a click on a reachable endpoint is the plot.
    if (state.phase === 'astrogation' && ship) {
      const option = plotOptions().find((o) => eq(o.endpoint, h));
      if (option) {
        act.plot(option.endpoint);
        return;
      }
    }

    // Ordnance: a click on an aim hex launches the torpedo along that vector.
    if (state.phase === 'ordnance' && ship && ui.aiming === 'torpedo') {
      const endpoints = torpedoAimEndpoints(state, ship, session.map);
      const index = endpoints.findIndex((e) => eq(e, h));
      if (index >= 0) {
        const aim = torpedoAimOptions(state, ship, session.map)[index];
        if (aim) {
          const ok = act.dispatch({
            type: 'launchOrdnance',
            by: activePlayer(state),
            ship: ship.id,
            kind: 'torpedo',
            aim,
          });
          if (ok) setUi({ aiming: null });
        }
        return;
      }
    }

    const here = visibleAt(h);
    if (here.length === 0) {
      if (state.phase !== 'combat') act.select(null);
      return;
    }

    if (state.phase === 'combat') {
      const me = activePlayer(state);
      const friends = here.filter(
        (s) => areAllied(state, me, s.owner) && !SHIP_CLASSES[s.shipClass].defensiveOnly,
      );
      const foes = here.filter((s) => !areAllied(state, me, s.owner));
      if (foes.length > 0) {
        // "If more than one ship occupies a hex, the attacker may attack one,
        // some, or all of them in one attack" — a hex click takes the whole hex;
        // the chips in the combat panel trim it down.
        const allSelected = foes.every((s) => ui.targets.includes(s.id));
        const next = allSelected
          ? ui.targets.filter((id) => !foes.some((s) => s.id === id))
          : [...new Set([...ui.targets, ...foes.map((s) => s.id)])];
        setUi({ targets: next, selected: here[0]!.id });
        return;
      }
      if (friends.length > 0) {
        const allSelected = friends.every((s) => ui.attackers.includes(s.id));
        const next = allSelected
          ? ui.attackers.filter((id) => !friends.some((s) => s.id === id))
          : [...new Set([...ui.attackers, ...friends.map((s) => s.id)])];
        setUi({ attackers: next, selected: here[0]!.id });
        return;
      }
    }

    // Otherwise cycle through the stack: "any number of ships may occupy the same hex."
    const at = here.findIndex((s) => s.id === ui.selected);
    const next = here[(at + 1) % here.length];
    if (next) act.select(next.id);
  };

  const handleHexHover = (h: Hex | null): void => {
    if (!session) return;
    const sameHex =
      (h === null && ui.hoverHex === null) ||
      (h !== null && ui.hoverHex !== null && eq(h, ui.hoverHex));

    let endpoint: Hex | null = null;
    if (h && session.state.phase === 'astrogation') {
      const option = plotOptions().find((o) => eq(o.endpoint, h));
      endpoint = option ? option.endpoint : null;
    }
    const sameEndpoint =
      (endpoint === null && ui.hoverEndpoint === null) ||
      (endpoint !== null && ui.hoverEndpoint !== null && eq(endpoint, ui.hoverEndpoint));

    if (sameHex && sameEndpoint) return;
    ui = { ...ui, hoverHex: h, hoverEndpoint: endpoint };
    schedule();
  };

  // --- Pointer bindings ----------------------------------------------------

  let pointerId: number | null = null;
  let dragStart: { x: number; y: number } | null = null;
  let dragged = false;
  let last: { x: number; y: number } | null = null;

  const localPoint = (ev: PointerEvent | WheelEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.button !== 1) return;
    pointerId = ev.pointerId;
    canvas.setPointerCapture(ev.pointerId);
    const p = localPoint(ev);
    dragStart = p;
    last = p;
    dragged = false;
  };

  const onPointerMove = (ev: PointerEvent): void => {
    const p = localPoint(ev);
    if (pointerId === ev.pointerId && dragStart && last) {
      if (!dragged && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > DRAG_THRESHOLD_PX) {
        dragged = true;
        canvas.classList.add('is-dragging');
      }
      if (dragged) {
        renderer?.panBy(p.x - last.x, p.y - last.y);
        last = p;
        schedule();
        return;
      }
    }
    handleHexHover(renderer ? renderer.screenToHex(p.x, p.y) : null);
  };

  const onPointerUp = (ev: PointerEvent): void => {
    if (pointerId !== ev.pointerId) return;
    const p = localPoint(ev);
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    pointerId = null;
    dragStart = null;
    last = null;
    canvas.classList.remove('is-dragging');
    if (dragged) {
      dragged = false;
      return;
    }
    if (renderer) handleHexClick(renderer.screenToHex(p.x, p.y));
  };

  const onPointerLeave = (): void => handleHexHover(null);

  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = localPoint(ev);
    const factor = Math.pow(0.999, ev.deltaY);
    renderer?.zoomAt(p.x, p.y, factor);
    schedule();
  };

  // --- Keyboard ------------------------------------------------------------

  const isTyping = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  const overlayOpen = (): boolean => overlays.childElementCount > 0;

  /** Tab-cycling belongs to the chart; inside the panels, Tab is still Tab. */
  const mapHasKeyboard = (): boolean => {
    const a = document.activeElement;
    return (
      a === null ||
      a === document.body ||
      a === canvas ||
      (a instanceof HTMLElement && a.classList.contains('row'))
    );
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (isTyping(ev.target)) return;
    if (overlayOpen() && ev.key !== 'Escape') return;
    if (!session) return;

    switch (ev.key) {
      case 'Tab':
        if (!mapHasKeyboard()) return;
        ev.preventDefault();
        act.cycle(ev.shiftKey ? -1 : 1);
        return;
      case ' ':
        if (!mapHasKeyboard()) return;
        ev.preventDefault();
        act.endPhase();
        return;
      case 'Escape':
        if (overlayOpen()) return;
        ev.preventDefault();
        if (ui.aiming) act.setAiming(null);
        else if (ui.landingPicker) act.setLandingPicker(false);
        else if (ui.attackers.length > 0 || ui.targets.length > 0) act.clearCombatSelection();
        else act.select(null);
        return;
      case 'g':
      case 'G':
        act.toggleFlag('gravity');
        return;
      case 'd':
      case 'D':
        act.toggleFlag('detection');
        return;
      case 'h':
      case 'H':
        act.toggleFlag('history');
        return;
      case 'f':
      case 'F':
        act.fit();
        return;
      case '+':
      case '=':
        act.zoom(1.25);
        return;
      case '-':
      case '_':
        act.zoom(0.8);
        return;
      case '?':
        act.openHelp();
        return;
      case 'u':
      case 'U':
        act.undo();
        return;
      default:
        return;
    }
  };

  // --- Rendering -----------------------------------------------------------

  /** Turn the shell's intent into the renderer's overlay contract. */
  const renderView = (s: SessionPort): RenderView => {
    const state = s.state;
    const me = activePlayer(state);
    const ship = selectedShip();

    // While aiming a torpedo the candidate hexes take over the "reachable"
    // channel: same affordance, different order — click a lit hex to commit.
    const reachable: {
      hex: Hex;
      accel: 0 | 1 | 2;
      danger?: string;
      orbit?: string;
      speed?: number;
    }[] = [];
    if (ui.aiming === 'torpedo') {
      for (const h of aimEndpoints()) reachable.push({ hex: h, accel: 1 });
    } else {
      for (const option of plotOptions()) {
        const danger = option.crashesInto
          ? `crashes into ${s.map.body(option.crashesInto)?.name ?? option.crashesInto}`
          : option.exitsMap
            ? 'leaves the chart'
            : option.asteroidHexes.length > 0
              ? `${option.asteroidHexes.length} asteroid hex(es)`
              : undefined;
        // Would this burn leave the ship in orbit? Orbit is emergent in
        // Triplanetary -- one hex per turn between adjacent gravity hexes of
        // the same body -- so it has to be derived from the resulting vector.
        const orbitBody =
          ship && !danger
            ? s.map.orbitOf(option.endpoint, sub(option.endpoint, ship.pos))
            : undefined;
        reachable.push({
          hex: option.endpoint,
          accel: option.accel,
          ...(danger ? { danger } : {}),
          ...(orbitBody ? { orbit: orbitBody.name } : {}),
          ...(ship ? { speed: hexLength(sub(option.endpoint, ship.pos)) } : {}),
        });
      }
    }

    // The single line the odds board is quoting, so the chart and the panel
    // always agree about what is being shot at.
    let attackPreview: { from: Hex; to: Hex; blocked: boolean } | null = null;
    const firstAttacker = ui.attackers[0] ? state.ships[ui.attackers[0]] : undefined;
    const firstTarget = ui.targets[0] ? state.ships[ui.targets[0]] : undefined;
    if (firstAttacker && firstTarget) {
      attackPreview = {
        from: firstAttacker.pos,
        to: firstTarget.pos,
        blocked: !s.map.hasLineOfSight(firstAttacker.pos, firstTarget.pos),
      };
    }

    const hiddenShips = new Set<ShipId>();
    if (state.options.fogOfWar) {
      for (const other of Object.values(state.ships)) {
        if (!other.destroyed && !isDetected(state, other, me)) hiddenShips.add(other.id);
      }
    }

    return {
      viewer: me,
      selectedShip: ui.selected,
      hoveredHex: ui.hoverHex,
      reachable,
      plannedEndpoint: ui.hoverEndpoint ?? ship?.plottedEndpoint ?? null,
      attackPreview,
      showGravity: ui.flags.gravity,
      showDetection: ui.flags.detection,
      showCourseHistory: ui.flags.history,
      hiddenShips,
    };
  };

  const drawFlash = (): void => {
    if (!renderer || ui.flash.length === 0) {
      fill(flashLayer);
      return;
    }
    const r = renderer;
    fill(
      flashLayer,
      ...ui.flash.map((h) => {
        const p = r.hexToScreen(h);
        return el('i', {
          class: 'flash-ring',
          style: { left: `${p.x}px`, top: `${p.y}px` },
        });
      }),
    );
  };

  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  const render = (): void => {
    if (!session) return;
    const state = session.state;

    // A new player-turn or phase invalidates half-built orders.
    const nextKey = `${state.turn}:${state.activePlayerIndex}:${state.phase}`;
    if (nextKey !== turnKey) {
      turnKey = nextKey;
      ui = {
        ...ui,
        attackers: [],
        targets: [],
        limitedStrength: null,
        aiming: null,
        landingPicker: false,
        overload: false,
        hoverEndpoint: null,
      };
      const owned = commandable();
      const stillMine = ui.selected ? owned.some((s) => s.id === ui.selected) : false;
      if (!stillMine) ui = { ...ui, selected: owned[0]?.id ?? null };
    }

    const ctx: Ctx = {
      state,
      map: session.map,
      ui,
      act,
      viewer: activePlayer(state),
    };

    root.classList.toggle('is-left-closed', !ui.leftOpen);
    root.classList.toggle('is-right-closed', !ui.rightOpen);
    root.classList.toggle('is-reduced-motion', reducedMotion);
    root.dataset['sheet'] = ui.sheet;
    root.dataset['phase'] = state.phase;

    for (const panel of panels) panel.update(ctx);
    drawNotice();

    renderer?.render(state, renderView(session));
    drawFlash();

    if (state.victory && !victoryShown) {
      victoryShown = true;
      showVictory();
    }
  };

  const drawNotice = (): void => {
    if (!ui.notice) {
      fill(noticeHost);
      return;
    }
    fill(
      noticeHost,
      el(
        'div',
        { class: `notice tone-${ui.notice.tone}` },
        icon('warning', 14),
        el('span', { text: ui.notice.text }),
        button({
          label: '×',
          variant: 'quiet',
          class: 'notice-x',
          onClick: () => setUi({ notice: null }),
          title: 'Dismiss',
        }),
      ),
    );
  };

  const showVictory = (): void => {
    if (!session) return;
    const v = session.state.victory;
    if (!v) return;
    const names = v.winners.map((id) => session!.state.players[id]?.name ?? id).join(', ');
    openModal(overlays, {
      title: names ? `${names} win` : 'The game is over',
      subtitle: `${v.level} victory`,
      body: el('p', { class: 'help-p', text: v.reason }),
      actions: [
        {
          label: 'Review the board',
          variant: 'quiet',
          onClick: () => undefined,
        },
        { label: 'New game', variant: 'primary', onClick: () => act.newGame() },
      ],
    });
  };

  // --- Lifecycle -----------------------------------------------------------

  const startScenario = (id: string, newSeed: number, options: Partial<GameOptions>): void => {
    scenarioId = id;
    seed = newSeed;
    gameOptions = { ...DEFAULT_OPTIONS, ...options };
    const state = deps.buildScenario(id, { seed, options: gameOptions });

    unsubscribe?.();
    session = deps.createSession(state);
    unsubscribe = session.subscribe(() => render());

    ui = { ...INITIAL_UI, flags: ui.flags };
    victoryShown = false;
    turnKey = '';
    syncViewInset();
    renderer?.fitAll(state);
    render();
    canvas.focus();
  };

  /**
   * Measure the screen edges the floating panels cover, straight from the CSS
   * custom properties that lay them out, so the value tracks the collapse
   * states and the responsive breakpoints without duplicating either.
   */
  const viewInset = (): { top: number; right: number; bottom: number; left: number } => {
    const cs = getComputedStyle(root);
    const px = (name: string): number => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : 0;
    };
    const gap = px('--gap');
    // Below the stacking breakpoint the side panels become bottom sheets, so
    // only the top bar is really occluding the chart.
    const stacked = window.matchMedia('(max-width: 900px)').matches;
    return stacked
      ? { top: px('--top-h') + gap, right: 0, bottom: 0, left: 0 }
      : {
          top: px('--top-h') + gap,
          right: px('--right-w') + gap,
          bottom: px('--log-h') + gap,
          left: px('--left-w') + gap,
        };
  };

  const syncViewInset = (): void => {
    renderer?.setViewInset(viewInset());
  };

  const resizeObserver = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer?.resize();
    syncViewInset();
    schedule();
  });

  const start = (): void => {
    deps.root.appendChild(root);
    renderer = deps.createRenderer(canvas, deps.map);
    renderer.resize();
    syncViewInset();
    renderer.fitChart();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    resizeObserver.observe(canvas);

    act.newGame();
  };

  const destroy = (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    resizeObserver.disconnect();
    window.clearTimeout(noticeTimer);
    if (frame) window.cancelAnimationFrame(frame);
    unsubscribe?.();
    root.remove();
  };

  return { el: root, start, destroy };
};
