/**
 * Ship counters, ordnance markers and the class glyphs that go on them.
 *
 * A counter is a small, high-contrast object that has to survive being one of
 * forty on a dark chart: chamfered like the cardboard it descends from, filled
 * with its owner's colour, and carrying only what a player needs at a glance —
 * class, number, fuel, damage. Everything else belongs in the side panel.
 *
 * `ships.ts` is used here purely as a data table (fuel capacity, the warship
 * flag); no rules logic is imported.
 */

import { SHIP_CLASSES, type ShipClass } from '../engine/ships.js';
import type { Ordnance, Ship } from '../engine/types.js';
import { type Frame, counterPath, diamondPath, glow, label, pulse, setFont } from './draw.js';
import { LOD, SIZES, THEME, clamp, darken, inkOn, lighten, rgba } from './theme.js';

/**
 * Damage is tracked as D1..D5; "cumulative damage of D6 or more destroys the
 * ship", so five pips is the whole track.
 */
const DAMAGE_PIPS = 5;
const FUEL_PIPS = 5;

export interface CounterOptions {
  readonly color: string;
  readonly selected?: boolean;
  readonly hovered?: boolean;
  /** Stack offset index when several counters share a hex. */
  readonly stackIndex?: number;
  readonly stackCount?: number;
}

/** Counter width in world units, clamped so it stays legible at any zoom. */
export const counterWidth = (f: Frame): number =>
  clamp(f.hexPx * 1.3, SIZES.counterMin, SIZES.counterMax) * f.u;

/** Where a counter sits: normally its hex centre, but landed ships hug the limb. */
export const counterOffset = (
  f: Frame,
  ship: Ship,
  dirCos: readonly number[],
  dirSin: readonly number[],
): { dx: number; dy: number } => {
  if (ship.location.kind === 'landed') {
    // Landed on a hexside — park the counter on that side of the world so the
    // printed disc stays visible, and so the side it must take off from is
    // unambiguous ("It must take off from the hex side where it landed").
    const d = ship.location.side.dir;
    return { dx: dirCos[d]! * f.pitch * 0.46, dy: dirSin[d]! * f.pitch * 0.46 };
  }
  return { dx: 0, dy: 0 };
};

// ---------------------------------------------------------------------------
// Class glyphs
// ---------------------------------------------------------------------------

