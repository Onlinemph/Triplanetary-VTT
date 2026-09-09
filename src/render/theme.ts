/**
 * Palette, typography and level-of-detail constants for the map renderer.
 *
 * Everything the renderer draws pulls its colour from here so the chart reads as
 * one instrument: a deep, near-black plate with cool instrument-cyan furniture,
 * warm hazard tones, and colour reserved almost entirely for things the player
 * can act on (counters, courses, hazards). Astral bodies bring their own colours
 * from `mapdata.ts` (`AstralBody.color` / `.glow`); this file supplies the rest.
 */

// ---------------------------------------------------------------------------
// Colour utilities
// ---------------------------------------------------------------------------

export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const PARSE_CACHE = new Map<string, RGB>();

const clampByte = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)`. Unknown input goes magenta. */
export const parseColor = (color: string): RGB => {
  const cached = PARSE_CACHE.get(color);
  if (cached) return cached;

  let out: RGB = { r: 255, g: 0, b: 255 };
  const s = color.trim();
  if (s.startsWith('#')) {
    const body = s.slice(1);
    if (body.length === 3) {
      out = {
        r: parseInt(body[0]! + body[0]!, 16),
        g: parseInt(body[1]! + body[1]!, 16),
        b: parseInt(body[2]! + body[2]!, 16),
      };
    } else if (body.length >= 6) {
      out = {
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16),
      };
    }
  } else if (s.startsWith('rgb')) {
    const parts = s
      .slice(s.indexOf('(') + 1)
      .replace(')', '')
      .split(',')
      .map((p) => Number(p.trim()));
    out = { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
  }

  PARSE_CACHE.set(color, out);
  return out;
};

/** `color` at a given alpha, as a CSS string. */
export const rgba = (color: string, alpha: number): string => {
  const c = parseColor(color);
  return `rgba(${c.r},${c.g},${c.b},${alpha < 0 ? 0 : alpha > 1 ? 1 : alpha})`;
};

const toHex2 = (n: number): string => clampByte(n).toString(16).padStart(2, '0');

/** Linear blend; `t = 0` is `a`, `t = 1` is `b`. */
export const mix = (a: string, b: string, t: number): string => {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return `#${toHex2(ca.r + (cb.r - ca.r) * k)}${toHex2(ca.g + (cb.g - ca.g) * k)}${toHex2(
    ca.b + (cb.b - ca.b) * k,
  )}`;
};

export const lighten = (color: string, t: number): string => mix(color, '#ffffff', t);
export const darken = (color: string, t: number): string => mix(color, '#000000', t);

/** A colour's perceived luminance in [0, 1] — used to pick readable ink. */
export const luminance = (color: string): number => {
  const c = parseColor(color);
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
};

/** Black or white, whichever will read on `color`. */
export const inkOn = (color: string): string => (luminance(color) > 0.55 ? '#0a0d13' : '#f2f7fb');

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const THEME = {
  font: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  monoFont: "'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace",

  /** Deep space. The canvas is opaque, so this is the true backdrop. */
  space: '#04060c',
  spaceEdge: '#010205',
  /** A whisper of light inside the chart disc so the play area reads as a plate. */
  chartFill: '#0a1220',
  chartEdge: '#3f7ca0',
  chartEdgeGlow: '#1c5f86',

  grid: '#22374d',
  gridBright: '#3a5b78',

  orbitRing: '#1a3247',
  orbitRingHot: '#3d7ba3',

  /** Full gravity: solid arrows. Weak gravity (Luna, Io): hollow arrows. */
  gravityFull: '#6fb9dd',
  gravityWeak: '#94aec2',

  asteroid: '#8d8474',
  asteroidRim: '#c0b49c',
  /** The dense "blue asteroid" cordon that conceals Clandestine. */
  asteroidDense: '#6f9ad6',
  asteroidDenseRim: '#a8c9f5',

  textPrimary: '#d3e4f2',
  textDim: '#7e94a8',
  textFaint: '#4d6070',

  accent: '#5fd7ff',
  accentDim: '#2c7f9e',
  safe: '#4fe0a0',
  warn: '#ffb454',
  danger: '#ff5f66',
  violet: '#b58cff',

  neutral: '#8fa6b8',

  mine: '#ff9b3d',
  torpedo: '#ff6a4d',
  nuke: '#ff5ce0',

  counterInk: '#f0f6fb',
  counterEdge: '#0a0f16',

  selection: '#8ef0ff',
  hover: '#a9c4d6',
  detection: '#4fd2ff',
} as const;

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------

/**
 * Thresholds in *screen pixels per hex radius*. The chart is ~68 hexes across,
 * so a fitted view sits near 6-8 px/hex: everything below that has to collapse
 * to silhouettes or the plate turns to mud (and the frame budget evaporates).
 */
export const LOD = {
  /** Below this the hex grid is not drawn at all. */
  gridMin: 4.5,
  /** At and above this the grid is at full (still low) contrast. */
  gridFull: 13,
  /** Per-hex ornament: gravity arrows, asteroid chips, base glyphs. */
  detailMin: 7,
  /** Body names. */
  labelMin: 5.5,
  /** Text inside counters (ship numbers, pips). */
  counterTextMin: 13,
  /** Full counters versus simplified silhouettes. */
  counterFullMin: 11,
  /** Turn numbers alongside course arrows. */
  courseTextMin: 12,
} as const;

/** Screen-pixel sizes that must not scale away with zoom. */
export const SIZES = {
  counterMin: 11,
  counterMax: 58,
  ordnanceMin: 5,
  ordnanceMax: 26,
  hairline: 1,
} as const;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
