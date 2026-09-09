/**
 * The combat forecast: "what happens if I fire?", answered exactly.
 *
 * A gun attack is decided by one die, so the odds are a count of six faces, not
 * an estimate. That makes the forecast checkable against the printed damage
 * table — which is the point of showing it at all: a player should be able to
 * trust the headline without opening the arithmetic underneath it.
 *
 * These tests are written from the table and the damage rule, not from the
 * forecast function, so a forecast that quietly disagreed with the CRT would
 * fail here rather than being confirmed by its own output.
 */

import { describe, expect, it } from 'vitest';
import {
  DESTRUCTION_THRESHOLD,
  ODDS_COLUMNS,
  gunDamage,
  type OddsColumn,
} from '../src/engine/crt.js';
import { makeShip } from '../src/engine/state.js';
import type { Ship } from '../src/engine/types.js';
import { hex } from '../src/engine/hex.js';
import { forecastOf } from '../src/engine/combat.js';

// The printed columns, taken from the engine rather than retyped — a column
// this file invented would test nothing.
const COLUMNS: readonly OddsColumn[] = ODDS_COLUMNS;

const hull = (disabled = 0): Ship => ({
  ...makeShip({ id: 't', owner: 'b', shipClass: 'corsair', pos: hex(0, 0) }),
  disabled,
});

describe('the forecast counts the die, and counts it right', () => {
  it('always accounts for exactly six faces', () => {
    for (const column of COLUMNS) {
      for (let mod = -3; mod <= 3; mod += 1) {
        const f = forecastOf(column, mod, [hull()]);
        expect({ column, mod, total: f.destroy + f.damage + f.nothing }).toEqual({
          column,
          mod,
          total: 6,
        });
      }
    }
  });

  it('agrees with the printed damage table, face by face', () => {
    // Recount independently here: an "E" is a kill, a null is nothing, and any
    // D result against a fresh hull is damage.
    for (const column of COLUMNS) {
      for (let mod = -2; mod <= 2; mod += 1) {
        let destroy = 0;
        let damage = 0;
        let nothing = 0;
        for (let face = 1; face <= 6; face += 1) {
          const r = gunDamage(column, face + mod);
          if (r === null) nothing += 1;
          else if (r === 'E') destroy += 1;
          else damage += 1;
        }
        expect({ column, mod, ...forecastOf(column, mod, [hull()]) }).toEqual({
          column,
          mod,
          destroy,
          damage,
          nothing,
          finishes: false,
        });
      }
    }
  });

  it('counts a finishing blow on an already-damaged ship as a kill', () => {
    // "Damage is cumulative... if a ship ever reaches a condition of D6 or
    // greater, it is destroyed" — so the same roll against the same odds is
    // deadlier to a ship that is already hurt, and the forecast has to say so.
    const fresh = forecastOf('2:1', 0, [hull(0)]);
    const hurt = forecastOf('2:1', 0, [hull(DESTRUCTION_THRESHOLD - 1)]);

    expect(hurt.destroy).toBeGreaterThan(fresh.destroy);
    expect(hurt.finishes).toBe(true);
    expect(fresh.finishes).toBe(false);
    // Nothing is invented: the extra kills come out of the damage column.
    expect(hurt.destroy + hurt.damage).toBe(fresh.destroy + fresh.damage);
  });

  it('treats a hopeless attack as six blanks', () => {
    // "Attacks at worse than 1:4 have no effect" — there is no column, so there
    // is nothing to roll for.
    expect(forecastOf(null, 0, [hull()])).toEqual({
      destroy: 0,
      damage: 0,
      nothing: 6,
      finishes: false,
    });
  });

  it('reads the worst case across a target group', () => {
    // In the basic system one roll applies to every ship attacked together, so a
    // face that finishes any one of them is a face that kills.
    const mixed = forecastOf('2:1', 0, [hull(0), hull(DESTRUCTION_THRESHOLD - 1)]);
    expect(mixed.finishes).toBe(true);
    expect(mixed.destroy).toBe(forecastOf('2:1', 0, [hull(DESTRUCTION_THRESHOLD - 1)]).destroy);
  });

  it('gets better as the odds improve, and worse as the modifier drops', () => {
    // A sanity property rather than a specific number: the forecast must move in
    // the direction the rules move.
    const atOdds = (c: OddsColumn): number => forecastOf(c, 0, [hull()]).nothing;
    expect(atOdds('4:1')).toBeLessThanOrEqual(atOdds('1:1'));
    expect(atOdds('1:1')).toBeLessThanOrEqual(atOdds('1:4'));

    const atMod = (m: number): number => forecastOf('2:1', m, [hull()]).nothing;
    expect(atMod(2)).toBeLessThanOrEqual(atMod(0));
    expect(atMod(0)).toBeLessThanOrEqual(atMod(-2));
  });
});
