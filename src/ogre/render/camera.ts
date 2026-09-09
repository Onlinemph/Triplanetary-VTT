/**
 * The camera: pan, zoom, and the two coordinate conversions the shell needs.
 *
 * It holds no game state. `screenToHex` and `hexToScreen` are exact inverses,
 * which is what lets a DOM overlay be pinned to a hex and a click be resolved
 * to one.
 */

import { type FracHex, type Hex, type Point, fromPixel, round, toPixel } from '../engine/hex.js';
import { type GameMap, allHexes } from '../engine/map.js';
import { clamp } from './theme.js';

export interface Inset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

export class Camera {
  /** Hex radius in CSS pixels. */
  private scale = 26;
  /** World point at the centre of the *unobscured* viewport. */
  private center: Point = { x: 0, y: 0 };
  private width = 800;
  private height = 600;
  private dpr = 1;
  private inset: Inset = NO_INSET;

  readonly minScale = 6;
  readonly maxScale = 90;

  get hexSize(): number {
    return this.scale;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  setInset(inset: Inset): void {
    this.inset = inset;
  }

  /** Centre of the area no panel is covering, in client pixels. */
  private viewCenter(): Point {
    return {
      x: (this.inset.left + (this.width - this.inset.right)) / 2,
      y: (this.inset.top + (this.height - this.inset.bottom)) / 2,
    };
  }

  /** Apply the camera to a context whose transform has been reset. */
  applyTo(ctx: CanvasRenderingContext2D): void {
    const vc = this.viewCenter();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(vc.x, vc.y);
    ctx.translate(-this.center.x, -this.center.y);
  }

  worldToScreen(p: Point): Point {
    const vc = this.viewCenter();
    return { x: p.x - this.center.x + vc.x, y: p.y - this.center.y + vc.y };
  }

  screenToWorld(p: Point): Point {
    const vc = this.viewCenter();
    return { x: p.x - vc.x + this.center.x, y: p.y - vc.y + this.center.y };
  }

  hexToScreen(h: Hex | FracHex): Point {
    return this.worldToScreen(toPixel(h, this.scale));
  }

  screenToHex(x: number, y: number): Hex {
    return round(fromPixel(this.screenToWorld({ x, y }), this.scale));
  }

  panBy(dx: number, dy: number): void {
    this.center = { x: this.center.x - dx, y: this.center.y - dy };
  }

  /** `factor` > 1 zooms in, anchored so the point under the cursor stays put. */
  zoomAt(x: number, y: number, factor: number): void {
    const before = this.screenToWorld({ x, y });
    const beforeHex = fromPixel(before, this.scale);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = toPixel(beforeHex, this.scale);
    const vc = this.viewCenter();
    this.center = { x: after.x - (x - vc.x), y: after.y - (y - vc.y) };
  }

  focusOn(h: Hex): void {
    this.center = toPixel(h, this.scale);
  }

  /** Frame a set of hexes at a workable zoom. */
  frame(hexes: readonly Hex[], opts: { padding?: number; maxHexPx?: number } = {}): void {
    if (hexes.length === 0) return;
    const padding = opts.padding ?? 40;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const h of hexes) {
      const p = toPixel(h, 1);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // The extremes are hex centres; add a hex of margin all round.
    const spanX = maxX - minX + 2;
    const spanY = maxY - minY + 2;

    const usableW = Math.max(80, this.width - this.inset.left - this.inset.right - padding * 2);
    const usableH = Math.max(80, this.height - this.inset.top - this.inset.bottom - padding * 2);

    this.scale = clamp(
      Math.min(usableW / spanX, usableH / spanY),
      this.minScale,
      opts.maxHexPx ?? this.maxScale,
    );
    this.center = {
      x: ((minX + maxX) / 2) * this.scale,
      y: ((minY + maxY) / 2) * this.scale,
    };
  }

  fitMap(map: GameMap): void {
    this.frame(allHexes(map), { maxHexPx: 44 });
  }
}
