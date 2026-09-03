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
import type { Command } from '@engine/commands.js';
import type { GameOptions, GameState, PlayerId } from '@engine/types.js';
import { GameSession } from '@net/session.js';
import {
  type AnyCommand,
  type AnyState,
  type GameKind,
  type KindRules,
  triRules,
} from '@net/kinds.js';
import {
  QuickTable,
  TableClient,
  type QuickEvents,
  type QuickLike,
  type SessionSink,
  type SupabaseLike,
  type TableClientEvents,
  type TableConnection,
} from '@net/supabase/index.js';
import { MapRenderer } from '@render/renderer.js';
import { SCENARIO_SUMMARIES, buildScenario, scenarioById } from '@scenarios/index.js';
import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';
import { decodeOrder, decodeResult, encodeOrder, encodeResult } from '@campaign/codec.js';
import { type OrderOfBattle, orderOf } from '@campaign/orders.js';
import { readBattleResult } from '@campaign/result.js';
import { CampaignSession } from '@campaign/session.js';
import { createApp } from '@ui/app.js';
import type {
  BoardPort,
  CampaignDeps,
  CampaignHandle,
  LinkState,
  OnlinePort,
  RendererPort,
  ScenarioDescriptor,
  SeatInfo,
  SessionPort,
  TableEvents,
  TableInfo,
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
  get history() {
    return session.history;
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
    hexPx: () => renderer.hexPx(),
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
 * The ground game's board, as the client fills it and the shell reads it.
 *
 * No engine lives here. The Ogre view brings its own session and adopts each
 * snapshot the way it adopts a save, so the vessel is only a value and the
 * listeners who want to hear it change.
 */
interface BoardVessel extends BoardPort {
  adoptSnapshot(state: AnyState): void;
}

const boardVessel = (): BoardVessel => {
  let state: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get state() {
      return state;
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    adoptSnapshot: (next) => {
      state = next;
      for (const fn of [...listeners]) fn();
    },
  };
};

/**
 * One sink for whichever game a table turns out to hold.
 *
 * A joiner learns the table's game only when the referee answers, after the
 * client has already been built, so the client is given both vessels behind
 * one door and each snapshot goes to the one shaped for it: a fleet game has
 * ships, a ground game has units.
 */
interface Sinks {
  readonly session: GameSession;
  readonly board: BoardVessel;
  readonly sink: SessionSink;
}

const sinks = (): Sinks => {
  const session = vessel();
  const board = boardVessel();
  return {
    session,
    board,
    sink: {
      map: session.map,
      adoptSnapshot: (state) => {
        if ('ships' in state) session.adoptSnapshot(state);
        else board.adoptSnapshot(state);
      },
    },
  };
};

/**
 * The rules for a table's game, found once the referee has named it. The
 * ground game's engine is loaded on demand, the way the battle view is, so a
 * fleet table costs nobody the download.
 */
const rulesFor = async (kind: GameKind): Promise<KindRules> => {
  if (kind === 'ogre') return (await import('@net/ogreRules.js')).ogreRules();
  return triRules(DEFAULT_MAP);
};

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

/**
 * The Supabase client, fetched and built on first use.
 *
 * `import()` rather than a static import, and the difference is a third of the
 * download. Built with the two environment variables set, a static import makes
 * one 534 kB chunk — 163 kB over the wire, and past the size Vite warns about;
 * this makes it two, and the 218 kB holding supabase-js (58 kB gzipped) is
 * fetched at the moment somebody opens or joins a table rather than at the
 * moment they open the page. Which is the right moment: a player working
 * through the scenarios alone never reaches for it at all, and one who does is
 * already waiting on a network round trip.
 *
 * Without those variables the branch below is statically false, the import is
 * unreachable, and Rollup drops supabase-js from the build entirely — so an
 * offline build was never paying for it either way. This is about the builds
 * that *do* have online play switched on.
 *
 * The *promise* is what gets memoised, not the client. Two lobby buttons
 * pressed in the same tick would otherwise each start their own import and
 * build their own client, and two clients means two anonymous sign-ins and two
 * Realtime sockets for one player.
 *
 * `SupabaseLike` is `client.ts`'s own narrow structural type, so nothing here
 * names a library type — which is what lets the static import go away entirely
 * rather than survive as a type-only reference.
 */
let supabase: Promise<SupabaseLike & QuickLike> | null = null;
const backend = async (): Promise<SupabaseLike & QuickLike> =>
  (supabase ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY),
  ));

