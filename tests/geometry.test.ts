/**
 * Course geometry tests.
 *
 * These pin the three distinctions the rulebook makes between a course
 * "entering" a hex, running along a hexside, and grazing a vertex.
 */

import { describe, expect, it } from 'vitest';
import {
  closestApproach,
  courseHitsDisc,
  hexesContaining,
  toPlane,
  traceSegment,
} from '../src/engine/geometry.js';
import { distance, hex, key, round, withinRadius } from '../src/engine/hex.js';

const keys = (hs: readonly { q: number; r: number }[]): string[] => hs.map(key);

describe('hexesContaining', () => {
  it('agrees with a brute-force nearest-centre test', () => {
    // Deterministic sweep rather than random sampling.
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const q = ((i * 37) % 971) / 97 - 5;
      const r = ((i * 53) % 887) / 89 - 5;
      const p = toPlane({ q, r });

      const candidates = withinRadius(round({ q, r }), 2);
      let best = Infinity;
      for (const c of candidates) {
        const pc = toPlane(c);
        best = Math.min(best, Math.hypot(pc.x - p.x, pc.y - p.y));
      }
      const nearest = candidates.filter((c) => {
        const pc = toPlane(c);
        return Math.hypot(pc.x - p.x, pc.y - p.y) < best + 1e-9;
      });

      expect(new Set(keys(hexesContaining(q, r)))).toEqual(new Set(keys(nearest)));
      checked++;
    }
    expect(checked).toBe(4000);
  });

  it('returns one hex for an interior point', () => {
    expect(hexesContaining(0.1, 0)).toHaveLength(1);
  });

  it('returns two hexes for a point on a hexside', () => {
    // Exactly halfway between (0,0) and its east neighbour.
    expect(hexesContaining(0.5, 0)).toHaveLength(2);
  });
});

describe('traceSegment', () => {
  it('traces a straight run through every intervening hex', () => {
    const t = traceSegment(hex(0, 0), hex(3, 0));
    expect(keys(t.entered)).toEqual(['0,0', '1,0', '2,0', '3,0']);
    expect(t.edgeRuns).toHaveLength(0);
  });

  it('a stationary ship traces to its own hex only', () => {
    const t = traceSegment(hex(4, -2), hex(4, -2));
    expect(keys(t.entered)).toEqual(['4,-2']);
  });

  it('runs along a hexside without entering either hex (rulebook Figure 7)', () => {
    // "the new course runs exactly along the edge of a gravity hex.
    //  The ship has not entered gravity hex III."
    const t = traceSegment(hex(0, 0), hex(1, 1));
    expect(keys(t.entered)).toEqual(['0,0', '1,1']);
    expect(t.edgeRuns).toHaveLength(1);

    const grazed = new Set(keys(t.edgeRuns[0]!));
    expect(grazed).toEqual(new Set(['0,1', '1,0']));

    // Ordnance still detonates on them: "any portion of the hex".
    const touchedEdges = t.touched.filter((x) => x.mode === 'edge');
    expect(new Set(keys(touchedEdges.map((x) => x.hex)))).toEqual(grazed);
  });

  it('never reports an entered hex that dense sampling disagrees with', () => {
    for (const target of withinRadius(hex(0, 0), 5)) {
      const t = traceSegment(hex(0, 0), target);
      const sampled = new Set<string>();
      const N = 4001;
      for (let i = 0; i <= N; i++) {
        const s = i / N;
        const cells = hexesContaining(target.q * s, target.r * s);
        if (cells.length === 1) sampled.add(key(cells[0]!));
      }
      expect(new Set(keys(t.entered))).toEqual(sampled);
    }
  });

  it('entered hexes form a connected chain from tail to head', () => {
    for (const target of withinRadius(hex(0, 0), 4)) {
      const t = traceSegment(hex(0, 0), target);
      for (let i = 1; i < t.entered.length; i++) {
        expect(distance(t.entered[i - 1]!, t.entered[i]!)).toBeLessThanOrEqual(2);
      }
      expect(key(t.entered[0]!)).toBe('0,0');
      expect(key(t.entered[t.entered.length - 1]!)).toBe(key(target));
    }
  });

  it('is symmetric: reversing a course visits the same hexes', () => {
    for (const target of withinRadius(hex(0, 0), 5)) {
      const fwd = traceSegment(hex(0, 0), target);
      const rev = traceSegment(target, hex(0, 0));
      expect(new Set(keys(fwd.entered))).toEqual(new Set(keys(rev.entered)));
      expect(new Set(keys(fwd.touched.map((x) => x.hex)))).toEqual(
        new Set(keys(rev.touched.map((x) => x.hex))),
      );
    }
  });
});

describe('courseHitsDisc', () => {
  it('detects a course that passes through a body', () => {
    expect(courseHitsDisc(hex(-2, 0), hex(2, 0), hex(0, 0), 0.33)).toBe(true);
  });

  it('ignores a body whose hex is merely clipped at the corner', () => {
    // A disc of radius 0.33 sits well inside its hex, so a course grazing the
    // hex boundary misses it. "they do not cover their entire hex."
    expect(courseHitsDisc(hex(0, 0), hex(1, 1), hex(1, 0), 0.33)).toBe(false);
  });

  it('a course ending on the body still hits it', () => {
    expect(courseHitsDisc(hex(-3, 0), hex(0, 0), hex(0, 0), 0.3)).toBe(true);
  });
});

describe('closestApproach', () => {
  it('measures from the nearest hex of the attacker path', () => {
    const path = [hex(0, 0), hex(1, 0), hex(2, 0), hex(3, 0)];
    // Target adjacent to the middle of the path, not to its endpoint.
    expect(closestApproach(path, hex(2, 1))).toBe(1);
  });

  it('is zero when the path passes through the target hex', () => {
    expect(closestApproach([hex(0, 0), hex(1, 0)], hex(1, 0))).toBe(0);
  });
});
