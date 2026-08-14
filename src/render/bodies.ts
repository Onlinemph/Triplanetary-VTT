/**
 * Astral bodies, their orbital rings, and the base glyphs printed on their
 * hexsides.
 *
 * Every body is drawn from its own data in `mapdata.ts` — position, printed
 * disc radius, colour and glow — and lit from Sol. That single rule (the light
 * comes from the middle of the chart) is what makes the plate read as a solar
 * system rather than a set of coloured dots: terminators all face outward, rim
 * lights all face in.
 *
 * Disc radii are in unit-pitch plane units, exactly as the engine's crash test
 * uses them, so what you see is what `map.crashedInto` tests against: "if a
 * ship's course vector intersects the printed outline of an astral body, it has
 * crashed."
 */

import { type Hex, toPixel } from '../engine/hex.js';
import type { GameMap } from '../engine/map.js';
import { type AstralBody, solarDistance } from '../engine/mapdata.js';
import type { BaseState, GameState, PlayerId } from '../engine/types.js';
import { type Frame, DIR_COS, DIR_SIN, blobPath, glow, label, setFont } from './draw.js';
import { Stream, hash2, noise2 } from './noise.js';
import { LOD, THEME, darken, lighten, mix, rgba, smoothstep } from './theme.js';

/** World-space radius of a body's printed disc. */
export const discRadiusOf = (f: Frame, body: AstralBody): number => body.discRadius * f.pitch;

// ---------------------------------------------------------------------------
// Orbital rings
// ---------------------------------------------------------------------------

/**
 * Thin arcs at each body's orbital distance.
 *
 * The chart's geography is polar — everything is "how far out are you" — and
 * the rings make that legible at a glance without adding contrast anywhere near
 * the play surface. Planets and the major asteroids ring Sol at their solar
 * distance; moons ring their primary instead, which is both truer and far less
 * noisy than four near-identical circles round the Sun for the Jovian system.
 */
export const drawOrbitRings = (f: Frame, map: GameMap): void => {
  const { ctx } = f;
  ctx.lineCap = 'butt';

  for (const body of map.bodies) {
    if (body.kind === 'star') continue;

    const centre = toPixel(body.hex, f.size);
    let ox = 0;
    let oy = 0;
    let r: number;

    if (body.kind === 'moon') {
      const primary = nearestPlanet(map, body);
      if (!primary) continue;
      const p = toPixel(primary.hex, f.size);
      ox = p.x;
      oy = p.y;
      r = Math.hypot(centre.x - ox, centre.y - oy);
    } else {
      r = solarDistance(body.hex) * f.pitch;
    }
    if (r < f.pitch * 0.4) continue;

    // Cheap reject: the ring's bounding box against the viewport.
    const rect = f.cam.visibleRect();
    if (rect.x0 > ox + r || rect.x1 < ox - r || rect.y0 > oy + r || rect.y1 < oy - r) continue;

    const theta = Math.atan2(centre.y - oy, centre.x - ox);
    const moon = body.kind === 'moon';

    // The quiet part of the ring.
    ctx.lineWidth = Math.max(0.6 * f.u, r * 0.0012);
    ctx.strokeStyle = rgba(THEME.orbitRing, moon ? 0.5 : 0.45);
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.stroke();

    // ...and a wake of brighter arcs either side of the body itself.
    const segments = 5;
    const span = moon ? 0.9 : 0.42;
    ctx.lineWidth = Math.max(0.7 * f.u, r * 0.0016);
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const step = span / segments;
      ctx.strokeStyle = rgba(THEME.orbitRingHot, 0.42 * (1 - t));
      ctx.beginPath();
      ctx.arc(ox, oy, r, theta - span * t - step, theta - span * t);
      // A fresh subpath, or the two arcs would be joined by a chord.
      ctx.moveTo(ox + Math.cos(theta + span * t) * r, oy + Math.sin(theta + span * t) * r);
      ctx.arc(ox, oy, r, theta + span * t, theta + span * t + step);
      ctx.stroke();
    }
  }
};

