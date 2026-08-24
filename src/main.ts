/**
 * Entry point, and the only file that knows the concrete shapes of the session,
 * the renderer, the scenario table and the Supabase client.
 *
 * Everything under `src/ui` is written against the structural ports in
 * `ui/ports.ts`; the adapters below are where those ports meet the real
 * modules. If one of those APIs shifts by an argument, it is fixed here and
 * nowhere else.
 *
 * It is also the only file that reads the environment. `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_ANON_KEY` are baked into the bundle by Vite, and a build given
 * neither is a build with no online play — which the shell is told as a reason
 * rather than as an absence, because a dead button wants an explanation.
 */

/// <reference types="vite/client" />

import { DEFAULT_MAP } from '@engine/map.js';
import type { GameOptions, GameState, PlayerId } from '@engine/types.js';
import { GameSession } from '@net/session.js';
import {
  TableClient,
  type TableClientEvents,
  type TableConnection,
} from '@net/supabase/index.js';
import { MapRenderer } from '@render/renderer.js';
import { SCENARIO_SUMMARIES, buildScenario } from '@scenarios/index.js';
import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '@ui/app.js';
import type {
  LinkState,
  OnlinePort,
  RendererPort,
  ScenarioDescriptor,
  SessionPort,
  TableEvents,
  TablePort,
} from '@ui/ports.js';
import './styles.css';

const mount = document.getElementById('root');
if (!mount) throw new Error('#root is missing from index.html');

/** Wrap the session so the shell only ever sees `SessionPort`. */
const port = (session: GameSession): SessionPort => ({
  get state() {
    return session.state;
  },
  get map() {
    return session.map;
  },
  dispatch: (cmd) => session.dispatch(cmd),
  subscribe: (fn) => session.subscribe(fn),
  undo: () => session.undo(),
});

const createSession = (state: GameState): SessionPort => port(new GameSession(state, DEFAULT_MAP));

/** Likewise for the map renderer. */
const createRenderer = (canvas: HTMLCanvasElement, map = DEFAULT_MAP): RendererPort => {
  const renderer = new MapRenderer(canvas, map);
  return {
    render: (state, view) => renderer.render(state, view),
    screenToHex: (x, y) => renderer.screenToHex(x, y),
    hexToScreen: (h) => renderer.hexToScreen(h),
    panBy: (dx, dy) => renderer.panBy(dx, dy),
    zoomAt: (x, y, factor) => renderer.zoomAt(x, y, factor),
    fitAll: (state) => renderer.fitAll(state),
    fitChart: () => renderer.fitChart(),
    focusOn: (h) => renderer.focusOn(h),
    frameHexes: (hexes, opts) => renderer.frameHexes(hexes, opts),
    resize: () => renderer.resize(),
    setViewInset: (inset) => renderer.setViewInset(inset),
  };
};

// ---------------------------------------------------------------------------
// Online play
// ---------------------------------------------------------------------------

/**
 * Vite substitutes `import.meta.env.VITE_*` textually at build time, so the
 * names are written out in full rather than looked up by key. An absent
 * variable is the empty string, which is the same thing as "no online play".
 */
const envValue = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const SUPABASE_URL = envValue(import.meta.env.VITE_SUPABASE_URL);
const SUPABASE_ANON_KEY = envValue(import.meta.env.VITE_SUPABASE_ANON_KEY);

/**
 * How a Realtime subscription reads to a player.
 *
 * `connecting` is not "offline": the client resubscribes with backoff and no
 * attempt cap, so a table that dropped is a table coming back, and the word for
 * it has to say so.
 */
const LINK: Record<TableConnection, LinkState> = {
  open: 'live',
  connecting: 'reconnecting',
  closed: 'offline',
};

/**
 * A vessel for the referee's board.
 *
 * `GameSession` is built from a starting position, and an online client's does
 * not exist until the referee answers. What arrives instead is `adoptSnapshot`,
 * which replaces the state wholesale and turns undo and local replay off — so
 * the position this session is constructed with is never played and never
 * shown. `create` and `join` both sync before they resolve, and the shell
 * installs the session only after that, which is what makes the substitution
 * invisible rather than a flash of the wrong board.
 */
const vessel = (): GameSession =>
  new GameSession(buildScenario(SCENARIO_SUMMARIES[0]!.id), DEFAULT_MAP);

