/**
 * The map renderer.
 *
 * One Canvas 2D surface, drawn back to front:
 *
 *   sky → chart plate → orbital rings → hex grid → asteroids → detection →
 *   reachable endpoints → gravity arrows → astral bodies → bases → courses →
 *   ordnance → ships → plot furniture → labels → vignette
 *
 * Everything between the plate and the labels is drawn in *world units* under a
 * single camera transform (see `camera.ts`), which is what keeps pan and zoom
 * to one matrix update instead of a coordinate conversion in every layer.
 *
 * ## Culling
 *
 * The chart is a fixed disc of ~3,800 hexes. Their centres, gravity sources and
 * belt membership never change, so they are indexed once in the constructor and
 * every frame walks that array with a rectangle test. No layer ever touches a
 * hex that is off-screen, and the grid path is memoised while the camera is
 * still — which is most frames.
 *
 * Nothing here mutates `GameState`, and no rules module is imported: the
 * renderer reads the same map facts the engine does (`map.gravityAt`,
 * `map.lineOfSightBlockedBy`, the belt) and draws them.
 */

import {
  type Hex,
  type Point,
  add,
  eq,
  hex,
  key,
  neighbor,
  parseKey,
  toPixel,
  withinRadius,
} from '../engine/hex.js';
import {
  type GameMap,
  DETECTION_RANGE_PLANETARY_BASE,
  DETECTION_RANGE_SHIP,
  type GravitySource,
} from '../engine/map.js';
import { MAP_RADIUS, inBounds } from '../engine/mapdata.js';
import {
  type GameState,
  type PlayerId,
  type Ship,
  type ShipId,
  areAllied,
} from '../engine/types.js';
import { Camera, type ViewInset, type Viewport } from './camera.js';
import {
  type Frame,
  DIR_COS,
  DIR_SIN,
  HEX_COS,
  HEX_SIN,
  hexPath,
  glow,
  label,
  pulse,
  setFont,
  taperedArrowPath,
} from './draw.js';
import {
  addAsteroidHex,
  asteroidJitter,
  drawBases,
  drawBodies,
  drawBodyLabels,
  drawOrbitRings,
  flushAsteroidBatch,
  newAsteroidBatch,
} from './bodies.js';
import { counterOffset, drawOrdnanceMarker, drawShipCounter, stackOffset } from './counters.js';
import { drawAccelMark, drawPredictedCourse, drawTrail } from './courses.js';
import { Starfield } from './starfield.js';
import { LOD, THEME, lighten, rgba, smoothstep } from './theme.js';

export type { Viewport } from './camera.js';

/**
 * Direction index → index of the first corner of the shared hexside, so an
 * outline can be drawn edge by edge. Verified against `hex.corners`, whose
 * corner `i` sits at 60·i − 30 degrees.
 */
const DIR_TO_CORNER: readonly number[] = [0, 5, 4, 3, 2, 1];

/** Cosmetic clock. Never feeds the engine — the engine has no notion of time. */
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0;

export interface RenderView {
  viewer: PlayerId | null;
  selectedShip?: ShipId | null;
  hoveredHex?: Hex | null;
  reachable?: { hex: Hex; accel: 0 | 1 | 2; danger?: string }[];
  plannedEndpoint?: Hex | null;
  attackPreview?: { from: Hex; to: Hex; blocked: boolean } | null;
  showGravity: boolean;
  showDetection: boolean;
  showCourseHistory: boolean;
  hiddenShips?: ReadonlySet<ShipId>;
}

interface ChartCell {
  readonly h: Hex;
  /** World-space centre. */
  readonly x: number;
  readonly y: number;
  /** 0 clear, 1 belt, 2 the dense Clandestine cordon. */
  readonly asteroid: 0 | 1 | 2;
  readonly gravity: readonly GravitySource[];
}