/** The planet a moon belongs to: simply the nearest one on the chart. */
const nearestPlanet = (map: GameMap, moon: AstralBody): AstralBody | undefined => {
  let best: AstralBody | undefined;
  let bestD = Infinity;
  for (const b of map.bodies) {
    if (b.kind !== 'planet') continue;
    const d = Math.hypot(b.hex.q - moon.hex.q, b.hex.r - moon.hex.r);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const drawStar = (f: Frame, body: AstralBody, cx: number, cy: number, r: number): void => {
  const { ctx } = f;

  // Corona: two broad blooms, then a slow rotating crown of rays.
  glow(f, cx, cy, r * 16, body.glow, 0.16);
  glow(f, cx, cy, r * 6.5, body.glow, 0.3);
  glow(f, cx, cy, r * 2.6, lighten(body.color, 0.25), 0.5);

  // Rays are only worth their gradients once the disc is more than a few pixels.
  const rays = f.hexPx < 4 ? 0 : f.hexPx < 12 ? 8 : 16;
  const spin = f.time * 0.000018;
  const rnd = new Stream(hash2(1, 1, 991));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + rnd.range(-0.05, 0.05);
    const len = r * rnd.range(1.9, 4.6);
    const w = r * rnd.range(0.05, 0.13);
    const grad = ctx.createLinearGradient(
      Math.cos(a) * r * 0.9,
      Math.sin(a) * r * 0.9,
      Math.cos(a) * len,
      Math.sin(a) * len,
    );
    grad.addColorStop(0, rgba(body.color, 0.3));
    grad.addColorStop(1, rgba(body.glow, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(
      Math.cos(a - 0.0) * r * 0.85 + Math.cos(a + Math.PI / 2) * w,
      Math.sin(a) * r * 0.85 + Math.sin(a + Math.PI / 2) * w,
    );
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.lineTo(
      Math.cos(a) * r * 0.85 - Math.cos(a + Math.PI / 2) * w,
      Math.sin(a) * r * 0.85 - Math.sin(a + Math.PI / 2) * w,
    );
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // The photosphere.
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0, '#fffdf4');
  disc.addColorStop(0.45, lighten(body.color, 0.35));
  disc.addColorStop(0.86, body.color);
  disc.addColorStop(1, mix(body.color, body.glow, 0.85));
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Limb darkening plus a hot rim.
  const limb = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
  limb.addColorStop(0, rgba(body.glow, 0));
  limb.addColorStop(1, rgba(body.glow, 0.55));
  ctx.fillStyle = limb;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = rgba('#fff3d0', 0.75);
  ctx.lineWidth = Math.max(0.7 * f.u, r * 0.035);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.995, 0, Math.PI * 2);
  ctx.stroke();
};

/** Soft, deterministic mottling clipped inside a disc — surface texture. */
const mottle = (
  f: Frame,
  body: AstralBody,
  cx: number,
  cy: number,
  r: number,
  count: number,
): void => {
  const { ctx } = f;
  const rnd = new Stream(hash2(body.hex.q, body.hex.r, 77));
  for (let i = 0; i < count; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = Math.sqrt(rnd.next()) * r * 0.86;
    const br = r * rnd.range(0.14, 0.42);
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const dark = rnd.next() < 0.55;
    const g = ctx.createRadialGradient(x, y, 0, x, y, br);
    const tint = dark ? darken(body.color, 0.35) : lighten(body.color, 0.3);
    g.addColorStop(0, rgba(tint, 0.34));
    g.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, br, 0, Math.PI * 2);
    ctx.fill();
  }
};

/** Latitudinal bands, for the one gas giant on the chart. */
const bands = (f: Frame, body: AstralBody, cx: number, cy: number, r: number): void => {
  const { ctx } = f;
  const rnd = new Stream(hash2(body.hex.q, body.hex.r, 313));
  const n = 7;
  for (let i = 0; i < n; i++) {
    const y0 = cy - r + (2 * r * i) / n;
    const h = ((2 * r) / n) * rnd.range(0.5, 1.0);
    const tint =
      rnd.next() < 0.5
        ? darken(body.color, rnd.range(0.15, 0.3))
        : lighten(body.color, rnd.range(0.1, 0.24));
    ctx.fillStyle = rgba(tint, 0.55);
    ctx.beginPath();
    ctx.ellipse(cx, y0 + h / 2, r, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The one storm every player will look for.
  const sx = cx + r * 0.28;
  const sy = cy + r * 0.22;
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.24);
  g.addColorStop(0, rgba('#e07a55', 0.75));
  g.addColorStop(1, rgba('#e07a55', 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(sx, sy, r * 0.26, r * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
};

const drawWorld = (
  f: Frame,
  body: AstralBody,
  cx: number,
  cy: number,
  r: number,
  lx: number,
  ly: number,
): void => {
  const { ctx } = f;
  const cool = body.kind === 'moon' ? 0.16 : 0;
  const base = cool > 0 ? mix(body.color, '#8fa7c4', cool) : body.color;

  // Atmosphere / halo.
  glow(
    f,
    cx,
    cy,
    r * (body.kind === 'moon' ? 1.9 : 2.5),
    body.glow,
    body.kind === 'moon' ? 0.16 : 0.24,
    r * 0.7,
  );

  // Lit hemisphere: a radial gradient pushed toward Sol.
  const g = ctx.createRadialGradient(
    cx + lx * r * 0.42,
    cy + ly * r * 0.42,
    r * 0.05,
    cx,
    cy,
    r * 1.15,
  );
  g.addColorStop(0, lighten(base, 0.5));
  g.addColorStop(0.5, lighten(base, 0.08));
  g.addColorStop(1, darken(base, 0.5));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  if (body.kind === 'planet' && !body.habitable) bands(f, body, cx, cy, r);
  else if (f.hexPx > 22) mottle(f, body, cx, cy, r, body.kind === 'moon' ? 5 : 8);

  // Terminator: darkness centred beyond the anti-solar limb, so the night side
  // goes deep but the disc keeps most of its colour. Airless bodies get a
  // tighter falloff than worlds with an atmosphere.
  const soft = body.kind === 'moon' ? 0.5 : 0.85;
  const ox = cx - lx * r * 1.5;
  const oy = cy - ly * r * 1.5;
  const t = ctx.createRadialGradient(ox, oy, r * 0.15, ox, oy, r * (1.55 + soft));
  t.addColorStop(0, rgba('#01030a', 0.88));
  t.addColorStop(0.55, rgba('#01030a', 0.42));
  t.addColorStop(1, rgba('#01030a', 0));
  ctx.fillStyle = t;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  // Rim light along the Sol-facing limb.
  const ang = Math.atan2(ly, lx);
  ctx.lineWidth = Math.max(0.6 * f.u, r * 0.085);
  ctx.strokeStyle = rgba(lighten(body.glow, 0.55), 0.72);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.955, ang - 1.15, ang + 1.15);
  ctx.stroke();

  // A hairline all the way round so the disc keeps its edge when zoomed out.
  ctx.lineWidth = Math.max(0.5 * f.u, r * 0.02);
  ctx.strokeStyle = rgba(darken(base, 0.55), 0.85);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
};

/** Ceres and Clandestine: rock, not sphere. */
const drawRock = (
  f: Frame,
  body: AstralBody,
  cx: number,
  cy: number,
  r: number,
  lx: number,
  ly: number,
): void => {
  const { ctx } = f;
  const rnd = new Stream(hash2(body.hex.q, body.hex.r, 4242));
  const n = 11;
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(r * rnd.range(0.74, 1.06));
  const rot = rnd.range(0, Math.PI * 2);

  glow(f, cx, cy, r * 2.4, body.glow, 0.2, r * 0.6);

  const g = ctx.createLinearGradient(cx + lx * r, cy + ly * r, cx - lx * r, cy - ly * r);
  g.addColorStop(0, lighten(body.color, 0.4));
  g.addColorStop(0.5, body.color);
  g.addColorStop(1, darken(body.color, 0.68));
  ctx.fillStyle = g;
  ctx.beginPath();
  blobPath(ctx, cx, cy, radii, rot);
  ctx.fill();

  ctx.lineWidth = Math.max(0.5 * f.u, r * 0.06);
  ctx.strokeStyle = rgba(lighten(body.color, 0.5), 0.5);
  ctx.stroke();

  if (f.hexPx > 26) {
    ctx.save();
    ctx.beginPath();
    blobPath(ctx, cx, cy, radii, rot);
    ctx.clip();
    for (let i = 0; i < 5; i++) {
      const a = rnd.range(0, Math.PI * 2);
      const d = Math.sqrt(rnd.next()) * r * 0.7;
      const cr = r * rnd.range(0.1, 0.26);
      ctx.fillStyle = rgba(darken(body.color, 0.5), 0.45);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, cr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
};

/** Draw every visible astral body, lit from Sol. */
export const drawBodies = (f: Frame, map: GameMap): void => {
  for (const body of map.bodies) {
    const c = toPixel(body.hex, f.size);
    const r = discRadiusOf(f, body);
    const bloom = body.kind === 'star' ? r * 18 : r * 3;
    if (!f.cam.isVisible(c.x, c.y, bloom)) continue;

    if (body.kind === 'star') {
      drawStar(f, body, c.x, c.y, r);
      continue;
    }

    // Light direction: from the body toward Sol, which sits at the origin.
    const len = Math.hypot(c.x, c.y) || 1;
    const lx = -c.x / len;
    const ly = -c.y / len;

    if (body.kind === 'majorAsteroid') drawRock(f, body, c.x, c.y, r, lx, ly);
    else drawWorld(f, body, c.x, c.y, r, lx, ly);
  }
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const drawBodyLabels = (f: Frame, map: GameMap): void => {
  if (f.hexPx < 3) return;
  const { ctx } = f;
  for (const body of map.bodies) {
    const major = body.kind === 'star' || body.kind === 'planet';
    if (!major && f.hexPx < LOD.labelMin) continue;

    const c = toPixel(body.hex, f.size);
    const r = discRadiusOf(f, body);
    if (!f.cam.isVisible(c.x, c.y, r * 4)) continue;

    const size = major ? 12 : 10;
    setFont(f, size, major ? '700' : '600');
    const fade = smoothstep(3, 7, f.hexPx);
    // Clear the disc *and* any base glyphs planted on its limb.
    const drop = Math.max(r * 1.5, r + 4 * f.u) + (major ? 11 : 9) * f.u;
    label(
      f,
      body.name.toUpperCase(),
      c.x,
      c.y + drop,
      rgba(major ? THEME.textPrimary : THEME.textDim, 0.55 + 0.35 * fade),
      0.55,
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
};

// ---------------------------------------------------------------------------
// Bases
// ---------------------------------------------------------------------------

/**
 * Base glyphs.
 *
 * "Bases are marked on the map with a base symbol, similar to the symbol on the
 * orbital base counter." Planetary bases live on a *hexside*, so the glyph is
 * planted on the world's limb facing out along that side — which is also the
 * direction of the gravity hex a ship must take off into, and the hex the
 * base's planetary defences fire at.
 */
export const drawBases = (
  f: Frame,
  map: GameMap,
  state: GameState,
  colorOf: (owner: PlayerId | null) => string,
): void => {
  const { ctx } = f;
  if (f.hexPx < LOD.detailMin * 0.7) return;

  for (const base of Object.values(state.bases)) {
    if (base.kind === 'planetary') drawPlanetaryBase(f, map, base, colorOf(base.owner));
    else if (base.kind === 'asteroid') drawAsteroidBase(f, base, colorOf(base.owner));
    else drawOrbitalBase(f, base, colorOf(base.owner));
  }
  ctx.setLineDash([]);
};

const drawPlanetaryBase = (f: Frame, map: GameMap, base: BaseState, color: string): void => {
  const side = base.side;
  if (!side) return;
  const body = map.bodyAt(side.hex);
  const c = toPixel(side.hex, f.size);
  const r = body ? discRadiusOf(f, body) : f.pitch * 0.2;
  if (!f.cam.isVisible(c.x, c.y, r * 3)) return;
  // Worlds with bases on all six sides would otherwise turn into a starburst
  // once the disc shrinks past a few pixels, so the glyphs are sized off the
  // disc and dropped entirely when there is no room for them.
  const discPx = r * f.cam.zoom;
  if (discPx < 12) return;

  const ux = DIR_COS[side.dir]!;
  const uy = DIR_SIN[side.dir]!;
  // Sit the glyph just off the limb, pointing out along its hexside — small
  // enough that six of them read as beacons rather than as spikes.
  const h = Math.min(r * 0.3, f.pitch * 0.085);
  const w = h * 1.3;
  const bx = c.x + ux * (r * 1.02);
  const by = c.y + uy * (r * 1.02);
  const px = -uy;
  const py = ux;

  const { ctx } = f;
  const live = !base.destroyed;
  const ink = live ? color : THEME.textFaint;

  ctx.beginPath();
  ctx.moveTo(bx + ux * h, by + uy * h);
  ctx.lineTo(bx + px * w * 0.5, by + py * w * 0.5);
  ctx.lineTo(bx - px * w * 0.5, by - py * w * 0.5);
  ctx.closePath();

  if (live && !base.suppressed) {
    ctx.fillStyle = rgba(ink, 0.85);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(0.8 * f.u, h * 0.14);
  ctx.strokeStyle = live ? rgba(lighten(ink, 0.45), 0.95) : rgba(THEME.textFaint, 0.7);
  if (base.suppressed) ctx.setLineDash([2 * f.u, 2 * f.u]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Planetary defences: a fire-control tick aimed at the gravity hex above.
  // "Planetary defenses may fire at any ship in the gravity hex directly above
  // their hex side."
  if (live && base.hasPlanetaryDefences && !base.suppressed && f.hexPx > LOD.detailMin * 1.6) {
    ctx.strokeStyle = rgba(lighten(ink, 0.3), 0.4);
    ctx.lineWidth = Math.max(0.6 * f.u, h * 0.09);
    ctx.beginPath();
    ctx.moveTo(bx + ux * h * 1.25, by + uy * h * 1.25);
    ctx.lineTo(bx + ux * h * 1.95, by + uy * h * 1.95);
    ctx.stroke();
  }

  if (base.destroyed) {
    ctx.strokeStyle = rgba(THEME.danger, 0.8);
    ctx.lineWidth = Math.max(0.8 * f.u, h * 0.16);
    ctx.beginPath();
    ctx.moveTo(bx - px * w * 0.4 + ux * h * 0.1, by - py * w * 0.4 + uy * h * 0.1);
    ctx.lineTo(bx + px * w * 0.4 + ux * h * 0.9, by + py * w * 0.4 + uy * h * 0.9);
    ctx.moveTo(bx + px * w * 0.4 + ux * h * 0.1, by + py * w * 0.4 + uy * h * 0.1);
    ctx.lineTo(bx - px * w * 0.4 + ux * h * 0.9, by - py * w * 0.4 + uy * h * 0.9);
    ctx.stroke();
  }
};

/**
 * Ceres and Clandestine. "It serves all the functions of an orbital base" —
 * so it gets the orbital base's ring, drawn around the rock itself.
 */
const drawAsteroidBase = (f: Frame, base: BaseState, color: string): void => {
  const c = toPixel(base.hex, f.size);
  if (!f.cam.isVisible(c.x, c.y, f.pitch)) return;
  const { ctx } = f;
  const r = f.pitch * 0.34;
  ctx.lineWidth = Math.max(0.8 * f.u, f.pitch * 0.018);
  ctx.strokeStyle = rgba(base.destroyed ? THEME.textFaint : color, 0.8);
  ctx.setLineDash([f.pitch * 0.12, f.pitch * 0.09]);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
};

/** The orbital base variant: a ring with a chevron, sitting in its own hex. */
const drawOrbitalBase = (f: Frame, base: BaseState, color: string): void => {
  const c = toPixel(base.hex, f.size);
  if (!f.cam.isVisible(c.x, c.y, f.pitch)) return;
  const { ctx } = f;
  const r = f.pitch * 0.3;
  const ink = base.destroyed ? THEME.textFaint : color;

  glow(f, c.x, c.y, r * 2.6, ink, 0.22, r * 0.4);
  ctx.lineWidth = Math.max(1 * f.u, r * 0.16);
  ctx.strokeStyle = rgba(ink, 0.95);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = rgba(ink, base.suppressed ? 0.3 : 0.85);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y - r * 0.55);
  ctx.lineTo(c.x + r * 0.5, c.y + r * 0.42);
  ctx.lineTo(c.x - r * 0.5, c.y + r * 0.42);
  ctx.closePath();
  ctx.fill();
};

// ---------------------------------------------------------------------------
// Asteroid field
// ---------------------------------------------------------------------------

/**
 * The belt is scatter, not a texture — "a die is rolled for each asteroid hex
 * entered", so the *hex* is the unit of danger and each one has to read as its
 * own object. Chips are hashed off the hex coordinates, matching how the belt
 * itself is generated in `mapdata.ts`.
 *
 * Several hundred belt hexes can be on screen at once, so the chips are
 * accumulated into a handful of `Path2D` buckets — two families (ordinary belt,
 * dense cordon) by three shades — and painted with about ten draw calls a frame
 * instead of two thousand.
 */
const SHADES = 3;

export interface AsteroidBatch {
  /** family * SHADES + shade */
  readonly chips: Path2D[];
  /** Per family: highlight outlines and the dusting of fines. */
  readonly rims: Path2D[];
  readonly fines: Path2D[];
  used: boolean;
}

export const newAsteroidBatch = (): AsteroidBatch => ({
  chips: Array.from({ length: 2 * SHADES }, () => new Path2D()),
  rims: [new Path2D(), new Path2D()],
  fines: [new Path2D(), new Path2D()],
  used: false,
});

export const addAsteroidHex = (
  f: Frame,
  batch: AsteroidBatch,
  h: Hex,
  cx: number,
  cy: number,
  dense: boolean,
): void => {
  batch.used = true;
  const family = dense ? 1 : 0;

  if (f.hexPx < LOD.detailMin) {
    // Far out: one soft speck per hex, enough to show the band's shape.
    const rr = f.pitch * (dense ? 0.2 : 0.15);
    const p = batch.chips[family * SHADES + 1]!;
    p.moveTo(cx + rr, cy);
    p.arc(cx, cy, rr, 0, Math.PI * 2);
    return;
  }

  const rnd = new Stream(hash2(h.q, h.r, dense ? 88 : 55));
  const chips = dense ? rnd.int(5, 8) : rnd.int(3, 5);
  const spread = f.pitch * 0.34;
  const rim = f.hexPx > LOD.detailMin * 2;

  if (dense && f.hexPx > LOD.detailMin * 1.4) {
    // The cordon reads as a haze as well as rubble: "only ships possessing
    // scanners may enter those hexes. Other ships are destroyed."
    glow(f, cx, cy, f.pitch * 0.6, THEME.asteroidDense, 0.16);
  }

  for (let i = 0; i < chips; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = Math.sqrt(rnd.next()) * spread;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const rr = f.pitch * rnd.range(0.028, 0.075);
    const n = rnd.int(5, 7);
    const radii: number[] = [];
    for (let k = 0; k < n; k++) radii.push(rr * rnd.range(0.62, 1.25));
    const rot = rnd.range(0, Math.PI * 2);
    const shade = rnd.int(0, SHADES - 1);

    blobPath(batch.chips[family * SHADES + shade]!, x, y, radii, rot);
    // Sun-side highlight on the larger chips only.
    if (rim && rr > f.pitch * 0.05) blobPath(batch.rims[family]!, x, y, radii, rot);
  }

  // A dusting of fines between the chips.
  if (f.hexPx > LOD.detailMin * 1.5) {
    const fines = dense ? 7 : 4;
    const s = f.pitch * 0.012;
    for (let i = 0; i < fines; i++) {
      const a = rnd.range(0, Math.PI * 2);
      const d = Math.sqrt(rnd.next()) * spread * 1.15;
      batch.fines[family]!.rect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s);
    }
  }
};

export const flushAsteroidBatch = (f: Frame, batch: AsteroidBatch): void => {
  if (!batch.used) return;
  const { ctx } = f;
  const far = f.hexPx < LOD.detailMin;

  for (let family = 0; family < 2; family++) {
    const dense = family === 1;
    const body = dense ? THEME.asteroidDense : THEME.asteroid;
    const rim = dense ? THEME.asteroidDenseRim : THEME.asteroidRim;

    for (let shade = 0; shade < SHADES; shade++) {
      const alpha = far ? (dense ? 0.55 : 0.42) : 0.9;
      ctx.fillStyle = rgba(mix(body, '#000000', shade * 0.17), alpha);
      ctx.fill(batch.chips[family * SHADES + shade]!);
    }

    ctx.strokeStyle = rgba(rim, 0.3);
    ctx.lineWidth = Math.max(0.4 * f.u, f.pitch * 0.006);
    ctx.stroke(batch.rims[family]!);

    ctx.fillStyle = rgba(rim, 0.22);
    ctx.fill(batch.fines[family]!);
  }
};

/** Deterministic per-hex jitter, so belt hexes never line up in rows. */
export const asteroidJitter = (h: Hex, pitchWorld: number): { dx: number; dy: number } => ({
  dx: (noise2(h.q, h.r, 17) - 0.5) * pitchWorld * 0.18,
  dy: (noise2(h.q, h.r, 18) - 0.5) * pitchWorld * 0.18,
});