/**
 * The optional rules, as the wire carries them.
 *
 * `CreateRequest.options` is a plain record of booleans, deliberately: the
 * referee builds the scenario with them and refuses the request if the
 * scenario dislikes what it got, so there is nothing for this side to validate.
 */
const optionRecord = (o: Partial<GameOptions>): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(o)) if (typeof value === 'boolean') out[key] = value;
  return out;
};

let supabase: ReturnType<typeof createClient> | null = null;
/** Made on first use: a build that never plays online never opens a connection. */
const backend = (): ReturnType<typeof createClient> =>
  (supabase ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY));

const adopt = (client: TableClient, session: GameSession, opened: boolean): TablePort => ({
  session: port(session),
  get seat() {
    return client.seat;
  },
  get table() {
    return client.table;
  },
  get link() {
    return LINK[client.connection];
  },
  host: opened,
  start: () => client.start(),
  // Moving seats is joining again by name. `takeSeat` vacates the old one in
  // the same write — "one account, one seat" — so there is nothing to undo
  // first, and nothing for another player to slip into in between.
  sit: async (seat) => {
    const code = client.table?.code;
    if (code === undefined) throw new Error('there is no table to sit down at');
    await client.join(code, seat);
  },
  send: (cmd) => client.send(cmd),
  leave: () => client.leave(),
  close: () => client.close(),
});

const relay = (e: TableEvents): TableClientEvents => ({
  onSeat: (seat: PlayerId | null) => e.onSeat?.(seat),
  onTable: (table) => e.onTable?.(table),
  onConnection: (state) => e.onLink?.(LINK[state]),
  onRejected: (reason) => e.onRefused?.(reason),
});

const online: OnlinePort =
  SUPABASE_URL === '' || SUPABASE_ANON_KEY === ''
    ? {
        available: false,
        reason:
          'Online play is off in this build: it was given no VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Everything else works exactly as it does with them.',
      }
    : {
        available: true,
        host: async (opts, events): Promise<TablePort> => {
          const session = vessel();
          const client = new TableClient(backend(), session, {}, relay(events));
          await client.create({
            scenarioId: opts.scenarioId,
            seed: opts.seed,
            options: optionRecord(opts.options),
            ...(opts.fleets ? { fleets: opts.fleets } : {}),
            computerSeats: opts.computerSeats,
          });
          return adopt(client, session, true);
        },
        join: async (code, seat, events): Promise<TablePort> => {
          const session = vessel();
          const client = new TableClient(backend(), session, {}, relay(events));
          await client.join(code, seat);
          return adopt(client, session, false);
        },
        // The invitation is this page with the code on it, so a friend who
        // follows it lands in the lobby rather than on the scenario list.
        linkFor: (code) => {
          const url = new URL(window.location.pathname, window.location.origin);
          url.searchParams.set('join', code);
          return url.toString();
        },
      };

const app = createApp({
  root: mount,
  map: DEFAULT_MAP,
  online,
  joinCode: new URL(window.location.href).searchParams.get('join'),
  // `SCENARIO_SUMMARIES` is the table already flattened to the shell's shape:
  // `ScenarioDef.players` is a {min, max} range, `ScenarioDescriptor.players` a
  // single seat count.
  scenarios: SCENARIO_SUMMARIES satisfies readonly ScenarioDescriptor[],
  // The shell's port speaks in plain strings — it has no business knowing the
  // `ShipClass` union — so a fleet chosen on the buy screen is narrowed here, at
  // the one seam where the scenario table is actually in scope. A name the table
  // does not know is dropped, and the scenario falls back to its printed fleet.
  buildScenario: (id, { fleets, ...rest }) =>
    buildScenario(id, {
      ...rest,
      ...(fleets
        ? {
            fleets: Object.fromEntries(
              Object.entries(fleets).map(([player, fleet]) => [
                player,
                fleet.filter((c): c is ShipClass => c in SHIP_CLASSES),
              ]),
            ),
          }
        : {}),
    }),
  createSession,
  createRenderer,
  // The seed is the only place the shell reaches for entropy; the engine itself
  // never does, so a game is fully reproducible from its seed and command log.
  randomSeed: () => Math.floor(Math.random() * 0xffffffff),
});

app.start();
