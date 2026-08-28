/**
 * Unit and Ogre statistics, against the official Ogre Record Sheets (SJG,
 * 10/15/12), the Size Table, 13.03 and 1.09, and the odds quoted in 7.13.1 and
 * the Example of Play.
 *
 * The few values that remain unconfirmed are flagged in `units.ts`; this file
 * asserts that the flags exist, so the list in docs/RULES-MAPPING.md cannot
 * silently go stale.
 */

import { describe, expect, it } from 'vitest';
import { oddsFor } from '../../src/ogre/engine/crt.js';
import {
  OGRE_TYPES,
  OGRE_WEAPONS,
  movementForTreads,
  ogreType,
} from '../../src/ogre/engine/ogres.js';
import { UNIT_CLASSES, unitClass } from '../../src/ogre/engine/units.js';

const column = (a: number, d: number): string => {
  const odds = oddsFor(a, d);
  return odds.kind === 'column' ? odds.column : odds.kind;
};

describe('Ogre weapons (Mark V record sheet, reproduced in the rules)', () => {
  it('has the printed attack, range and defence', () => {
    expect(OGRE_WEAPONS.main).toMatchObject({ attack: 4, range: 3, defense: 4 });
    expect(OGRE_WEAPONS.secondary).toMatchObject({ attack: 3, range: 2, defense: 3 });
    expect(OGRE_WEAPONS.ap).toMatchObject({ attack: 1, range: 1, defense: 1 });
    expect(OGRE_WEAPONS.missile).toMatchObject({ attack: 6, range: 5, defense: 3 });
  });

  it('gives the missile rack the record sheet’s DEF 4', () => {
    // The rack is tougher than the missile it throws: the record sheets print
    // "MISSILE RACKS DEF 4" against "MISSILES ATK 6 RNG 5 DEF 3".
    expect(OGRE_WEAPONS.missileRack.defense).toBe(4);
    expect(OGRE_WEAPONS.missile.defense).toBe(3);
  });

  it('gives the Mark V its printed inventory', () => {
    const mk5 = ogreType('MK5');
    expect(mk5.weapons).toEqual({ main: 2, secondary: 6, ap: 12, missile: 6 });
    expect(mk5.treads).toBe(60);
    expect(mk5.baseMove).toBe(3);
    expect(mk5.size).toBe(8);
    expect(mk5.armorUnits).toBe(25);
    expect(mk5.vp).toBe(150);
  });

  // Transcribed card by card from the record sheets.
  it('matches every record sheet', () => {
    const expected: Record<
      string,
      { w: Record<string, number>; im: number; t: number; m: number; au: number; sz: number }
    > = {
      MK1: { w: { main: 1, ap: 4 }, im: 0, t: 18, m: 3, au: 4, sz: 5 },
      MK2: { w: { main: 1, secondary: 2, ap: 6 }, im: 0, t: 30, m: 3, au: 8, sz: 6 },
      MK3: { w: { main: 1, secondary: 4, ap: 8, missile: 2 }, im: 0, t: 45, m: 3, au: 17, sz: 7 },
      MK3B: { w: { main: 2, secondary: 4, ap: 8, missile: 4 }, im: 0, t: 48, m: 3, au: 20, sz: 7 },
      MK4: {
        w: { main: 1, secondary: 2, ap: 8, missileRack: 3 },
        im: 15,
        t: 56,
        m: 4,
        au: 25,
        sz: 8,
      },
      MK5: { w: { main: 2, secondary: 6, ap: 12, missile: 6 }, im: 0, t: 60, m: 3, au: 25, sz: 8 },
      MK6: {
        w: { main: 3, secondary: 6, ap: 16, missile: 6, missileRack: 3 },
        im: 12,
        t: 72,
        m: 3,
        au: 40,
        sz: 9,
      },
      FENCER: { w: { secondary: 2, ap: 8, missileRack: 4 }, im: 20, t: 48, m: 3, au: 22, sz: 8 },
      FENCER_B: { w: { main: 2, ap: 8, missileRack: 4 }, im: 20, t: 48, m: 3, au: 23, sz: 8 },
      DOPPELSOLDNER: {
        w: { main: 2, secondary: 8, ap: 12, missileRack: 6 },
        im: 20,
        t: 60,
        m: 3,
        au: 40,
        sz: 9,
      },
      NINJA: {
        w: { main: 1, secondary: 2, ap: 8, missile: 2, missileRack: 1 },
        im: 4,
        t: 40,
        m: 4,
        au: 25,
        sz: 7,
      },
      VULCAN: { w: { arm: 2, secondary: 2, ap: 6 }, im: 0, t: 48, m: 4, au: 25, sz: 7 },
    };

    for (const [id, e] of Object.entries(expected)) {
      const o = OGRE_TYPES[id as keyof typeof OGRE_TYPES];
      expect({ id, ...o.weapons }).toEqual({ id, ...e.w });
      expect({ id, treads: o.treads }).toEqual({ id, treads: e.t });
      expect({ id, im: o.internalMissiles }).toEqual({ id, im: e.im });
      expect({ id, move: o.baseMove }).toEqual({ id, move: e.m });
      expect({ id, au: o.armorUnits }).toEqual({ id, au: e.au });
      expect({ id, size: o.size }).toEqual({ id, size: e.sz });
    }
  });

  // The Fencer-B trades the Fencer's light railguns for main batteries; it has
  // no secondary battery at all, which is easy to "fix" by mistake.
  it('leaves the Fencer without a main battery and the Fencer-B without secondaries', () => {
    expect(ogreType('FENCER').weapons.main).toBeUndefined();
    expect(ogreType('FENCER_B').weapons.secondary).toBeUndefined();
  });

  // "The Ninja carries a main battery and two secondary batteries. It has a
  // single missile rack and four internal missiles; two more missiles are
  // mounted externally. It has eight AP batteries. A Ninja starts with a move
  // of 4 and 40 tread units." (14.02)
  it('gives the Ninja its stated inventory', () => {
    const ninja = ogreType('NINJA');
    expect(ninja.weapons).toEqual({ main: 1, secondary: 2, ap: 8, missile: 2, missileRack: 1 });
    expect(ninja.internalMissiles).toBe(4);
    expect(ninja.baseMove).toBe(4);
    expect(ninja.treads).toBe(40);
  });

  // "all it has are two secondary batteries and six AP guns" ... "It starts
  // with a move of 4 hexes. It has 48 tread units." ... "Each arm ... has D2."
  it('gives the Vulcan its stated inventory', () => {
    const vulcan = ogreType('VULCAN');
    expect(vulcan.weapons).toEqual({ arm: 2, secondary: 2, ap: 6 });
    expect(vulcan.treads).toBe(48);
    expect(vulcan.baseMove).toBe(4);
    expect(OGRE_WEAPONS.arm.defense).toBe(2);
  });
});