const adopt = (client: TableClient, s: Sinks, opened: boolean): TablePort => {
  // The referee has answered by now, so the table's game is known: a fleet
  // table hands the shell its session, a ground table hands it the board.
  const ground = client.table?.kind === 'ogre';
  const codeOf = (): string => {
    const code = client.table?.code;
    if (code === undefined) throw new Error('there is no table to sit down at');
    return code;
  };
  return {
    session: ground ? null : port(s.session),
    board: ground ? s.board : null,
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
      await client.join(codeOf(), seat);
    },
    // Taking a seat back is the same join with a claim on it; the client
    // presents the password it was let in with.
    reclaim: async (seat) => {
      await client.join(codeOf(), seat, { reclaim: true });
    },
    send: (cmd) => client.send(cmd as AnyCommand),
    leave: () => client.leave(),
    close: () => client.close(),
  };
};

const relay = (e: TableEvents): TableClientEvents => ({
  onSeat: (seat: PlayerId | null) => e.onSeat?.(seat),
  onTable: (table) => e.onTable?.(table),
  onConnection: (state) => e.onLink?.(LINK[state]),
  onRejected: (reason) => e.onRefused?.(reason),
});

/**
 * The same, for a quick table.
 *
 * `onTable` is deliberately not forwarded: the quick client's table info is
 * about the code and the claims, and the shell's `TableInfo` is assembled from
 * the board in `quickAdopt`. Passing the raw one through would mean two places
 * building the same object out of different halves.
 *
 * Drift gets a notice rather than silence. It is the one thing that can happen
 * in this mode and not the refereed one, and a player watching their board
 * change under them deserves the reason.
 */
const quickRelay = (e: TableEvents): QuickEvents => ({
  onSeat: (seat) => e.onSeat?.(seat),
  onRefused: (reason) => e.onRefused?.(reason),
  onLink: (state) => {
    // Already the shell's vocabulary — `LINK` exists to translate the refereed
    // client's different three words, and putting it here would be a mapping
    // from a set to itself.
    quickLink = state === 'connecting' ? 'reconnecting' : state;
    e.onLink?.(quickLink);
  },
  onDrift: (at) =>
    e.onRefused?.(
      `Move ${String(at)} did not produce the board the sender saw — rebuilt from the move list. If it keeps happening, both players should reload.`,
    ),
});

/**
 * A quick table, dressed as the shell's `TablePort`.
 *
 * The shell was written against a refereed table and should not have to learn
 * a second vocabulary, so the differences are absorbed here rather than
 * spreading into the UI. Two of them are worth naming.
 *
 * There is no lobby to close, so `start` does nothing: a quick table is playing
 * from the moment it exists, because there is no referee that needs telling to
 * begin. And there is no roster on the server — the seats are the scenario's,
 * so the list is built from the board every browser already has, with the
 * database's claim map saying which of them somebody is sitting in.
 */
const quickAdopt = (client: QuickTable, session: GameSession, opened: boolean): TablePort => {
  const table = (): TableInfo | null => {
    const info = client.table;
    if (!info) return null;
    const state = session.state;
    const claims = info.seats;
    return {
      id: info.code,
      code: info.code,
      kind: 'tri',
      locked: true,
      scenarioId: info.scenarioId,
      fog: false,
      status: 'playing',
      turn: state.turn,
      commandCount: client.index,
      seats: state.playerOrder.map((seat, ordinal): SeatInfo => {
        const claim = claims[seat];
        return {
          seat,
          ordinal,
          faction: state.players[seat]?.faction ?? '',
          name:
            claim?.name !== undefined && claim.name !== ''
              ? claim.name
              : (state.players[seat]?.name ?? seat),
          kind: claim ? 'human' : 'open',
          present: claim !== undefined,
          mine: client.seat === seat,
        };
      }),
    };
  };

  return {
    session: port(session),
    board: null,
    get seat() {
      return client.seat;
    },
    get table() {
      return table();
    },
    get link() {
      return quickLink;
    },
    host: opened,
    start: async () => undefined,
    sit: (seat) => client.sit(seat),
    // A quick table has no names to prove: everyone at it knows the one
    // password. What it has instead is a clock — a seat nobody has been heard
    // from in a while is open again, and sitting there is the reclaim.
    reclaim: (seat) => client.sit(seat),
    send: (cmd) => client.send(cmd as Command),
    leave: () => client.leave(),
    close: () => {
      client.close();
    },
  };
};

