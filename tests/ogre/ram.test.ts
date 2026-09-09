/**
 * Ramming (Section 6), including the two worked examples the rules print.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/ogre/engine/rng.js';
import { canRam, resolveRam } from '../../src/ogre/engine/ram.js';
import { movementForTreads, ogreType } from '../../src/ogre/engine/ogres.js';
import type { GameState, OgreUnit } from '../../src/ogre/engine/types.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre, seedForRoll } from './helpers.js';

const map = flatMap(12, 12);

const withRoll = (state: GameState, roll: number): GameState => ({
  ...state,
  rng: createRng(seedForRoll(roll)),
});

const ogreOf = (state: GameState, id: string): OgreUnit => state.units[id] as OgreUnit;

describe('an Ogre rams an armour unit (6.02)', () => {
  it('disables on 1-3 and destroys on 4-6, costing treads either way', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, B, 'HVY', at(4, 3));
    g = hvy.state;

    // "An Ogre loses two tread units for ramming a Heavy Tank or MHWZ."
    const soft = resolveRam(withRoll(g, 2), map, ogre.id, at(4, 3));
    expect(soft.ok).toBe(true);
    expect(ogreOf(soft.state, ogre.id).treads).toBe(58);
    expect((soft.state.units[hvy.id] as { disabled: string }).disabled).toBe('combat');
    expect(soft.state.units[hvy.id]!.destroyed).toBe(false);

    const hard = resolveRam(withRoll(g, 5), map, ogre.id, at(4, 3));
    expect(hard.state.units[hvy.id]!.destroyed).toBe(true);
    expect(ogreOf(hard.state, ogre.id).treads).toBe(58);
  });

  it('costs one tread unit for anything lighter', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    const msl = put(g, B, 'MSL', at(4, 3));
    g = msl.state;

    const out = resolveRam(withRoll(g, 5), map, ogre.id, at(4, 3));
    expect(ogreOf(out.state, ogre.id).treads).toBe(59);
  });

  it('flattens an immobile unit automatically', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const hwz = put(g, B, 'HWZ', at(4, 3));
    g = hwz.state;

    const out = resolveRam(withRoll(g, 1), map, ogre.id, at(4, 3));
    expect(out.state.units[hwz.id]!.destroyed).toBe(true);
  });

  // "Example: A Mark V with 41 remaining tread units moves one hex and rams a
  // Missile Tank. This reduces its tread units to 40, so its movement is
  // reduced to 2; it may move only one more hex that turn." (6.04)
  it('reproduces the 6.04 example exactly', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK5', at(4, 5));
    g = ogre.state;
    const msl = put(g, B, 'MSL', at(4, 4));
    g = msl.state;

    // The Ogre has already moved one hex and is down to 41 treads.
    g = {
      ...g,
      units: { ...g.units, [ogre.id]: { ...ogreOf(g, ogre.id), treads: 41, moveUsed: 1 } },
    };
    expect(movementForTreads(ogreType('MK5'), 41)).toBe(3);

    const out = resolveRam(withRoll(g, 5), map, ogre.id, at(4, 4));
    const after = ogreOf(out.state, ogre.id);
    expect(after.treads).toBe(40);
    expect(movementForTreads(ogreType('MK5'), after.treads)).toBe(2);
    // One point for the first hex, one for the ram: exactly one hex left.
    expect(after.moveUsed).toBe(2);
  });
});

describe('an Ogre rams a command post (6.03)', () => {
  it('destroys it and costs nothing, because a standard CP is D0', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const cp = put(g, B, 'CP', at(4, 3));
    g = cp.state;

    const out = resolveRam(g, map, ogre.id, at(4, 3));
    expect(out.state.units[cp.id]!.destroyed).toBe(true);
    expect(ogreOf(out.state, ogre.id).treads).toBe(ogreType('MK3').treads);
  });
});

describe('Ogre versus Ogre (6.05)', () => {
  // "A Mark V rams a Mark III. The Mark V automatically loses 3 tread units
  // because it rammed a smaller Ogre. A Mk. V rolls four dice to ram."
  it('charges the rammer 3 treads against a smaller or equal Ogre', () => {
    let g = inPhase(newGame(), 'movement');
    const mk5 = putOgre(g, A, 'MK5', at(4, 4));
    g = mk5.state;
    const mk3 = putOgre(g, B, 'MK3', at(4, 3));
    g = mk3.state;

    const out = resolveRam(g, map, mk5.id, at(4, 3));
    expect(out.ok).toBe(true);
    expect(ogreOf(out.state, mk5.id).treads).toBe(57);
    // Four dice: between 4 and 24 tread units off the Mark III.
    const lost = ogreType('MK3').treads - ogreOf(out.state, mk3.id).treads;
    expect(lost).toBeGreaterThanOrEqual(4);
    expect(lost).toBeLessThanOrEqual(24);
  });

  // "On its own move, the Mark III rams back. It automatically loses 5 tread
  // units because it rammed a bigger Ogre. A Mk. III rolls two dice."
  it('charges the rammer 5 treads against a bigger Ogre, and rolls two dice', () => {
    let g = inPhase(newGame(), 'movement');
    const mk3 = putOgre(g, A, 'MK3', at(4, 4));
    g = mk3.state;
    const mk5 = putOgre(g, B, 'MK5', at(4, 3));
    g = mk5.state;

    const out = resolveRam(g, map, mk3.id, at(4, 3));
    expect(ogreOf(out.state, mk3.id).treads).toBe(ogreType('MK3').treads - 5);
    const lost = 60 - ogreOf(out.state, mk5.id).treads;
    expect(lost).toBeGreaterThanOrEqual(2);
    expect(lost).toBeLessThanOrEqual(12);
  });

  it('stops the rammer where it stood, and only once per turn (6.01.1, 6.05)', () => {
    let g = inPhase(newGame(), 'movement');
    const mk5 = putOgre(g, A, 'MK5', at(4, 4));
    g = mk5.state;
    const mk3 = putOgre(g, B, 'MK3', at(4, 3));
    g = mk3.state;

    const out = resolveRam(g, map, mk5.id, at(4, 3));
    const after = ogreOf(out.state, mk5.id);
    expect(after.pos).toEqual(at(4, 4));
    expect(after.movementEnded).toBe(true);
    expect(canRam(out.state, map, after, at(4, 3)).ok).toBe(false);
  });
});

describe('conventional units ram an Ogre (6.07.2)', () => {
  it('kills the rammer and costs the Ogre one tread — two for a Heavy Tank', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;
    const msl = put(g, A, 'MSL', at(3, 4));
    g = msl.state;

    const byHeavy = resolveRam(g, map, hvy.id, at(4, 4));
    expect(byHeavy.state.units[hvy.id]!.destroyed).toBe(true);
    expect(ogreOf(byHeavy.state, ogre.id).treads).toBe(58);

    const byMissile = resolveRam(g, map, msl.id, at(4, 4));
    expect(byMissile.state.units[msl.id]!.destroyed).toBe(true);
    expect(ogreOf(byMissile.state, ogre.id).treads).toBe(59);
  });
});

describe('GEVs ram (6.07.3)', () => {
  it('destroys the GEV and hits the target at twice its attack strength', () => {
    let g = inPhase(newGame(), 'movement');
    const gev = put(g, A, 'GEV', at(4, 4)); // attack 2, doubled to 4
    g = gev.state;
    const msl = put(g, B, 'MSL', at(4, 3)); // D2 -> 4 vs 2 is 2-1
    g = msl.state;

    const out = resolveRam(withRoll(g, 6), map, gev.id, at(4, 3));
    expect(out.state.units[gev.id]!.destroyed).toBe(true);
    expect(out.state.units[msl.id]!.destroyed).toBe(true);
  });
});

describe('ramming limits and prohibitions (6.01.1, 6.07)', () => {
  it('allows two ordinary rams a turn but not three', () => {
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK5', at(4, 4));
    g = ogre.state;
    g = {
      ...g,
      units: { ...g.units, [ogre.id]: { ...ogreOf(g, ogre.id), ramsThisTurn: 2 } },
    };
    const msl = put(g, B, 'MSL', at(4, 3));
    g = msl.state;

    expect(canRam(g, map, ogreOf(g, ogre.id), at(4, 3)).ok).toBe(false);
  });

  it('never lets infantry ram or be rammed (6.07)', () => {
    let g = inPhase(newGame(), 'movement');
    const inf = put(g, A, 'INF', at(4, 4), 3);
    g = inf.state;
    const enemy = put(g, B, 'INF', at(4, 3), 3);
    g = enemy.state;

    expect(canRam(g, map, g.units[inf.id]!, at(4, 3)).ok).toBe(false);

    const hvy = put(g, A, 'HVY', at(3, 3));
    g = hvy.state;
    expect(canRam(g, map, g.units[hvy.id]!, at(4, 3)).ok).toBe(false);
  });

  it('will not let a Missile Tank ram anything but an Ogre (6.07.4)', () => {
    let g = inPhase(newGame(), 'movement');
    const msl = put(g, A, 'MSL', at(4, 4));
    g = msl.state;
    const hvy = put(g, B, 'HVY', at(4, 3));
    g = hvy.state;
    expect(canRam(g, map, g.units[msl.id]!, at(4, 3)).ok).toBe(false);
  });
});
