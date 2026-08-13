/**
 * A deterministic, cached, parallax starfield.
 *
 * Stars live in *layer space*: a fixed lattice of cells that is offset by a
 * fraction of the camera's pan. Distant layers barely move, near layers slide,
 * and the chart gains depth without anything ever being stored per-star. Each
 * cell's contents are a pure function of its coordinates (see `noise.ts`), so
 * the sky is identical on every client and stable across pans — cells are
 * generated once and memoised.
 */

import type { Camera } from './camera.js';
import { Stream, hash2 } from './noise.js';
import { rgba } from './theme.js';

const CELL = 260;

interface LayerDef {
  /** 0 = infinitely distant (fixed), 1 = locked to the world. */
  readonly parallax: number;
  readonly count: number;
  readonly minR: number;
  readonly maxR: number;
  readonly alpha: number;
  readonly salt: number;
}

const LAYERS: readonly LayerDef[] = [
  { parallax: 0.06, count: 26, minR: 0.35, maxR: 0.85, alpha: 0.55, salt: 101 },
  { parallax: 0.16, count: 13, minR: 0.55, maxR: 1.25, alpha: 0.75, salt: 202 },
  { parallax: 0.34, count: 5, minR: 0.8, maxR: 1.9, alpha: 0.95, salt: 303 },
];

/** Star colours: mostly cold white, a few warm and a few blue giants. */
const STAR_COLORS: readonly string[] = [
  '#ffffff',
  '#e7f0ff',
  '#cfe0ff',
  '#b9d2ff',
  '#ffe8c9',
  '#ffd2a8',
];

const ALPHA_BUCKETS = 5;

/** Fixed soft clouds in the deepest layer, so the void is not perfectly empty. */
const NEBULAE: readonly {
  x: number;
  y: number;
  r: number;
  color: string;
  alpha: number;
}[] = [
  { x: -1400, y: -900, r: 1500, color: '#2a3f7a', alpha: 0.1 },
  { x: 1750, y: 620, r: 1750, color: '#4a2a63', alpha: 0.085 },
  { x: 250, y: 1600, r: 1300, color: '#1d4f6b', alpha: 0.075 },
];

/** x, y, radius, alpha, colour index, twinkle phase. */
const STRIDE = 6;

export class Starfield {
  private readonly cache = new Map<string, Float32Array>();
  /** Precomputed fill styles, indexed [layer][colour][alpha bucket]. */
  private readonly styles: string[][][];
  /** Reused scratch buckets so a frame allocates nothing. */
  private readonly groups: number[][] = Array.from(
    { length: STAR_COLORS.length * ALPHA_BUCKETS },
    () => [],
  );

  constructor() {
    this.styles = LAYERS.map((layer) =>
      STAR_COLORS.map((c) => {
        const out: string[] = [];
        for (let b = 0; b < ALPHA_BUCKETS; b++) {
          out.push(rgba(c, (layer.alpha * (b + 1)) / ALPHA_BUCKETS));
        }
        return out;
      }),
    );
  }