/** A compact silhouette per ship class, drawn inside a box of half-size `s`. */
export const drawClassGlyph = (
  ctx: CanvasRenderingContext2D,
  cls: ShipClass,
  cx: number,
  cy: number,
  s: number,
  color: string,
  lineW: number,
): void => {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineJoin = 'round';
  ctx.beginPath();

  switch (cls) {
    case 'transport': {
      ctx.rect(cx - s * 0.85, cy - s * 0.55, s * 1.7, s * 1.1);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = rgba('#000000', 0.45);
      ctx.moveTo(cx - s * 0.3, cy - s * 0.55);
      ctx.lineTo(cx - s * 0.3, cy + s * 0.55);
      ctx.moveTo(cx + s * 0.3, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.3, cy + s * 0.55);
      ctx.stroke();
      break;
    }
    case 'packet': {
      ctx.rect(cx - s * 0.8, cy - s * 0.4, s * 1.6, s * 0.95);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.25, cy - s * 0.4);
      ctx.lineTo(cx, cy - s * 0.95);
      ctx.lineTo(cx + s * 0.25, cy - s * 0.4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'tanker': {
      ctx.ellipse(cx, cy, s * 0.95, s * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = rgba('#000000', 0.4);
      ctx.ellipse(cx - s * 0.32, cy, s * 0.2, s * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'liner': {
      ctx.ellipse(cx, cy, s * 1.0, s * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = rgba('#000000', 0.45);
      for (let i = -2; i <= 2; i++) {
        ctx.rect(cx + i * s * 0.3 - s * 0.06, cy - s * 0.08, s * 0.12, s * 0.16);
      }
      ctx.fill();
      break;
    }
    case 'corvette': {
      ctx.moveTo(cx + s * 0.9, cy);
      ctx.lineTo(cx - s * 0.6, cy - s * 0.6);
      ctx.lineTo(cx - s * 0.25, cy);
      ctx.lineTo(cx - s * 0.6, cy + s * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'corsair': {
      ctx.moveTo(cx + s * 1.0, cy);
      ctx.lineTo(cx - s * 0.35, cy - s * 0.75);
      ctx.lineTo(cx - s * 0.75, cy - s * 0.3);
      ctx.lineTo(cx - s * 0.4, cy);
      ctx.lineTo(cx - s * 0.75, cy + s * 0.3);
      ctx.lineTo(cx - s * 0.35, cy + s * 0.75);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'frigate': {
      ctx.moveTo(cx + s * 1.0, cy);
      ctx.lineTo(cx - s * 0.2, cy - s * 0.5);
      ctx.lineTo(cx - s * 0.85, cy - s * 0.85);
      ctx.lineTo(cx - s * 0.55, cy);
      ctx.lineTo(cx - s * 0.85, cy + s * 0.85);
      ctx.lineTo(cx - s * 0.2, cy + s * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'dreadnaught': {
      ctx.moveTo(cx + s * 1.05, cy);
      ctx.lineTo(cx - s * 0.1, cy - s * 0.62);
      ctx.lineTo(cx - s * 0.95, cy - s * 0.62);
      ctx.lineTo(cx - s * 0.6, cy);
      ctx.lineTo(cx - s * 0.95, cy + s * 0.62);
      ctx.lineTo(cx - s * 0.1, cy + s * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = rgba('#000000', 0.4);
      ctx.rect(cx - s * 0.35, cy - s * 0.5, s * 0.16, s * 1.0);
      ctx.rect(cx + s * 0.05, cy - s * 0.36, s * 0.16, s * 0.72);
      ctx.fill();
      break;
    }
    case 'torch': {
      // Two nested chevrons: the drive plume of an unlimited-fuel ship.
      ctx.moveTo(cx - s * 0.85, cy - s * 0.75);
      ctx.lineTo(cx + s * 0.35, cy);
      ctx.lineTo(cx - s * 0.85, cy + s * 0.75);
      ctx.lineTo(cx - s * 0.5, cy);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.1, cy - s * 0.62);
      ctx.lineTo(cx + s * 0.95, cy);
      ctx.lineTo(cx - s * 0.1, cy + s * 0.62);
      ctx.lineTo(cx + s * 0.15, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'orbitalBase': {
      ctx.arc(cx, cy, s * 0.85, 0, Math.PI * 2);
      ctx.lineWidth = lineW * 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.5);
      ctx.lineTo(cx + s * 0.45, cy + s * 0.38);
      ctx.lineTo(cx - s * 0.45, cy + s * 0.38);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'robotGuards': {
      // A bunker on a rock: flat-bottomed and domed, so it never reads as a hull
      // pointing anywhere. Robot guards do not move and cannot open fire.
      ctx.moveTo(cx - s * 0.8, cy + s * 0.55);
      ctx.lineTo(cx - s * 0.8, cy + s * 0.05);
      ctx.arc(cx, cy + s * 0.05, s * 0.8, Math.PI, 0);
      ctx.lineTo(cx + s * 0.8, cy + s * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = rgba('#000000', 0.45);
      ctx.moveTo(cx - s * 0.35, cy + s * 0.1);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.1);
      ctx.stroke();
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Ship counters
// ---------------------------------------------------------------------------

const hazardStripes = (
  f: Frame,
  cx: number,
  cy: number,
  w: number,
  h: number,
  alpha: number,
): void => {
  const { ctx } = f;
  ctx.save();
  ctx.beginPath();
  counterPath(ctx, cx, cy, w, h, h * 0.22);
  ctx.clip();
  ctx.strokeStyle = rgba('#ffb454', alpha);
  ctx.lineWidth = w * 0.055;
  const step = w * 0.17;
  for (let x = -w; x < w * 1.5; x += step) {
    ctx.beginPath();
    ctx.moveTo(cx + x, cy - h);
    ctx.lineTo(cx + x + h * 2, cy + h);
    ctx.stroke();
  }
  ctx.restore();
};

const pipRow = (
  f: Frame,
  x0: number,
  y: number,
  count: number,
  filled: number,
  pipW: number,
  gap: number,
  onColor: string,
  offColor: string,
): void => {
  const { ctx } = f;
  const pipH = pipW * 0.75;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i < filled ? onColor : offColor;
    ctx.fillRect(x0 + i * (pipW + gap), y, pipW, pipH);
  }
};

/**
 * Draw one ship counter centred at a world point.
 *
 * Destroyed ships are never passed here — they are simply gone from the chart.
 */
export const drawShipCounter = (
  f: Frame,
  ship: Ship,
  cx: number,
  cy: number,
  opts: CounterOptions,
): void => {
  const { ctx } = f;
  const color = opts.color;
  const disabled = ship.disabled > 0;

  // --- Simplified silhouette when zoomed out --------------------------------
  if (f.hexPx < LOD.counterFullMin) {
    const s = clamp(f.hexPx * 0.85, 5, 13) * f.u;
    glow(f, cx, cy, s * 2.6, color, 0.35, s * 0.3);
    ctx.beginPath();
    diamondPath(ctx, cx, cy, s, s * 0.85);
    ctx.fillStyle = disabled ? rgba(THEME.warn, 0.95) : color;
    ctx.fill();
    ctx.lineWidth = 0.9 * f.u;
    ctx.strokeStyle = rgba(THEME.counterEdge, 0.9);
    ctx.stroke();
    if (opts.selected) {
      ctx.strokeStyle = rgba(THEME.selection, 0.95);
      ctx.lineWidth = 1.6 * f.u;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  // --- Full counter ---------------------------------------------------------
  const w = counterWidth(f);
  const h = w * 0.68;
  const chamfer = h * 0.22;
  const ink = inkOn(color);

  if (opts.selected) glow(f, cx, cy, w * 1.5, THEME.selection, 0.3, w * 0.35);

  // Drop shadow, so counters sit above the plate rather than in it.
  ctx.beginPath();
  counterPath(ctx, cx + w * 0.045, cy + h * 0.09, w, h, chamfer);
  ctx.fillStyle = rgba('#000000', 0.45);
  ctx.fill();

  // Body.
  const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
  g.addColorStop(0, lighten(color, 0.24));
  g.addColorStop(0.52, color);
  g.addColorStop(1, darken(color, 0.42));
  ctx.beginPath();
  counterPath(ctx, cx, cy, w, h, chamfer);
  ctx.fillStyle = g;
  ctx.fill();

  if (disabled) hazardStripes(f, cx, cy, w, h, 0.22);

  // Edge. Disabled ships get a hazard rim; selection overrides it.
  ctx.lineWidth = Math.max(0.9 * f.u, w * 0.028);
  ctx.strokeStyle = rgba(darken(color, 0.72), 0.95);
  ctx.stroke();

  if (ship.capturedBy) {
    // A prize crew: an inner border in the captor's colour would need their
    // palette, so mark it with a dashed inner rule instead.
    ctx.save();
    ctx.setLineDash([w * 0.06, w * 0.05]);
    ctx.lineWidth = Math.max(0.8 * f.u, w * 0.022);
    ctx.strokeStyle = rgba('#ffffff', 0.7);
    ctx.beginPath();
    counterPath(ctx, cx, cy, w * 0.86, h * 0.78, chamfer * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  if (opts.selected) {
    ctx.lineWidth = Math.max(1.4 * f.u, w * 0.045);
    ctx.strokeStyle = rgba(THEME.selection, 0.85 + 0.15 * pulse(f, 1600));
    ctx.beginPath();
    counterPath(ctx, cx, cy, w * 1.14, h * 1.2, chamfer);
    ctx.stroke();
  } else if (opts.hovered) {
    ctx.lineWidth = Math.max(1 * f.u, w * 0.03);
    ctx.strokeStyle = rgba(THEME.hover, 0.7);
    ctx.beginPath();
    counterPath(ctx, cx, cy, w * 1.1, h * 1.16, chamfer);
    ctx.stroke();
  }

  if (disabled) {
    ctx.lineWidth = Math.max(1 * f.u, w * 0.032);
    ctx.strokeStyle = rgba(THEME.warn, 0.85);
    ctx.beginPath();
    counterPath(ctx, cx, cy, w, h, chamfer);
    ctx.stroke();
  }

  // Class glyph, left third.
  drawClassGlyph(
    ctx,
    ship.shipClass,
    cx - w * 0.27,
    cy - h * 0.06,
    h * 0.3,
    rgba(ink, 0.92),
    Math.max(0.6 * f.u, w * 0.018),
  );

  if (f.hexPx >= LOD.counterTextMin) {
    // Counter number, right side.
    setFont(f, Math.max(7, (w / f.u) * 0.3), '700');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(ink, 0.95);
    ctx.fillText(String(ship.number), cx + w * 0.2, cy - h * 0.08);

    // Fuel pips along the bottom. A torch has unlimited fuel; show it full.
    const cap = SHIP_CLASSES[ship.shipClass].fuelCapacity;
    const fuelFilled = !isFinite(cap)
      ? FUEL_PIPS
      : cap <= 0
        ? 0
        : Math.ceil((clamp(ship.fuel, 0, cap) / cap) * FUEL_PIPS);
    const pipW = w * 0.088;
    const gap = w * 0.028;
    const rowW = FUEL_PIPS * pipW + (FUEL_PIPS - 1) * gap;
    pipRow(
      f,
      cx - rowW / 2,
      cy + h * 0.26,
      FUEL_PIPS,
      fuelFilled,
      pipW,
      gap,
      rgba(isFinite(cap) ? THEME.accent : THEME.safe, 0.95),
      rgba(THEME.counterEdge, 0.45),
    );

    // Damage pips along the top, filling from the right.
    if (ship.disabled > 0) {
      const dmg = Math.min(DAMAGE_PIPS, ship.disabled);
      pipRow(
        f,
        cx - rowW / 2,
        cy - h * 0.42,
        DAMAGE_PIPS,
        dmg,
        pipW,
        gap,
        rgba(THEME.danger, 0.95),
        rgba(THEME.counterEdge, 0.35),
      );
    }
  }

  // Heroic: "+1 to the die roll for gun combat when attacking", permanently.
  if (ship.heroic) {
    const sx = cx - w * 0.42;
    const sy = cy - h * 0.34;
    const r = h * 0.13;
    ctx.fillStyle = rgba('#ffd76a', 0.95);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.45;
      const x = sx + Math.cos(a) * rr;
      const y = sy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Surrendered: "Surrendered ships may not be captured" — but they may be
  // looted, so the state has to be visible.
  if (ship.surrenderedTo.length > 0) {
    const fx = cx + w * 0.4;
    const fy = cy + h * 0.3;
    ctx.fillStyle = rgba('#ffffff', 0.9);
    ctx.fillRect(fx - h * 0.11, fy - h * 0.14, h * 0.22, h * 0.16);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
};

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

const ORDNANCE_LETTER: Readonly<Record<Ordnance['kind'], string>> = {
  mine: 'M',
  torpedo: 'T',
  nuke: 'N',
};

const ORDNANCE_COLOR: Readonly<Record<Ordnance['kind'], string>> = {
  mine: THEME.mine,
  torpedo: THEME.torpedo,
  nuke: THEME.nuke,
};

/**
 * Ordnance markers.
 *
 * "Mark torpedoes with T, mines with M, and nukes with N." All three live five
 * turns, so the marker dims as the fuse burns down.
 */
export const drawOrdnanceMarker = (
  f: Frame,
  o: Ordnance,
  cx: number,
  cy: number,
  ownerColor: string,
): void => {
  const { ctx } = f;
  const color = ORDNANCE_COLOR[o.kind];
  const s = clamp(f.hexPx * 0.62, SIZES.ordnanceMin, SIZES.ordnanceMax) * f.u;
  // Five turns of life; fade toward the end so an expiring mine reads as such.
  const life = clamp(o.turnsRemaining / 5, 0.15, 1);
  const beat = pulse(f, o.kind === 'nuke' ? 900 : 1800);

  glow(f, cx, cy, s * (2.4 + beat * 0.5), color, 0.3 * life + 0.12);

  ctx.beginPath();
  diamondPath(ctx, cx, cy, s, s);
  ctx.fillStyle = rgba(darken(color, 0.55), 0.92);
  ctx.fill();
  ctx.lineWidth = Math.max(0.9 * f.u, s * 0.12);
  ctx.strokeStyle = rgba(lighten(color, 0.25), 0.6 + 0.4 * life);
  ctx.stroke();

  // A hairline in the owner's colour: whose mine field this is matters.
  ctx.lineWidth = Math.max(0.6 * f.u, s * 0.07);
  ctx.strokeStyle = rgba(ownerColor, 0.85);
  ctx.beginPath();
  diamondPath(ctx, cx, cy, s * 0.62, s * 0.62);
  ctx.stroke();

  if (f.hexPx >= LOD.counterTextMin * 0.8) {
    setFont(f, Math.max(7, (s / f.u) * 0.95), '800');
    label(f, ORDNANCE_LETTER[o.kind], cx, cy + s * 0.03, rgba('#ffffff', 0.95), 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
};

/** Fan several counters sharing one hex so every one of them stays readable. */
export const stackOffset = (f: Frame, index: number, count: number): { dx: number; dy: number } => {
  if (count <= 1) return { dx: 0, dy: 0 };
  const step = counterWidth(f) * 0.2;
  const centred = index - (count - 1) / 2;
  return { dx: centred * step * 0.9, dy: centred * step };
};