/** The last link state a quick table reported, for the badge to read. */
let quickLink: LinkState = 'offline';

const online: OnlinePort =
  SUPABASE_URL === '' || SUPABASE_ANON_KEY === ''
    ? {
        available: false,
        reason:
          'Online play is off in this build: it was given no VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Everything else works exactly as it does with them.',
      }
    : {
        available: true,
        // Quick first: it is the one that needs nothing beyond the two values
        // this build already has. A refereed table additionally needs the Edge
        // Function deployed, which cannot be known from here — so it is
        // offered, and it fails with the referee's own words if it is absent.
        modes: ['quick', 'refereed'],
        host: async (opts, events): Promise<TablePort> => {
          if (opts.mode === 'quick') {
            const session = vessel();
            const client = new QuickTable(await backend(), session, quickRelay(events));
            await client.host({
              scenarioId: opts.scenarioId,
              password: opts.password ?? '',
              setup: {
                ...(opts.seed === undefined ? {} : { seed: opts.seed }),
                options: optionRecord(opts.options),
                ...(opts.fleets ? { fleets: opts.fleets } : {}),
                // A campaign order rides the frozen setup so every joiner
                // rebuilds the order's battle, not the printed default.
                ...(opts.order ? { order: opts.order } : {}),
              },
            });
            return quickAdopt(client, session, true);
          }
          const s = sinks();
          const client = new TableClient(
            await backend(),
            s.sink,
            { rules: rulesFor },
            relay(events),
          );
          await client.create({
            ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
            scenarioId: opts.scenarioId,
            seed: opts.seed,
            options: optionRecord(opts.options),
            ...(opts.fleets ? { fleets: opts.fleets } : {}),
            ...(opts.order ? { order: opts.order } : {}),
            computerSeats: opts.computerSeats,
            ...(opts.password !== undefined && opts.password !== ''
              ? { password: opts.password }
              : {}),
          });
          return adopt(client, s, true);
        },
        join: async (code, seat, events, jopts): Promise<TablePort> => {
          if (jopts?.mode === 'quick') {
            const session = vessel();
            const client = new QuickTable(await backend(), session, quickRelay(events));
            await client.join(code, jopts.password ?? '');
            // A watcher passes `null` and stays standing. Anyone else sits: a
            // named seat if they asked for one, otherwise the first free chair,
            // which is what following a link should do without a second
            // question. Deciding *which* chair is free is the client's job, not
            // this adapter's — it is the one that knows how the database ages
            // a claim out.
            if (seat !== null) {
              if (seat === undefined) {
                // A full table is not a failed join — the game is still worth
                // watching, and a scenario for one player is a table with one
                // chair. Say which it is rather than leaving every order to be
                // refused with no explanation.
                if ((await client.sitAnywhere()) === null) {
                  events.onRefused?.(
                    'Every side at this table is taken, so you are watching. Ask whoever is playing to leave a seat.',
                  );
                }
              } else await client.sit(seat);
            }
            return quickAdopt(client, session, false);
          }
          const s = sinks();
          const client = new TableClient(
            await backend(),
            s.sink,
            { rules: rulesFor },
            relay(events),
          );
          await client.join(
            code,
            seat,
            jopts?.password !== undefined && jopts.password !== ''
              ? { password: jopts.password }
              : {},
          );
          return adopt(client, s, false);
        },
        // The invitation is this page with the code on it, so a friend who
        // follows it lands in the lobby rather than on the scenario list.
        linkFor: (code) => {
          const url = new URL(window.location.pathname, window.location.origin);
          url.searchParams.set('join', code);
          return url.toString();
        },
      };

// ---------------------------------------------------------------------------
// The campaign
// ---------------------------------------------------------------------------

