import { describe, expect, it } from 'vitest';
import { SQRT3, fromOffset, toPixel } from '../../src/ogre/engine/hex.js';
import { areaLinePoints } from '../../src/ogre/render/renderer.js';

/**
 * The two grey lines that divide the Ogre map into North, Central and South
 * are printed *on the board*, so they have to run along hexsides. On an odd-q
 * board the boundary between two rows is a staircase — odd columns sit half a
 * hex lower than even ones — and a line that ignores that reads as drawn over
 * the map rather than part of it.
 */
describe('the area lines', () => {
  const size = 30;
  const cols = 21;
  const row = 8;

  it('is made of nothing but hexsides', () => {
    const pts = areaLinePoints(cols, row, size);
    expect(pts).toHaveLength(cols * 2);

    // Every side of a flat-top hex is exactly its centre-to-vertex distance
    // long, so any segment longer than that has left the grid.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(size, 6);
    }
  });

  it('runs along the south face of the row it names', () => {
    const pts = areaLinePoints(cols, row, size);
    const inradius = (size * SQRT3) / 2;

    for (let col = 1; col <= cols; col++) {
      const c = toPixel(fromOffset({ col, row }), size);
      const sw = pts[(col - 1) * 2]!;
      const se = pts[(col - 1) * 2 + 1]!;

      expect(sw.x).toBeCloseTo(c.x - size / 2, 6);
      expect(se.x).toBeCloseTo(c.x + size / 2, 6);
      expect(sw.y).toBeCloseTo(c.y + inradius, 6);
      expect(se.y).toBeCloseTo(c.y + inradius, 6);
    }
  });

  it('steps down into odd columns and back up out of them', () => {
    const pts = areaLinePoints(cols, row, size);
    const stagger = (size * SQRT3) / 2;

    // Column 1 is even-q and column 2 odd-q, which sits half a hex lower, so
    // the line drops by that much between them and climbs back over the next
    // pair. A straight line across the row would fail both of these.
    expect(pts[3]!.y - pts[0]!.y).toBeCloseTo(stagger, 6);
    expect(pts[5]!.y - pts[2]!.y).toBeCloseTo(-stagger, 6);
  });
});
