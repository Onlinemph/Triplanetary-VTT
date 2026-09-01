/**
 * The map renderer: an immediate-mode canvas that reads a `GameState` and a
 * `RenderView` and draws. It holds no game state and dispatches no commands.
 *
 * Every mark on the board is generated from coordinates and unit statistics.
 * There is no image asset to load, which is also why this project ships no
 * copyrighted artwork: the cratered plain, the counters and the Ogre's damage
 * bar are all drawn from the same data the rules use.
 */

import {
  type Hex,
  type Point,
  canonicalSide,
  corners,
  key as hexKey,
  label as hexLabel,
  neighbor,
  sideCorners,
  sideKey,
  toPixel,
} from '../engine/hex.js';
import { type GameMap, allHexes, inBounds, terrainAt } from '../engine/map.js';
import { type Terrain, baseTerrain } from '../engine/terrain.js';
import { OGRE_WEAPONS, movementForTreads, ogreType } from '../engine/ogres.js';
import { unitClass } from '../engine/units.js';
import {
  type GameState,
  type OgreUnit,
  type Unit,
  type UnitId,
  isOgre,
  onBoard,
} from '../engine/types.js';
import { unitAbbr } from '../engine/state.js';
import { Camera, type Inset } from './camera.js';
import {
  type BoardPalette,
  BOARD,
  LOD,
  TERRAIN_COLORS,
  THEME,
  darken,
  hexNoise,
  inkOn,
  lighten,
  mix,
  rgba,
  smoothstep,
} from './theme.js';

export interface ReachHint {
  readonly hex: Hex;
  readonly cost: number;
  readonly hazard: null | 'disable' | 'stuck';
}

export interface RenderView {
  readonly selected: UnitId | null;
  readonly hover: Hex | null;
  /** Hexes the selected unit can reach this phase, from the engine. */
  readonly reachable: readonly ReachHint[];
  /** Hexes holding something the selection could ram. */
  readonly ramTargets: readonly Hex[];
  /** Units the selection could shoot at. */
  readonly fireTargets: readonly UnitId[];
  /** Units queued as attackers in the fire panel. */
  readonly attackers: readonly UnitId[];
  /** Highlighted by hovering a log entry. */
  readonly focus: readonly Hex[];
  /**
   * Hexes something may be put down on: a side's setup area while the
   * counters are going down, or the map edge a reserve may enter at.
   */
  readonly zone: readonly Hex[];
  /** The part of the zone under an attack-strength ceiling, tinted apart. */
  readonly zoneLimit: readonly Hex[];
  /** A hex being aimed at — a cruise missile's target — with its blast rings. */
  readonly aim: Hex | null;
  readonly showAreas: boolean;
  readonly showHexNumbers: boolean;
  /** Which player's eyes we are drawing for; their counters read brighter. */
  readonly viewer: string | null;
}

export const EMPTY_VIEW: RenderView = {
  selected: null,
  hover: null,
  reachable: [],
  ramTargets: [],
  fireTargets: [],
  attackers: [],
  focus: [],
  zone: [],
  zoneLimit: [],
  aim: null,
  showAreas: true,
  showHexNumbers: false,
  viewer: null,
};

