/**
 * Course arrows, drawn to the rulebook's Standard Astrogation Conventions.
 *
 * Verbatim from p. 3:
 *
 *  1. "Vectors, or 'course arrows,' are drawn as straight lines, beginning in
 *     the center of a hex and ending in the center of a hex. An arrowhead is
 *     drawn at the head of the line to indicate direction of travel. Actual
 *     courses are solid lines; predicted courses drawn for computation may be
 *     shown by a dot at the predicted destination."
 *  2. "When fuel is spent for acceleration, this is indicated by a small circle
 *     drawn at the base of the arrow. For double acceleration ... a double
 *     circle is drawn."
 *  3. "Each arrow is numbered consecutively from day 1 as a time and turn
 *     record. When a ship becomes stationary in space, draw a square in the hex,
 *     with the number of the turn in the square."
 *  4. "When mines, nukes, or torpedoes are launched, their vector arrows are
 *     drawn on the map. Mark torpedoes with T, mines with M, and nukes with N."
 *
 * The legend of Figure 6 adds the fourth convention this module implements:
 * "A dashed line is a predicted course not traveled."
 */

import { type Hex, eq, toPixel } from '../engine/hex.js';
import type { CourseLeg } from '../engine/types.js';
import { type Frame, arrowHeadPath, label, setFont } from './draw.js';
import { LOD, THEME, clamp, lighten, rgba } from './theme.js';

export interface CourseStyle {
  readonly color: string;
  readonly alpha: number;
  /** Predicted, untravelled courses. */
  readonly dashed: boolean;
  /** Stroke width in screen pixels. */
  readonly width: number;
  readonly showNumber: boolean;
  /** Draw the acceleration circle / double circle at the tail. */
  readonly showAccel: boolean;
}

const arrowGeometry = (f: Frame, width: number) => ({
  headLen: clamp(f.pitch * 0.3, 7 * f.u, 18 * f.u),
  headHalf: clamp(f.pitch * 0.13, 3.5 * f.u, 8 * f.u),
  lw: Math.max(width * f.u, f.pitch * 0.012),
});

/**
 * The acceleration marker at the base of an arrow: one circle for a point of
 * fuel, two for the overload manoeuvre.
 */
export const drawAccelMark = (
  f: Frame,
  x: number,
  y: number,
  accel: 0 | 1 | 2,
  color: string,
  alpha: number,
): void => {
  if (accel === 0) return;
  const { ctx } = f;
  const r = clamp(f.pitch * 0.11, 3 * f.u, 7 * f.u);
  ctx.lineWidth = Math.max(1 * f.u, f.pitch * 0.014);
  ctx.strokeStyle = rgba(color, alpha);
  ctx.fillStyle = rgba('#000000', alpha * 0.55);

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (accel === 2) {
    // "For double acceleration ... a double circle is drawn."
    ctx.beginPath();
    ctx.arc(x, y, r * 1.62, 0, Math.PI * 2);
    ctx.stroke();
  }
};