  private cell(layerIndex: number, i: number, j: number): Float32Array {
    const key = `${layerIndex}:${i}:${j}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const layer = LAYERS[layerIndex]!;
    const rnd = new Stream(hash2(i, j, layer.salt));
    const n = Math.max(1, layer.count + rnd.int(-2, 2));
    const out = new Float32Array(n * STRIDE);
    for (let s = 0; s < n; s++) {
      const o = s * STRIDE;
      out[o] = (i + rnd.next()) * CELL;
      out[o + 1] = (j + rnd.next()) * CELL;
      // Radius biased small: cube the roll so bright stars stay rare.
      const t = rnd.next();
      out[o + 2] = layer.minR + (layer.maxR - layer.minR) * t * t * t;
      out[o + 3] = 0.35 + rnd.next() * 0.65;
      out[o + 4] = rnd.int(0, STAR_COLORS.length - 1);
      out[o + 5] = rnd.next() * Math.PI * 2;
    }

    // Bounded memo: a full sweep of the chart touches a few hundred cells.
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }

  /**
   * Draw the sky. Expects a screen-space (CSS pixel) transform to be active;
   * `time` is used only for a very slight twinkle.
   */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, time: number): void {
    const { width, height } = cam;

    // Deep clouds first, riding the slowest layer.
    const slow = LAYERS[0]!.parallax;
    const nx = -cam.x * cam.zoom * slow;
    const ny = -cam.y * cam.zoom * slow;
    for (const neb of NEBULAE) {
      const x = neb.x + nx;
      const y = neb.y + ny;
      if (x + neb.r < 0 || x - neb.r > width || y + neb.r < 0 || y - neb.r > height) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, neb.r);
      g.addColorStop(0, rgba(neb.color, neb.alpha));
      g.addColorStop(0.55, rgba(neb.color, neb.alpha * 0.35));
      g.addColorStop(1, rgba(neb.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - neb.r, y - neb.r, neb.r * 2, neb.r * 2);
    }

    // Brightness lifts slightly as you zoom in, as though the optics opened up.
    const zoomGain = 0.85 + 0.35 * Math.min(1, cam.zoom);

    for (let li = 0; li < LAYERS.length; li++) {
      const layer = LAYERS[li]!;
      const ox = -cam.x * cam.zoom * layer.parallax;
      const oy = -cam.y * cam.zoom * layer.parallax;
      const i0 = Math.floor(-ox / CELL);
      const i1 = Math.floor((width - ox) / CELL);
      const j0 = Math.floor(-oy / CELL);
      const j1 = Math.floor((height - oy) / CELL);
      const styles = this.styles[li]!;

      // One pass over the visible stars, bucketed by (colour, alpha) so the
      // draw phase changes fillStyle a few dozen times instead of per star.
      const groups = this.groups;
      for (const g of groups) g.length = 0;
      const glare: number[] = [];

      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const stars = this.cell(li, i, j);
          for (let o = 0; o < stars.length; o += STRIDE) {
            const x = stars[o]! + ox;
            const y = stars[o + 1]! + oy;
            if (x < -4 || x > width + 4 || y < -4 || y > height + 4) continue;
            const twinkle = 0.86 + 0.14 * Math.sin(time * 0.0011 + stars[o + 5]!);
            const a = stars[o + 3]! * twinkle * zoomGain;
            const bucket = Math.min(ALPHA_BUCKETS - 1, Math.max(0, Math.floor(a * ALPHA_BUCKETS)));
            const ci = stars[o + 4]!;
            const r = stars[o + 2]!;
            groups[ci * ALPHA_BUCKETS + bucket]!.push(x, y, r);
            if (r > 1.45 && glare.length < 60) glare.push(x, y, r, ci);
          }
        }
      }

      for (let ci = 0; ci < STAR_COLORS.length; ci++) {
        for (let bucket = 0; bucket < ALPHA_BUCKETS; bucket++) {
          const list = groups[ci * ALPHA_BUCKETS + bucket]!;
          if (list.length === 0) continue;
          ctx.fillStyle = styles[ci]![bucket]!;
          for (let k = 0; k < list.length; k += 3) {
            const x = list[k]!;
            const y = list[k + 1]!;
            const r = list[k + 2]!;
            if (r < 0.9) {
              // fillRect is markedly cheaper than arc() for pinpricks.
              ctx.fillRect(x - r, y - r, r * 2, r * 2);
            } else {
              ctx.beginPath();
              ctx.arc(x, y, r, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // A few diffraction spikes on the brightest stars of the layer.
      for (let g = 0; g < glare.length; g += 4) {
        const x = glare[g]!;
        const y = glare[g + 1]!;
        const r = glare[g + 2]!;
        const ci = glare[g + 3]!;
        const len = r * 5;
        ctx.strokeStyle = rgba(STAR_COLORS[ci]!, 0.16 * layer.alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - len, y);
        ctx.lineTo(x + len, y);
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y + len);
        ctx.stroke();
      }
    }
  }
}
