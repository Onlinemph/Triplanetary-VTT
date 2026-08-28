/**
 * Hex geometry, and the map's own column-row labels.
 *
 * The labels are not decoration: scenario setup is written in them ("any hex
 * whose number ends in 17 or higher"), so `label`/`parseLabel` and the
 * neighbour relation have to agree with the printed board.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  corners,
  distance,
  fromOffset,
  fromPixel,
  hex,
  label,
  neighbors,
  parseLabel,
  round,
  toOffset,
  toPixel,
} from '../../src/ogre/engine/hex.js';

describe('labels', () => {
  it('numbers the top-left hex 0101', () => {
    expect(label(fromOffset({ col: 1, row: 1 }))).toBe('0101');
    expect(label(fromOffset({ col: 14, row: 1 }))).toBe('1401');
    expect(label(fromOffset({ col: 21, row: 17 }))).toBe('2117');
  });

  it('round-trips through parseLabel', () => {
    for (const text of ['0101', '1401', '2117', '0803']) {
      expect(label(parseLabel(text)!)).toBe(text);
    }
    expect(parseLabel('nonsense')).toBeNull();
  });

  it('keeps offset and axial coordinates in step', () => {
    for (let col = 1; col <= 12; col++) {
      for (let row = 1; row <= 12; row++) {
        expect(toOffset(fromOffset({ col, row }))).toEqual({ col, row });
      }
    }
  });
});

describe('adjacency', () => {
  it('gives every hex six neighbours, each one step away', () => {
    const h = fromOffset({ col: 4, row: 4 });
    const ns = neighbors(h);
    expect(ns).toHaveLength(6);
    for (const n of ns) expect(distance(h, n)).toBe(1);
  });

  it('makes opposite directions reverse each other', () => {
    for (let i = 0; i < 6; i++) {
      const a = DIRECTIONS[i]!;
      const b = DIRECTIONS[(i + 3) % 6]!;
      expect({ q: a.q + b.q, r: a.r + b.r }).toEqual({ q: 0, r: 0 });
    }
  });

  it('measures range as hex distance, which is all Ogre needs (7.02)', () => {
    const a = hex(0, 0);
    expect(distance(a, hex(3, 0))).toBe(3);
    expect(distance(a, hex(0, 3))).toBe(3);
    expect(distance(a, hex(-2, -1))).toBe(3);
  });
});

describe('pixel projection (flat-top)', () => {
  it('round-trips through fromPixel', () => {
    for (const h of [hex(0, 0), hex(3, -2), hex(-4, 5), hex(7, 7)]) {
      expect(round(fromPixel(toPixel(h, 20), 20))).toEqual(h);
    }
  });

  it('puts the first corner due east of the centre', () => {
    const c = corners(hex(0, 0), 10);
    expect(c[0]!.x).toBeCloseTo(10);
    expect(c[0]!.y).toBeCloseTo(0);
  });

  it('keeps an inset hexagon concentric with its hex', () => {
    // The board draws selection, hover and reachability as hexagons a little
    // smaller than the hex itself. Shrinking by passing a smaller `size` scales
    // the whole layout toward hex (0, 0) instead, which leaves the outline
    // drifting further off its hex the further out the hex lies -- invisible at
    // the origin, half a hex away at the far corner of the map.
    const size = 40;
    for (const h of [hex(0, 0), hex(3, -2), hex(12, 9), hex(-14, 20)]) {
      const centre = toPixel(h, size);
      for (const radius of [size, size * 0.88, size - 0.5]) {
        const pts = corners(h, size, radius);
        const mid = {
          x: pts.reduce((s, p) => s + p.x, 0) / 6,
          y: pts.reduce((s, p) => s + p.y, 0) / 6,
        };
        expect(mid.x).toBeCloseTo(centre.x, 6);
        expect(mid.y).toBeCloseTo(centre.y, 6);
        expect(Math.hypot(pts[0]!.x - centre.x, pts[0]!.y - centre.y)).toBeCloseTo(radius, 6);
      }
    }
  });
});
