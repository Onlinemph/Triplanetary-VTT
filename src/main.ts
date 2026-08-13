/**
 * Entry point, and the only file that knows the concrete shapes of the session,
 * the renderer and the scenario table.
 *
 * Everything under `src/ui` is written against the structural ports in
 * `ui/ports.ts`; the three adapters below are where those ports meet the real
 * modules. If one of those APIs shifts by an argument, it is fixed here and
 * nowhere else.
 */

import { DEFAULT_MAP } from '@engine/map.js';
import type { GameState } from '@engine/types.js';
import { GameSession } from '@net/session.js';
import { MapRenderer } from '@render/renderer.js';
import { SCENARIO_SUMMARIES, buildScenario } from '@scenarios/index.js';
import { createApp } from '@ui/app.js';
import type { RendererPort, ScenarioDescriptor, SessionPort } from '@ui/ports.js';
import './styles.css';

const mount = document.getElementById('root');
if (!mount) throw new Error('#root is missing from index.html');

/** Wrap the session so the shell only ever sees `SessionPort`. */
const createSession = (state: GameState): SessionPort => {
  const session = new GameSession(state, DEFAULT_MAP);
  return {
    get state() {
      return session.state;
    },
    get map() {
      return session.map;
    },
    dispatch: (cmd) => session.dispatch(cmd),
    subscribe: (fn) => session.subscribe(fn),
    undo: () => session.undo(),
  };
};

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
    resize: () => renderer.resize(),
  };
};

const app = createApp({
  root: mount,
  map: DEFAULT_MAP,
  // `SCENARIO_SUMMARIES` is the table already flattened to the shell's shape:
  // `ScenarioDef.players` is a {min, max} range, `ScenarioDescriptor.players` a
  // single seat count.
  scenarios: SCENARIO_SUMMARIES satisfies readonly ScenarioDescriptor[],
  buildScenario: (id, opts) => buildScenario(id, opts),
  createSession,
  createRenderer,
  // The seed is the only place the shell reaches for entropy; the engine itself
  // never does, so a game is fully reproducible from its seed and command log.
  randomSeed: () => Math.floor(Math.random() * 0xffffffff),
});

app.start();