/** "When a ship becomes stationary in space, draw a square in the hex." */
export const drawStationaryMark = (
  f: Frame,
  h: Hex,
  turn: number,
  color: string,
  alpha: number,
  showNumber: boolean,
): void => {
  const { ctx } = f;
  const c = toPixel(h, f.size);
  const s = clamp(f.pitch * 0.26, 6 * f.u, 16 * f.u);
  ctx.lineWidth = Math.max(1.1 * f.u, f.pitch * 0.016);
  ctx.strokeStyle = rgba(color, alpha);
  ctx.fillStyle = rgba('#000000', alpha * 0.5);
  ctx.beginPath();
  ctx.rect(c.x - s, c.y - s, s * 2, s * 2);
  ctx.fill();
  ctx.stroke();
  if (showNumber && f.hexPx >= LOD.courseTextMin) {
    setFont(f, clamp((s / f.u) * 0.95, 7, 13), '700');
    label(f, String(turn), c.x, c.y, rgba(lighten(color, 0.4), alpha), 0.6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
};

/**
 * One course arrow, centre of hex to centre of hex.
 *
 * A zero-length leg is a stationary turn and gets the square instead.
 */
export const drawCourseArrow = (
  f: Frame,
  from: Hex,
  to: Hex,
  turn: number,
  accel: 0 | 1 | 2,
  style: CourseStyle,
  terminal = false,
): void => {
  const { ctx } = f;
  if (eq(from, to)) {
    drawStationaryMark(f, from, turn, style.color, style.alpha, style.showNumber);
    return;
  }

  const a = toPixel(from, f.size);
  const b = toPixel(to, f.size);
  if (
    !f.cam.isVisible(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.hypot(b.x - a.x, b.y - a.y) / 2 + f.pitch,
    )
  )
    return;

  const { headLen, headHalf, lw } = arrowGeometry(f, style.width);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = rgba(style.color, style.alpha);
  if (style.dashed) ctx.setLineDash([5 * f.u, 4 * f.u]);
  else ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x - ux * headLen * 0.72, b.y - uy * headLen * 0.72);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead.
  ctx.beginPath();
  arrowHeadPath(ctx, b.x, b.y, angle, headLen, headHalf);
  if (style.dashed) {
    // A predicted head is outlined, not filled — it has not been flown yet.
    ctx.lineWidth = lw * 0.9;
    ctx.stroke();
  } else {
    ctx.fillStyle = rgba(style.color, style.alpha);
    ctx.fill();
  }

  if (style.showAccel) drawAccelMark(f, a.x, a.y, accel, style.color, style.alpha);

  // Turn number, set just off the arrow's midpoint.
  if (style.showNumber && f.hexPx >= LOD.courseTextMin) {
    const mx = (a.x + b.x) / 2 - uy * 9 * f.u;
    const my = (a.y + b.y) / 2 + ux * 9 * f.u;
    setFont(f, 10, '700');
    label(f, String(turn), mx, my, rgba(lighten(style.color, 0.45), style.alpha), 0.7);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // A leg that ended in a crash or an exit gets a burst at its head.
  if (terminal) {
    ctx.strokeStyle = rgba(THEME.danger, style.alpha);
    ctx.lineWidth = lw * 1.2;
    const r = clamp(f.pitch * 0.2, 5 * f.u, 12 * f.u);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      ctx.moveTo(b.x + Math.cos(t) * r * 0.35, b.y + Math.sin(t) * r * 0.35);
      ctx.lineTo(b.x + Math.cos(t) * r, b.y + Math.sin(t) * r);
    }
    ctx.stroke();
  }
};

/**
 * A whole trail. Older legs fade; the most recent leg is always full strength
 * because it *is* the ship's current velocity vector, and the player reads the
 * next turn's endpoint off it.
 */
export const drawTrail = (
  f: Frame,
  legs: readonly CourseLeg[],
  currentTurn: number,
  color: string,
  showHistory: boolean,
  width = 1.8,
): void => {
  if (legs.length === 0) return;
  // Age is measured against this turn, or against the last leg flown if the
  // ship has not moved yet — either way the current vector stays at full
  // strength, because the player reads next turn's endpoint off it.
  const newest = Math.max(legs[legs.length - 1]!.turn, currentTurn - 1);

  for (const leg of legs) {
    const age = newest - leg.turn;
    if (!showHistory && age > 0) continue;
    const alpha = age === 0 ? 0.92 : Math.max(0.1, 0.55 * Math.pow(0.68, age));
    drawCourseArrow(
      f,
      leg.from,
      leg.to,
      leg.turn,
      leg.accel,
      {
        color,
        alpha,
        dashed: false,
        width: age === 0 ? width : width * 0.8,
        showNumber: age <= 1 || showHistory,
        showAccel: true,
      },
      leg.terminal === true,
    );
  }
};

/**
 * The predicted course: dashed, with "a dot at the predicted destination".
 */
export const drawPredictedCourse = (
  f: Frame,
  from: Hex,
  to: Hex,
  accel: 0 | 1 | 2,
  color: string,
  turn: number,
): void => {
  drawCourseArrow(f, from, to, turn, accel, {
    color,
    alpha: 0.85,
    dashed: true,
    width: 1.6,
    showNumber: false,
    showAccel: true,
  });

  const { ctx } = f;
  const b = toPixel(to, f.size);
  const r = clamp(f.pitch * 0.09, 2.5 * f.u, 6 * f.u);
  ctx.fillStyle = rgba(color, 0.9);
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fill();
};
