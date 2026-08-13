/**
 * Canvas primitives shared by every layer, plus the per-frame context object.
 *
 * All of these draw in **world units**. The camera transform is already on the
 * context, so a "1 px" hairline is written `f.u` (one screen pixel expressed in
 * world units) and a "12 px" label is `12 * f.u`. That is the whole trick that
 * keeps strokes and type at a constant apparent size through the zoom range.
 */

import { DIRECTIONS, toPixel } from '../engine/hex.js';
import type { Camera } from './camera.js';
import { THEME, rgba } from './theme.js';

export interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly cam: Camera;
  /** Screen pixels per hex radius; the level-of-detail dial. */
  readonly hexPx: number;
  /** One screen pixel in world units. Multiply screen sizes by this. */
  readonly u: number;
  /** Hex radius in world units. */
  readonly size: number;
  /** World-space distance between adjacent hex centres. */
  readonly pitch: number;
  /** Milliseconds, for pulses. Purely cosmetic — never feeds the engine. */
  readonly time: number;
}

// ---------------------------------------------------------------------------
// Geometry tables
// ---------------------------------------------------------------------------

/** Unit corner offsets of a pointy-top hex, matching `hex.corners`. */
export const HEX_COS: readonly number[] = [0, 1, 2, 3, 4, 5].map((i) =>
  Math.cos((Math.PI / 180) * (60 * i - 30)),
);
export const HEX_SIN: readonly number[] = [0, 1, 2, 3, 4, 5].map((i) =>
  Math.sin((Math.PI / 180) * (60 * i - 30)),
);

/**
 * Screen-space angle of each of the six hex directions, derived from the same
 * projection the engine uses so the two can never drift apart.
 */
export const DIR_ANGLE: readonly number[] = DIRECTIONS.map((d) => {
  const p = toPixel(d, 1);
  return Math.atan2(p.y, p.x);
});

export const DIR_COS: readonly number[] = DIR_ANGLE.map(Math.cos);
export const DIR_SIN: readonly number[] = DIR_ANGLE.map(Math.sin);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const hexPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  cx: number,
  cy: number,
  size: number,
): void => {
  ctx.moveTo(cx + size * HEX_COS[0]!, cy + size * HEX_SIN[0]!);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + size * HEX_COS[i]!, cy + size * HEX_SIN[i]!);
  ctx.closePath();
};

/** A chamfered rectangle — the silhouette of a cardboard wargame counter. */
export const counterPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  chamfer: number,
): void => {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const c = Math.min(chamfer, w / 2, h / 2);
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
};

export const diamondPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void => {
  ctx.moveTo(cx, cy - ry);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.closePath();
};

/**
 * A tapered arrow: broad at the tail, narrowing into a barbed head.
 *
 * Used for gravity, which the rulebook draws as arrows in the hexes adjacent to
 * a body — solid for full gravity, "hollow arrows" for weak gravity (Luna, Io).
 * Building one path lets the caller choose fill or stroke and get both.
 */
export const taperedArrowPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tailW: number,
  headW: number,
  headLen: number,
): void => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const hl = Math.min(headLen, len * 0.85);
  const nx = x1 - ux * hl;
  const ny = y1 - uy * hl;
  const neckW = tailW * 0.34;

  ctx.moveTo(x0 + px * tailW * 0.5, y0 + py * tailW * 0.5);
  ctx.lineTo(nx + px * neckW * 0.5, ny + py * neckW * 0.5);
  ctx.lineTo(nx + px * headW * 0.5, ny + py * headW * 0.5);
  ctx.lineTo(x1, y1);
  ctx.lineTo(nx - px * headW * 0.5, ny - py * headW * 0.5);
  ctx.lineTo(nx - px * neckW * 0.5, ny - py * neckW * 0.5);
  ctx.lineTo(x0 - px * tailW * 0.5, y0 - py * tailW * 0.5);
  ctx.closePath();
};

/** A plain filled arrowhead, for course arrows. */
export const arrowHeadPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  halfWidth: number,
): void => {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const px = -uy;
  const py = ux;
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * len + px * halfWidth, y - uy * len + py * halfWidth);
  ctx.lineTo(x - ux * len * 0.72, y - uy * len * 0.72);
  ctx.lineTo(x - ux * len - px * halfWidth, y - uy * len - py * halfWidth);
  ctx.closePath();
};

/** An irregular closed blob — asteroids, rocky worldlets. */
export const blobPath = (
  ctx: CanvasRenderingContext2D | Path2D,
  cx: number,
  cy: number,
  radii: readonly number[],
  rotation = 0,
): void => {
  const n = radii.length;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const a = rotation + (i / n) * Math.PI * 2;
    const r = radii[i]!;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
};

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** A soft radial bloom centred on a point. */
export const glow = (
  f: Frame,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number,
  inner = 0,
): void => {
  if (radius <= 0 || alpha <= 0) return;
  const g = f.ctx.createRadialGradient(x, y, Math.max(0, inner), x, y, radius);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.45, rgba(color, alpha * 0.34));
  g.addColorStop(1, rgba(color, 0));
  f.ctx.fillStyle = g;
  f.ctx.beginPath();
  f.ctx.arc(x, y, radius, 0, Math.PI * 2);
  f.ctx.fill();
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const setFont = (f: Frame, px: number, weight = '600', family = THEME.font): void => {
  f.ctx.font = `${weight} ${(px * f.u).toFixed(3)}px ${family}`;
};

/** Centred label with an optional dark halo so it survives busy backgrounds. */
export const label = (
  f: Frame,
  text: string,
  x: number,
  y: number,
  color: string,
  haloAlpha = 0.75,
): void => {
  const { ctx } = f;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (haloAlpha > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * f.u;
    ctx.strokeStyle = rgba('#000000', haloAlpha);
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** A smooth 0..1 sine pulse with the given period in milliseconds. */
export const pulse = (f: Frame, periodMs: number, phase = 0): number =>
  0.5 + 0.5 * Math.sin((f.time / periodMs + phase) * Math.PI * 2);
