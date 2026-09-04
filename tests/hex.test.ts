/**
 * Hex primitive tests.
 *
 * The direction-index arithmetic matters beyond tidiness: the gravity
 * derivation in map.ts and the orbit rule both rely on `DIRECTIONS` being in
 * strict rotational order, so that rotating an index by one rotates the vector
 * by 60 degrees and adding three reverses it.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  add,
  corners,
  directionTo,
  distance,
  eq,
  fromPixel,
  hex,
  hexSide,
  key,
  length,
  neighbor,
  parseKey,
  pitch,
  ring,
  round,
  scale,
  sideGravityHex,
  sideKey,
  sub,
  toPixel,
  withinRadius,
} from '../src/engine/hex.js';

describe('directions', () => {
  it('has six unit-length directions', () => {
    expect(DIRECTIONS).toHaveLength(6);
    for (const d of DIRECTIONS) expect(length(d)).toBe(1);
  });

  it('is in rotational order, so +3 reverses and +1 turns 60 degrees', () => {
    for (let i = 0; i < 6; i++) {
      // Opposite directions cancel.
      expect(eq(add(DIRECTIONS[i]!, DIRECTIONS[(i + 3) % 6]!), hex(0, 0))).toBe(true);
      // Consecutive directions are themselves one hex apart.
      expect(distance(DIRECTIONS[i]!, DIRECTIONS[(i + 1) % 6]!)).toBe(1);
      // Directions two apart are two hexes apart.
      expect(distance(DIRECTIONS[i]!, DIRECTIONS[(i + 2) % 6]!)).toBe(2);
    }
  });

  it('sums to zero over the full ring', () => {
    expect(DIRECTIONS.reduce((a, b) => add(a, b), hex(0, 0))).toEqual(hex(0, 0));
  });

  it('resolves directionTo for adjacent hexes and rejects others', () => {
    const origin = hex(3, -2);
    for (let i = 0; i < 6; i++) {
      expect(directionTo(origin, neighbor(origin, i))).toBe(i);
    }
    expect(directionTo(origin, add(origin, hex(2, 0)))).toBe(-1);
    expect(directionTo(origin, origin)).toBe(-1);
  });
});

describe('arithmetic', () => {
  it('makes velocity the difference of positions, and adds back', () => {
    const from = hex(2, 5);
    const to = hex(-3, 7);
    const v = sub(to, from);
    expect(eq(add(from, v), to)).toBe(true);
  });

  it('measures distance as the hex metric', () => {
    expect(distance(hex(0, 0), hex(0, 0))).toBe(0);
    expect(distance(hex(0, 0), hex(3, 0))).toBe(3);
    expect(distance(hex(0, 0), hex(0, 3))).toBe(3);
    // Axial (1,1) is two steps, not one: it is a "diagonal".
    expect(distance(hex(0, 0), hex(1, 1))).toBe(2);
    expect(distance(hex(0, 0), hex(3, -3))).toBe(3);
  });

  it('is symmetric and obeys the triangle inequality', () => {
    const pts = withinRadius(hex(0, 0), 4);
    for (const a of pts) {
      for (const b of pts) {
        expect(distance(a, b)).toBe(distance(b, a));
        for (const c of [hex(1, 1), hex(-2, 3), hex(0, -4)]) {
          expect(distance(a, b)).toBeLessThanOrEqual(distance(a, c) + distance(c, b));
        }
      }
    }
  });

  it('scales vectors linearly', () => {
    expect(length(scale(DIRECTIONS[0]!, 5))).toBe(5);
    expect(eq(scale(hex(2, -1), 3), hex(6, -3))).toBe(true);
  });
});

describe('neighbourhoods', () => {
  it('counts 3r^2+3r+1 hexes within a radius', () => {
    for (let r = 0; r <= 6; r++) {
      expect(withinRadius(hex(4, -7), r)).toHaveLength(3 * r * r + 3 * r + 1);
    }
  });

  it('builds rings of exactly 6r hexes, all at that distance', () => {
    const centre = hex(-2, 3);
    for (let r = 1; r <= 6; r++) {
      const found = ring(centre, r);
      expect(found).toHaveLength(6 * r);
      for (const h of found) expect(distance(centre, h)).toBe(r);
      expect(new Set(found.map(key)).size).toBe(6 * r);
    }
    expect(ring(centre, 0)).toEqual([centre]);
  });

  it('partitions withinRadius into rings', () => {
    const centre = hex(1, 1);
    const all = new Set(withinRadius(centre, 4).map(key));
    const byRing = new Set<string>();
    for (let r = 0; r <= 4; r++) for (const h of ring(centre, r)) byRing.add(key(h));
    expect(byRing).toEqual(all);
  });
});

describe('keys', () => {
  it('round-trips through parseKey, including negatives', () => {
    for (const h of [hex(0, 0), hex(-4, 9), hex(12, -30), hex(-1, -1)]) {
      expect(parseKey(key(h))).toEqual(h);
    }
  });

  it('is unique per hex', () => {
    const pts = withinRadius(hex(0, 0), 8);
    expect(new Set(pts.map(key)).size).toBe(pts.length);
  });
});

describe('pixel projection', () => {
  it('round-trips a hex through pixel space', () => {
    for (const h of withinRadius(hex(0, 0), 6)) {
      expect(round(fromPixel(toPixel(h, 24), 24))).toEqual(h);
    }
  });

  it('puts adjacent hex centres exactly one pitch apart', () => {
    const size = 17;
    const origin = toPixel(hex(0, 0), size);
    for (let i = 0; i < 6; i++) {
      const p = toPixel(neighbor(hex(0, 0), i), size);
      expect(Math.hypot(p.x - origin.x, p.y - origin.y)).toBeCloseTo(pitch(size), 9);
    }
  });

  it('draws six corners at the layout radius', () => {
    const size = 20;
    const c = corners(hex(2, -1), size);
    expect(c).toHaveLength(6);
    const centre = toPixel(hex(2, -1), size);
    for (const p of c) {
      expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(size, 9);
    }
  });
});

describe('hexsides', () => {
  it('normalises the direction index', () => {
    expect(hexSide(hex(1, 1), 7).dir).toBe(1);
    expect(hexSide(hex(1, 1), -1).dir).toBe(5);
  });

  it('maps each side to the gravity hex directly above it', () => {
    // This one-to-one correspondence is what lets the rules say "the gravity hex
    // directly above the base's hex side".
    const world = hex(4, 4);
    const seen = new Set<string>();
    for (let d = 0; d < 6; d++) {
      const g = sideGravityHex(hexSide(world, d));
      expect(distance(world, g)).toBe(1);
      seen.add(key(g));
    }
    expect(seen.size).toBe(6);
  });

  it('gives distinct keys per side', () => {
    const seen = new Set<string>();
    for (let d = 0; d < 6; d++) seen.add(sideKey(hexSide(hex(0, 0), d)));
    expect(seen.size).toBe(6);
  });
});

describe('rounding', () => {
  it('preserves the cube invariant', () => {
    for (let i = 0; i < 500; i++) {
      const q = ((i * 61) % 400) / 37 - 5;
      const r = ((i * 97) % 400) / 41 - 5;
      const h = round({ q, r });
      expect(Number.isInteger(h.q)).toBe(true);
      expect(Number.isInteger(h.r)).toBe(true);
    }
  });

  it('is the identity on exact hexes', () => {
    for (const h of withinRadius(hex(0, 0), 5)) {
      expect(round(h)).toEqual(h);
    }
  });
});