/**
 * Where the companion Ogre app lives, for the "Open in Ogre" link on a ground
 * battle. Overridable at build time for forks and local hacking; the token in
 * the link works against any copy of the app.
 */
const OGRE_URL = envValue(import.meta.env.VITE_OGRE_URL) || 'https://onlinemph.github.io/OGRE-VTT/';

const CAMPAIGN_KEY = 'triplanetary-campaign-v1';

let campaign: CampaignSession | null = null;
let campaignLoaded = false;

/** Save after every accepted order. A campaign file is a seed and a log. */
const persistCampaign = (session: CampaignSession): void => {
  if (session !== campaign) return; // an abandoned war must not resurrect itself
  try {
    localStorage.setItem(CAMPAIGN_KEY, session.serialise());
  } catch {
    console.warn('the campaign could not be saved to localStorage');
  }
};

const adoptCampaign = (session: CampaignSession): CampaignSession => {
  session.subscribe(() => persistCampaign(session));
  persistCampaign(session);
  return session;
};

const loadCampaign = (): CampaignSession | null => {
  if (campaignLoaded) return campaign;
  campaignLoaded = true;
  try {
    const raw = localStorage.getItem(CAMPAIGN_KEY);
    campaign = raw == null ? null : adoptCampaign(CampaignSession.deserialise(raw));
  } catch (err) {
    console.warn('the saved campaign would not load', err);
    campaign = null;
  }
  return campaign;
};

const handleOf = (session: CampaignSession): CampaignHandle => ({
  get state() {
    return session.state;
  },
  get canUndo() {
    return session.canUndo;
  },
  dispatch: (cmd) => session.dispatch(cmd),
  subscribe: (fn) => session.subscribe(fn),
  undo: () => session.undo(),
});

const campaignDeps: CampaignDeps = {
  current: () => {
    const session = loadCampaign();
    return session ? handleOf(session) : null;
  },
  start: (seed) => {
    campaignLoaded = true;
    campaign = adoptCampaign(new CampaignSession(seed));
    return handleOf(campaign);
  },
  abandon: () => {
    campaignLoaded = true;
    campaign = null;
    try {
      localStorage.removeItem(CAMPAIGN_KEY);
    } catch {
      // Nothing to do: with storage blocked there was nothing saved either.
    }
  },
  orderToken: (order) => encodeOrder(order),
  ogreUrl: (order) => {
    const url = new URL(OGRE_URL);
    url.searchParams.set('battle', encodeOrder(order));
    return url.toString();
  },
  parseResult: (text) => decodeResult(text),
  resultFor: (state, history) => {
    // The shell may have wandered off to an ordinary scenario; a game that
    // was not built from an order has no result to hand back.
    if (orderOf(state.scenarioData) === null) return null;
    return readBattleResult(state, DEFAULT_MAP, history);
  },
  resultToken: (result) => encodeResult(result),
};

/**
 * A `?battle=` token is an `OrderOfBattle` sent by a campaign running in
 * another browser. A token for a scenario this app does not play (a landing,
 * say, pasted at the wrong app) gets told which app it wanted.
 */
const battleFrom = (
  token: string | null,
): { battle: OrderOfBattle | null; error: string | null } => {
  if (token === null || token === '') return { battle: null, error: null };
  try {
    const order = decodeOrder(token);
    // 'landing' is not on this app's scenario list, but it is playable here
    // all the same: the shell mounts the embedded Ogre view for it.
    if (order.scenarioId === 'landing' || scenarioById(order.scenarioId)) {
      return { battle: order, error: null };
    }
    return {
      battle: null,
      error: `That order is for "${order.scenarioId}", which this app does not play.`,
    };
  } catch (err) {
    return {
      battle: null,
      error: err instanceof Error ? err.message : 'the token does not decode',
    };
  }
};

const { battle, error: battleError } = battleFrom(
  new URL(window.location.href).searchParams.get('battle'),
);

const app = createApp({
  root: mount,
  map: DEFAULT_MAP,
  online,
  joinCode: new URL(window.location.href).searchParams.get('join'),
  battle,
  battleError,
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
  campaign: campaignDeps,
});

app.start();
