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
  type GameState,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipId,
  DEFAULT_OPTIONS,
  PHASE_LABELS,
  activePlayer,
  areAllied,
  liveShips,
  controllerOf,
} from '@engine/types.js';
import type { PlotOption, PlotPreview } from '@engine/movement.js';
import { phaseIsIdle } from '@engine/reducer.js';
import { createInitialState } from '@engine/state.js';
import type { Command } from '@engine/commands.js';
import { button, el, fill } from './components/dom.js';
import { icon } from './components/glyphs.js';
import { type Overlay, openModal } from './components/modal.js';
import { aiCommand } from '../ai/driver.js';
import { type OrderOfBattle, isCampaignBattle, orderOf } from '@campaign/orders.js';
import { CAMPAIGN_SIDES, SITES } from '@campaign/data.js';
import type {
  AppDeps,
  ComputerSeats,
  OnlineMode,
  OnlinePort,
  RenderView,
  RendererPort,
  SessionPort,
  TableEvents,
  TablePort,
} from './ports.js';
import { createCombatPanel } from './panels/combat.js';
import { createFleetPanel } from './panels/fleet.js';
import { createInspector } from './panels/inspector.js';
import {
  type Lobby,
  type TableActions,
  type TableView,
  createTableBadge,
  mountOnlineChoices,
  openHostDialog,
  openJoinDialog,
  openLobby,
} from './panels/lobby.js';
import { mountCampaignChoice, openWarRoom } from './panels/campaign.js';
import { createLogPanel } from './panels/logpanel.js';
import { openHelpDrawer } from './panels/help.js';
import { type PickerResult, openScenarioPicker } from './panels/scenarioPicker.js';
import {
  type TableOffer,
  mountAllGames,
  openOgrePicker,
  openStartMenu,
} from './panels/startMenu.js';
import { type BuilderCatalogue, openBattleBuilder } from './panels/battleBuilder.js';
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
  // The campaign's sites, pinned to their bodies while the war room is open —
  // the same `hexToScreen` trick as the flash layer, but clickable.
  const warPins = el('div', { class: 'war-pins' });
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

  // The online affordances all speak to the shell through one small verb list,
  // for the same reason the panels speak through `Actions`: the lobby and the
  // badge should not know whether leaving a table also tears down a session.
  const tableActions: TableActions = {
    sit: (seat) => void sitAt(seat),
    reclaim: (seat) => void reclaimSeat(seat),
    configure: () => void configureTable(),
    start: () => void startTable(),
    leave: () => leaveTable(true),
    notify: (text, tone) => act.notify(text, tone),
  };
  const badge = createTableBadge(tableActions);

  const root = el(
    'div',
    { class: 'app' },
    canvas,
    flashLayer,
    warPins,
    topBar.el,
    noticeHost,
    badge.el,
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
  /** Re-entry guard for `autoAdvance`: dispatching renders, which would recurse. */
  let busySkipping = false;
  /** The same guard for the computer's own loop. */
  let busyAi = false;
  /** Seats the computer plays, by player id. Empty for an all-human game. */
  let computerSeats: Set<PlayerId> = new Set();
  let ui: UiState = { ...INITIAL_UI };
  let scenarioId = deps.scenarios[0]?.id ?? '';
  let gameOptions: GameOptions = { ...DEFAULT_OPTIONS };
  let seed = deps.randomSeed();
  let helpOverlay: Overlay | null = null;
  let pickerOverlay: Overlay | null = null;
  let menuOverlay: Overlay | null = null;
  let noticeTimer = 0;
  let noticeSeq = 0;
  let victoryShown = false;
  let turnKey = '';
  let frame = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Online state --------------------------------------------------------

  /** The table this client is sitting at, or null for a game played here. */
  let table: TablePort | null = null;
  let lobby: Lobby | null = null;
  let joinOverlay: Overlay | null = null;
  /**
   * What the picker's Begin button is going to mean. Set by the online buttons
   * immediately before they press it — see `mountOnlineChoices`.
   */
  let intent: 'here' | 'online' = 'here';
  /**
   * Which arrangement the online buttons chose, and the password a quick table
   * needs. Held beside `intent` for the same reason: the picker's Begin button
   * is the only door out, and it takes no arguments.
   */
  let onlineAs: { mode: OnlineMode; password: string } = { mode: 'refereed', password: '' };
  /**
   * The code and seat we last held.
   *
   * Standing up vacates the seat, so coming back with an unspecified seat would
   * take the lowest open one rather than the one that was ours. Remembering it
   * is what makes leaving and rejoining resume the same side of the same game.
   */
  let resume: { code: string; seat: PlayerId | null } | null = null;

  /**
   * The tables this browser has sat at: code, password and the table's own
   * words for itself, so a player can come back to a game from the start
   * menu without a link or a memory for six letters. Kept in this browser
   * only, newest first, a dozen at most; a child table for a frozen sky is
   * not kept, because the war it belongs to is.
   */
  const TABLES_KEY = 'triplanetary-tables-v1';
  interface KnownTable {
    readonly code: string;
    readonly password: string;
    readonly mode: OnlineMode;
    readonly title: string;
    readonly when: number;
  }
  const readKnownTables = (): KnownTable[] => {
    try {
      const raw = localStorage.getItem(TABLES_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(
            (k): k is KnownTable =>
              typeof k === 'object' &&
              k !== null &&
              typeof (k as KnownTable).code === 'string' &&
              typeof (k as KnownTable).password === 'string' &&
              ((k as KnownTable).mode === 'quick' || (k as KnownTable).mode === 'refereed') &&
              typeof (k as KnownTable).title === 'string' &&
              typeof (k as KnownTable).when === 'number',
          )
        : [];
    } catch {
      return [];
    }
  };
  const writeKnownTables = (list: readonly KnownTable[]): void => {
    try {
      localStorage.setItem(TABLES_KEY, JSON.stringify(list.slice(0, 12)));
    } catch {
      // Storage blocked: the list simply is not kept.
    }
  };
  let remembered = '';
  const rememberTable = (t: TablePort): void => {
    const info = t.table;
    if (info === null || info.parent !== undefined) return;
    const title = info.title ?? scenarioName();
    const stamp = `${info.code}|${title}`;
    if (stamp === remembered) return;
    remembered = stamp;
    const entry: KnownTable = {
      code: info.code,
      password: t.password ?? '',
      mode: t.mode,
      title,
      when: Date.now(),
    };
    writeKnownTables([entry, ...readKnownTables().filter((k) => k.code !== info.code)]);
  };
  const forgetTable = (code: string): void => {
    writeKnownTables(readKnownTables().filter((k) => k.code !== code));
    if (remembered.startsWith(`${code}|`)) remembered = '';
  };
  const ago = (when: number): string => {
    const days = Math.floor((Date.now() - when) / 86_400_000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  const tableOffers = (): readonly TableOffer[] =>
    online.available
      ? readKnownTables().map((k) => ({
          label: `${k.title} · ${k.code}`,
          sub: `${k.mode === 'quick' ? 'quick table' : 'refereed table'}, ${ago(k.when)}`,
          onRejoin: () => void rejoinTable(k),
          onForget: () => forgetTable(k.code),
        }))
      : [];
  const rejoinTable = async (k: KnownTable): Promise<void> => {
    if (!online.available) return;
    const wanted = resume?.code === k.code ? (resume.seat ?? undefined) : undefined;
    try {
      enterTable(
        await online.join(k.code, wanted, tableEvents(), { mode: k.mode, password: k.password }),
      );
    } catch (err) {
      act.notify(
        `Could not rejoin ${k.code}: ${reasonOf(err)}. If the table is gone, forget it from the start menu.`,
        'bad',
      );
      if (!session && table === null) act.newGame();
    }
  };

  const online: OnlinePort = deps.online ?? {
    available: false,
    reason: 'This build has no server to play on.',
  };

  const scenarioName = (): string =>
    table?.table?.title ?? deps.scenarios.find((s) => s.id === scenarioId)?.name ?? 'Triplanetary';

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

  /**
   * Whose eyes the chart is drawn through.
   *
   * Hot-seat play renders for whoever is to move, because the person at the
   * keyboard changes with the turn. At an online table it never does: the board
   * this client holds was redacted for one seat, and drawing it as somebody
   * else's would both hide ships this player is entitled to see and light up
   * ones they are not.
   */
  const viewerOf = (state: GameState): PlayerId => table?.seat ?? activePlayer(state);

  const visibleAt = (h: Hex): Ship[] => {
    if (!session) return [];
    const state = session.state;
    const me = viewerOf(state);
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
      const t = table;
      if (t) {
        // Online the board does not move here. "The referee draws a fresh,
        // unguessable seed for every command", and this client is not told what
        // it was until the command has been resolved, so applying anything now
        // would be a guess at the dice. What the shell may still do is treat the
        // half-built order as spent, because that is interface state and not the
        // game; a refusal arrives moments later as a notice.
        void t.send(cmd).catch((err: unknown) => act.notify(reasonOf(err), 'bad'));
        return true;
      }
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
      if (table) {
        // Rewinding this client rewinds nothing at anybody else's. The referee's
        // log is the only history an online table has.
        act.notify('There is no undo at an online table — the referee holds the log.', 'warn');
        return;
      }
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
      raiseNotice(text, tone);
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
      if (menuOverlay || pickerOverlay || ogrePickerOverlay) return;
      const savedGame = session === null ? readGameSave() : null;
      const anyBattle = groundBattle === null ? readBattleSave() : null;
      // An Orbital Drop assault belongs to its war: resuming the war mounts
      // the battle where it was left, so the menu offers the war once.
      const battleInWar =
        savedGame?.scenarioId === 'orbital-drop' &&
        anyBattle?.source.kind === 'order' &&
        anyBattle.source.order.battleId.startsWith('drop-');
      const savedBattle = battleInWar ? null : anyBattle;
      menuOverlay = openStartMenu(overlays, {
        campaignRunning: deps.campaign.current() !== null,
        dismissible: session !== null || table !== null,
        resumeGame: savedGame
          ? {
              label: `${savedGame.name}, day ${savedGame.turn}${
                battleInWar ? ` — ${anyBattle.name} under way` : ''
              }`,
              onResume: () => resumeGame(savedGame),
              onDiscard: () => clearGameSave(),
            }
          : null,
        tables: tableOffers(),
        resumeBattle: savedBattle
          ? {
              label: `${savedBattle.name}, turn ${savedBattle.turn}`,
              onResume: () => resumeBattle(savedBattle),
              onDiscard: () => clearBattleSave(),
            }
          : null,
        onClose: () => {
          menuOverlay = null;
        },
        onTriplanetary: () => openTriPicker(),
        onOgre: () => void openOgreScenarios(),
        // The war IS a scenario now: Orbital Drop, hot seat, fresh seed.
        onCampaign: () =>
          startScenario('orbital-drop', deps.randomSeed(), gameOptions, undefined, []),
      });
    },
  };

  /**
   * The Triplanetary door — the scenario picker this app has always opened
   * first, now one of three. Its foot keeps every other way out: host and
   * join, the campaign, and the way back to the start menu.
   */
  const openTriPicker = (): void => {
    if (pickerOverlay) return;
    intent = 'here';
    const overlay = openScenarioPicker(
      overlays,
      deps.scenarios,
      { id: scenarioId, options: gameOptions, seed },
      (result) => {
        pickerOverlay = null;
        if (intent === 'online') {
          void hostTable(result);
          return;
        }
        startScenario(
          result.id,
          result.opts.seed,
          result.opts.options,
          result.opts.fleets,
          result.computerSeats,
        );
      },
      session !== null,
      () => {
        pickerOverlay = null;
      },
    );
    pickerOverlay = overlay;
    mountOnlineChoices(overlay, {
      host: overlays,
      reason: online.available ? null : online.reason,
      ...(online.available ? { modes: online.modes } : {}),
      onHost: (mode, password) => {
        intent = 'online';
        onlineAs = { mode, password };
        beginFrom(overlay);
      },
      onJoin: () => {
        overlay.close();
        promptJoin(null);
      },
    });
    mountCampaignChoice(overlay, {
      running: deps.campaign.current() !== null,
      onOpen: () => {
        overlay.close();
        openCampaign();
      },
    });
    mountAllGames(overlay, () => act.newGame());
  };

  /**
   * Press the picker's own Begin button.
   *
   * The scenario, the optional rules, the seed and the fleets live inside the
   * picker and leave it only through that button. Hosting wants the same
   * choices as playing here, so it makes the same choice and changes only what
   * the answer means — see `intent`.
   */
  const beginFrom = (overlay: Overlay): void => {
    overlay.el.querySelector<HTMLButtonElement>('.modal-foot .btn-primary')?.click();
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
      case 'k':
      case 'K':
        act.toggleFlag('autoSkip');
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
    const me = viewerOf(state);
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

  // --- The war-room backdrop ------------------------------------------------

  /**
   * A shipless state for drawing the bare chart: the planets, the orbits and
   * the printed bases, with nothing in flight. Minted once — the strategic
   * layer never mutates it.
   */
  let chartState: GameState | null = null;
  const warChartState = (): GameState =>
    (chartState ??= createInitialState({
      scenarioId: 'war-room',
      seed: 1,
      players: [],
      ships: [],
      map: deps.map,
    }));

  /**
   * With no game in progress the canvas shows the chart itself, so the start
   * menu and the war room sit over the inner system rather than a void — and
   * while the war room is open, the campaign's sites are pinned to their
   * bodies on it.
   */
  const drawWarBackdrop = (): void => {
    if (!renderer) return;
    renderer.render(warChartState(), {
      viewer: null,
      showGravity: false,
      showDetection: false,
      showCourseHistory: false,
    });
    updateWarPins();
  };

  /**
   * One chart pin: a slim chip off the body's right shoulder, scaled to the
   * zoom the way the canvas layers scale. Far out it is a dot and a name;
   * zoomed in it grows its economy line. It never sits on the planet.
   */
  const chartPin = (o: {
    hex: Hex;
    name: string;
    color: string | null;
    title: string;
    meta: string;
    flag: string | null;
    contested: boolean;
    onClick(): void;
  }): HTMLElement | null => {
    const r = renderer;
    if (!r) return null;
    const px = r.hexPx();
    const p = r.hexToScreen(o.hex);
    const full = px >= 16;
    const tiny = px < 7;
    return el(
      'button',
      {
        class:
          'war-pin' +
          (full ? ' war-pin--full' : '') +
          (tiny ? ' war-pin--tiny' : '') +
          (o.contested ? ' is-contested' : ''),
        type: 'button',
        style: {
          left: `${p.x + Math.max(9, px * 0.95)}px`,
          top: `${p.y}px`,
          '--player': o.color ?? 'var(--ink-faint)',
        },
        title: o.title,
        onclick: o.onClick,
      },
      el('span', { class: 'war-pin-dot' }),
      el('span', { class: 'war-pin-name', text: o.name }),
      full ? el('span', { class: 'war-pin-meta mono', text: o.meta }) : null,
      full && o.flag ? el('span', { class: 'war-pin-flag', text: o.flag }) : null,
    );
  };

  /**
   * Chips in a cluster — Terra and Luna, the Jovian moons — slide apart
   * instead of stacking: any chip overlapping an earlier one steps below it.
   */
  const declutterPins = (): void => {
    const kids = [...warPins.children] as HTMLElement[];
    const boxes = kids
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    for (let i = 1; i < boxes.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = boxes[j]!.r;
        const b = boxes[i]!.r;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          const shift = a.bottom - b.top + 2;
          const node = boxes[i]!.n;
          node.style.top = `${parseFloat(node.style.top) + shift}px`;
          boxes[i]!.r = new DOMRect(b.x, b.y + shift, b.width, b.height);
        }
      }
    }
  };

  const updateWarPins = (): void => {
    const camp = warRoom ? deps.campaign.current() : null;
    if (!renderer || !camp) {
      if (warPins.childElementCount > 0) fill(warPins);
      return;
    }
    const state = camp.state;
    fill(
      warPins,
      ...SITES.flatMap((def) => {
        const body = deps.map.bodies.find((b) => b.id === def.id);
        const site = state.sites[def.id];
        if (!body || !site) return [];
        const holder = site.holder ? CAMPAIGN_SIDES[site.holder] : null;
        const troops = Object.values(site.garrison).reduce((n, c) => n + c, 0);
        const contested = state.pending?.site === def.id;
        const pin = chartPin({
          hex: body.hex,
          name: def.name,
          color: holder?.color ?? null,
          title: `${def.name} — ${holder?.name ?? 'unclaimed'}`,
          meta: `${def.production} PP · ${troops > 0 ? `${troops} garrison` : 'open'}`,
          flag: contested ? 'under attack' : null,
          contested,
          onClick: () => focusWarSite(def.id),
        });
        return pin ? [pin] : [];
      }),
    );
    declutterPins();
  };

  /**
   * Orbital Drop's pins: every body with a base, its holder and its garrison,
   * read live off the game state. The same layer the old war room pins use.
   */
  const updateDropPins = (state: GameState): void => {
    if (!renderer) return;
    const data = state.scenarioData['orbitalDrop'] as
      | {
          garrisons?: Record<
            string,
            { units?: Record<string, number>; reaction?: Record<string, number> }
          >;
          invasion?: { world?: string } | null;
        }
      | undefined;
    const garrisons = data?.garrisons ?? {};
    const contestedWorld = data?.invasion?.world ?? null;

    const byBody = new Map<string, { owner: PlayerId | null; bases: number; troops: number }>();
    for (const base of Object.values(state.bases)) {
      if (base.destroyed || base.kind === 'orbital') continue;
      const world = deps.map.bodyAt(base.hex)?.id ?? base.id.split(':')[0]!;
      const entry = byBody.get(world) ?? { owner: null, bases: 0, troops: 0 };
      entry.bases += 1;
      if (base.owner !== null) entry.owner = base.owner;
      const g = garrisons[base.id];
      const count = (f?: Record<string, number>): number =>
        Object.values(f ?? {}).reduce((n, c) => n + c, 0);
      entry.troops += count(g?.units) + count(g?.reaction);
      byBody.set(world, entry);
    }

    fill(
      warPins,
      ...[...byBody.entries()].flatMap(([world, info]) => {
        const body = deps.map.bodies.find((b) => b.id === world);
        if (!body) return [];
        const holder = info.owner ? state.players[info.owner] : null;
        const contested = contestedWorld === world;
        const pin = chartPin({
          hex: body.hex,
          name: body.name,
          color: holder?.color ?? null,
          title:
            `${body.name} — ${holder?.name ?? 'militia only'} · ` +
            `MCr ${(info.bases * 0.5).toFixed(1)}/day · ` +
            `${info.troops > 0 ? `${info.troops} garrison` : 'militia'}`,
          meta: `MCr ${(info.bases * 0.5).toFixed(1)}/day · ${info.troops > 0 ? `${info.troops} garrison` : 'militia'}`,
          flag: contested ? 'invasion' : null,
          contested,
          onClick: () => {
            renderer?.focusOn(body.hex);
            schedule();
          },
        });
        return pin ? [pin] : [];
      }),
    );
    declutterPins();
  };

  /** A pin was clicked: bring that site's card into view in the war room. */
  const focusWarSite = (id: string): void => {
    const card = warRoom?.el.querySelector<HTMLElement>(`[data-site="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.classList.remove('is-flash');
    // Reflow so a second click on the same site restarts the animation.
    void card.offsetWidth;
    card.classList.add('is-flash');
  };

  /**
   * Advance through phases in which nobody has an order to give.
   *
   * The rules are untouched: every phase still happens and everything the
   * sequence of play does automatically inside it still runs — ships move,
   * ordnance flies, detectors sweep, damage recovers. What is dropped is the
   * prompt, because a phase whose only legal orders are "end phase" and
   * "concede" is a click that changes nothing.
   *
   * Three guards make this safe to run on every render:
   *
   *  - `phaseIsIdle` asks *every* player, so a phase in which somebody else owes
   *    return fire or an answer to a surrender demand is never skipped.
   *  - `busy` stops re-entry: `dispatch` notifies subscribers, which renders,
   *    which would come straight back in here.
   *  - The loop stops the moment a phase fails to advance, so a rejected or
   *    inert `endPhase` can never spin.
   */
  /**
   * Show a transient notice and arm its dismissal, without rendering.
   *
   * Separated from `act.notify` so `autoAdvance` can raise one from inside its
   * loop: notifying would render, and rendering is what called it.
   */
  const raiseNotice = (text: string, tone: Notice['tone']): void => {
    const notice: Notice = { text, tone, id: ++noticeSeq };
    ui = { ...ui, notice };
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      if (ui.notice?.id === notice.id) setUi({ notice: null });
    }, NOTICE_MS);
  };

  /**
   * Let the computer play its seats.
   *
   * It dispatches through the same session a person's click does, so every order
   * is logged, judged and undoable exactly as theirs would be — the computer has
   * no private channel into the engine. The loop runs to completion before the
   * frame is drawn, which is why the interface never shows a half-finished
   * computer turn, and why there is no timer to leak: it is the same shape as
   * `autoAdvance` below, and shares its re-entry discipline.
   *
   * The step budget is a backstop against a policy bug, not a rule. A whole game
   * turn for every seat is far more orders than any honest position needs.
   */
  const runComputerSeats = (): void => {
    if (!session || busyAi || computerSeats.size === 0) return;
    busyAi = true;
    try {
      const limit = 60 * Math.max(1, session.state.playerOrder.length);
      let gave = 0;
      for (let i = 0; i < limit; i += 1) {
        const before = session.state;
        if (before.victory) break;
        const order = aiCommand(before, computerSeats, session.map);
        if (order === null) break;
        if (!session.dispatch(order.command).ok) {
          // An order the engine refuses is a bug in the policy, not something to
          // retry: stop and let the player see where it got stuck.
          raiseNotice(
            `The computer gave an order the rules refused (${order.command.type}).`,
            'bad',
          );
          break;
        }
        if (session.state === before) break;
        if (order.command.type !== 'endPhase') gave += 1;
      }
      if (gave > 0) {
        const who = [...computerSeats]
          .map((p) => session?.state.players[p]?.faction ?? p)
          .join(' and ');
        raiseNotice(`${who} played — see the log.`, 'info');
      }
    } finally {
      busyAi = false;
    }
  };

  const autoAdvance = (): void => {
    // Never online. This walks the sequence of play by dispatching `endPhase`
    // straight into the session, which at a table is a view of somebody else's
    // authority: the phase would advance here and nowhere else. The referee is
    // the only participant that may decide a phase is empty.
    if (!session || table !== null || busySkipping || !ui.flags.autoSkip) return;
    busySkipping = true;
    try {
      const skipped: Phase[] = [];
      // A whole turn for every seat, and no more: enough to walk out of a dead
      // patch, bounded so a bug cannot hang the interface.
      const limit = 5 * Math.max(1, session.state.playerOrder.length) + 1;
      for (let i = 0; i < limit; i += 1) {
        const before = session.state;
        if (!phaseIsIdle(before, session.map)) break;
        const seat = activePlayer(before);
        if (!session.dispatch({ type: 'endPhase', by: seat }).ok) break;
        const after = session.state;
        if (after.phase === before.phase && after.activePlayerIndex === before.activePlayerIndex) {
          break;
        }
        skipped.push(before.phase);
      }
      if (skipped.length > 0) {
        // Say what was skipped. A phase that vanishes without a word reads as
        // the interface losing your click.
        const names = [...new Set(skipped)].map((p) => PHASE_LABELS[p].toLowerCase());
        raiseNotice(`Skipped ${names.join(', ')} — nothing to do.`, 'info');
      }
    } finally {
      busySkipping = false;
    }
  };

  const render = (): void => {
    // With no game running the play panels are empty frames; hide them so the
    // chart under the start menu and the war room is the chart, not chrome.
    root.classList.toggle('is-idle', !session);
    if (!session) {
      paintTable();
      drawWarBackdrop();
      return;
    }
    if (session.state.scenarioId === 'orbital-drop') {
      updateDropPins(session.state);
      syncOrbitalGround();
    } else if (warPins.childElementCount > 0) {
      fill(warPins);
    }
    runComputerSeats();
    autoAdvance();
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
      viewer: viewerOf(state),
    };

    root.classList.toggle('is-left-closed', !ui.leftOpen);
    root.classList.toggle('is-right-closed', !ui.rightOpen);
    root.classList.toggle('is-reduced-motion', reducedMotion);
    root.dataset['sheet'] = ui.sheet;
    root.dataset['phase'] = state.phase;

    for (const panel of panels) panel.update(ctx);
    drawNotice();
    paintTable();

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

    // Where a campaign battle's result goes. If the war room in this browser
    // is waiting on exactly this battle, one button hands it over; otherwise —
    // the battle arrived as a token or a table code from a campaign running
    // somewhere else — the result leaves the way the order came, as a token.
    const order = orderOf(session.state.scenarioData);
    const fromCampaign = order !== null && isCampaignBattle(order);
    const result = fromCampaign ? deps.campaign.resultFor(session.state, session.history) : null;
    const pendingId = deps.campaign.current()?.state.pending?.order?.battleId ?? null;
    const reportable = result !== null && order !== null && order.battleId === pendingId;
    const token = result !== null && !reportable ? deps.campaign.resultToken(result) : null;

    const tokenField = token
      ? el('textarea', {
          class: 'battle-token',
          readonly: true,
          rows: '4',
          'aria-label': 'Battle result token',
          onFocus: (ev: FocusEvent) => (ev.target as HTMLTextAreaElement).select(),
          text: token,
        })
      : null;

    openModal(overlays, {
      title: names ? `${names} win` : 'The game is over',
      subtitle: `${v.level} victory`,
      body: token
        ? el(
            'div',
            {},
            el('p', { class: 'help-p', text: v.reason }),
            el('p', {
              class: 'help-p',
              text: 'This was a campaign battle. Copy the result below and paste it back into the war room it came from.',
            }),
            tokenField,
          )
        : el('p', { class: 'help-p', text: v.reason }),
      actions: [
        ...(reportable && result !== null
          ? [
              {
                label: 'Report to the campaign',
                variant: 'primary' as const,
                onClick: () => {
                  const outcome = deps.campaign.current()?.dispatch({
                    type: 'reportBattle',
                    result,
                  });
                  if (outcome?.ok) openCampaign();
                  else act.notify(outcome?.reason ?? 'The campaign refused the result.', 'bad');
                },
              },
            ]
          : []),
        ...(token
          ? [
              {
                label: 'Copy the result',
                variant: 'primary' as const,
                closes: false,
                onClick: () => {
                  navigator.clipboard?.writeText(token).then(
                    () => act.notify('Result copied. Paste it into the campaign.', 'info'),
                    () => tokenField?.select(),
                  );
                },
              },
            ]
          : []),
        {
          label: 'Review the board',
          variant: 'quiet',
          onClick: () => undefined,
        },
        {
          label: 'New game',
          variant: token || reportable ? 'quiet' : 'primary',
          onClick: () => act.newGame(),
        },
      ],
    });
  };

  // --- Campaign battles ----------------------------------------------------

  /** One line for the pre-game dialog: who sails where, against what. */
  const transferSummary = (order: OrderOfBattle): string => {
    const [convoy, patrol] = order.sides;
    const target = deps.map.body(String(order.terms['target']))?.name ?? '?';
    const freight = convoy?.forces['freight'] ?? 0;
    return (
      `${convoy?.faction ?? 'The convoy'} sails for ${target} with ${freight} lots of ` +
      `ground force aboard; ${patrol?.faction ?? 'the patrol'} comes out to meet it.`
    );
  };

  /**
   * Start a battle the campaign ordered. The order decides the scenario and
   * both fleets; the one choice left to make here is who plays each seat,
   * which is what `promptBattle` asks.
   */
  const startBattle = (order: OrderOfBattle, computer: ComputerSeats): void => {
    closeTable(true);
    let state: GameState;
    try {
      state = deps.buildScenario(order.scenarioId, { seed: order.seed, options: {}, order });
    } catch (err) {
      act.notify(reasonOf(err), 'bad');
      act.newGame();
      return;
    }
    scenarioId = state.scenarioId;
    computerSeats = new Set(
      computer.map((i) => state.playerOrder[i]).filter((p): p is PlayerId => p !== undefined),
    );
    installSession(deps.createSession(state));
    canvas.focus();
  };

  /** A campaign battle is an instruction, like a `?join=` link: honour it first. */
  const promptBattle = (order: OrderOfBattle): void => {
    openModal(overlays, {
      title: 'A battle from the campaign',
      subtitle: 'Contested transfer',
      body: el(
        'div',
        {},
        el('p', { class: 'help-p', text: transferSummary(order) }),
        el('p', {
          class: 'help-p',
          text: 'Play both seats at this keyboard, or hand one to the computer. When the transfer is decided, the result goes back to the campaign.',
        }),
      ),
      actions: [
        { label: 'Both seats here', variant: 'primary', onClick: () => startBattle(order, []) },
        {
          label: 'Computer flies the patrol',
          variant: 'quiet',
          onClick: () => startBattle(order, [1]),
        },
        {
          label: 'Computer flies the convoy',
          variant: 'quiet',
          onClick: () => startBattle(order, [0]),
        },
      ],
    });
  };

  // --- The embedded Ogre battle ---------------------------------------------

  /** The mounted ground battle, if one is being fought. */
  let groundBattle: { destroy(): void } | null = null;

  const closeGroundBattle = (): void => {
    groundBattle?.destroy();
    groundBattle = null;
  };

  // --- Battle autosave -------------------------------------------------------

  /**
   * An unfinished Ogre battle is saved in this browser after every accepted
   * order, as what built it plus its command log — the same replayable shape
   * the campaign uses. One at a time: a new battle replaces the save, and a
   * finished one clears it.
   */
  const BATTLE_KEY = 'triplanetary-ogre-battle-v1';
  interface BattleSave {
    readonly v: 1;
    readonly source:
      | {
          readonly kind: 'scenario';
          readonly id: string;
          readonly seed: number;
          /** A custom battle's order: the forces, the map and the terms. */
          readonly order?: OrderOfBattle;
        }
      | { readonly kind: 'order'; readonly order: OrderOfBattle };
    readonly ai: readonly string[];
    readonly setup: boolean;
    readonly log: readonly unknown[];
    readonly name: string;
    readonly turn: number;
  }

  const readBattleSave = (): BattleSave | null => {
    try {
      const raw = localStorage.getItem(BATTLE_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as BattleSave;
      return parsed && parsed.v === 1 && Array.isArray(parsed.log) ? parsed : null;
    } catch {
      return null;
    }
  };
  const writeBattleSave = (save: BattleSave): void => {
    try {
      localStorage.setItem(BATTLE_KEY, JSON.stringify(save));
    } catch {
      // Storage blocked: the battle simply is not saved.
    }
  };
  const clearBattleSave = (): void => {
    try {
      localStorage.removeItem(BATTLE_KEY);
    } catch {
      // Nothing to clear.
    }
  };

  /** The autosave hook every mounted battle gets. */
  const battleProgress =
    (source: BattleSave['source'], ai: readonly string[], setup: boolean) =>
    (log: readonly unknown[], info: { scenarioName: string; turn: number; finished: boolean }) => {
      if (info.finished) {
        clearBattleSave();
        return;
      }
      writeBattleSave({ v: 1, source, ai, setup, log, name: info.scenarioName, turn: info.turn });
    };

  // --- Game autosave ---------------------------------------------------------

  /**
   * A Triplanetary game played at this keyboard is saved the same way: the
   * scenario, its seed and options, who the computer plays, and the log. A
   * table played online is the server's to remember, not the browser's.
   */
  const GAME_KEY = 'triplanetary-game-v1';
  interface GameSave {
    readonly v: 1;
    readonly scenarioId: string;
    readonly seed: number;
    readonly options: GameOptions;
    readonly fleets?: Readonly<Record<string, readonly string[]>>;
    readonly computerSeats: readonly string[];
    readonly history: readonly unknown[];
    readonly name: string;
    readonly turn: number;
  }
  /** The fleets the current game was built with, for its save. */
  let lastFleets: Readonly<Record<string, readonly string[]>> | undefined;

  const readGameSave = (): GameSave | null => {
    try {
      const raw = localStorage.getItem(GAME_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as GameSave;
      return parsed && parsed.v === 1 && Array.isArray(parsed.history) ? parsed : null;
    } catch {
      return null;
    }
  };
  const persistGame = (): void => {
    if (!session || table !== null) return;
    if (session.state.victory !== null) {
      try {
        localStorage.removeItem(GAME_KEY);
      } catch {
        // Nothing to clear.
      }
      return;
    }
    const name = deps.scenarios.find((s) => s.id === scenarioId)?.name ?? scenarioId;
    const save: GameSave = {
      v: 1,
      scenarioId,
      seed,
      options: gameOptions,
      ...(lastFleets ? { fleets: lastFleets } : {}),
      computerSeats: [...computerSeats],
      history: session.history,
      name,
      turn: session.state.turn,
    };
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify(save));
    } catch {
      // Storage blocked: the game simply is not saved.
    }
  };
  const clearGameSave = (): void => {
    try {
      localStorage.removeItem(GAME_KEY);
    } catch {
      // Nothing to clear.
    }
  };

  /** Rebuild a saved game and replay its log onto it. */
  const resumeGame = (save: GameSave): void => {
    closeTable(true);
    scenarioId = save.scenarioId;
    seed = save.seed;
    gameOptions = { ...DEFAULT_OPTIONS, ...save.options };
    lastFleets = save.fleets;
    const state = deps.buildScenario(save.scenarioId, {
      seed: save.seed,
      options: gameOptions,
      ...(save.fleets ? { fleets: save.fleets } : {}),
    });
    computerSeats = new Set(save.computerSeats);
    const next = deps.createSession(state);
    for (const cmd of save.history) next.dispatch(cmd as Command);
    installSession(next);
    canvas.focus();
  };

  /**
   * Fight a landing right here: the companion game's whole shell, ported and
   * mounted over this one. Loaded on demand — a player who never reaches a
   * ground battle never downloads the Ogre engine — the way the Supabase
   * client is.
   */
  const openGroundBattle = async (
    order: OrderOfBattle,
    resume: BattleSave | null = null,
  ): Promise<void> => {
    if (groundBattle) return;
    const make = await import('../ogre/ui/battle.js').catch(() => null);
    if (make === null) {
      act.notify(
        'The Ogre battle view could not be loaded. Use the Open-in-Ogre link instead.',
        'bad',
      );
      openCampaign();
      return;
    }
    // Whether this battle has a war room waiting for it decides how it ends:
    // a report button straight back, or a token for a campaign elsewhere.
    const pendingId = deps.campaign.current()?.state.pending?.order?.battleId ?? null;
    const reportable = order.battleId === pendingId;
    const source = { kind: 'order', order } as const;
    const setup = resume ? resume.setup : true;
    const ai = resume ? resume.ai : [];
    groundBattle = make.createOgreBattle({
      host: overlays,
      battle: {
        kind: 'order',
        order,
        reportLabel: reportable ? 'Report to the campaign' : null,
        onResult: (result) => {
          const outcome = deps.campaign.current()?.dispatch({ type: 'reportBattle', result });
          if (!outcome?.ok) {
            act.notify(outcome?.reason ?? 'The campaign refused the result.', 'bad');
            return;
          }
          clearBattleSave();
          closeGroundBattle();
          openCampaign();
        },
        resultToken: (result) => deps.campaign.resultToken(result),
      },
      ai,
      setup,
      ...(resume ? { resume: resume.log as never } : {}),
      onProgress: battleProgress(source, ai, setup),
      onExit: () => {
        closeGroundBattle();
        if (deps.campaign.current()?.state.pending) openCampaign();
        else if (!session && table === null) act.newGame();
      },
    });
  };

  /** A printed Ogre scenario, fought for its own sake: verdict, then home. */
  const openOgreScenario = async (
    id: string,
    battleSeed: number,
    ai: readonly string[] = [],
    resume: BattleSave | null = null,
    order?: OrderOfBattle,
  ): Promise<void> => {
    if (groundBattle) return;
    const make = await import('../ogre/ui/battle.js').catch(() => null);
    if (make === null) {
      act.notify('The Ogre battle view could not be loaded.', 'bad');
      act.newGame();
      return;
    }
    const source = {
      kind: 'scenario',
      id,
      seed: battleSeed,
      ...(order ? { order } : {}),
    } as const;
    const setup = resume ? resume.setup : true;
    groundBattle = make.createOgreBattle({
      host: overlays,
      battle: source,
      ai,
      setup,
      ...(resume ? { resume: resume.log as never } : {}),
      onProgress: battleProgress(source, ai, setup),
      onExit: () => {
        closeGroundBattle();
        if (!session && table === null) act.newGame();
      },
    });
  };

  /** Pick a saved battle back up, whatever it was. */
  const resumeBattle = (save: BattleSave): void => {
    if (save.source.kind === 'scenario') {
      void openOgreScenario(save.source.id, save.source.seed, save.ai, save, save.source.order);
      return;
    }
    // An Orbital Drop assault resumes with the war it belongs to; a campaign
    // landing resumes on its own, reporting to whichever war room is open.
    if (orbitalPending()?.battleId === save.source.order.battleId) {
      void mountOrbitalBattle(save.source.order);
    } else {
      void openGroundBattle(save.source.order, save);
    }
  };

  // --- Orbital Drop: the frozen sky --------------------------------------

  /** The battle id already mounted (or offered), so render() mounts it once. */
  let orbitalMounted: string | null = null;
  let frozenPrompt: Overlay | null = null;

  const orbitalPending = (): OrderOfBattle | null => {
    if (!session || session.state.scenarioId !== 'orbital-drop') return null;
    const data = session.state.scenarioData['orbitalDrop'] as
      { pendingGround?: OrderOfBattle | null } | undefined;
    return data?.pendingGround ?? null;
  };

  /**
   * Mount the assault the freeze minted; its result resumes the day.
   *
   * The seats follow the war: a power the computer plays above the sky has
   * its ground battle played for it too, and a base's militia — nobody's
   * seat — is always the computer's. A save for this very battle is picked
   * back up where it was left.
   */
  const mountOrbitalBattle = async (order: OrderOfBattle): Promise<void> => {
    if (groundBattle) return;
    frozenPrompt?.close();
    const make = await import('../ogre/ui/battle.js').catch(() => null);
    if (make === null) {
      act.notify('The ground battle view could not be loaded.', 'bad');
      return;
    }
    const saved = readBattleSave();
    const resume =
      saved && saved.source.kind === 'order' && saved.source.order.battleId === order.battleId
        ? saved
        : null;
    const ai = resume
      ? resume.ai
      : order.sides.map((s) => s.player).filter((p) => computerSeats.has(p) || p === 'militia');
    const source = { kind: 'order', order } as const;
    const setup = resume ? resume.setup : true;
    groundBattle = make.createOgreBattle({
      host: overlays,
      battle: {
        kind: 'order',
        order,
        reportLabel: 'Return to the war',
        onResult: (result) => {
          const s = session;
          if (!s) return;
          const outcome = s.dispatch({
            type: 'resolveGroundBattle',
            by: activePlayer(s.state),
            result,
          });
          if (!outcome.ok) {
            act.notify(outcome.reason ?? 'The war refused the result.', 'bad');
            return;
          }
          clearBattleSave();
          closeGroundBattle();
        },
        resultToken: (result) => deps.campaign.resultToken(result),
      },
      ai,
      setup,
      ...(resume ? { resume: resume.log as never } : {}),
      onProgress: battleProgress(source, ai, setup),
      onExit: () => {
        closeGroundBattle();
        openFrozenPrompt(order);
      },
    });
  };

  /** The sky stays frozen: leaving the battle only steps outside the door. */
  const openFrozenPrompt = (order: OrderOfBattle): void => {
    if (frozenPrompt) return;
    frozenPrompt = openModal(overlays, {
      title: 'The sky is frozen',
      subtitle: 'Orbital Drop §4.05',
      body: el('p', {
        class: 'help-p',
        text:
          'All courses, ordnance and fuel states hold exactly as plotted. ' +
          'Nothing moves until the ground battle is decided.',
      }),
      dismissible: false,
      onClose: () => {
        frozenPrompt = null;
      },
      actions: [
        {
          label: 'Return to the battle',
          variant: 'primary',
          onClick: () => void mountOrbitalBattle(order),
        },
      ],
    });
  };

  /** Called from render(): mount the ground battle the moment the sky freezes. */
  const syncOrbitalGround = (): void => {
    const order = orbitalPending();
    if (!order) {
      orbitalMounted = null;
      if (frozenPrompt) frozenPrompt.close();
      return;
    }
    if (orbitalMounted === order.battleId) return;
    orbitalMounted = order.battleId;
    const t = table;
    if (t !== null) {
      // Online, the ground battle is not this browser's to build. A refereed
      // table gets a child table from the referee, and `refreshTable` hops to
      // it; a quick table has no referee to open one.
      if (t.mode === 'quick') {
        act.notify(
          'The sky is frozen, but a quick table has no referee to fight the ground battle. Host the war as a refereed table to play it through.',
          'warn',
        );
      }
      return;
    }
    void mountOrbitalBattle(order);
  };

  /**
   * The Ogre door: the ported scenarios are loaded the moment somebody wants
   * them — the list rides the same on-demand chunks as the battle view.
   */
  let ogrePickerOverlay: Overlay | null = null;
  const openOgreScenarios = async (): Promise<void> => {
    if (ogrePickerOverlay) return;
    const mod = await import('../ogre/scenarios/index.js').catch(() => null);
    if (mod === null) {
      act.notify('The Ogre scenarios could not be loaded.', 'bad');
      act.newGame();
      return;
    }
    // The seats, read off a built board: the picker names them, and the
    // shell turns "the computer plays seat 1" back into a player id.
    const seats = new Map<string, readonly string[]>();
    const scenarios = mod.SCENARIOS.map((s) => {
      const built = s.build({ seed: 1 });
      seats.set(s.id, built.playerOrder);
      return { ...s, sides: built.playerOrder.map((p) => built.players[p]?.name ?? p) };
    });
    ogrePickerOverlay = openOgrePicker(overlays, {
      scenarios,
      seed: deps.randomSeed(),
      newSeed: () => deps.randomSeed(),
      dismissible: session !== null || table !== null,
      onClose: () => {
        ogrePickerOverlay = null;
      },
      onBack: () => act.newGame(),
      onStart: (id, battleSeed, computer) => {
        const ids = seats.get(id) ?? [];
        const ai = computer !== null && ids[computer] !== undefined ? [ids[computer]!] : [];
        void openOgreScenario(id, battleSeed, ai);
      },
      onCustom: () => void openCustomBuilder(),
      // A ground table needs the referee: it keeps the board and plays the
      // computer's seat, so a quick table cannot hold one.
      ...(online.available && online.modes.includes('refereed')
        ? {
            onHost: (id: string, battleSeed: number, computer: number | null) => {
              openHostDialog(overlays, {
                modes: ['refereed'],
                onHost: (_mode, password) =>
                  void hostOgreTable(id, battleSeed, computer, password, undefined),
                onCancel: () => void openOgreScenarios(),
              });
            },
          }
        : {}),
    });
  };

  /**
   * The builder's catalogue: the ground game's units, boards and presets,
   * loaded on demand the way the battle view is. Cached, because the engine
   * does not change between openings.
   */
  let builderCatalogue: BuilderCatalogue | null = null;
  const loadCatalogue = async (): Promise<BuilderCatalogue | null> => {
    if (builderCatalogue) return builderCatalogue;
    const loaded = await Promise.all([
      import('../ogre/scenarios/index.js'),
      import('../ogre/engine/units.js'),
      import('../ogre/engine/ogres.js'),
      import('../ogre/engine/map.js'),
      import('../ogre/engine/hex.js'),
    ]).catch(() => null);
    if (loaded === null) return null;
    const [scen, units, ogres, maps, hexes] = loaded;
    const unit = (id: string): { id: string; name: string; armorUnits: number } => {
      const cls = (units.UNIT_CLASSES as Record<string, { name: string; armorUnits: number }>)[id]!;
      return { id, name: cls.name, armorUnits: cls.armorUnits };
    };
    const custom = (
      name: string,
      blurb: string,
      order: Omit<OrderOfBattle, 'battleId' | 'scenarioId' | 'seed'>,
    ): { name: string; blurb: string; order: OrderOfBattle } => ({
      name,
      blurb,
      order: { battleId: `preset-${name}`, seed: 0, scenarioId: scen.CUSTOM_ID, ...order },
    });
    builderCatalogue = {
      ogres: Object.values(ogres.OGRE_TYPES).map((t) => ({
        id: t.id,
        name: t.name,
        armorUnits: t.armorUnits,
      })),
      armour: units.SELECTABLE_CLASSES.map(unit),
      infantry: Object.values(units.UNIT_CLASSES)
        .filter((c) => c.kind === 'infantry')
        .map((c) => unit(c.id)),
      victories: (['command-post', 'breakthrough', 'attrition'] as const).map((id) => ({
        id,
        name: scen.VICTORY_NAMES[id],
        blurb: scen.VICTORY_BLURBS[id],
      })),
      limits: scen.MAP_LIMITS,
      presets: [
        custom('Combined arms', 'A cybertank with an escort against a mixed defence.', {
          sides: scen.DEFAULT_CUSTOM.sides,
          terms: scen.DEFAULT_CUSTOM.terms,
        }),
        custom(
          'Mark III attack',
          'The classic: one Ogre against twelve armour units and twenty squads.',
          {
            sides: [
              { player: 'attacker', faction: 'Paneuropean Federation', forces: { MK3: 1 } },
              {
                player: 'defender',
                faction: 'North American Combine',
                forces: { HVY: 4, MSL: 3, GEV: 3, HWZ: 1, INF: 20 },
              },
            ],
            terms: { map: { kind: 'ogre' }, victory: 'command-post', centralLimit: 20 },
          },
        ),
        custom('Cybertank duel', 'A Mark V against a Mark III with a screen of its own.', {
          sides: [
            { player: 'attacker', faction: 'Paneuropean Federation', forces: { MK5: 1 } },
            {
              player: 'defender',
              faction: 'North American Combine',
              forces: { MK3: 1, HVY: 2, GEV: 2, INF: 6 },
            },
          ],
          terms: { map: { kind: 'ogre' }, victory: 'command-post' },
        }),
        custom('River crossing', 'Break through settled country and off the far edge.', {
          sides: [
            {
              player: 'attacker',
              faction: 'Paneuropean Federation',
              forces: { MK3: 1, HVY: 2, GEV: 4, INF: 6 },
            },
            {
              player: 'defender',
              faction: 'North American Combine',
              forces: { HVY: 3, MSL: 2, GEV: 2, HWZ: 1, INF: 12 },
            },
          ],
          terms: { map: { kind: 'gev' }, victory: 'breakthrough', turnLimit: 12 },
        }),
      ],
      preview: (spec) => {
        const map = scen.customMap(spec);
        return {
          name: map.name,
          cols: map.cols,
          rows: map.rows,
          cells: maps
            .allHexes(map)
            .map((h) => ({ ...hexes.toOffset(h), terrain: maps.terrainAt(map, h) }))
            .filter((c) => c.terrain !== 'clear'),
          lines: map.areaLines ?? null,
        };
      },
      value: (forces) => scen.forceValue(forces),
    };
    return builderCatalogue;
  };

  /** The custom battle door: build an order, then fight it here or host it. */
  let builderOverlay: Overlay | null = null;
  const openCustomBuilder = async (initial?: OrderOfBattle): Promise<void> => {
    if (builderOverlay) return;
    const catalogue = await loadCatalogue();
    if (catalogue === null) {
      act.notify('The battle builder could not be loaded.', 'bad');
      act.newGame();
      return;
    }
    const seats = (computer: number | null): readonly string[] =>
      computer === null ? [] : [computer === 0 ? 'attacker' : 'defender'];
    builderOverlay = openBattleBuilder(overlays, {
      catalogue,
      ...(initial ? { initial } : {}),
      dismissible: session !== null || table !== null,
      newSeed: () => deps.randomSeed(),
      onClose: () => {
        builderOverlay = null;
      },
      onBack: () => void openOgreScenarios(),
      onStart: (order, computer) =>
        void openOgreScenario(order.scenarioId, order.seed, seats(computer), null, order),
      ...(online.available && online.modes.includes('refereed')
        ? {
            onHost: (order: OrderOfBattle, computer: number | null) => {
              openHostDialog(overlays, {
                modes: ['refereed'],
                onHost: (_mode, password) =>
                  void hostOgreTable(order.scenarioId, order.seed, computer, password, order),
                onCancel: () => void openCustomBuilder(order),
              });
            },
          }
        : {}),
    });
  };

  /** Open a refereed table for a printed Ogre scenario, and share the code. */
  const hostOgreTable = async (
    id: string,
    battleSeed: number,
    computer: number | null,
    password: string,
    order: OrderOfBattle | undefined,
  ): Promise<void> => {
    if (!online.available) return;
    try {
      enterTable(
        await online.host(
          {
            kind: 'ogre',
            scenarioId: id,
            seed: battleSeed,
            options: {},
            ...(order ? { order } : {}),
            computerSeats: computer === null ? [] : [computer],
            mode: 'refereed',
            password,
          },
          tableEvents(),
        ),
      );
    } catch (err) {
      act.notify(`Could not open a table: ${reasonOf(err)}`, 'bad');
      if (order) void openCustomBuilder(order);
      else void openOgreScenarios();
    }
  };

  /**
   * Fight a ground table's battle in the Ogre view, over everything else.
   *
   * The view is handed the board the referee keeps and the seat this browser
   * holds; every order it forms goes to the referee, and every snapshot that
   * comes back is adopted. The scenario is built locally only to name the
   * map and the victory check — the board itself is the referee's.
   */
  const mountOgreTable = async (t: TablePort): Promise<void> => {
    const info = t.table;
    const board = t.board;
    if (groundBattle || board === null || info === null) return;
    const make = await import('../ogre/ui/battle.js').catch(() => null);
    if (make === null) {
      act.notify('The Ogre battle view could not be loaded.', 'bad');
      return;
    }
    // The load took a moment; the table may have been left in it.
    if (groundBattle || table !== t || t.board === null || t.board.state === null) return;
    groundBattle = make.createOgreBattle({
      host: overlays,
      battle: { kind: 'scenario', id: info.scenarioId, seed: 0 },
      online: {
        get seat() {
          return t.seat;
        },
        board,
        send: (cmd) => t.send(cmd),
      },
      ai: info.seats.filter((seat) => seat.kind === 'computer').map((seat) => seat.seat),
      setup: false,
      onExit: () => {
        closeGroundBattle();
        // A battle fought for a frozen sky leads back to the war it froze.
        const parent = t.table?.parent;
        if (parent !== undefined) {
          const password = t.password;
          closeTable(false);
          void returnToParent(parent.code, password);
        } else leaveTable(false);
      },
    });
  };

  // --- The war room ---------------------------------------------------------

  let warRoom: Overlay | null = null;
  /** What to do once the war room has closed — a battle to start, a table to host. */
  let afterWarRoom: (() => void) | null = null;

  const closeWarRoom = (then?: () => void): void => {
    afterWarRoom = then ?? null;
    warRoom?.close();
  };

  const openCampaign = (): void => {
    if (warRoom) return;
    warRoom = openWarRoom(overlays, deps.campaign, {
      fightHere: (order) => closeWarRoom(() => promptBattle(order)),
      fightGround: (order) => closeWarRoom(() => void openGroundBattle(order)),
      hostOnline: online.available
        ? (order) => closeWarRoom(() => hostCampaignBattle(order))
        : null,
      ...(online.available ? {} : { onlineReason: online.reason }),
      notify: (text, tone) => act.notify(text, tone),
      newSeed: () => deps.randomSeed(),
      // Every order redraws the war room; the pins on the chart follow it.
      onChanged: () => schedule(),
      onClose: () => {
        warRoom = null;
        syncViewInset();
        schedule();
        const next = afterWarRoom;
        afterWarRoom = null;
        if (next) next();
        else if (!session && table === null) act.newGame();
      },
    });
    // The war room docks to the side of the chart rather than covering it:
    // frame the whole disc in what it leaves visible, so the sites it pins
    // are actually on screen.
    if (!session) {
      syncViewInset();
      renderer?.fitChart();
    }
    schedule();
  };

  /** Open an online table for a campaign transfer, and share the code. */
  const hostCampaignBattle = (order: OrderOfBattle): void => {
    if (!online.available) return;
    const modes = online.modes;
    if (modes.length === 1 && modes[0] === 'refereed') {
      void hostTransfer(order, 'refereed', '');
      return;
    }
    openHostDialog(overlays, {
      modes,
      onHost: (mode, password) => void hostTransfer(order, mode, password),
      onCancel: () => openCampaign(),
    });
  };

  const hostTransfer = async (
    order: OrderOfBattle,
    mode: OnlineMode,
    password: string,
  ): Promise<void> => {
    if (!online.available) return;
    scenarioId = order.scenarioId;
    seed = order.seed;
    try {
      enterTable(
        await online.host(
          {
            scenarioId: order.scenarioId,
            seed: order.seed,
            options: {},
            computerSeats: [],
            mode,
            password,
            order,
          },
          tableEvents(),
        ),
      );
    } catch (err) {
      act.notify(`Could not open a table: ${reasonOf(err)}`, 'bad');
      openCampaign();
    }
  };

  // --- Online --------------------------------------------------------------

  const reasonOf = (err: unknown): string =>
    err instanceof Error && err.message !== '' ? err.message : 'the referee could not be reached';

  const tableEvents = (): TableEvents => ({
    onSeat: () => refreshTable(),
    onTable: () => refreshTable(),
    onLink: () => refreshTable(),
    // "A refusal from the referee must surface as a notice, not vanish." It is
    // the only feedback an online order gets when the board does not move.
    onRefused: (reason) => act.notify(reason, 'bad'),
  });

  /** Everything the lobby and the badge draw themselves from, or null when off. */
  const tableView = (): TableView | null => {
    const t = table;
    if (t === null) return null;
    const info = t.table;
    // A ground table's board is the Ogre view's to read; the badge says only
    // that the table exists. Whose move it is shows in that view's own bar.
    const state = t.session !== null ? (session?.state ?? null) : null;
    const who =
      info !== null && info.status === 'playing' && state !== null ? activePlayer(state) : null;
    return {
      table: info,
      seat: t.seat,
      link: t.link,
      host: t.host,
      scenarioName: scenarioName(),
      joinLink: online.available && info !== null ? online.linkFor(info.code) : '',
      turn:
        who === null || state === null
          ? null
          : { name: state.players[who]?.name ?? who, mine: who === t.seat },
    };
  };

  /** Repaint the online chrome. Never calls `render`, because `render` calls it. */
  const paintTable = (): void => {
    const view = tableView();
    // The badge lives where a notice would otherwise be thrown; the class moves
    // the notices down rather than letting a refusal land underneath the thing
    // that says whose turn it is.
    root.classList.toggle('is-online', view !== null);
    badge.update(view);
    if (view !== null) lobby?.update(view);
  };

  /**
   * The table said something. Decide whether we are in the lobby or in a game,
   * and repaint everything.
   */
  const refreshTable = (): void => {
    const t = table;
    const info = t?.table ?? null;
    if (t !== null && info !== null) {
      scenarioId = info.scenarioId;
      resume = { code: info.code, seat: t.seat };
      rememberTable(t);
    }
    const waiting = t !== null && (info === null || info.status === 'lobby');
    if (waiting && lobby === null) {
      lobby = openLobby(overlays, tableActions, tableView()!);
    } else if (!waiting && lobby !== null) {
      lobby.close();
      lobby = null;
      // The lobby was covering the chart, and the game it was waiting for has
      // begun; frame it rather than leaving the player looking at the last fit.
      if (session) renderer?.fitAll(session.state);
      canvas.focus();
    }
    // A ground table that has begun is fought in the Ogre view, over
    // everything: a joiner arriving mid-battle lands straight in it.
    if (t !== null && t.board !== null && info !== null && info.status !== 'lobby') {
      void mountOgreTable(t);
    }
    // A fleet table waiting on a ground battle sends everyone to it.
    if (t !== null && info !== null && info.child !== undefined && t.session !== null) {
      void hopToChild(t, info.child.code);
    }
    paintTable();
    render();
  };

  /**
   * The frozen sky, online: the referee has opened a ground table for the
   * battle and named it on this one, so everyone here hops across. The seat
   * follows the account, the password follows the client, and the war table
   * is left listening-off but not vacated — it is where everyone comes back.
   */
  let hopping = false;
  const hopToChild = async (from: TablePort, code: string): Promise<void> => {
    if (!online.available || hopping) return;
    hopping = true;
    try {
      const child = await online.join(code, undefined, tableEvents(), {
        mode: 'refereed',
        password: from.password ?? '',
      });
      enterTable(child);
      act.notify(
        'The sky is frozen. The ground battle is at its own table; the war resumes when it is decided.',
        'info',
      );
    } catch (err) {
      act.notify(`Could not reach the ground battle: ${reasonOf(err)}`, 'bad');
    } finally {
      hopping = false;
    }
  };

  const returnToParent = async (code: string, password: string | null): Promise<void> => {
    if (!online.available) return;
    try {
      enterTable(
        await online.join(code, undefined, tableEvents(), {
          mode: 'refereed',
          password: password ?? '',
        }),
      );
    } catch (err) {
      act.notify(`Could not return to the war: ${reasonOf(err)}`, 'bad');
      act.newGame();
    }
  };

  const enterTable = (t: TablePort): void => {
    closeTable(false);
    table = t;
    // The referee plays the computer's seats, through the same judge a person's
    // orders go through. Nothing on this side should be giving them.
    computerSeats = new Set();
    if (t.session !== null) installSession(t.session);
    refreshTable();
  };

  const hostTable = async (result: PickerResult): Promise<void> => {
    if (!online.available) return;
    scenarioId = result.id;
    seed = result.opts.seed;
    gameOptions = { ...DEFAULT_OPTIONS, ...result.opts.options };
    try {
      enterTable(
        await online.host(
          {
            scenarioId: result.id,
            ...result.opts,
            computerSeats: result.computerSeats,
            mode: onlineAs.mode,
            password: onlineAs.password,
          },
          tableEvents(),
        ),
      );
    } catch (err) {
      act.notify(`Could not open a table: ${reasonOf(err)}`, 'bad');
      act.newGame();
    }
  };

  const joinTable = async (code: string, watchOnly: boolean, password = ''): Promise<void> => {
    if (!online.available) return;
    // An unspecified seat resumes the one this account already holds, which is
    // what a reconnect wants. Only after an explicit leave — when the seat has
    // genuinely been vacated — is it worth asking for the old one by name.
    const wanted = watchOnly
      ? null
      : resume?.code === code
        ? (resume.seat ?? undefined)
        : undefined;
    const attempt = (mode: OnlineMode): Promise<TablePort> =>
      online.join(code, wanted, tableEvents(), { mode, password });
    try {
      // Every table has a password now, so the joiner cannot tell from what
      // they typed which arrangement a code belongs to. A quick table is one
      // database call to ask, so it is asked first; the referee's answer is
      // the one reported when neither knows the code, because it is the one
      // that also covers a wrong password.
      const quickToo = password !== '' && online.modes.includes('quick');
      let port: TablePort | null = null;
      if (quickToo) port = await attempt('quick').catch(() => null);
      enterTable(port ?? (await attempt('refereed')));
    } catch (err) {
      act.notify(`Could not join ${code}: ${reasonOf(err)}`, 'bad');
      if (session) act.newGame();
      else promptJoin(code);
    }
  };

  const promptJoin = (code: string | null): void => {
    if (!online.available || joinOverlay !== null) return;
    // A link to a table this browser already knows brings its password along.
    const known = code === null ? undefined : readKnownTables().find((k) => k.code === code);
    joinOverlay = openJoinDialog(overlays, {
      code,
      ...(known ? { password: known.password } : {}),
      wantsPassword: true,
      onJoin: (typed, watchOnly, password) => {
        joinOverlay = null;
        void joinTable(typed, watchOnly, password);
      },
      onCancel: () => {
        joinOverlay = null;
        // A `?join=` link with nothing behind it must still leave a playable
        // game, so backing out of the first dialog lands on the scenario screen.
        if (!session && table === null) act.newGame();
      },
    });
  };

  const startTable = async (): Promise<void> => {
    const t = table;
    if (t === null) return;
    try {
      await t.start();
    } catch (err) {
      act.notify(reasonOf(err), 'bad');
    }
    refreshTable();
  };

  const sitAt = async (seat: PlayerId | null): Promise<void> => {
    const t = table;
    if (t === null) return;
    try {
      await t.sit(seat);
    } catch (err) {
      act.notify(reasonOf(err), 'bad');
    }
    refreshTable();
  };

  /**
   * The host changes a ground table's setup from the lobby: the builder opens
   * on the table's current order (or a preset, for a printed scenario), and
   * what it produces goes to the referee, which rebuilds the board for
   * everyone. The computer keeps the seats it had.
   */
  const configureTable = async (): Promise<void> => {
    const t = table;
    const info = t?.table;
    if (!t || !info || !t.configure || builderOverlay) return;
    const catalogue = await loadCatalogue();
    if (catalogue === null) {
      act.notify('The battle builder could not be loaded.', 'bad');
      return;
    }
    const board = t.board?.state as { scenarioData?: Record<string, unknown> } | null | undefined;
    const current = board?.scenarioData?.['order'] as OrderOfBattle | undefined;
    const computers = info.seats.filter((s) => s.kind === 'computer').map((s) => s.ordinal);
    builderOverlay = openBattleBuilder(overlays, {
      catalogue,
      ...(current && current.scenarioId === 'custom' ? { initial: current } : {}),
      dismissible: true,
      newSeed: () => deps.randomSeed(),
      onClose: () => {
        builderOverlay = null;
      },
      onBack: () => undefined,
      onApply: (order) => {
        void (async () => {
          try {
            await t.configure?.({
              kind: 'ogre',
              scenarioId: order.scenarioId,
              seed: order.seed,
              options: {},
              order,
              computerSeats: computers,
              mode: 'refereed',
            });
            act.notify('The setup is changed. Everyone in the lobby sees it.', 'good');
          } catch (err) {
            act.notify(reasonOf(err), 'bad');
          }
          refreshTable();
        })();
      },
    });
  };

  const reclaimSeat = async (seat: PlayerId): Promise<void> => {
    const t = table;
    if (t === null) return;
    try {
      await t.reclaim(seat);
      act.notify('The seat is yours again.', 'good');
    } catch (err) {
      act.notify(reasonOf(err), 'bad');
    }
    refreshTable();
  };

  /**
   * Stop being at a table.
   *
   * `vacate` is the difference between standing up and merely looking away: a
   * vacated seat is open for somebody else, and one that is only closed is
   * still ours to come back to.
   */
  const closeTable = (vacate: boolean): void => {
    const t = table;
    table = null;
    lobby?.close();
    lobby = null;
    badge.update(null);
    if (t === null) return;
    if (vacate) void t.leave().catch(() => undefined);
    else t.close();
  };

  /**
   * The board stays on screen after leaving. It is no longer anybody's game,
   * but it is still the record of one, and clearing it would throw away the
   * last thing the player was looking at.
   */
  const leaveTable = (vacate: boolean): void => {
    if (table === null) return;
    // Standing up is leaving for good; the table drops off the start menu.
    const code = table.table?.code;
    if (vacate && code !== undefined) forgetTable(code);
    closeTable(vacate);
    render();
    act.newGame();
  };

  // --- Lifecycle -----------------------------------------------------------

  const installSession = (next: SessionPort): void => {
    unsubscribe?.();
    session = next;
    unsubscribe = session.subscribe(() => {
      render();
      persistGame();
    });
    persistGame();

    ui = { ...INITIAL_UI, flags: ui.flags };
    victoryShown = false;
    turnKey = '';
    syncViewInset();
    renderer?.fitAll(session.state);
    render();
  };

  const startScenario = (
    id: string,
    newSeed: number,
    options: Partial<GameOptions>,
    fleets?: Readonly<Record<string, readonly string[]>>,
    seats: ComputerSeats = [],
  ): void => {
    closeTable(true);
    scenarioId = id;
    seed = newSeed;
    gameOptions = { ...DEFAULT_OPTIONS, ...options };
    lastFleets = fleets;
    const state = deps.buildScenario(id, {
      seed,
      options: gameOptions,
      ...(fleets ? { fleets } : {}),
    });

    // Seat *n* on the picker is `playerOrder[n]` in the built game — the one
    // place the index the player clicked becomes a player id.
    computerSeats = new Set(
      seats.map((i) => state.playerOrder[i]).filter((p): p is PlayerId => p !== undefined),
    );

    installSession(deps.createSession(state));
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
    // With no game underneath, the play panels are hidden; what occludes the
    // chart is the docked war room, when it is open.
    if (!session) {
      const warW = warRoom ? Math.min(600, window.innerWidth * 0.92) : 0;
      return { top: px('--top-h') + gap, right: warW + gap, bottom: gap, left: gap };
    }
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
    // First paint: with no game yet, this draws the bare chart so whatever
    // opens next — the start menu, a prompt, the war room — sits over it.
    schedule();

    // A `?join=` link is an instruction, not a preference: somebody sent it, and
    // the first thing to show is the table it names rather than a scenario list
    // the player is going to dismiss. A `?battle=` token from the campaign is
    // the same kind of instruction; a token that would not decode still gets a
    // sentence, because a dead parameter wants an explanation.
    const invited = deps.joinCode ?? null;
    if (invited !== null && invited !== '' && online.available) promptJoin(invited);
    else if (deps.battle && deps.battle.scenarioId === 'landing')
      void openGroundBattle(deps.battle);
    else if (deps.battle) promptBattle(deps.battle);
    else if (deps.battleError != null && deps.battleError !== '') {
      openModal(overlays, {
        title: 'The battle token could not be read',
        body: el('p', { class: 'help-p', text: deps.battleError }),
        actions: [
          { label: 'Go to the scenarios', variant: 'primary', onClick: () => act.newGame() },
        ],
      });
    } else act.newGame();
  };

  const destroy = (): void => {
    closeGroundBattle();
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
    // Closed, not vacated: a reload is not a player standing up, and the seat
    // should still be theirs when the page comes back.
    closeTable(false);
    root.remove();
  };

  return { el: root, start, destroy };
};