describe('the tread track (3.04.2, 6.04)', () => {
  // "when a Mark V is reduced to 40 tread units, its movement is reduced from
  // 3 to 2" — and 6.04's example puts the boundary at 41.
  it('drops the Mark V from 3 to 2 at exactly 40 treads', () => {
    const mk5 = ogreType('MK5');
    expect(movementForTreads(mk5, 60)).toBe(3);
    expect(movementForTreads(mk5, 41)).toBe(3);
    expect(movementForTreads(mk5, 40)).toBe(2);
    expect(movementForTreads(mk5, 21)).toBe(2);
    expect(movementForTreads(mk5, 20)).toBe(1);
    expect(movementForTreads(mk5, 1)).toBe(1);
  });

  // "When the Ogre's tread units are all gone, the Ogre can no longer move at
  // all. It can still fire at anything within range."
  it('immobilises an Ogre with no treads left', () => {
    expect(movementForTreads(ogreType('MK5'), 0)).toBe(0);
    expect(movementForTreads(ogreType('MK3'), 0)).toBe(0);
  });

  it('gives a Mark IV a four-step track for its four movement points', () => {
    const mk4 = ogreType('MK4');
    expect(movementForTreads(mk4, mk4.treads)).toBe(4);
    expect(movementForTreads(mk4, 43)).toBe(4);
    expect(movementForTreads(mk4, 42)).toBe(3);
    expect(movementForTreads(mk4, 1)).toBe(1);
  });

  /**
   * The evidence that "equal bands" is the right reading of the printed track:
   * every Ogre's tread count divides exactly by its starting movement. 18/3,
   * 45/3, 56/4, 60/3, 72/3, 40/4, 48/4 — twelve for twelve, which would be a
   * remarkable coincidence if the track were anything else.
   */
  it('divides every tread count exactly by its starting movement', () => {
    for (const type of Object.values(OGRE_TYPES)) {
      expect({ id: type.id, remainder: type.treads % type.baseMove }).toEqual({
        id: type.id,
        remainder: 0,
      });
    }
  });
});

