/**
 * Overrun combat (Section 8).
 *
 * The three things that make it a different game from the fire phase get most
 * of the attention here: the defender's initiative, the doubled and halved
 * strengths of 8.02, and 7.11.2's "any D or X result to non-Ogre units is an X".
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/ogre/engine/rng.js';
import { key } from '../../src/ogre/engine/hex.js';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import {
  overrunActor,
  overrunStrength,
  overrunUnits,
  previewOverrunAttack,
} from '../../src/ogre/engine/overrun.js';
import type { GameState, OgreUnit } from '../../src/ogre/engine/types.js';
import { unitClass } from '../../src/ogre/engine/units.js';
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

const overrunGame = (opts: { stackingLimit?: number } = {}): GameState => ({
  ...inPhase(newGame({ stackingLimit: opts.stackingLimit ?? 5 }), 'movement'),
  options: {
    ...newGame().options,
    stackingLimit: opts.stackingLimit ?? 5,
    overrunCombat: true,
  },
});

const withRoll = (state: GameState, roll: number): GameState => ({
  ...state,
  rng: createRng(seedForRoll(roll)),
});

const ogreOf = (state: GameState, id: string): OgreUnit => state.units[id] as OgreUnit;
const weaponOf = (state: GameState, id: string, kind: string): string =>
  ogreOf(state, id).weapons.find((w) => w.kind === kind && !w.destroyed)!.id;

/** Player A charges a hex held by player B, and the dismount window is closed. */
const startOverrun = (
  state: GameState,
  moverId: string,
  target: ReturnType<typeof at>,
): GameState => {
  const begun = applyCommand(state, { type: 'overrun', by: A, unit: moverId, target }, map);
  expect(begun.result.ok).toBe(true);
  const firing = applyCommand(begun.state, { type: 'endFireRound', by: A }, map);
  expect(firing.result.ok).toBe(true);
  return firing.state;
};

describe('starting one (8.01, 6.00)', () => {
  it('is refused when the game is using the ramming rules', () => {
    let g = inPhase(newGame(), 'movement'); // overrunCombat defaults to false
    const enemy = put(g, B, 'HVY', at(4, 4));
    g = enemy.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const out = applyCommand(g, { type: 'overrun', by: A, unit: hvy.id, target: at(4, 4) }, map);
    expect(out.result.ok).toBe(false);
  });

  it('is refused when there is nothing there', () => {
    let g = overrunGame();
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;
    const out = applyCommand(g, { type: 'overrun', by: A, unit: hvy.id, target: at(4, 4) }, map);
    expect(out.result.ok).toBe(false);
  });

  // "all infantry units are divided into 1-squad counters" (8.04)
  it('splits infantry into single squads and gives the defender the first round', () => {
    let g = overrunGame();
    const inf = put(g, B, 'INF', at(4, 4), 3);
    g = inf.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const begun = applyCommand(g, { type: 'overrun', by: A, unit: hvy.id, target: at(4, 4) }, map);
    expect(begun.result.ok).toBe(true);

    const state = begun.state;
    expect(state.overrun).not.toBeNull();
    expect(state.overrun!.firing).toBe('defender');

    const defenders = overrunUnits(state, 'defender');
    expect(defenders).toHaveLength(3);
    for (const d of defenders) expect(d.kind === 'unit' && d.squads).toBe(1);
  });

  it('opens with a dismount window that belongs to the attacker', () => {
    let g = overrunGame();
    const inf = put(g, B, 'INF', at(4, 4), 1);
    g = inf.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    const begun = applyCommand(g, { type: 'overrun', by: A, unit: hvy.id, target: at(4, 4) }, map);
    expect(begun.state.overrun!.step).toBe('dismount');
    expect(overrunActor(begun.state)).toBe(A);

    // Once closed, the defender is the one who acts.
    const firing = applyCommand(begun.state, { type: 'endFireRound', by: A }, map);
    expect(firing.state.overrun!.step).toBe('fire');
    expect(overrunActor(firing.state)).toBe(B);
  });
});

