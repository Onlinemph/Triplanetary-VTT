/**
 * Counter glyphs and toolbar icons.
 *
 * Ten ship classes, ten silhouettes, all drawn in the same 24x24 box with a
 * single stroke weight so a fleet list reads as one instrument rather than a
 * sticker sheet. Commercial hulls are blunt and horizontal; warships are wedges
 * pointing along their course; the orbital base is the only ring.
 */

import type { ShipClass } from '@engine/ships.js';
import type { OrdnanceKind } from '@engine/types.js';
import { svg } from './dom.js';

interface GlyphDef {
  /** Filled body path. */
  readonly body: string;
  /** Optional stroked detail drawn over the body. */
  readonly detail?: string;
}

const GLYPHS: Readonly<Record<ShipClass, GlyphDef>> = {
  // Blunt boxes: cargo hulls.
  transport: { body: 'M4 8 H20 V16 H4 Z', detail: 'M9 8 V16 M15 8 V16' },
  packet: { body: 'M4 8 H16 L21 12 L16 16 H4 Z', detail: 'M10 8 V16' },
  tanker: {
    body: 'M7 8 H17 A3.2 4 0 0 1 17 16 H7 A3.2 4 0 0 0 7 8 Z',
    detail: 'M12 8.6 V15.4',
  },
  liner: {
    body: 'M3.5 12 A8.5 3.6 0 1 0 20.5 12 A8.5 3.6 0 1 0 3.5 12 Z',
    detail: 'M8 12 H16',
  },
  // Wedges: warships, nose to the right.
  corvette: { body: 'M20 12 L8 7 V17 Z' },
  corsair: { body: 'M21 12 L5 6 L9 12 L5 18 Z' },
  frigate: { body: 'M22 12 L6 5 V19 Z', detail: 'M6 9 L2 12 L6 15' },
  dreadnaught: {
    body: 'M22 12 L16 6 H5 L2 12 L5 18 H16 Z',
    detail: 'M11 6 V18',
  },
  torch: {
    body: 'M20 12 L9 7 V17 Z',
    detail: 'M9 12 H2 M9 9.5 L4 8 M9 14.5 L4 16',
  },
  orbitalBase: {
    body: 'M12 4.5 A7.5 7.5 0 1 0 12 19.5 A7.5 7.5 0 1 0 12 4.5 Z M12 9 A3 3 0 1 1 12 15 A3 3 0 1 1 12 9 Z',
    detail: 'M2 12 H5 M19 12 H22',
  },
};

export const shipGlyph = (cls: ShipClass, size = 20): SVGElement => {
  const g = GLYPHS[cls];
  return svg(
    'svg',
    {
      class: 'glyph',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', { d: g.body, fill: 'currentColor', 'fill-rule': 'evenodd' }),
    g.detail
      ? svg('path', {
          d: g.detail,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
          opacity: 0.55,
        })
      : null,
  );
};

const ORDNANCE_GLYPH: Readonly<Record<OrdnanceKind, string>> = {
  mine: 'M12 5 V19 M5 12 H19 M7 7 L17 17 M17 7 L7 17',
  torpedo: 'M4 12 H18 M18 12 L14 9 M18 12 L14 15',
  nuke: 'M12 6 A6 6 0 1 0 12 18 A6 6 0 1 0 12 6 Z M12 9.5 A2.5 2.5 0 1 1 12 14.5 A2.5 2.5 0 1 1 12 9.5 Z',
};

export const ordnanceGlyph = (kind: OrdnanceKind, size = 16): SVGElement =>
  svg(
    'svg',
    {
      class: 'glyph',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', {
      d: ORDNANCE_GLYPH[kind],
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
    }),
  );

export type IconName =
  | 'help'
  | 'undo'
  | 'fit'
  | 'gravity'
  | 'detection'
  | 'history'
  | 'close'
  | 'chevron'
  | 'scenarios'
  | 'plus'
  | 'minus'
  | 'warning'
  | 'target';

const ICONS: Readonly<Record<IconName, string>> = {
  help: 'M12 3.5 A8.5 8.5 0 1 0 12 20.5 A8.5 8.5 0 1 0 12 3.5 Z M9.4 9.6 A2.7 2.7 0 1 1 12 13 V14.4 M12 17.2 V17.3',
  undo: 'M4 9 H14 A5 5 0 0 1 14 19 H8 M4 9 L8 5 M4 9 L8 13',
  fit: 'M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15',
  gravity: 'M12 4 V15 M12 20 L8 15 H16 Z M5 7 L7 9 M19 7 L17 9',
  detection:
    'M12 12 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M12 5.5 A6.5 6.5 0 0 1 18.5 12 M12 2 A10 10 0 0 1 22 12',
  history: 'M5 12 A7 7 0 1 0 8 6 M5 12 H8.6 M5 12 V8.4 M12 8.5 V12.4 L15 14',
  close: 'M6 6 L18 18 M18 6 L6 18',
  chevron: 'M9 6 L15 12 L9 18',
  scenarios: 'M4 6 H20 M4 12 H20 M4 18 H13',
  plus: 'M12 5 V19 M5 12 H19',
  minus: 'M5 12 H19',
  warning: 'M12 4 L21 19 H3 Z M12 10 V14 M12 16.6 V16.7',
  target: 'M12 4 V8 M12 16 V20 M4 12 H8 M16 12 H20 M12 8 A4 4 0 1 0 12 16 A4 4 0 1 0 12 8 Z',
};

export const icon = (name: IconName, size = 16): SVGElement =>
  svg(
    'svg',
    {
      class: 'icon',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', {
      d: ICONS[name],
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