describe('conventional units', () => {
  // "A Missile Tank could fire on a gun from the secondary battery at 1-1, a
  // missile at 1-1, an AP gun at 3-1, or a main battery at 1-2. A Howitzer
  // could attack a secondary at 2-1." (7.13.1)
  it('reproduces the odds quoted in 7.13.1', () => {
    const msl = unitClass('MSL').attack;
    expect(column(msl, OGRE_WEAPONS.secondary.defense)).toBe('1-1');
    expect(column(msl, OGRE_WEAPONS.missile.defense)).toBe('1-1');
    expect(column(msl, OGRE_WEAPONS.ap.defense)).toBe('3-1');
    expect(column(msl, OGRE_WEAPONS.main.defense)).toBe('1-2');
    expect(column(unitClass('HWZ').attack, OGRE_WEAPONS.secondary.defense)).toBe('2-1');
  });

  // From the Example of Play, both directions.
  it('reproduces the Example of Play', () => {
    const main = OGRE_WEAPONS.main.attack;
    const secondary = OGRE_WEAPONS.secondary.attack;
    const ap = OGRE_WEAPONS.ap.attack;

    expect(column(main, unitClass('LGEV').defense)).toBe('4-1');
    expect(column(secondary, unitClass('HVY').defense)).toBe('1-1');
    expect(column(secondary, unitClass('GEV').defense)).toBe('1-1');
    expect(column(ap * 3, 3)).toBe('1-1'); // 3 AP on a 3-squad counter
    expect(column(ap * 2, 1)).toBe('2-1'); // 2 AP on a single squad
    expect(column(secondary * 2, unitClass('GEV').defense)).toBe('3-1');
    expect(column(main, unitClass('GEV').defense)).toBe('2-1');
    expect(oddsFor(secondary * 2 + main, unitClass('GEV').defense).kind).toBe('auto');

    expect(column(unitClass('HVY').attack, OGRE_WEAPONS.main.defense)).toBe('1-1');
    expect(column(unitClass('MSL').attack, OGRE_WEAPONS.secondary.defense)).toBe('1-1');
    expect(column(unitClass('GEV').attack, OGRE_WEAPONS.main.defense)).toBe('1-2');
    expect(column(unitClass('HWZ').attack, OGRE_WEAPONS.secondary.defense)).toBe('2-1');
  });

  // "A Howitzer fires on a Superheavy Tank carrying two squads of infantry ...
  // The attack is a 3-to-1 on the two infantry ... but only a 1-to-1 on the
  // Superheavy." (5.11.2)
  it('reproduces the Superheavy example in 5.11.2', () => {
    expect(column(unitClass('HWZ').attack, 2)).toBe('3-1');
    expect(column(unitClass('HWZ').attack, unitClass('SHVY').defense)).toBe('1-1');
  });

  // "the Superheavy Tank (6*/3) may attack with two separate 3/3 attacks" (7.02)
  it('gives the Superheavy a splittable 6/3 and two AP', () => {
    const shvy = unitClass('SHVY');
    expect(shvy.attack).toBe(6);
    expect(shvy.range).toBe(3);
    expect(shvy.splitAttack).toBe(true);
    expect(shvy.ap).toBe(2);
  });

  // "It has Attack 2, Range 8, Defense 1, and Movement 0." (14.01)
  it('gives the Light Artillery Drone its stated line', () => {
    expect(unitClass('LAD')).toMatchObject({ attack: 2, range: 8, defense: 1, move: 0 });
  });

  // "A basic CP has a defense of 0, and will be destroyed by any attack." (3.05)
  it('leaves the command post at defence zero', () => {
    expect(unitClass('CP').defense).toBe(0);
    expect(oddsFor(1, 0).kind).toBe('auto');
  });

  it('prices the roster the way 1.07 and 1.08 do', () => {
    expect(unitClass('LT').armorUnits).toBe(0.5);
    expect(unitClass('LGEV').armorUnits).toBe(0.5);
    expect(unitClass('HWZ').armorUnits).toBe(2);
    expect(unitClass('MHWZ').armorUnits).toBe(2);
    expect(unitClass('SHVY').armorUnits).toBe(2);
    expect(unitClass('MCRL').armorUnits).toBe(3);
    expect(unitClass('INF').vp).toBe(2);
    expect(unitClass('MAR').vp).toBe(4);
    expect(unitClass('HVY').vp).toBe(6);
    expect(unitClass('HWZ').vp).toBe(12);
  });

  // "A regular GEV has a movement of 4-3." (5.05)
  it('gives the GEV two movement phases', () => {
    expect(unitClass('GEV').move).toBe(4);
    expect(unitClass('GEV').secondMove).toBe(3);
  });
});

describe('provenance', () => {
  it('leaves nothing flagged that a published table settles', () => {
    // These were all flagged until the unit summary and the record sheets
    // arrived. If a flag comes back here, docs/RULES-MAPPING.md is telling
    // players to check something that is no longer in doubt.
    for (const id of ['HVY', 'MSL', 'LT', 'SHVY', 'HWZ', 'MHWZ', 'GEV', 'LGEV', 'GEVPC'] as const) {
      expect({ id, flags: UNIT_CLASSES[id].unconfirmed }).toEqual({ id, flags: undefined });
    }
    expect(UNIT_CLASSES.INF.unconfirmed).toBeUndefined();
  });

  it('still flags the units no table covers', () => {
    // No published summary lists the Truck, the Hovertruck or the Missile
    // Crawler, and none of the three appears in a worked example.
    expect(UNIT_CLASSES.TK.unconfirmed).toContain('move');
    expect(UNIT_CLASSES.MCRL.unconfirmed).toContain('defense');
  });

  it('every class carries a provenance note', () => {
    for (const cls of Object.values(UNIT_CLASSES)) {
      expect(cls.note.length).toBeGreaterThan(20);
    }
  });
});
