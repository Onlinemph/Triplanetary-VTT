/**
 * The Combat Results Table and the odds ladder, checked against every worked
 * example the rulebook prints.
 */

import { describe, expect, it } from 'vitest';
import { CRT, describeOdds, oddsFor, resolve } from '../../src/ogre/engine/crt.js';

describe('the odds ladder (7.10)', () => {
  // "Combat odds are always rounded off in favor of the defender."
  it('reduces a ratio in the defender’s favour', () => {
    expect(oddsFor(2, 1)).toEqual({ kind: 'column', column: '2-1' });
    expect(oddsFor(4, 2)).toEqual({ kind: 'column', column: '2-1' });
    expect(oddsFor(6, 3)).toEqual({ kind: 'column', column: '2-1' });
    expect(oddsFor(2, 2)).toEqual({ kind: 'column', column: '1-1' });
    // "Attack strength 3 vs. defense strength 2 = still only a 1-1. There's not
    // enough attack strength for a 2-1 attack, so it rounds down."
    expect(oddsFor(3, 2)).toEqual({ kind: 'column', column: '1-1' });
    expect(oddsFor(2, 3)).toEqual({ kind: 'column', column: '1-2' });
  });

  it('treats 5-1 and better as an automatic kill', () => {
    expect(oddsFor(6, 1)).toEqual({ kind: 'auto' });
    expect(oddsFor(5, 1)).toEqual({ kind: 'auto' });
    expect(oddsFor(10, 2)).toEqual({ kind: 'auto' });
  });

  it('treats worse than 1-2 as no attack at all', () => {
    expect(oddsFor(1, 3)).toEqual({ kind: 'none' });
    expect(oddsFor(2, 5)).toEqual({ kind: 'none' });
  });

  it('destroys a zero-defence unit automatically (3.05)', () => {
    expect(oddsFor(1, 0)).toEqual({ kind: 'auto' });
  });

  // Spillover is "half the strength (not rounded)" (7.12) and a disabled unit
  // in an overrun fires at "half its printed attack strength (not rounded)"
  // (8.02), so fractional strengths have to survive the ladder.
  it('keeps fractional attack strengths', () => {
    expect(oddsFor(1.5, 3)).toEqual({ kind: 'column', column: '1-2' });
    expect(oddsFor(1.5, 2)).toEqual({ kind: 'column', column: '1-2' });
    // 1.5 against 4 is 0.375 — below 1-2, so nothing happens at all.
    expect(oddsFor(1.5, 4)).toEqual({ kind: 'none' });
    expect(oddsFor(3, 3)).toEqual({ kind: 'column', column: '1-1' });
  });

  it('announces odds the way a player would (7.08)', () => {
    expect(describeOdds(oddsFor(4, 1))).toBe('4 to 1');
    expect(describeOdds(oddsFor(2, 3))).toBe('1 to 2');
  });
});

describe('the printed table', () => {
  it('matches the rulebook row for row', () => {
    expect(CRT['1-2']).toEqual(['NE', 'NE', 'NE', 'NE', 'D', 'X']);
    expect(CRT['1-1']).toEqual(['NE', 'NE', 'D', 'D', 'X', 'X']);
    expect(CRT['2-1']).toEqual(['NE', 'D', 'D', 'X', 'X', 'X']);
    expect(CRT['3-1']).toEqual(['D', 'D', 'X', 'X', 'X', 'X']);
    expect(CRT['4-1']).toEqual(['D', 'X', 'X', 'X', 'X', 'X']);
  });

  // "each result on the CRT is 'taken down' one step. A D result is read as NE,
  // and an X is read as a D." (7.11.1)
  it('steps spillover results down', () => {
    const odds = oddsFor(3, 1);
    expect(resolve(odds, 1, 'normal')).toBe('D');
    expect(resolve(odds, 1, 'spillover')).toBe('NE');
    expect(resolve(odds, 3, 'normal')).toBe('X');
    expect(resolve(odds, 3, 'spillover')).toBe('D');
  });

  // "treat any D or X result to non-Ogre units as an X" (7.11.2)
  it('steps overrun results up', () => {
    const odds = oddsFor(1, 1);
    expect(resolve(odds, 3, 'normal')).toBe('D');
    expect(resolve(odds, 3, 'overrun')).toBe('X');
    expect(resolve(odds, 1, 'overrun')).toBe('NE');
  });
});
