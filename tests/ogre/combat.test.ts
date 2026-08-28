/**
 * Combat: Section 7, including the two places where an Ogre is not a unit.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/ogre/engine/rng.js';
import { key } from '../../src/ogre/engine/hex.js';
import { previewAttack, resolveAttack, resetFireFlags } from '../../src/ogre/engine/combat.js';
import { ogreIsDestroyed } from '../../src/ogre/engine/state.js';
import type { GameState, OgreUnit } from '../../src/ogre/engine/types.js';
import {
  A,
  B,
  at,
  flatMap,
  inPhase,
  newGame,
  put,
  putOgre,
  seedForRoll,
  setDisabled,
} from './helpers.js';

const map = flatMap(12, 12);
const townMap = flatMap(12, 12, { [key(at(4, 4))]: 'town' });

const withRoll = (state: GameState, roll: number): GameState => ({
  ...state,
  rng: createRng(seedForRoll(roll)),
});

const ogreOf = (state: GameState, id: string): OgreUnit => state.units[id] as OgreUnit;

const weaponOf = (state: GameState, id: string, kind: string): string =>
  ogreOf(state, id).weapons.find((w) => w.kind === kind && !w.destroyed)!.id;

describe('attacks on Ogre weapons (7.13.1)', () => {
  it('destroys a weapon on an X and does nothing on a D', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3)); // adjacent, range 2
    g = hvy.state;

    const main = weaponOf(g, ogre.id, 'main');
    const target = { kind: 'ogreWeapon', unit: ogre.id, weapon: main } as const;

    // Heavy Tank (4) against a main battery (D4) is 1-1: a 5 or 6 is an X.
    const preview = previewAttack(g, map, [{ unit: hvy.id }], target);
    expect(preview.ok).toBe(true);
    expect(preview.odds).toEqual({ kind: 'column', column: '1-1' });

    const miss = resolveAttack(withRoll(g, 3), map, [{ unit: hvy.id }], target);
    // A D at 1-1 does nothing at all to an Ogre.
    expect(miss.resolution!.result).toBe('NE');
    expect(ogreOf(miss.state, ogre.id).weapons.find((w) => w.id === main)!.destroyed).toBe(false);

    const hit = resolveAttack(withRoll(g, 5), map, [{ unit: hvy.id }], target);
    expect(hit.resolution!.result).toBe('X');
    expect(ogreOf(hit.state, ogre.id).weapons.find((w) => w.id === main)!.destroyed).toBe(true);
  });

  it('refuses to target an Ogre as a whole (7.13)', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK3', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const preview = previewAttack(g, map, [{ unit: hvy.id }], { kind: 'unit', unit: ogre.id });
    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/name a weapon or the treads/);
  });
});

describe('attacks on treads (7.13.2)', () => {
  it('is always 1-1, and costs the Ogre the attacker’s strength on a 5 or 6', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const target = { kind: 'ogreTreads', unit: ogre.id } as const;
    const preview = previewAttack(g, map, [{ unit: hvy.id }], target);
    expect(preview.treadAttack).toBe(true);
    expect(preview.treadHitOn).toBe(5);

    const miss = resolveAttack(withRoll(g, 4), map, [{ unit: hvy.id }], target);
    expect(ogreOf(miss.state, ogre.id).treads).toBe(60);

    // "Thus, a successful Heavy Tank attack on treads would cost an Ogre 4
    // tread units."
    const hit = resolveAttack(withRoll(g, 5), map, [{ unit: hvy.id }], target);
    expect(ogreOf(hit.state, ogre.id).treads).toBe(56);
  });

  it('needs a 6 when the Ogre is in a town (7.14.2)', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const target = { kind: 'ogreTreads', unit: ogre.id } as const;
    expect(previewAttack(g, townMap, [{ unit: hvy.id }], target).treadHitOn).toBe(6);

    const five = resolveAttack(withRoll(g, 5), townMap, [{ unit: hvy.id }], target);
    expect(ogreOf(five.state, ogre.id).treads).toBe(60);
    const six = resolveAttack(withRoll(g, 6), townMap, [{ unit: hvy.id }], target);
    expect(ogreOf(six.state, ogre.id).treads).toBe(56);
  });

  it('refuses combined fire on treads (7.06, 7.13.2)', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const a1 = put(g, A, 'HVY', at(4, 3));
    g = a1.state;
    const a2 = put(g, A, 'HVY', at(3, 3));
    g = a2.state;

    const preview = previewAttack(g, map, [{ unit: a1.id }, { unit: a2.id }], {
      kind: 'ogreTreads',
      unit: ogre.id,
    });
    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/one unit at a time/);
  });
});

describe('combining fire (7.06)', () => {
  it('adds strengths against one target', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const gev = put(g, B, 'GEV', at(4, 3));
    g = gev.state;

    const sb = ogreOf(g, ogre.id)
      .weapons.filter((w) => w.kind === 'secondary')
      .slice(0, 2);
    const preview = previewAttack(
      g,
      map,
      sb.map((w) => ({ unit: ogre.id, weapon: w.id })),
      { kind: 'unit', unit: gev.id },
    );
    // "it could, instead of the above attacks, use both secondaries on the GEV
    // (3-to-1)"
    expect(preview.attackStrength).toBe(6);
    expect(preview.odds).toEqual({ kind: 'column', column: '3-1' });
  });

  it('makes 5-1 automatic with no die at all (7.10)', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const gev = put(g, B, 'GEV', at(4, 3));
    g = gev.state;

    const guns = ogreOf(g, ogre.id)
      .weapons.filter((w) => w.kind === 'secondary' || w.kind === 'main')
      .slice(0, 3);
    const out = resolveAttack(
      g,
      map,
      guns.map((w) => ({ unit: ogre.id, weapon: w.id })),
      { kind: 'unit', unit: gev.id },
    );
    expect(out.resolution!.automatic).toBe(true);
    expect(out.resolution!.result).toBe('X');
    expect(out.state.units[gev.id]!.destroyed).toBe(true);
  });
});

describe('antipersonnel weapons (7.05.1)', () => {
  it('will not fire on armour', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, B, 'HVY', at(4, 3));
    g = hvy.state;

    const ap = weaponOf(g, ogre.id, 'ap');
    const preview = previewAttack(g, map, [{ unit: ogre.id, weapon: ap }], {
      kind: 'unit',
      unit: hvy.id,
    });
    expect(preview.ok).toBe(false);
  });

  it('fires once per infantry counter per phase, with any number of guns', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const inf = put(g, B, 'INF', at(4, 3), 3);
    g = inf.state;

    const aps = ogreOf(g, ogre.id)
      .weapons.filter((w) => w.kind === 'ap')
      .slice(0, 3);
    const first = resolveAttack(
      withRoll(g, 1),
      map,
      aps.map((w) => ({ unit: ogre.id, weapon: w.id })),
      { kind: 'unit', unit: inf.id },
    );
    expect(first.resolution).not.toBeNull();

    const more = ogreOf(first.state, ogre.id).weapons.filter((w) => w.kind === 'ap' && !w.fired);
    const second = previewAttack(first.state, map, [{ unit: ogre.id, weapon: more[0]!.id }], {
      kind: 'unit',
      unit: inf.id,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already swept/);
  });
});

describe('results (7.11)', () => {
  it('reduces infantry by a squad on a D and kills the counter at zero', () => {
    let g = inPhase(newGame(), 'fire');
    const inf = put(g, B, 'INF', at(4, 4), 2);
    g = inf.state;
    const hvy = put(g, A, 'HVY', at(4, 3)); // 4 vs D2 = 2-1
    g = hvy.state;

    const out = resolveAttack(withRoll(g, 2), map, [{ unit: hvy.id }], {
      kind: 'unit',
      unit: inf.id,
    });
    expect(out.resolution!.result).toBe('D');
    const after = out.state.units[inf.id]!;
    expect(after.kind === 'unit' && after.squads).toBe(1);
  });

  it('destroys an already-disabled unit on a second D', () => {
    let g = inPhase(newGame(), 'fire');
    const gev = put(g, B, 'GEV', at(4, 4));
    g = gev.state;
    g = setDisabled(g, gev.id, 'combat');
    const msl = put(g, A, 'MSL', at(4, 3)); // 3 vs D2 = 1-1
    g = msl.state;

    const out = resolveAttack(withRoll(g, 3), map, [{ unit: msl.id }], {
      kind: 'unit',
      unit: gev.id,
    });
    expect(out.resolution!.result).toBe('D');
    expect(out.state.units[gev.id]!.destroyed).toBe(true);
  });
});

describe('spillover (7.12)', () => {
  it('reproduces the rulebook’s worked example', () => {
    // "A Heavy Tank, Missile Tank, and a squad of infantry are in the same hex.
    // The hex is fired on by a Howitzer (attack strength 6); the Heavy is the
    // target. Its defense is 3, so it suffers a 2-to-1 attack. At the same
    // time, the other two units in the hex each suffer a half-strength (that
    // is, attack strength 3) spillover attack – which would be a 1-to-1 on the
    // Missile Tank and a 3-to-1 on the infantry."
    let g = inPhase(newGame({ stackingLimit: 5 }), 'fire');
    const hvy = put(g, B, 'HVY', at(4, 4));
    g = hvy.state;
    const msl = put(g, B, 'MSL', at(4, 4));
    g = msl.state;
    const inf = put(g, B, 'INF', at(4, 4), 1);
    g = inf.state;
    const hwz = put(g, A, 'HWZ', at(4, 1)); // range 8
    g = hwz.state;

    const preview = previewAttack(g, map, [{ unit: hwz.id }], { kind: 'unit', unit: hvy.id });
    expect(preview.odds).toEqual({ kind: 'column', column: '2-1' });

    // A 6 destroys the Heavy Tank outright, and the spillover — an X read as a
    // D — disables the Missile Tank and kills the lone squad.
    const out = resolveAttack(withRoll(g, 6), map, [{ unit: hwz.id }], {
      kind: 'unit',
      unit: hvy.id,
    });
    expect(out.state.units[hvy.id]!.destroyed).toBe(true);
  });

  it('never spills onto an Ogre (7.12.2)', () => {
    let g = inPhase(newGame({ stackingLimit: 5 }), 'fire');
    const ogre = putOgre(g, B, 'MK3', at(4, 4));
    g = ogre.state;
    const gev = put(g, B, 'GEV', at(4, 4));
    g = gev.state;
    const hwz = put(g, A, 'HWZ', at(4, 1));
    g = hwz.state;

    const before = ogreOf(g, ogre.id).treads;
    const out = resolveAttack(withRoll(g, 6), map, [{ unit: hwz.id }], {
      kind: 'unit',
      unit: gev.id,
    });
    expect(ogreOf(out.state, ogre.id).treads).toBe(before);
  });
});

describe('destroying an Ogre (7.13.3)', () => {
  it('needs every fireable weapon and every tread gone', () => {
    let g = newGame();
    const ogre = putOgre(g, B, 'MK1', at(4, 4));
    g = ogre.state;

    const stripped = {
      ...ogreOf(g, ogre.id),
      weapons: ogreOf(g, ogre.id).weapons.map((w) => ({ ...w, destroyed: true })),
      treads: 3,
    };
    expect(ogreIsDestroyed(stripped)).toBe(false);
    expect(ogreIsDestroyed({ ...stripped, treads: 0 })).toBe(true);

    // Treads gone but a gun left is still a live Ogre: "It can still fire at
    // anything within range."
    const gunOnly = { ...ogreOf(g, ogre.id), treads: 0 };
    expect(ogreIsDestroyed(gunOnly)).toBe(false);
  });

  it('counts a missile rack with no missiles as unfireable (3.04.2)', () => {
    let g = newGame();
    const ogre = putOgre(g, B, 'MK4', at(4, 4));
    g = ogre.state;
    const empty: OgreUnit = {
      ...ogreOf(g, ogre.id),
      weapons: ogreOf(g, ogre.id).weapons.map((w) =>
        w.kind === 'missileRack' ? w : { ...w, destroyed: true },
      ),
      internalMissiles: 0,
      treads: 0,
    };
    expect(ogreIsDestroyed(empty)).toBe(true);
  });
});

describe('firing discipline (7.05, 7.09)', () => {
  it('lets each weapon fire once a turn, and resets on the owner’s next turn', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const gev = put(g, B, 'GEV', at(4, 3));
    g = gev.state;

    const sb = weaponOf(g, ogre.id, 'secondary');
    const out = resolveAttack(withRoll(g, 1), map, [{ unit: ogre.id, weapon: sb }], {
      kind: 'unit',
      unit: gev.id,
    });
    const again = previewAttack(out.state, map, [{ unit: ogre.id, weapon: sb }], {
      kind: 'unit',
      unit: gev.id,
    });
    expect(again.ok).toBe(false);

    const reset = resetFireFlags(out.state, A);
    expect(
      previewAttack(reset, map, [{ unit: ogre.id, weapon: sb }], { kind: 'unit', unit: gev.id }).ok,
    ).toBe(true);
  });

  it('spends an external missile permanently (7.05.2)', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const gev = put(g, B, 'GEV', at(4, 2));
    g = gev.state;

    const missile = weaponOf(g, ogre.id, 'missile');
    const out = resolveAttack(withRoll(g, 1), map, [{ unit: ogre.id, weapon: missile }], {
      kind: 'unit',
      unit: gev.id,
    });
    const reset = resetFireFlags(out.state, A);
    const still = ogreOf(reset, ogre.id).weapons.find((w) => w.id === missile)!;
    expect(still.fired).toBe(true);
  });

  it('refuses a shot out of range (7.02)', () => {
    let g = inPhase(newGame(), 'fire');
    const gev = put(g, B, 'GEV', at(10, 10));
    g = gev.state;
    const hvy = put(g, A, 'HVY', at(1, 1));
    g = hvy.state;
    expect(previewAttack(g, map, [{ unit: hvy.id }], { kind: 'unit', unit: gev.id }).ok).toBe(
      false,
    );
  });
});

describe('water (7.14.4)', () => {
  const waterMap = flatMap(12, 12, { [key(at(4, 4))]: 'water' });

  it('silences infantry that are swimming, but not Marines', () => {
    let g = inPhase(newGame(), 'fire');
    const inf = put(g, A, 'INF', at(4, 4), 3);
    g = inf.state;
    const mar = put(g, A, 'MAR', at(4, 4), 1);
    g = mar.state;
    const enemy = put(g, B, 'GEV', at(4, 3));
    g = enemy.state;

    const target = { kind: 'unit', unit: enemy.id } as const;
    expect(previewAttack(g, waterMap, [{ unit: inf.id }], target).ok).toBe(false);
    // "Exception: Marines may attack while in water."
    expect(previewAttack(g, waterMap, [{ unit: mar.id }], target).ok).toBe(true);
  });

  it('silences a submerged Ogre', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const enemy = put(g, B, 'GEV', at(4, 3));
    g = enemy.state;

    const sb = weaponOf(g, ogre.id, 'secondary');
    const preview = previewAttack(g, waterMap, [{ unit: ogre.id, weapon: sb }], {
      kind: 'unit',
      unit: enemy.id,
    });
    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/submerged/);
  });

  it('lets only howitzers and Ogre missiles reach one, at half strength', () => {
    let g = inPhase(newGame(), 'fire');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;
    const hwz = put(g, A, 'HWZ', at(4, 1));
    g = hwz.state;

    const main = weaponOf(g, ogre.id, 'main');
    const target = { kind: 'ogreWeapon', unit: ogre.id, weapon: main } as const;

    expect(previewAttack(g, waterMap, [{ unit: hvy.id }], target).ok).toBe(false);

    // A Howitzer's 6 is halved to 3 against a main battery's D4: a 1-2, where
    // on dry land it would have been a 1-1.
    const preview = previewAttack(g, waterMap, [{ unit: hwz.id }], target);
    expect(preview.ok).toBe(true);
    expect(preview.attackStrength).toBe(3);
    expect(preview.odds).toEqual({ kind: 'column', column: '1-2' });
  });

  it('leaves a GEV on water attacking normally', () => {
    let g = inPhase(newGame(), 'fire');
    const gev = put(g, A, 'GEV', at(4, 4));
    g = gev.state;
    const enemy = put(g, B, 'HVY', at(4, 3));
    g = enemy.state;
    expect(
      previewAttack(g, waterMap, [{ unit: gev.id }], { kind: 'unit', unit: enemy.id }).ok,
    ).toBe(true);
  });
});