export class MapRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: GameMap;
  private readonly cam = new Camera();
  private readonly stars = new Starfield();

  /** Every in-bounds hex, indexed once. */
  private readonly cells: ChartCell[] = [];
  /** Reused per-frame scratch: the subset of `cells` currently on screen. */
  private visible: ChartCell[] = [];

  private gridCacheKey = '';
  private gridCache: Path2D | null = null;

  constructor(canvas: HTMLCanvasElement, map: GameMap) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('MapRenderer: 2D canvas context unavailable');
    this.ctx = ctx;
    this.map = map;

    const size = this.cam.hexSize;
    for (let q = -MAP_RADIUS - 1; q <= MAP_RADIUS + 1; q++) {
      for (let r = -MAP_RADIUS - 1; r <= MAP_RADIUS + 1; r++) {
        const h = hex(q, r);
        if (!inBounds(h)) continue;
        const p = toPixel(h, size);
        const asteroid: 0 | 1 | 2 = map.isDenseAsteroid(h) ? 2 : map.isAsteroid(h) ? 1 : 0;
        this.cells.push({ h, x: p.x, y: p.y, asteroid, gravity: map.gravityAt(h) });
      }
    }

    this.cam.panRadius = MAP_RADIUS * this.cam.pitch;
    this.resize();
    this.fitChart();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get camera(): Camera {
    return this.cam;
  }

  get viewport(): Viewport {
    return this.cam.viewport;
  }

  /**
   * Tell the camera which screen edges are hidden behind floating UI panels, so
   * framing and focusing target the region the player can actually see.
   */
  setViewInset(inset: Partial<ViewInset>): void {
    this.cam.setInset(inset);
  }

  /** Match the backing store to the element's CSS size and pixel ratio. */
  resize(): void {
    const dpr =
      typeof globalThis !== 'undefined' && typeof globalThis.devicePixelRatio === 'number'
        ? globalThis.devicePixelRatio
        : 1;
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;

    // A renderer built before its canvas has been laid out has no viewport to
    // fit to; re-frame the chart the first time a real one shows up.
    const wasDegenerate = this.cam.width <= 1 || this.cam.height <= 1;
    this.cam.setViewport(cssW, cssH, dpr);
    if (wasDegenerate && cssW > 1 && cssH > 1) this.fitChart();
    else this.cam.clampCentre();
  }

  screenToHex(x: number, y: number): Hex {
    return this.cam.screenToHex(x, y);
  }

  hexToScreen(h: Hex): { x: number; y: number } {
    return this.cam.hexToScreen(h);
  }

  panBy(dx: number, dy: number): void {
    this.cam.panBy(dx, dy);
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    this.cam.zoomAt(screenX, screenY, factor);
  }

  focusOn(h: Hex, opts?: { zoom?: number }): void {
    if (opts?.zoom !== undefined) this.cam.setZoom(opts.zoom);
    this.cam.centreOnHex(h);
  }

  /** Frame the whole chart disc. */
  fitChart(): void {
    const r = MAP_RADIUS * this.cam.pitch + this.cam.pitch;
    this.cam.fitWorldRect({ x0: -r, y0: -r, x1: r, y1: r }, 24);
  }

  /**
   * Frame everything currently in play — live ships and ordnance — falling back
   * to the whole chart when there is nothing to look at.
   */
  fitAll(state: GameState): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const include = (h: Hex): void => {
      const p = toPixel(h, this.cam.hexSize);
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    };

    for (const ship of Object.values(state.ships)) {
      if (ship.destroyed) continue;
      include(ship.pos);
      if (ship.plottedEndpoint) include(ship.plottedEndpoint);
    }
    for (const o of Object.values(state.ordnance)) include(o.pos);

    if (!isFinite(x0)) {
      this.fitChart();
      return;
    }
    const pad = this.cam.pitch * 2.5;
    this.cam.fitWorldRect({ x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }, 60);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  render(state: GameState, view: RenderView): void {
    const ctx = this.ctx;
    const cam = this.cam;
    const f: Frame = {
      ctx,
      cam,
      hexPx: cam.hexPx,
      u: cam.unit,
      size: cam.hexSize,
      pitch: cam.pitch,
      time: now(),
    };

    // --- Sky ---------------------------------------------------------------
    cam.applyScreenTransform(ctx);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = THEME.space;
    ctx.fillRect(0, 0, cam.width, cam.height);
    this.stars.draw(ctx, cam, f.time);

    // --- World -------------------------------------------------------------
    cam.applyWorldTransform(ctx);
    // Layers set stroke state freely; start every frame from a known baseline
    // so nothing leaks across frames or between layers.
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    this.collectVisible(f);

    this.drawChartPlate(f);
    drawOrbitRings(f, this.map);
    this.drawGrid(f);
    this.drawAsteroids(f, state);
    if (view.showDetection) this.drawDetection(f, state, view);
    this.drawReachable(f, view);
    if (view.showGravity) this.drawGravity(f);
    drawBodies(f, this.map);
    drawBases(f, this.map, state, (owner) => this.colorOf(state, owner));
    this.drawCourses(f, state, view);
    this.drawOrdnance(f, state, view);
    this.drawShips(f, state, view);
    this.drawPlotFurniture(f, state, view);
    drawBodyLabels(f, this.map);

    // --- Screen ------------------------------------------------------------
    cam.applyScreenTransform(ctx);
    this.drawVignette(f);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  private collectVisible(f: Frame): void {
    // A hex and a half of slack, so ornament that overhangs its own hex (chips,
    // gravity arrows) is still drawn when its centre is just off screen.
    const rect = f.cam.visibleRect(f.pitch * 1.5 * f.cam.zoom);
    const out = this.visible;
    out.length = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i]!;
      if (c.x < rect.x0 || c.x > rect.x1 || c.y < rect.y0 || c.y > rect.y1) continue;
      out.push(c);
    }
  }

  /** The play surface: a faint plate with a hard, luminous edge. */
  private drawChartPlate(f: Frame): void {
    const { ctx } = f;
    const r = MAP_RADIUS * f.pitch + f.pitch * 0.5;

    const g = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
    g.addColorStop(0, rgba(THEME.chartFill, 0.85));
    g.addColorStop(0.65, rgba(THEME.chartFill, 0.45));
    g.addColorStop(1, rgba(THEME.chartFill, 0.08));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // "Any ship whose final course places it off the map is considered
    // eliminated" — so the boundary is a hard rule, and it is drawn like one.
    ctx.strokeStyle = rgba(THEME.chartEdgeGlow, 0.35);
    ctx.lineWidth = 6 * f.u;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = rgba(THEME.chartEdge, 0.85);
    ctx.lineWidth = 1.4 * f.u;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.setLineDash([6 * f.u, 7 * f.u]);
    ctx.strokeStyle = rgba(THEME.danger, 0.22);
    ctx.lineWidth = 1 * f.u;
    ctx.beginPath();
    ctx.arc(0, 0, r + 7 * f.u, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The hex grid. Each hex draws only its east, south-east and south-west
   * edges — every interior edge is therefore drawn exactly once — plus the
   * three remaining edges wherever the neighbour is off the chart, which closes
   * the disc's outline.
   */
  private drawGrid(f: Frame): void {
    const alpha = smoothstep(LOD.gridMin, LOD.gridFull, f.hexPx) * 0.9;
    if (alpha <= 0.01) return;
    const { ctx } = f;
    const s = f.size;

    const rect = f.cam.visibleRect();
    const cacheKey = `${Math.round(rect.x0 / s)}:${Math.round(rect.y0 / s)}:${Math.round(
      rect.x1 / s,
    )}:${Math.round(rect.y1 / s)}`;
    let path = this.gridCache;
    if (!path || cacheKey !== this.gridCacheKey) {
      path = new Path2D();
      for (let i = 0; i < this.visible.length; i++) {
        const c = this.visible[i]!;
        const x = c.x;
        const y = c.y;
        path.moveTo(x + s * HEX_COS[0]!, y + s * HEX_SIN[0]!);
        path.lineTo(x + s * HEX_COS[1]!, y + s * HEX_SIN[1]!);
        path.lineTo(x + s * HEX_COS[2]!, y + s * HEX_SIN[2]!);
        path.lineTo(x + s * HEX_COS[3]!, y + s * HEX_SIN[3]!);
        // Close the rim of the disc where the neighbour does not exist.
        for (const dir of [3, 2, 1]) {
          if (inBounds(neighbor(c.h, dir))) continue;
          const ci = DIR_TO_CORNER[dir]!;
          const cj = (ci + 1) % 6;
          path.moveTo(x + s * HEX_COS[ci]!, y + s * HEX_SIN[ci]!);
          path.lineTo(x + s * HEX_COS[cj]!, y + s * HEX_SIN[cj]!);
        }
      }
      this.gridCache = path;
      this.gridCacheKey = cacheKey;
    }

    ctx.lineWidth = Math.max(0.5 * f.u, f.pitch * 0.004);
    ctx.strokeStyle = rgba(THEME.grid, alpha * 0.55);
    ctx.stroke(path);
  }

  private drawAsteroids(f: Frame, state: GameState): void {
    // Nuked hexes stop being asteroids: "the asteroids in that hex are cleared".
    const cleared = state.clearedAsteroids.length > 0 ? new Set(state.clearedAsteroids) : null;
    const batch = newAsteroidBatch();
    for (let i = 0; i < this.visible.length; i++) {
      const c = this.visible[i]!;
      if (c.asteroid === 0) continue;
      if (cleared && cleared.has(key(c.h))) continue;
      const j = asteroidJitter(c.h, f.pitch);
      addAsteroidHex(f, batch, c.h, c.x + j.dx, c.y + j.dy, c.asteroid === 2);
    }
    flushAsteroidBatch(f, batch);
  }

  /**
   * Gravity arrows.
   *
   * "This gravity is represented by the arrows in hexes adjacent to those
   * bodies", each arrow pointing at its body (see the derivation in `map.ts`).
   * Weak gravity — Luna and Io — is "represented by hollow arrows", so those
   * are stroked rather than filled: the shape says *optional* before the player
   * has to remember which moons are weak.
   */
  private drawGravity(f: Frame): void {
    if (f.hexPx < LOD.gridMin) return;
    const { ctx } = f;
    const fade = smoothstep(LOD.gridMin, LOD.detailMin * 1.6, f.hexPx);
    if (fade <= 0.02) return;

    for (let i = 0; i < this.visible.length; i++) {
      const c = this.visible[i]!;
      if (c.gravity.length === 0) continue;

      for (let gi = 0; gi < c.gravity.length; gi++) {
        const src = c.gravity[gi]!;
        // The arrow is a unit hex vector; project it to get its screen angle.
        const dir = toPixel(src.arrow, 1);
        const len = Math.hypot(dir.x, dir.y) || 1;
        const ux = dir.x / len;
        const uy = dir.y / len;

        // Two bodies can share a gravity hex; nudge each arrow off the axis.
        const spread = c.gravity.length > 1 ? (gi - (c.gravity.length - 1) / 2) * f.pitch * 0.2 : 0;
        const px = -uy * spread;
        const py = ux * spread;

        const tail = f.pitch * 0.24;
        const head = f.pitch * 0.26;
        const x0 = c.x - ux * tail + px;
        const y0 = c.y - uy * tail + py;
        const x1 = c.x + ux * head + px;
        const y1 = c.y + uy * head + py;

        ctx.beginPath();
        taperedArrowPath(
          ctx,
          x0,
          y0,
          x1,
          y1,
          f.pitch * 0.062,
          f.pitch * 0.15,
          f.pitch * 0.18,
        );

        if (src.strength === 'full') {
          ctx.fillStyle = rgba(THEME.gravityFull, 0.62 * fade);
          ctx.fill();
        } else {
          // Hollow: the pilot may ignore the first of a consecutive run.
          ctx.lineWidth = Math.max(0.8 * f.u, f.pitch * 0.013);
          ctx.strokeStyle = rgba(THEME.gravityWeak, 0.8 * fade);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * Detection footprints for the viewing side.
   *
   * "Detectors on ships and orbital bases (including Ceres and Clandestine)
   * have a range of three hexes; detectors on planetary bases have a range of
   * five hexes. The detection areas of planetary bases are printed on the map."
   */
  private drawDetection(f: Frame, state: GameState, view: RenderView): void {
    const viewer = view.viewer;
    if (!viewer) return;

    const shipHexes = new Set<string>();
    const baseHexes = new Set<string>();
    const push = (into: Set<string>, centre: Hex, radius: number): void => {
      for (const h of withinRadius(centre, radius)) {
        if (inBounds(h)) into.add(key(h));
      }
    };

    for (const ship of Object.values(state.ships)) {
      if (ship.destroyed) continue;
      if (!areAllied(state, ship.owner, viewer)) continue;
      push(shipHexes, ship.pos, DETECTION_RANGE_SHIP);
    }
    for (const base of Object.values(state.bases)) {
      if (base.destroyed || base.owner === null) continue;
      if (!areAllied(state, base.owner, viewer)) continue;
      const centre = base.kind === 'planetary' && base.side ? base.side.hex : base.hex;
      const radius =
        base.kind === 'planetary' ? DETECTION_RANGE_PLANETARY_BASE : DETECTION_RANGE_SHIP;
      push(baseHexes, centre, radius);
    }

    if (shipHexes.size === 0 && baseHexes.size === 0) return;

    const union = new Set<string>([...baseHexes, ...shipHexes]);
    this.fillHexSet(f, union, rgba(THEME.detection, 0.05));
    this.strokeHexSetBoundary(f, union, rgba(THEME.detection, 0.3), 1.1);
    // Printed base footprints get their own finer outline inside the union.
    if (baseHexes.size > 0 && f.hexPx > LOD.gridMin) {
      this.strokeHexSetBoundary(f, baseHexes, rgba(THEME.detection, 0.18), 0.7);
    }
  }

  private fillHexSet(f: Frame, hexes: ReadonlySet<string>, style: string): void {
    const { ctx } = f;
    const rect = f.cam.visibleRect(f.pitch);
    const path = new Path2D();
    for (const k of hexes) {
      const h = parseKey(k);
      const p = toPixel(h, f.size);
      if (p.x < rect.x0 - f.pitch || p.x > rect.x1 + f.pitch) continue;
      if (p.y < rect.y0 - f.pitch || p.y > rect.y1 + f.pitch) continue;
      hexPath(path, p.x, p.y, f.size);
    }
    ctx.fillStyle = style;
    // Non-zero winding over a tiling never double-blends the overlap.
    ctx.fill(path);
  }

  private strokeHexSetBoundary(
    f: Frame,
    hexes: ReadonlySet<string>,
    style: string,
    widthPx: number,
  ): void {
    const { ctx } = f;
    const path = new Path2D();
    for (const k of hexes) {
      const h = parseKey(k);
      const p = toPixel(h, f.size);
      if (!f.cam.isVisible(p.x, p.y, f.pitch)) continue;
      for (let dir = 0; dir < 6; dir++) {
        if (hexes.has(key(neighbor(h, dir)))) continue;
        const ci = DIR_TO_CORNER[dir]!;
        const cj = (ci + 1) % 6;
        path.moveTo(p.x + f.size * HEX_COS[ci]!, p.y + f.size * HEX_SIN[ci]!);
        path.lineTo(p.x + f.size * HEX_COS[cj]!, p.y + f.size * HEX_SIN[cj]!);
      }
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = Math.max(widthPx * f.u, f.pitch * 0.006);
    ctx.stroke(path);
  }

  /**
   * Candidate endpoints while plotting.
   *
   * "One fuel point may be spent to shift the head of the course arrow one hex
   * in any direction", so the reachable set is the natural endpoint plus its
   * ring — tinted by what waits there.
   */
  private drawReachable(f: Frame, view: RenderView): void {
    const list = view.reachable;
    if (!list || list.length === 0) return;
    const { ctx } = f;

    for (const entry of list) {
      const p = toPixel(entry.hex, f.size);
      if (!f.cam.isVisible(p.x, p.y, f.pitch)) continue;
      const tint = dangerColor(entry.danger);

      ctx.beginPath();
      hexPath(ctx, p.x, p.y, f.size * 0.92);
      ctx.fillStyle = rgba(tint, 0.13);
      ctx.fill();
      ctx.lineWidth = Math.max(0.9 * f.u, f.pitch * 0.01);
      ctx.strokeStyle = rgba(tint, 0.55);
      ctx.stroke();

      // Same notation as the course arrows: a circle for one point of fuel, a
      // double circle for the overload manoeuvre.
      if (entry.accel > 0 && f.hexPx >= LOD.detailMin) {
        drawAccelMark(f, p.x, p.y, entry.accel, tint, 0.8);
      }
    }
  }

  /**
   * Course arrows for every ship the viewer can see.
   *
   * Plots are public information in Triplanetary — they are drawn on the shared
   * map, and the Grand Tour scenario even offers "you may erase each ship's
   * course arrows as soon as it refuels, to keep players from easily shadowing
   * previous routes" as a *variant*, which only makes sense if the trails are
   * normally there for everyone to read.
   */
  private drawCourses(f: Frame, state: GameState, view: RenderView): void {
    for (const ship of Object.values(state.ships)) {
      if (ship.destroyed || this.isHidden(state, view, ship)) continue;
      const color = this.colorOf(state, ship.owner);
      const selected = view.selectedShip === ship.id;
      drawTrail(
        f,
        ship.course,
        state.turn,
        color,
        view.showCourseHistory,
        selected ? 2.2 : 1.7,
      );
    }

    // The selected ship's predicted course, dashed.
    const sel = view.selectedShip ? state.ships[view.selectedShip] : undefined;
    if (sel && !sel.destroyed && !this.isHidden(state, view, sel)) {
      // Endpoint = position + velocity + gravity picked up last turn, which is
      // exactly what the astrogation phase commits; a plotted endpoint (if the
      // player has already spent fuel) supersedes it.
      const natural = add(add(sel.pos, sel.velocity), sel.pendingGravity);
      const endpoint = view.plannedEndpoint ?? sel.plottedEndpoint ?? natural;
      if (!eq(endpoint, sel.pos) || sel.plottedAccel > 0) {
        drawPredictedCourse(
          f,
          sel.pos,
          endpoint,
          sel.plottedAccel,
          lighten(this.colorOf(state, sel.owner), 0.25),
          state.turn,
        );
      }
    }
  }

  private drawOrdnance(f: Frame, state: GameState, view: RenderView): void {
    const items = Object.values(state.ordnance);
    if (items.length === 0) return;

    for (const o of items) {
      const color = this.colorOf(state, o.owner);
      // "their vector arrows are drawn on the map" — ordnance is not hidden.
      drawTrail(f, o.course, state.turn, color, view.showCourseHistory, 1.3);
    }

    const groups = groupBy(items, (o) => key(o.pos));
    for (const [, list] of groups) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i]!;
        const p = toPixel(o.pos, f.size);
        if (!f.cam.isVisible(p.x, p.y, f.pitch)) continue;
        const off = stackOffset(f, i, list.length);
        drawOrdnanceMarker(f, o, p.x + off.dx, p.y + off.dy, this.colorOf(state, o.owner));
      }
    }
  }

  private drawShips(f: Frame, state: GameState, view: RenderView): void {
    const drawable: Ship[] = [];
    for (const ship of Object.values(state.ships)) {
      if (ship.destroyed) continue;
      if (this.isHidden(state, view, ship)) continue;
      const p = toPixel(ship.pos, f.size);
      if (!f.cam.isVisible(p.x, p.y, f.pitch * 2)) continue;
      drawable.push(ship);
    }

    const groups = groupBy(drawable, (s) => key(s.pos));
    for (const [, list] of groups) {
      // Landed ships hug their hexside; only space-going counters stack.
      const stackers = list.filter((s) => s.location.kind !== 'landed');
      for (let i = 0; i < list.length; i++) {
        const ship = list[i]!;
        const centre = toPixel(ship.pos, f.size);
        let x = centre.x;
        let y = centre.y;
        if (ship.location.kind === 'landed') {
          const off = counterOffset(f, ship, DIR_COS, DIR_SIN);
          x += off.dx;
          y += off.dy;
        } else {
          const idx = stackers.indexOf(ship);
          const off = stackOffset(f, idx < 0 ? 0 : idx, stackers.length);
          x += off.dx;
          y += off.dy;
        }
        drawShipCounter(f, ship, x, y, {
          color: this.colorOf(state, ship.owner),
          selected: view.selectedShip === ship.id,
          hovered: view.hoveredHex ? eq(view.hoveredHex, ship.pos) : false,
        });
      }
    }
  }

  /** Hover ring, planned endpoint, attack preview. */
  private drawPlotFurniture(f: Frame, state: GameState, view: RenderView): void {
    const { ctx } = f;

    if (view.hoveredHex && inBounds(view.hoveredHex)) {
      const p = toPixel(view.hoveredHex, f.size);
      ctx.beginPath();
      hexPath(ctx, p.x, p.y, f.size * 0.97);
      ctx.strokeStyle = rgba(THEME.hover, 0.55);
      ctx.lineWidth = Math.max(1 * f.u, f.pitch * 0.012);
      ctx.stroke();
    }

    if (view.plannedEndpoint) {
      const p = toPixel(view.plannedEndpoint, f.size);
      const beat = pulse(f, 1400);
      glow(f, p.x, p.y, f.pitch * (0.7 + 0.12 * beat), THEME.accent, 0.28);
      ctx.beginPath();
      ctx.arc(p.x, p.y, f.size * (0.62 + 0.09 * beat), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(THEME.accent, 0.55 + 0.35 * beat);
      ctx.lineWidth = Math.max(1.4 * f.u, f.pitch * 0.018);
      ctx.stroke();

      ctx.beginPath();
      hexPath(ctx, p.x, p.y, f.size * 0.94);
      ctx.strokeStyle = rgba(THEME.accent, 0.8);
      ctx.lineWidth = Math.max(1 * f.u, f.pitch * 0.012);
      ctx.stroke();
    }

    const preview = view.attackPreview;
    if (preview) {
      const a = toPixel(preview.from, f.size);
      const b = toPixel(preview.to, f.size);
      const tint = preview.blocked ? THEME.danger : THEME.safe;
      ctx.save();
      ctx.setLineDash(preview.blocked ? [4 * f.u, 4 * f.u] : [10 * f.u, 5 * f.u]);
      ctx.strokeStyle = rgba(tint, 0.85);
      ctx.lineWidth = Math.max(1.6 * f.u, f.pitch * 0.02);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = rgba(tint, 0.9);
      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(2.5 * f.u, f.pitch * 0.06), 0, Math.PI * 2);
      ctx.fill();

      if (preview.blocked) {
        // "Attacks may be made through other ships, ordnance, and asteroids,
        // but not through moons, planets, or Sol." Show the offending body.
        const blocker = this.map.lineOfSightBlockedBy(preview.from, preview.to);
        if (blocker) {
          const c = toPixel(blocker.hex, f.size);
          const r = f.pitch * 0.4;
          ctx.strokeStyle = rgba(THEME.danger, 0.95);
          ctx.lineWidth = Math.max(1.8 * f.u, f.pitch * 0.022);
          ctx.beginPath();
          ctx.moveTo(c.x - r, c.y - r);
          ctx.lineTo(c.x + r, c.y + r);
          ctx.moveTo(c.x + r, c.y - r);
          ctx.lineTo(c.x - r, c.y + r);
          ctx.stroke();
          if (f.hexPx >= LOD.courseTextMin) {
            setFont(f, 10, '700');
            label(f, 'NO LOS', c.x, c.y - r - 8 * f.u, THEME.danger, 0.8);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
          }
        }
      }
    }

    // A quiet marker under the selected ship's hex, so it stays findable when
    // its counter is buried in a stack.
    const sel = view.selectedShip ? state.ships[view.selectedShip] : undefined;
    if (sel && !sel.destroyed) {
      const p = toPixel(sel.pos, f.size);
      ctx.beginPath();
      hexPath(ctx, p.x, p.y, f.size * 0.99);
      ctx.strokeStyle = rgba(THEME.selection, 0.4);
      ctx.lineWidth = Math.max(1.2 * f.u, f.pitch * 0.014);
      ctx.stroke();
    }
  }

  /** A soft darkening at the edges: focus stays in the middle of the plate. */
  private drawVignette(f: Frame): void {
    const { ctx } = f;
    const w = f.cam.width;
    const h = f.cam.height;
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.55, w / 2, h / 2, r);
    g.addColorStop(0, rgba(THEME.spaceEdge, 0));
    g.addColorStop(1, rgba(THEME.spaceEdge, 0.55));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private colorOf(state: GameState, owner: PlayerId | null): string {
    if (owner === null) return THEME.neutral;
    return state.players[owner]?.color ?? THEME.neutral;
  }

  /**
   * Fog of war. "Once a ship has been detected by the enemy, it remains
   * detected (regardless of range) until it arrives at a friendly base", so
   * visibility is a flag on the ship, not a range test at draw time.
   */
  private isHidden(state: GameState, view: RenderView, ship: Ship): boolean {
    if (view.hiddenShips?.has(ship.id)) return true;
    const viewer = view.viewer;
    if (!state.options.fogOfWar || viewer === null) return false;
    if (areAllied(state, ship.owner, viewer)) return false;
    return !ship.detectedBy.includes(viewer);
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const dangerColor = (danger?: string): string => {
  if (!danger) return THEME.accent;
  const d = danger.toLowerCase();
  if (d.includes('crash') || d.includes('sol') || d.includes('destroy')) return THEME.danger;
  if (d.includes('asteroid') || d.includes('mine')) return THEME.warn;
  if (d.includes('off') || d.includes('exit') || d.includes('map')) return THEME.violet;
  return THEME.accent;
};

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
};

/** The raw hex→world projection, for callers drawing their own overlays. */
export const worldCentreOf = (h: Hex, hexSize: number): Point => toPixel(h, hexSize);
