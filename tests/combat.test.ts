/**
 * Combat modifier tests.
 *
 * Range and relative velocity are the two rules a plausible implementation is
 * most likely to get subtly wrong, because neither is measured between the two
 * ships' final positions. Range runs from the attacker's *closest approach
 * along its course* to the target's *final* hex, and relative velocity is the
 * separation of the two course vectors drawn from a common origin.
 */

import { describe, expect, it } from 'vitest';
import {
  type GameState,
  type Ship,
  DEFAULT_MAP,
  createInitialState,
  add,
  hex,
  makePlayer,
  makeShip,
  sub,
} from '../src/engine/index.js';
import { previewAttack } from '../src/engine/combat.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

/** Deep space, clear of every body and the belt. */
const CLEAR = hex(0, 9);

const arena = (ships: readonly Ship[]): GameState =>
  createInitialState({
    scenarioId: 'test',
    seed: 5,
    players: [makePlayer(A, 'A', 'Alpha', '#e8703a'), makePlayer(B, 'B', 'Beta', '#4a9fe0')],
    ships,
  });

/**
 * A ship that arrived at `pos` having flown `velocity` to get there — the
 * engine reconstructs its course as `pos - velocity -> pos`.
 */
const flew = (
  id: string,
  owner: string,
  shipClass: Ship['shipClass'],
  pos: ReturnType<typeof hex>,
  velocity = hex(0, 0),
): Ship => makeShip({ id, owner, shipClass, pos, velocity });

describe('range', () => {
  it('is zero when the attacker ends in the target’s hex', () => {
    const s = arena([
      flew('atk', A, 'corsair', CLEAR),
      flew('def', B, 'corvette', CLEAR),
    ]);
    const p = previewAttack(s, ['atk'], ['def'], map);
    expect(p.legal).toBe(true);
    expect(p.range).toBe(0);
  });

  it('counts hexes between the two ships when both are stationary', () => {
    for (const d of [1, 2, 3, 4]) {
      const s = arena([
        flew('atk', A, 'corsair', CLEAR),
        flew('def', B, 'corvette', add(CLEAR, hex(d, 0))),
      ]);
      expect(previewAttack(s, ['atk'], ['def'], map).range).toBe(d);
    }
  });

  it('measures from the closest approach of the attacker’s course, not its endpoint', () => {
    // "This range is always measured from the attacker's closest approach to
    //  the target's final position."
    //
    // The attacker flew straight past the target and kept going: it ended four
    // hexes away, but it passed directly alongside on the way. Range is 1.
    const target = add(CLEAR, hex(2, 1));
    const attackerEnd = add(CLEAR, hex(5, 0));
    const s = arena([
      // Course runs CLEAR -> CLEAR+(5,0); the target sits one hex off that line.
      flew('atk', A, 'corsair', attackerEnd, hex(5, 0)),
      flew('def', B, 'corvette', target),
    ]);

    const p = previewAttack(s, ['atk'], ['def'], map);
    // Naive "distance between final positions" would give 3, not 1.
    expect(add(CLEAR, hex(0, 0))).toEqual(sub(attackerEnd, hex(5, 0)));
    expect(p.range).toBe(1);
  });

  it('uses the greatest range across several targets', () => {
    // "In multiple ship attacks, use the greatest range applicable."
    const s = arena([
      flew('atk', A, 'frigate', CLEAR),
      flew('d1', B, 'corvette', add(CLEAR, hex(2, 0))),
      flew('d2', B, 'corvette', add(CLEAR, hex(2, 0))),
    ]);
    expect(previewAttack(s, ['atk'], ['d1', 'd2'], map).range).toBe(2);
  });
});

describe('relative velocity', () => {
  const withVelocities = (va: ReturnType<typeof hex>, vb: ReturnType<typeof hex>): number => {
    const s = arena([
      flew('atk', A, 'corsair', CLEAR, va),
      flew('def', B, 'corvette', CLEAR, vb),
    ]);
    return previewAttack(s, ['atk'], ['def'], map).relativeVelocity;
  };

  it('is zero for two ships on the same vector', () => {
    expect(withVelocities(hex(3, 0), hex(3, 0))).toBe(0);
  });

  it('is the separation of the two course vectors from a common origin', () => {
    // Rulebook Figure 9: plot the second course from the first's tail; the gap
    // between the two heads is the velocity difference.
    expect(withVelocities(hex(2, 0), hex(0, 0))).toBe(2);
    expect(withVelocities(hex(3, 0), hex(0, 0))).toBe(3);
    // Head-on: velocities +2 and -2 differ by 4, not 0.
    expect(withVelocities(hex(2, 0), hex(-2, 0))).toBe(4);
  });

  it('applies no penalty up to a difference of two, then one per hex', () => {
    // "Subtract 1 from the combat die roll for each hex of velocity difference
    //  greater than 2. For example, in Figure 9, the velocity difference is 2;
    //  there is no die modifier."
    const modFor = (va: ReturnType<typeof hex>, vb: ReturnType<typeof hex>): number => {
      const s = arena([
        flew('atk', A, 'corsair', CLEAR, va),
        flew('def', B, 'corvette', CLEAR, vb),
      ]);
      return previewAttack(s, ['atk'], ['def'], map).modifiers.relativeVelocity;
    };
    expect(modFor(hex(2, 0), hex(0, 0))).toBe(0);
    expect(modFor(hex(3, 0), hex(0, 0))).toBe(-1);
    expect(modFor(hex(5, 0), hex(0, 0))).toBe(-3);
  });
});

describe('odds', () => {
  it('pools multiple attackers and sums the defenders', () => {
    // "Multiple attacking ships... may attack with the sum of their combat
    //  strengths." / "Any combination of ships attacked together defends with
    //  the sum of their combat strengths."
    const s = arena([
      flew('a1', A, 'corvette', CLEAR), // 2
      flew('a2', A, 'corvette', CLEAR), // 2
      flew('d1', B, 'corvette', add(CLEAR, hex(1, 0))), // 2
    ]);
    const p = previewAttack(s, ['a1', 'a2'], ['d1'], map);
    expect(p.attackStrength).toBe(4);
    expect(p.defenceStrength).toBe(2);
    expect(p.column).toBe('2:1');
  });

  it('rounds the column in favour of the defender', () => {
    // A frigate (8) against a corsair (4) and a corvette (2) is 8:6, which is
    // 1.33 -- and so 1:1, not 2:1.
    const s = arena([
      flew('atk', A, 'frigate', CLEAR),
      flew('d1', B, 'corsair', add(CLEAR, hex(1, 0))),
      flew('d2', B, 'corvette', add(CLEAR, hex(1, 0))),
    ]);
    const p = previewAttack(s, ['atk'], ['d1', 'd2'], map);
    expect(p.attackStrength).toBe(8);
    expect(p.defenceStrength).toBe(6);
    expect(p.column).toBe('1:1');
  });

  it('honours a limited attack', () => {
    // "A ship may always attack or counterattack with less than its rated
    //  combat strength, if it hopes to disable a target without destroying it."
    const s = arena([
      flew('atk', A, 'dreadnaught', CLEAR), // 15
      flew('def', B, 'corvette', add(CLEAR, hex(1, 0))), // 2
    ]);
    expect(previewAttack(s, ['atk'], ['def'], map).column).toBe('4:1');
    expect(previewAttack(s, ['atk'], ['def'], map, 2).column).toBe('1:1');
  });
});