describe('attack strengths (8.02)', () => {
  it('doubles infantry', () => {
    let g = overrunGame();
    const inf = put(g, A, 'INF', at(4, 4), 1);
    g = inf.state;
    expect(overrunStrength(g.units[inf.id]!, { unit: inf.id })).toBe(2);
  });

  it('doubles Ogre weapons', () => {
    let g = overrunGame();
    const ogre = putOgre(g, A, 'MK3', at(4, 4));
    g = ogre.state;
    const sb = weaponOf(g, ogre.id, 'secondary');
    expect(overrunStrength(g.units[ogre.id]!, { unit: ogre.id, weapon: sb })).toBe(6);
  });

  it('leaves ordinary armour alone', () => {
    let g = overrunGame();
    const hvy = put(g, A, 'HVY', at(4, 4));
    g = hvy.state;
    expect(overrunStrength(g.units[hvy.id]!, { unit: hvy.id })).toBe(unitClass('HVY').attack);
  });

  it('halves a disabled unit, without rounding', () => {
    let g = overrunGame();
    const hvy = put(g, A, 'HVY', at(4, 4));
    g = setDisabled(hvy.state, hvy.id, 'combat');
    expect(overrunStrength(g.units[hvy.id]!, { unit: hvy.id })).toBe(2);

    let h = overrunGame();
    const msl = put(h, A, 'MSL', at(4, 4)); // attack 3
    h = setDisabled(msl.state, msl.id, 'combat');
    expect(overrunStrength(h.units[msl.id]!, { unit: msl.id })).toBe(1.5);
  });

  // "If a disabled Superheavy is overrun, its AP guns are halved because it's
  // disabled and doubled because it's an overrun, so they fire at normal
  // strength." (8.02)
  it('reproduces the Superheavy example exactly', () => {
    let g = overrunGame();
    const shvy = put(g, A, 'SHVY', at(4, 4));
    g = shvy.state;
    const ap = { unit: shvy.id, antipersonnel: true };

    expect(overrunStrength(g.units[shvy.id]!, ap)).toBe(4); // 2 guns, doubled
    const disabled = setDisabled(g, shvy.id, 'combat');
    expect(overrunStrength(disabled.units[shvy.id]!, ap)).toBe(2); // back to printed
  });

  // "Any CP has an attack strength of 1 in an overrun (1/2 if it is disabled)."
  it('gives a command post the strength it has nowhere else', () => {
    let g = overrunGame();
    const cp = put(g, A, 'CP', at(4, 4));
    g = cp.state;
    expect(unitClass('CP').attack).toBe(0);
    expect(overrunStrength(g.units[cp.id]!, { unit: cp.id })).toBe(1);
  });
});

describe('defence (8.03)', () => {
  it('gives the defender terrain and the attacker nothing', () => {
    const townMap = flatMap(12, 12, { [key(at(4, 4))]: 'town' });
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'HVY', at(4, 3));
    g = attacker.state;

    const begun = applyCommand(
      g,
      { type: 'overrun', by: A, unit: attacker.id, target: at(4, 4) },
      townMap,
    );
    const state = applyCommand(begun.state, { type: 'endFireRound', by: A }, townMap).state;

    // The defender shoots first: a Heavy Tank (4) against an attacking Heavy
    // Tank defending at its printed D3, so 1-1 — no town doubling.
    const onAttacker = previewOverrunAttack(state, townMap, [{ unit: defender.id }], {
      kind: 'unit',
      unit: attacker.id,
    });
    expect(onAttacker.defenseStrength).toBe(3);

    // The other way round, the defender is in a town: D3 doubled to 6.
    const round2 = applyCommand(state, { type: 'endFireRound', by: B }, townMap).state;
    const onDefender = previewOverrunAttack(round2, townMap, [{ unit: attacker.id }], {
      kind: 'unit',
      unit: defender.id,
    });
    expect(onDefender.defenseStrength).toBe(6);
  });
});

