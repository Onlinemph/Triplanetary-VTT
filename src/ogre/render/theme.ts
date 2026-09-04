/**
 * Palette, typography and level-of-detail constants.
 *
 * Two boards, two moods. The original Ogre map is "devastated, cratered
 * terrain" — a warm, dead ochre plain under a sodium sky, with the craters as
 * cold holes in it. The G.E.V. maps are "undamaged terrain with towns and
 * forests" and read green and inhabited. Everything else — the chrome, the
 * counters, the selection furniture — is the same instrument in both, so a
 * player never has to relearn what a colour means.
 *
 * Colour is spent almost entirely on things a player can act on.
 */

export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const PARSE_CACHE = new Map<string, RGB>();

const clampByte = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

/** Parse `#rgb`, `#rrggbb` or `rgb(...)`. Unknown input goes magenta, loudly. */
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
  }
  PARSE_CACHE.set(color, out);
  return out;
};

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

export const luminance = (color: string): number => {
  const c = parseColor(color);
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
};

/** Black or white, whichever will read on `color`. */
export const inkOn = (color: string): string => (luminance(color) > 0.55 ? '#12100c' : '#f6f2e9');

export const THEME = {
  font: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  monoFont: "'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace",

  /** Outside the board. The canvas is opaque, so this is the true backdrop. */
  void: '#0b0a08',
  voidEdge: '#050403',

  grid: '#6b5a41',
  gridBright: '#a3866a',

  /** Selection and pointer furniture, shared by both boards. */
  select: '#ffd479',
  hover: '#f2e7cf',
  reach: '#7fd4a8',
  reachEdge: '#a8f0c8',
  hazard: '#ffb454',
  threat: '#ff6b5f',
  ramLine: '#ff8a3d',

  textPrimary: '#efe6d6',
  textDim: '#a2957f',
  textFaint: '#6b6153',

  counterInk: '#f7f2e7',
  counterEdge: '#0a0806',
  disabled: '#5d574c',

  good: '#7fd4a8',
  warn: '#ffb454',
  bad: '#ff6b5f',
} as const;

export interface BoardPalette {
  readonly ground: string;
  readonly groundAlt: string;
  readonly grid: string;
  readonly crater: string;
  readonly craterRim: string;
  readonly label: string;
}

/** Per-board ground colours. */
export const BOARD: Readonly<Record<'ogre' | 'gev', BoardPalette>> = {
  ogre: {
    ground: '#5e4630',
    groundAlt: '#6a5039',
    grid: '#8a6a49',
    crater: '#241a12',
    craterRim: '#8f7250',
    label: '#c9ab84',
  },
  gev: {
    ground: '#3f5233',
    groundAlt: '#485c39',
    grid: '#6b8455',
    crater: '#1c1a15',
    craterRim: '#7d6a4f',
    label: '#b7c9a4',
  },
};

/** Terrain fills, layered over the board's ground colour. */
export const TERRAIN_COLORS = {
  town: '#8e8677',
  townRoof: '#b6a993',
  forest: '#2f4a2c',
  forestCanopy: '#3f6238',
  swamp: '#3c4a3a',
  swampWater: '#4a6154',
  water: '#20415c',
  waterLight: '#2f5c7e',
  rubble: '#5a5147',
  road: '#a89b7d',
  rail: '#8d8577',
  ridge: '#241d16',
  ridgeCrest: '#d9c9a3',
  stream: '#4f7f9a',
} as const;

/**
 * Thresholds in *screen pixels per hex radius*.
 *
 * The Ogre board is 21 hexes across and the green board 28, so a fitted view
 * sits comfortably above 14 px/hex on a laptop — far roomier than a star chart.
 * The thresholds exist for the zoomed-out overview, where a hundred counters
 * have to collapse to silhouettes or the plate turns to mud.
 */
export const LOD = {
  gridMin: 5,
  gridFull: 14,
  /** Per-hex ornament: crater rims, forest stipple, town blocks. */
  detailMin: 9,
  /** Stat lines inside counters. */
  counterTextMin: 20,
  /** Unit abbreviations. */
  counterLabelMin: 14,
  /** Hex numbers. */
  hexLabelMin: 26,
} as const;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A stable pseudo-random value in [0, 1) for a hex.
 *
 * Used to vary ground tone and scatter crater debris so the plain does not look
 * tiled. It is a hash rather than a generator: the renderer must not consume
 * the game's RNG, and the same hex must look the same on every frame and every
 * client.
 */
export const hexNoise = (q: number, r: number, salt = 0): number => {
  let h = (q * 374761393 + r * 668265263 + salt * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
};
