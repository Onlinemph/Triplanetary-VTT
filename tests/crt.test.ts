/**
 * Combat results table tests — transcription checks against the printed tables
 * on rulebook pages 6 and 16, plus the odds-rounding rule.
 */

import { describe, expect, it } from 'vitest';
import {
  clampRoll,
  gunDamage,
  gunToHit,
  hitLocation,
  oddsColumn,
  otherDamage,
  rangeModifier,
  velocityModifier,
} from '../src/engine/crt.js';
import { createRng, rollDie, shuffle } from '../src/engine/rng.js';

describe('oddsColumn', () => {
  it('reduces the rulebook’s worked example to 2:1', () => {
    // "A corsair (combat strength 4) attacks a corvette (combat strength 2).
    //  4 to 2 reduces to 2-to-1"
    expect(oddsColumn(4, 2)).toBe('2:1');
  });

  it('rounds in favour of the defender', () => {
    expect(oddsColumn(5, 2)).toBe('2:1'); // 2.5 -> 2:1, not 3:1
    expect(oddsColumn(7, 2)).toBe('3:1'); // 3.5 -> 3:1
    expect(oddsColumn(3, 4)).toBe('1:2'); // 0.75 -> 1:2, not 1:1
    expect(oddsColumn(1, 3)).toBe('1:4'); // 0.33 -> 1:4
  });

  it('caps at 4:1 and floors at 1:4', () => {
    expect(oddsColumn(100, 1)).toBe('4:1');
    expect(oddsColumn(1, 5)).toBeNull(); // "Attacks at less than 1:4 have no effect."
    expect(oddsColumn(0, 5)).toBeNull();
  });

  it('treats exact column values as that column', () => {
    expect(oddsColumn(1, 1)).toBe('1:1');
    expect(oddsColumn(1, 2)).toBe('1:2');
    expect(oddsColumn(1, 4)).toBe('1:4');
    expect(oddsColumn(3, 1)).toBe('3:1');
  });
});

describe('gun combat damage table', () => {
  it('matches the printed table exactly', () => {
    const table: Record<string, (number | 'E' | null)[]> = {
      '1:4': [null, null, null, null, null, 1],
      '1:2': [null, null, null, null, 2, 3],
      '1:1': [null, null, null, 2, 3, 4],
      '2:1': [null, null, 2, 3, 4, 5],
      '3:1': [null, 2, 3, 4, 5, 'E'],
      '4:1': [2, 3, 4, 5, 'E', 'E'],
    };
    for (const [col, expected] of Object.entries(table)) {
      for (let roll = 1; roll <= 6; roll++) {
        expect(gunDamage(col as never, roll)).toEqual(expected[roll - 1]);
      }
    }
  });

  it('treats a roll modified below 1 as no effect and above 6 as 6', () => {
    // "A die roll modified to less than 1 has no effect.
    //  A die roll modified to more than 6 is 6."
    expect(clampRoll(0)).toBeNull();
    expect(clampRoll(-3)).toBeNull();
    expect(clampRoll(9)).toBe(6);
    expect(gunDamage('4:1', -1)).toBeNull();
    expect(gunDamage('4:1', 12)).toBe('E');
  });

  it('makes a range of 6 unsurvivable for the attacker’s odds', () => {
    // "Note that a range modification of -6 will mean that an attack cannot succeed."
    for (const col of ['1:4', '1:2', '1:1', '2:1', '3:1', '4:1'] as const) {
      for (let die = 1; die <= 6; die++) {
        expect(gunDamage(col, die + rangeModifier(6))).toBeNull();
      }
    }
  });
});

describe('other damage table', () => {
  it('matches the printed table exactly', () => {
    const table = {
      torpedo: [null, 1, 1, 1, 2, 3],
      mine: [null, null, null, null, 2, 2],
      asteroid: [null, null, null, null, 1, 2],
      ram: [null, null, 1, 1, 3, 5],
    } as const;
    for (const [kind, expected] of Object.entries(table)) {
      for (let roll = 1; roll <= 6; roll++) {
        expect(otherDamage(kind as never, roll)).toEqual(expected[roll - 1]);
      }
    }
  });
});

describe('modifiers', () => {
  it('subtracts one per hex of range', () => {
    expect(rangeModifier(0)).toBe(0);
    expect(rangeModifier(4)).toBe(-4);
  });

  it('subtracts one per hex of velocity difference over two', () => {
    // "in Figure 9, the velocity difference is 2; there is no die modifier"
    expect(velocityModifier(0)).toBe(0);
    expect(velocityModifier(2)).toBe(0);
    expect(velocityModifier(3)).toBe(-1);
    expect(velocityModifier(6)).toBe(-4);
  });
});

describe('advanced combat tables', () => {
  it('matches the printed to-hit table', () => {
    const table = {
      '1:4': [0, 0, 0, 0, 0, 1],
      '1:2': [0, 0, 0, 0, 1, 1],
      '1:1': [0, 0, 0, 1, 1, 2],
      '2:1': [0, 0, 1, 1, 2, 2],
      '3:1': [0, 1, 1, 2, 2, 3],
      '4:1': [1, 1, 2, 2, 3, 3],
    } as const;
    for (const [col, expected] of Object.entries(table)) {
      for (let roll = 1; roll <= 6; roll++) {
        expect(gunToHit(col as never, roll)).toBe(expected[roll - 1]);
      }
    }
  });

  it('maps hit locations per the rulebook', () => {
    expect(hitLocation(1)).toEqual({ weapon: 1, drive: 0, structure: 0 });
    expect(hitLocation(2)).toEqual({ weapon: 0, drive: 1, structure: 0 });
    expect(hitLocation(3)).toEqual({ weapon: 0, drive: 0, structure: 1 });
    expect(hitLocation(4)).toEqual({ weapon: 1, drive: 0, structure: 1 });
    expect(hitLocation(5)).toEqual({ weapon: 1, drive: 1, structure: 0 });
    expect(hitLocation(6)).toEqual({ weapon: 0, drive: 1, structure: 1 });
  });
});

describe('rng determinism', () => {
  it('produces the same sequence from the same seed', () => {
    const roll = (seed: number, n: number): number[] => {
      let s = createRng(seed);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const res = rollDie(s);
        s = res.state;
        out.push(res.value);
      }
      return out;
    };
    expect(roll(12345, 20)).toEqual(roll(12345, 20));
    expect(roll(12345, 20)).not.toEqual(roll(54321, 20));
  });

  it('rolls only 1 through 6, roughly uniformly', () => {
    let s = createRng(99);
    const counts = new Map<number, number>();
    for (let i = 0; i < 60000; i++) {
      const res = rollDie(s);
      s = res.state;
      expect(res.value).toBeGreaterThanOrEqual(1);
      expect(res.value).toBeLessThanOrEqual(6);
      counts.set(res.value, (counts.get(res.value) ?? 0) + 1);
    }
    for (const face of [1, 2, 3, 4, 5, 6]) {
      // Each face should land near 10000; allow generous slack.
      expect(counts.get(face)!).toBeGreaterThan(9000);
      expect(counts.get(face)!).toBeLessThan(11000);
    }
  });

  it('shuffles deterministically and preserves membership', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(createRng(7), items);
    const b = shuffle(createRng(7), items);
    expect(a.items).toEqual(b.items);
    expect([...a.items].sort()).toEqual(items);
  });
});