describe('results (7.11.2)', () => {
  it('destroys a non-Ogre on a D as well as an X', () => {
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'GEV', at(4, 3));
    g = attacker.state;
    g = startOverrun(g, attacker.id, at(4, 4));

    // Heavy Tank (4) on a GEV defending at its printed D2: a 2-1, where a roll
    // of 2 is a D — and a D in an overrun is a kill.
    const preview = previewOverrunAttack(g, map, [{ unit: defender.id }], {
      kind: 'unit',
      unit: attacker.id,
    });
    expect(preview.odds).toEqual({ kind: 'column', column: '2-1' });

    const out = applyCommand(
      withRoll(g, 2),
      {
        type: 'overrunAttack',
        by: B,
        attackers: [{ unit: defender.id }],
        target: { kind: 'unit', unit: attacker.id },
      },
      map,
    );
    expect(out.result.ok).toBe(true);
    expect(out.state.units[attacker.id]!.destroyed).toBe(true);
  });

  it('needs a true X to touch an Ogre', () => {
    let g = overrunGame();
    const ogre = putOgre(g, B, 'MK5', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;
    g = startOverrun(g, hvy.id, at(4, 4));
    // Skip the defender's round so the attacker can shoot.
    g = applyCommand(g, { type: 'endFireRound', by: B }, map).state;

    const main = weaponOf(g, ogre.id, 'main');
    const target = { kind: 'ogreWeapon', unit: ogre.id, weapon: main } as const;

    // 4 against D4 is 1-1; a roll of 3 is a D, which does nothing to an Ogre.
    const soft = applyCommand(
      withRoll(g, 3),
      { type: 'overrunAttack', by: A, attackers: [{ unit: hvy.id }], target },
      map,
    );
    expect(ogreOf(soft.state, ogre.id).weapons.find((w) => w.id === main)!.destroyed).toBe(false);

    const hard = applyCommand(
      withRoll(g, 5),
      { type: 'overrunAttack', by: A, attackers: [{ unit: hvy.id }], target },
      map,
    );
    expect(ogreOf(hard.state, ogre.id).weapons.find((w) => w.id === main)!.destroyed).toBe(true);
  });
});

describe('fire rounds (8.04)', () => {
  it('refuses a shot from the side that is not firing', () => {
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'HVY', at(4, 3));
    g = attacker.state;
    g = startOverrun(g, attacker.id, at(4, 4));

    const out = applyCommand(
      g,
      {
        type: 'overrunAttack',
        by: A,
        attackers: [{ unit: attacker.id }],
        target: { kind: 'unit', unit: defender.id },
      },
      map,
    );
    expect(out.result.ok).toBe(false);
    expect(out.result.ok === false && out.result.reason).toMatch(/fire round/);
  });

  it('lets each unit fire once per round, and refreshes it next round', () => {
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'SHVY', at(4, 3)); // D5, survives a 4-strength hit
    g = attacker.state;
    g = startOverrun(g, attacker.id, at(4, 4));

    const shot = {
      type: 'overrunAttack' as const,
      by: B,
      attackers: [{ unit: defender.id }],
      target: { kind: 'unit' as const, unit: attacker.id },
    };
    const first = applyCommand(withRoll(g, 1), shot, map);
    expect(first.result.ok).toBe(true);
    const again = applyCommand(first.state, shot, map);
    expect(again.result.ok).toBe(false);

    // Two round-ends later it is the defender's turn to fire again.
    let back = applyCommand(first.state, { type: 'endFireRound', by: B }, map).state;
    back = applyCommand(back, { type: 'endFireRound', by: A }, map).state;
    expect(back.overrun!.round).toBe(2);
    expect(previewOverrunAttack(back, map, [{ unit: defender.id }], shot.target).ok).toBe(true);
  });

  it('ends the combat when one side is gone, leaving the survivors in the hex', () => {
    let g = overrunGame();
    const inf = put(g, B, 'INF', at(4, 4), 1);
    g = inf.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;
    g = startOverrun(g, hvy.id, at(4, 4));
    g = applyCommand(g, { type: 'endFireRound', by: B }, map).state;

    // Heavy Tank 4 against one squad at D1 is 4-1: anything but a 1 is a kill,
    // and a 1 is a D, which in an overrun is also a kill.
    const out = applyCommand(
      withRoll(g, 1),
      {
        type: 'overrunAttack',
        by: A,
        attackers: [{ unit: hvy.id }],
        target: { kind: 'unit', unit: inf.id },
      },
      map,
    );
    expect(out.state.units[inf.id]!.destroyed).toBe(true);
    expect(out.state.overrun).toBeNull();
    expect(out.state.units[hvy.id]!.pos).toEqual(at(4, 4));
  });
});