export class MapRenderer {
  readonly camera = new Camera();
  private readonly ctx: CanvasRenderingContext2D;
  private palette: BoardPalette;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private map: GameMap,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('this browser has no 2D canvas');
    this.ctx = ctx;
    this.palette = map.id === 'gev' ? BOARD.gev : BOARD.ogre;
    this.resize();
    this.camera.fitMap(map);
  }

  setMap(map: GameMap): void {
    this.map = map;
    this.palette = map.id === 'gev' ? BOARD.gev : BOARD.ogre;
    this.camera.fitMap(map);
  }

  panBy(dx: number, dy: number): void {
    this.camera.panBy(dx, dy);
  }

  zoomAt(x: number, y: number, factor: number): void {
    this.camera.zoomAt(x, y, factor);
  }

  setViewInset(inset: Inset): void {
    this.camera.setInset(inset);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.camera.resize(rect.width, rect.height, dpr);
  }

  screenToHex(x: number, y: number): Hex {
    return this.camera.screenToHex(x, y);
  }

  hexToScreen(h: Hex): Point {
    return this.camera.hexToScreen(h);
  }

  fitMap(): void {
    this.camera.fitMap(this.map);
  }

  focusOn(h: Hex): void {
    this.camera.focusOn(h);
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  render(state: GameState, view: RenderView = EMPTY_VIEW): void {
    const ctx = this.ctx;
    const size = this.camera.hexSize;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = THEME.void;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.camera.applyTo(ctx);

    const hexes = allHexes(this.map);
    this.drawGround(state, hexes, size, view);
    this.drawRoutes(hexes, size, state);
    this.drawSides(hexes, size, state);
    if (size >= LOD.gridMin) this.drawGrid(hexes, size);
    if (view.showAreas && this.map.areaLines) this.drawAreaLines(size);
    this.drawZone(view, size);
    this.drawOverlays(state, view, size);
    this.drawBuildings(state, view, size);
    this.drawUnits(state, view, size);
    this.drawMissiles(state, size);
    if (view.aim) this.drawAim(view.aim, size);
    if (view.showHexNumbers && size >= LOD.hexLabelMin) this.drawHexNumbers(hexes, size);
  }

  /**
   * A setup area or an entry edge: a soft wash over every hex a counter may
   * go down on, and a warmer one over the part of it under a ceiling.
   */
  private drawZone(view: RenderView, size: number): void {
    if (view.zone.length === 0) return;
    const ctx = this.ctx;
    const limited = new Set(view.zoneLimit.map(hexKey));
    for (const h of view.zone) {
      this.path(ctx, h, size, size * 0.06);
      ctx.fillStyle = rgba(limited.has(hexKey(h)) ? THEME.hazard : THEME.reach, 0.12);
      ctx.fill();
      ctx.strokeStyle = rgba(limited.has(hexKey(h)) ? THEME.hazard : THEME.reachEdge, 0.28);
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.stroke();
    }
  }

  /** The hex a cruise missile is aimed at, and the two rings its blast reaches. */
  private drawAim(aim: Hex, size: number): void {
    const ctx = this.ctx;
    const c = toPixel(aim, size);
    ctx.save();
    ctx.setLineDash([size * 0.2, size * 0.14]);
    for (const [ring, alpha] of [
      [1, 0.7],
      [2, 0.4],
    ] as const) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, size * (1.5 * ring + 0.35), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(THEME.threat, alpha);
      ctx.lineWidth = Math.max(1.5, size * 0.06);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    this.path(ctx, aim, size, size * 0.04);
    ctx.strokeStyle = THEME.threat;
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.stroke();
  }

  /**
   * Buildings (Section 11): a squat block with a structure-point bar, in the
   * owner's colour with a slate roof, so a base reads as a thing to be taken
   * rather than a counter to be shot.
   */
  private drawBuildings(state: GameState, view: RenderView, size: number): void {
    const ctx = this.ctx;
    for (const b of Object.values(state.buildings)) {
      const c = toPixel(b.pos, size);
      const w = size * 1.3;
      const h = size * 0.9;
      const owner = b.owner ? state.players[b.owner] : undefined;
      const color = owner?.color ?? '#7a7062';

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = size * 0.2;
      roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, size * 0.08);
      ctx.fillStyle = b.destroyed ? mix('#3a332b', THEME.disabled, 0.4) : mix(color, '#8e8677', 0.55);
      ctx.fill();
      ctx.restore();

      roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, size * 0.08);
      ctx.strokeStyle = view.hover && hexKey(view.hover) === hexKey(b.pos) ? THEME.hover : THEME.counterEdge;
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.stroke();

      if (b.destroyed) {
        ctx.strokeStyle = rgba(THEME.bad, 0.8);
        ctx.lineWidth = Math.max(1.5, size * 0.07);
        ctx.beginPath();
        ctx.moveTo(c.x - w * 0.3, c.y - h * 0.3);
        ctx.lineTo(c.x + w * 0.3, c.y + h * 0.3);
        ctx.moveTo(c.x + w * 0.3, c.y - h * 0.3);
        ctx.lineTo(c.x - w * 0.3, c.y + h * 0.3);
        ctx.stroke();
        continue;
      }

      if (size >= LOD.counterLabelMin) {
        ctx.fillStyle = THEME.counterInk;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `600 ${Math.round(size * 0.24)}px ${THEME.font}`;
        ctx.fillText(BUILDING_TAGS[b.kind] ?? b.kind.toUpperCase(), c.x, c.y - h * 0.18);
      }
      const frac = b.maxStructurePoints > 0 ? b.structurePoints / b.maxStructurePoints : 0;
      const barW = w * 0.76;
      const barH = h * 0.18;
      const x = c.x - barW / 2;
      const y = c.y + h * 0.12;
      ctx.fillStyle = rgba('#000000', 0.45);
      ctx.fillRect(x, y, barW, barH);
      ctx.fillStyle = frac > 0.66 ? THEME.good : frac > 0.33 ? THEME.warn : THEME.bad;
      ctx.fillRect(x, y, barW * frac, barH);
      if (size >= LOD.counterTextMin) {
        ctx.fillStyle = THEME.counterInk;
        ctx.font = `${Math.round(size * 0.17)}px ${THEME.monoFont}`;
        ctx.textBaseline = 'top';
        ctx.fillText(`${b.structurePoints} SP`, c.x, y + barH + size * 0.02);
      }
    }
  }

  /** Cruise missiles in flight: a bright dart on a dashed line to the target. */
  private drawMissiles(state: GameState, size: number): void {
    const ctx = this.ctx;
    for (const m of Object.values(state.missiles ?? {})) {
      const from = toPixel(m.pos, size);
      const to = toPixel(m.target, size);
      ctx.save();
      ctx.setLineDash([size * 0.18, size * 0.18]);
      ctx.strokeStyle = rgba(THEME.threat, 0.6);
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.save();
      ctx.translate(from.x, from.y);
      ctx.rotate(angle);
      ctx.fillStyle = state.players[m.owner]?.color ?? THEME.threat;
      ctx.strokeStyle = THEME.counterEdge;
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.beginPath();
      ctx.moveTo(size * 0.5, 0);
      ctx.lineTo(-size * 0.3, size * 0.22);
      ctx.lineTo(-size * 0.15, 0);
      ctx.lineTo(-size * 0.3, -size * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------

  /** `shrink` insets the outline without moving the hex it belongs to. */
  private path(ctx: CanvasRenderingContext2D, h: Hex, size: number, shrink = 0): void {
    const pts = corners(h, size, size - shrink);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < 6; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
  }

  private drawGround(
    state: GameState,
    hexes: readonly Hex[],
    size: number,
    view: RenderView,
  ): void {
    const ctx = this.ctx;
    const detail = size >= LOD.detailMin;

    for (const h of hexes) {
      const terrain = terrainAt(this.map, h, state.terrainOverrides);
      const noise = hexNoise(h.q, h.r);
      this.path(ctx, h, size);

      ctx.fillStyle = this.groundFill(terrain, noise);
      ctx.fill();

      if (!detail) continue;
      switch (baseTerrain(terrain)) {
        case 'crater':
          this.drawCrater(h, size, noise);
          break;
        case 'forest':
          this.drawForest(h, size, terrain === 'damagedForest');
          break;
        case 'town':
          this.drawTown(h, size, terrain === 'damagedTown');
          break;
        case 'swamp':
          this.drawSwamp(h, size);
          break;
        case 'water':
          this.drawWater(h, size);
          break;
        case 'rubble':
          this.drawRubble(h, size);
          break;
        default:
          break;
      }
    }
    void view;
  }

  private groundFill(terrain: Terrain, noise: number): string {
    const p = this.palette;
    const base = mix(p.ground, p.groundAlt, noise);
    switch (baseTerrain(terrain)) {
      case 'crater':
        return p.crater;
      case 'forest':
        return mix(TERRAIN_COLORS.forest, TERRAIN_COLORS.forestCanopy, noise);
      case 'town':
        return mix(TERRAIN_COLORS.town, darken(TERRAIN_COLORS.town, 0.2), noise);
      case 'swamp':
        return mix(TERRAIN_COLORS.swamp, TERRAIN_COLORS.swampWater, noise * 0.6);
      case 'water':
        return mix(TERRAIN_COLORS.water, TERRAIN_COLORS.waterLight, noise * 0.5);
      case 'rubble':
        return mix(TERRAIN_COLORS.rubble, darken(TERRAIN_COLORS.rubble, 0.25), noise);
      default:
        return base;
    }
  }

  /**
   * A crater: a dark pit with a bright spoil rim on the sun side, and a few
   * chips of debris. The rim is what makes an impassable hex read as impassable
   * at a glance, so it survives further down the zoom than the debris does.
   */
  private drawCrater(h: Hex, size: number, noise: number): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    // A flat-top hex's inradius is size * sqrt(3)/2; the pit has to stay inside
    // it, or a field of craters merges into one unreadable blot and a player can
    // no longer tell which hexes are actually closed.
    const r = size * (0.42 + noise * 0.07);

    ctx.save();
    this.path(ctx, h, size);
    ctx.clip();

    const gradient = ctx.createRadialGradient(c.x, c.y - r * 0.25, r * 0.1, c.x, c.y, r);
    gradient.addColorStop(0, '#0a0705');
    gradient.addColorStop(0.75, this.palette.crater);
    gradient.addColorStop(1, rgba(this.palette.craterRim, 0.35));
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // A bright spoil rim on the lit side is what makes an impassable hex read
    // as impassable at a glance.
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * 0.94, Math.PI * 1.02, Math.PI * 1.98);
    ctx.strokeStyle = rgba(this.palette.craterRim, 0.85);
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.stroke();

    if (size >= LOD.detailMin * 1.4) {
      ctx.fillStyle = rgba(this.palette.craterRim, 0.3);
      for (let i = 0; i < 4; i++) {
        const a = hexNoise(h.q, h.r, i + 1) * Math.PI * 2;
        const d = r * (1.08 + hexNoise(h.q, h.r, i + 11) * 0.25);
        ctx.beginPath();
        ctx.arc(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, size * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawForest(h: Hex, size: number, damaged: boolean): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.fillStyle = rgba(TERRAIN_COLORS.forestCanopy, damaged ? 0.4 : 0.85);
    for (let i = 0; i < 7; i++) {
      const a = hexNoise(h.q, h.r, i) * Math.PI * 2;
      const d = size * 0.55 * hexNoise(h.q, h.r, i + 30);
      const x = c.x + Math.cos(a) * d;
      const y = c.y + Math.sin(a) * d;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    if (damaged) this.drawFires(h, size);
  }

  private drawTown(h: Hex, size: number, damaged: boolean): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.fillStyle = rgba(TERRAIN_COLORS.townRoof, damaged ? 0.45 : 0.9);
    for (let i = 0; i < 5; i++) {
      const n1 = hexNoise(h.q, h.r, i + 50);
      const n2 = hexNoise(h.q, h.r, i + 70);
      const w = size * (0.18 + n1 * 0.16);
      const x = c.x + (n1 - 0.5) * size * 0.9;
      const y = c.y + (n2 - 0.5) * size * 0.9;
      ctx.fillRect(x - w / 2, y - w / 2, w, w);
    }
    if (damaged) this.drawFires(h, size);
  }

  private drawFires(h: Hex, size: number): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.fillStyle = rgba(THEME.warn, 0.75);
    for (let i = 0; i < 3; i++) {
      const a = hexNoise(h.q, h.r, i + 90) * Math.PI * 2;
      const d = size * 0.4;
      ctx.beginPath();
      ctx.arc(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, size * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSwamp(h: Hex, size: number): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.strokeStyle = rgba(TERRAIN_COLORS.swampWater, 0.85);
    ctx.lineWidth = Math.max(1, size * 0.06);
    for (let i = 0; i < 4; i++) {
      const y = c.y + (hexNoise(h.q, h.r, i + 120) - 0.5) * size * 1.0;
      const w = size * (0.3 + hexNoise(h.q, h.r, i + 140) * 0.4);
      ctx.beginPath();
      ctx.moveTo(c.x - w, y);
      ctx.lineTo(c.x + w, y);
      ctx.stroke();
    }
  }

  private drawWater(h: Hex, size: number): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.strokeStyle = rgba(TERRAIN_COLORS.waterLight, 0.6);
    ctx.lineWidth = Math.max(1, size * 0.05);
    for (let i = 0; i < 3; i++) {
      const y = c.y + (i - 1) * size * 0.35;
      ctx.beginPath();
      ctx.moveTo(c.x - size * 0.45, y);
      ctx.quadraticCurveTo(c.x, y + size * 0.12, c.x + size * 0.45, y);
      ctx.stroke();
    }
  }

  private drawRubble(h: Hex, size: number): void {
    const ctx = this.ctx;
    const c = toPixel(h, size);
    ctx.fillStyle = rgba(darken(TERRAIN_COLORS.rubble, 0.4), 0.9);
    for (let i = 0; i < 9; i++) {
      const a = hexNoise(h.q, h.r, i + 200) * Math.PI * 2;
      const d = size * 0.6 * hexNoise(h.q, h.r, i + 220);
      ctx.fillRect(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, size * 0.1, size * 0.08);
    }
  }

  // -------------------------------------------------------------------------
  // Linear features
  // -------------------------------------------------------------------------

  private drawRoutes(hexes: readonly Hex[], size: number, state: GameState): void {
    const ctx = this.ctx;
    const cut = new Set(state.routesCut);
    ctx.lineCap = 'round';

    for (const h of hexes) {
      const c = toPixel(h, size);
      for (let dir = 0; dir < 3; dir++) {
        const route = this.map.routes[sideKey(canonicalSide(h, dir))];
        if (!route) continue;
        const n = neighbor(h, dir);
        if (!inBounds(this.map, n)) continue;
        const nc = toPixel(n, size);
        const broken = cut.has(hexKey(h)) || cut.has(hexKey(n));

        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(nc.x, nc.y);
        if (route === 'rail') {
          ctx.strokeStyle = rgba(TERRAIN_COLORS.rail, broken ? 0.25 : 0.8);
          ctx.lineWidth = Math.max(1, size * 0.09);
          ctx.setLineDash([size * 0.12, size * 0.12]);
        } else {
          ctx.strokeStyle = rgba(TERRAIN_COLORS.road, broken ? 0.2 : 0.75);
          ctx.lineWidth = Math.max(1.5, size * 0.14);
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private drawSides(hexes: readonly Hex[], size: number, state: GameState): void {
    const ctx = this.ctx;
    const overrides = state.sideOverrides ?? {};
    for (const h of hexes) {
      const pts = corners(h, size);
      for (let dir = 0; dir < 3; dir++) {
        const k = sideKey(canonicalSide(h, dir));
        const feature = overrides[k] ?? this.map.sides[k];
        if (!feature) continue;
        const [a, b] = sideCorners(dir);
        ctx.beginPath();
        ctx.moveTo(pts[a]!.x, pts[a]!.y);
        ctx.lineTo(pts[b]!.x, pts[b]!.y);
        if (feature === 'ridge') {
          ctx.strokeStyle = TERRAIN_COLORS.ridge;
          ctx.lineWidth = Math.max(2, size * 0.18);
        } else if (feature === 'stream') {
          ctx.strokeStyle = rgba(TERRAIN_COLORS.stream, 0.9);
          ctx.lineWidth = Math.max(1.5, size * 0.1);
        } else {
          ctx.strokeStyle = rgba('#d8c79a', 0.8);
          ctx.lineWidth = Math.max(1.5, size * 0.1);
        }
        ctx.stroke();
      }
    }
  }

  private drawGrid(hexes: readonly Hex[], size: number): void {
    const ctx = this.ctx;
    const strength = smoothstep(LOD.gridMin, LOD.gridFull, size);
    ctx.strokeStyle = rgba(this.palette.grid, 0.2 + strength * 0.3);
    ctx.lineWidth = 1;
    for (const h of hexes) {
      this.path(ctx, h, size, 0.5);
      ctx.stroke();
    }
  }

  /**
   * The two lines the setup instructions are written in terms of: "There are
   * four gray arrows on the edges of the Ogre map. They define two lines which
   * divide the map into North, Central, and South areas."
   *
   * `areaOf` reads `north` as the last northern row and `south` as the first
   * southern one, so both lines are drawn along a row's *south* face: below the
   * north row, and below the row above the south one.
   */
  private drawAreaLines(size: number): void {
    const ctx = this.ctx;
    const lines = this.map.areaLines!;
    ctx.save();
    ctx.setLineDash([size * 0.45, size * 0.3]);
    ctx.strokeStyle = rgba(THEME.select, 0.45);
    ctx.lineWidth = Math.max(1.5, size * 0.055);

    for (const row of [lines.north, lines.south - 1]) {
      const pts = areaLinePoints(this.map.cols, row, size);
      if (pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawHexNumbers(hexes: readonly Hex[], size: number): void {
    const ctx = this.ctx;
    ctx.font = `${Math.round(size * 0.26)}px ${THEME.monoFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(this.palette.label, 0.55);
    for (const h of hexes) {
      const c = toPixel(h, size);
      ctx.fillText(hexLabel(h), c.x, c.y - size * 0.78);
    }
  }

  // -------------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------------

  private drawOverlays(state: GameState, view: RenderView, size: number): void {
    const ctx = this.ctx;

    for (const r of view.reachable) {
      this.path(ctx, r.hex, size, size * 0.12);
      ctx.fillStyle = rgba(r.hazard ? THEME.hazard : THEME.reach, r.hazard ? 0.16 : 0.13);
      ctx.fill();
      ctx.strokeStyle = rgba(r.hazard ? THEME.hazard : THEME.reachEdge, 0.5);
      ctx.lineWidth = Math.max(1, size * 0.045);
      ctx.stroke();
    }

    for (const h of view.ramTargets) {
      this.path(ctx, h, size, size * 0.08);
      ctx.strokeStyle = rgba(THEME.ramLine, 0.85);
      ctx.lineWidth = Math.max(2, size * 0.09);
      ctx.setLineDash([size * 0.22, size * 0.16]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const h of view.focus) {
      this.path(ctx, h, size, size * 0.05);
      ctx.strokeStyle = rgba(THEME.select, 0.8);
      ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.stroke();
    }

    if (view.hover && inBounds(this.map, view.hover)) {
      this.path(ctx, view.hover, size, size * 0.03);
      ctx.strokeStyle = rgba(THEME.hover, 0.45);
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.stroke();
    }

    const selected = view.selected ? state.units[view.selected] : undefined;
    if (selected && onBoard(selected)) {
      this.path(ctx, selected.pos, size, size * 0.02);
      ctx.strokeStyle = THEME.select;
      ctx.lineWidth = Math.max(2, size * 0.09);
      ctx.stroke();
    }

    for (const id of view.fireTargets) {
      const u = state.units[id];
      if (!u || !onBoard(u)) continue;
      const c = toPixel(u.pos, size);
      ctx.beginPath();
      ctx.arc(c.x, c.y, size * 0.86, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(THEME.threat, 0.7);
      ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.setLineDash([size * 0.16, size * 0.16]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  private drawUnits(state: GameState, view: RenderView, size: number): void {
    // Draw the stack bottom-up so a counter's shadow lands on the one beneath.
    const byHex = new Map<string, Unit[]>();
    for (const u of Object.values(state.units)) {
      if (!onBoard(u)) continue;
      if (u.kind === 'unit' && u.ridingOn) continue;
      const k = hexKey(u.pos);
      const list = byHex.get(k) ?? [];
      list.push(u);
      byHex.set(k, list);
    }

    for (const [, stack] of byHex) {
      stack.sort((a, b) => (isOgre(a) ? -1 : 0) - (isOgre(b) ? -1 : 0));
      const spread = Math.min(stack.length - 1, 3);
      stack.forEach((u, i) => {
        const c = toPixel(u.pos, size);
        const offset = spread === 0 ? 0 : (i - spread / 2) * size * 0.17;
        this.drawCounter(state, u, { x: c.x + offset, y: c.y + offset }, size, view);
      });
    }
  }

  private drawCounter(state: GameState, u: Unit, c: Point, size: number, view: RenderView): void {
    const ctx = this.ctx;
    const player = state.players[u.owner];
    const color = player?.color ?? '#888';
    const ogre = isOgre(u);
    const w = size * (ogre ? 1.5 : 1.12);
    const h = size * (ogre ? 1.0 : 1.12);
    const r = size * 0.16;
    const disabled = u.kind === 'unit' && u.disabled !== 'none';
    const selected = view.selected === u.id;
    const queued = view.attackers.includes(u.id);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.22;
    ctx.shadowOffsetY = size * 0.06;

    roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, r);
    ctx.fillStyle = disabled ? mix(color, THEME.disabled, 0.6) : color;
    ctx.fill();
    ctx.restore();

    // A darker band across the top carries the abbreviation; the field below
    // carries the numbers. That is the printed counter's own layout.
    ctx.save();
    roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, r);
    ctx.clip();
    ctx.fillStyle = rgba('#000000', 0.28);
    ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h * 0.42);
    ctx.restore();

    roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, r);
    ctx.strokeStyle = selected ? THEME.select : queued ? THEME.threat : THEME.counterEdge;
    ctx.lineWidth = selected || queued ? Math.max(2, size * 0.08) : Math.max(1, size * 0.04);
    ctx.stroke();

    const ink = inkOn(color);
    ctx.textAlign = 'center';

    if (size >= LOD.counterLabelMin) {
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.round(size * (ogre ? 0.3 : 0.28))}px ${THEME.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(unitAbbr(u), c.x, c.y - h * 0.22);
    }

    if (ogre) this.drawOgreBar(u, c, w, h, size, ink);
    else if (size >= LOD.counterTextMin) this.drawStats(u, c, h, size, ink);

    // An Ogre still assembling: hatched over, with the turn it wakes.
    if (ogre && u.activatesOn !== undefined && state.turn < u.activatesOn) {
      ctx.save();
      roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, r);
      ctx.clip();
      ctx.strokeStyle = rgba('#000000', 0.45);
      ctx.lineWidth = Math.max(1, size * 0.06);
      for (let x = -w; x < w; x += size * 0.22) {
        ctx.beginPath();
        ctx.moveTo(c.x + x, c.y - h / 2);
        ctx.lineTo(c.x + x + h, c.y + h / 2);
        ctx.stroke();
      }
      ctx.restore();
      if (size >= LOD.counterLabelMin) {
        ctx.fillStyle = THEME.warn;
        ctx.font = `700 ${Math.round(size * 0.24)}px ${THEME.font}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(`T${u.activatesOn}`, c.x + w * 0.34, c.y - h * 0.36);
      }
    }

    if (disabled) {
      ctx.strokeStyle = rgba('#000000', 0.7);
      ctx.lineWidth = Math.max(1.5, size * 0.07);
      ctx.beginPath();
      ctx.moveTo(c.x - w * 0.34, c.y + h * 0.3);
      ctx.lineTo(c.x + w * 0.34, c.y + h * 0.3);
      ctx.stroke();
    }
    if (u.kind === 'unit' && u.stuck) {
      ctx.fillStyle = THEME.hazard;
      ctx.beginPath();
      ctx.arc(c.x + w * 0.36, c.y - h * 0.36, size * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * The Ogre's counter carries its record sheet in miniature: a tread bar that
   * empties as it is shot away, and a row of pips for the weapons still aboard.
   * Everything a player needs to decide whether to close is on the counter.
   */
  private drawOgreBar(
    u: OgreUnit,
    c: Point,
    w: number,
    h: number,
    size: number,
    ink: string,
  ): void {
    const ctx = this.ctx;
    const type = ogreType(u.typeId);
    const frac = Math.max(0, u.treads / type.treads);

    const barW = w * 0.78;
    const barH = h * 0.16;
    const x = c.x - barW / 2;
    const y = c.y + h * 0.06;

    ctx.fillStyle = rgba('#000000', 0.45);
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = frac > 0.66 ? THEME.good : frac > 0.33 ? THEME.warn : THEME.bad;
    ctx.fillRect(x, y, barW * frac, barH);
    ctx.strokeStyle = rgba(ink, 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, barW, barH);

    if (size < LOD.counterTextMin) return;

    ctx.fillStyle = ink;
    ctx.font = `${Math.round(size * 0.2)}px ${THEME.monoFont}`;
    ctx.textBaseline = 'top';
    const move = movementForTreads(type, u.treads);
    ctx.fillText(`${u.treads}t  M${move}`, c.x, y + barH + size * 0.04);

    // Weapon pips, biggest gun first.
    const alive = u.weapons.filter((x2) => !x2.destroyed);
    const groups: [string, number][] = [
      ['MB', alive.filter((x2) => x2.kind === 'main').length],
      ['SB', alive.filter((x2) => x2.kind === 'secondary').length],
      ['M', alive.filter((x2) => x2.kind === 'missile' && !x2.fired).length + u.internalMissiles],
      ['AP', alive.filter((x2) => x2.kind === 'ap').length],
    ];
    ctx.font = `${Math.round(size * 0.17)}px ${THEME.monoFont}`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      groups
        .filter(([, n]) => n > 0)
        .map(([tag, n]) => `${n}${tag}`)
        .join(' '),
      c.x,
      c.y - h * 0.36,
    );
  }

  /** `4/2` over `D3 M3` — the printed counter, in the printed order (3.01). */
  private drawStats(u: Unit, c: Point, h: number, size: number, ink: string): void {
    if (u.kind !== 'unit') return;
    const ctx = this.ctx;
    const cls = unitClass(u.classId);
    const infantry = cls.kind === 'infantry';
    const attack = infantry ? cls.attack * u.squads : cls.attack;
    const defense = infantry ? cls.defense * u.squads : cls.defense;

    ctx.fillStyle = ink;
    ctx.font = `${Math.round(size * 0.22)}px ${THEME.monoFont}`;
    ctx.textBaseline = 'middle';
    if (cls.attack > 0) {
      ctx.fillText(`${attack}${cls.splitAttack ? '*' : ''}/${cls.range}`, c.x, c.y + h * 0.1);
    }
    const move = cls.secondMove != null ? `${cls.move}-${cls.secondMove}` : `${cls.move}`;
    ctx.font = `${Math.round(size * 0.19)}px ${THEME.monoFont}`;
    ctx.fillText(`D${defense} M${move}`, c.x, c.y + h * 0.33);
  }
}

/** What a building's block says on it. */
const BUILDING_TAGS: Readonly<Record<string, string>> = {
  admin: 'ADMIN',
  strongpoint: 'STRONG',
  reactor: 'REACTOR',
  radar: 'RADAR',
  laser: 'LASER',
  laserTower: 'TOWER',
};

/**
 * The polyline running along the south faces of one printed row, west to east.
 *
 * The board is odd-q: odd-numbered columns sit half a hex lower than even ones,
 * so the boundary between two rows is a staircase and not a straight line. Each
 * column contributes its hex's south face — corner 2 (south-west) to corner 1
 * (south-east) — and the step that bridges one column to the next is itself a
 * hexside, which is why consecutive points are always exactly `size` apart.
 *
 * Walking any other pair of corners produces a line that looks roughly right at
 * a glance and cuts straight through hexes on inspection.
 */
export const areaLinePoints = (cols: number, row: number, size: number): Point[] => {
  const out: Point[] = [];
  for (let col = 1; col <= cols; col++) {
    const q = col - 1;
    const h: Hex = { q, r: row - 1 - ((q - (q & 1)) >> 1) };
    const pts = corners(h, size);
    out.push(pts[2]!, pts[1]!);
  }
  return out;
};

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
};

/** Ogre weapon ranges, for the interface's threat rings. */
export const weaponRange = (kind: keyof typeof OGRE_WEAPONS): number => OGRE_WEAPONS[kind].range;

export { lighten };
