/**
 * The map camera: world <-> screen, pan, zoom, culling.
 *
 * ## Spaces
 *
 * - **Hex space** — axial `{q, r}`, the engine's coordinates.
 * - **World space** — pixels at zoom 1, i.e. exactly `hex.toPixel(h, HEX_SIZE)`.
 *   Every layer of the renderer draws in world space, so a single canvas
 *   transform does all the pan/zoom work and no layer has to know about it.
 * - **Screen space** — CSS pixels inside the canvas. Device pixels are handled
 *   by folding `devicePixelRatio` into the same transform, which is what keeps
 *   hairlines crisp on HiDPI without any layer rounding coordinates itself.
 */

import { type FracHex, type Hex, type Point, fromPixel, round, toPixel, pitch } from '../engine/hex.js';

/** Centre-to-vertex distance of a hex in world units, at zoom 1. */
export const HEX_SIZE = 32;

/** Zoom is clamped in terms of *screen pixels per hex radius*, not raw scale. */
export const MIN_HEX_PX = 3;
export const MAX_HEX_PX = 120;

export interface Viewport {
  width: number;
  height: number;
}

export interface WorldRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export class Camera {
  /** World-space point at the centre of the viewport. */
  x = 0;
  y = 0;
  /** Screen pixels per world unit. */
  zoom = 1;

  width = 1;
  height = 1;
  dpr = 1;

  readonly hexSize = HEX_SIZE;
  /** World-space distance between adjacent hex centres. */
  readonly pitch = pitch(HEX_SIZE);

  /**
   * How far the centre may stray from the origin, in world units. The chart is
   * a disc around Sol, so a single radius is the whole constraint; the renderer
   * sets it from `MAP_RADIUS` once the map is known.
   */
  panRadius = HEX_SIZE * 60;

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  setViewport(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.max(1, dpr);
  }

  get viewport(): Viewport {
    return { width: this.width, height: this.height };
  }

  /** Screen pixels per hex radius — the number every level-of-detail test uses. */
  get hexPx(): number {
    return this.hexSize * this.zoom;
  }

  /** One screen pixel expressed in world units. Line widths multiply by this. */
  get unit(): number {
    return 1 / this.zoom;
  }

  get minZoom(): number {
    return MIN_HEX_PX / this.hexSize;
  }

  get maxZoom(): number {
    return MAX_HEX_PX / this.hexSize;
  }

  // -------------------------------------------------------------------------
  // Transforms
  // -------------------------------------------------------------------------

  worldToScreen(wx: number, wy: number): Point {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    };
  }

  screenToWorld(sx: number, sy: number): Point {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** World-space centre of a hex. */
  hexCentre(h: Hex | FracHex): Point {
    return toPixel(h, this.hexSize);
  }

  hexToScreen(h: Hex): Point {
    const p = toPixel(h, this.hexSize);
    return this.worldToScreen(p.x, p.y);
  }

  screenToHex(sx: number, sy: number): Hex {
    const w = this.screenToWorld(sx, sy);
    return round(fromPixel(w, this.hexSize));
  }

  /** Set the canvas transform so drawing happens in world units. */
  applyWorldTransform(ctx: CanvasRenderingContext2D): void {
    const s = this.zoom * this.dpr;
    ctx.setTransform(
      s,
      0,
      0,
      s,
      this.dpr * (this.width / 2 - this.x * this.zoom),
      this.dpr * (this.height / 2 - this.y * this.zoom),
    );
  }

  /** Set the canvas transform so drawing happens in CSS pixels. */
  applyScreenTransform(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /** Pan by a screen-pixel delta (drag semantics: content follows the pointer). */
  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clampCentre();
  }

  /** Zoom about a screen point, keeping the world point under it fixed. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.setZoom(this.zoom * factor);
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clampCentre();
  }

  setZoom(z: number): void {
    const lo = this.minZoom;
    const hi = this.maxZoom;
    this.zoom = z < lo ? lo : z > hi ? hi : z;
  }

  centreOnWorld(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.clampCentre();
  }

  centreOnHex(h: Hex): void {
    const p = toPixel(h, this.hexSize);
    this.centreOnWorld(p.x, p.y);
  }

  /** Frame a world-space rectangle with `padding` screen pixels of margin. */
  fitWorldRect(rect: WorldRect, padding = 48): void {
    const w = Math.max(1e-3, rect.x1 - rect.x0);
    const h = Math.max(1e-3, rect.y1 - rect.y0);
    const availW = Math.max(32, this.width - padding * 2);
    const availH = Math.max(32, this.height - padding * 2);
    this.setZoom(Math.min(availW / w, availH / h));
    this.centreOnWorld((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2);
  }

  /**
   * Keep the chart reachable. The centre may leave the disc by the smaller of
   * half a viewport or the disc radius, which lets a player nudge the edge of
   * the map into the middle of the screen without ever losing it entirely.
   */
  clampCentre(): void {
    const slackX = Math.min(this.width / (2 * this.zoom), this.panRadius);
    const slackY = Math.min(this.height / (2 * this.zoom), this.panRadius);
    const rx = this.panRadius + slackX;
    const ry = this.panRadius + slackY;
    if (this.x < -rx) this.x = -rx;
    if (this.x > rx) this.x = rx;
    if (this.y < -ry) this.y = -ry;
    if (this.y > ry) this.y = ry;
  }

  // -------------------------------------------------------------------------
  // Culling
  // -------------------------------------------------------------------------

  /** The visible world rectangle, grown by `marginPx` screen pixels. */
  visibleRect(marginPx = 0): WorldRect {
    const halfW = this.width / (2 * this.zoom) + marginPx / this.zoom;
    const halfH = this.height / (2 * this.zoom) + marginPx / this.zoom;
    return { x0: this.x - halfW, y0: this.y - halfH, x1: this.x + halfW, y1: this.y + halfH };
  }

  /** Is a world-space disc at all visible? */
  isVisible(wx: number, wy: number, radius: number): boolean {
    const r = this.visibleRect();
    return wx + radius >= r.x0 && wx - radius <= r.x1 && wy + radius >= r.y0 && wy - radius <= r.y1;
  }

  /**
   * Visit every hex whose centre lies in the visible rectangle.
   *
   * Rows are indexed directly rather than scanned: for a pointy-top layout
   * `y = 1.5 * size * r` and `x = sqrt(3) * size * (q + r/2)`, so each row's `q`
   * span is a closed-form interval. Nothing off-screen is ever touched.
   */
  forEachVisibleHex(fn: (h: Hex) => void, marginHexes = 1): void {
    const rect = this.visibleRect();
    const rowH = 1.5 * this.hexSize;
    const colW = this.pitch;
    const rMin = Math.floor(rect.y0 / rowH) - marginHexes;
    const rMax = Math.ceil(rect.y1 / rowH) + marginHexes;
    for (let r = rMin; r <= rMax; r++) {
      const qMin = Math.floor(rect.x0 / colW - r / 2) - marginHexes;
      const qMax = Math.ceil(rect.x1 / colW - r / 2) + marginHexes;
      for (let q = qMin; q <= qMax; q++) fn({ q, r });
    }
  }
}