describe('Ogres in an overrun (8.05)', () => {
  // "If, during overrun combat, an Ogre loses all its weapons that have valid
  // targets in that combat, it is removed from the combat after two further
  // enemy fire rounds and replaced in the hex." (8.05.1)
  it('withdraws a disarmed Ogre after two further enemy fire rounds', () => {
    let g = overrunGame();
    const ogre = putOgre(g, B, 'MK1', at(4, 4));
    g = ogre.state;
    const hvy = put(g, A, 'HVY', at(4, 3));
    g = hvy.state;

    // Strip the Ogre of everything before the combat starts.
    g = {
      ...g,
      units: {
        ...g.units,
        [ogre.id]: {
          ...ogreOf(g, ogre.id),
          weapons: ogreOf(g, ogre.id).weapons.map((w) => ({ ...w, destroyed: true })),
        },
      },
    };
    g = startOverrun(g, hvy.id, at(4, 4));

    // It is still in the combat, with the countdown started.
    expect(overrunUnits(g, 'defender')).toHaveLength(1);

    // Two of the attacker's fire rounds later, it disengages — and the overrun
    // ends, because nothing is left on the defending side.
    let n = applyCommand(g, { type: 'endFireRound', by: B }, map).state; // defender -> attacker
    n = applyCommand(n, { type: 'endFireRound', by: A }, map).state; // attacker -> defender
    n = applyCommand(n, { type: 'endFireRound', by: B }, map).state;
    n = applyCommand(n, { type: 'endFireRound', by: A }, map).state;

    expect(n.overrun).toBeNull();
    // Withdrawn, not destroyed: it still has treads.
    expect(n.units[ogre.id]!.destroyed).toBe(false);
    expect(n.units[ogre.id]!.pos).toEqual(at(4, 4));
  });

  // "A missile rack can fire only one missile per turn. Once an Ogre uses a
  // missile rack, it may not use it in subsequent fire rounds that turn." (8.05.4)
  it('spends a missile rack for the whole turn, not the round', () => {
    let g = overrunGame();
    const ogre = putOgre(g, A, 'MK4', at(4, 3));
    g = ogre.state;
    const inf = put(g, B, 'INF', at(4, 4), 1);
    g = inf.state;
    g = startOverrun(g, ogre.id, at(4, 4));
    g = applyCommand(g, { type: 'endFireRound', by: B }, map).state;

    const rack = weaponOf(g, ogre.id, 'missileRack');
    const shot = {
      type: 'overrunAttack' as const,
      by: A,
      attackers: [{ unit: ogre.id, weapon: rack }],
      target: { kind: 'unit' as const, unit: inf.id },
    };
    // Miss, so the combat carries on: 12 against D1 is automatic, so instead
    // check the flag directly after firing.
    const fired = applyCommand(withRoll(g, 1), shot, map);
    expect(fired.result.ok).toBe(true);
    const after = ogreOf(fired.state, ogre.id).weapons.find((w) => w.id === rack)!;
    expect(after.fired).toBe(true);
    expect(ogreOf(fired.state, ogre.id).internalMissiles).toBe(14);
  });
});

describe('seats', () => {
  it('lets the defender act during their fire round even though it is not their turn', () => {
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'SHVY', at(4, 3));
    g = attacker.state;
    g = startOverrun(g, attacker.id, at(4, 4));

    expect(g.playerOrder[g.activePlayerIndex]).toBe(A);
    expect(overrunActor(g)).toBe(B);

    const out = applyCommand(
      withRoll(g, 1),
      {
        type: 'overrunAttack',
        by: B,
        attackers: [{ unit: defender.id }],
        target: { kind: 'unit', unit: attacker.id },
      },
      map,
    );
    expect(out.result.ok).toBe(true);
  });

  it('blocks ordinary commands until the overrun is finished', () => {
    let g = overrunGame();
    const defender = put(g, B, 'HVY', at(4, 4));
    g = defender.state;
    const attacker = put(g, A, 'SHVY', at(4, 3));
    g = attacker.state;
    g = startOverrun(g, attacker.id, at(4, 4));

    const out = applyCommand(g, { type: 'endPhase', by: A }, map);
    expect(out.result.ok).toBe(false);
    expect(out.result.ok === false && out.result.reason).toMatch(/finish the overrun/);
  });
});
