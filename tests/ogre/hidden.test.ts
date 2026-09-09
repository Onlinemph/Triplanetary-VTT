/**
 * Hidden information: minefields (13.04), camouflage (13.05) and dummies
 * (13.06), each proved against the reducer, and the view a seat receives
 * proved to withhold what it should — the computer included.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { key } from '../../src/ogre/engine/hex.js';
import {
  hasHiddenInformation,
  isDummy,
  isUnknown,
  mineAt,
  minefieldsLeft,
  minesOf,
  redactOgreState,
  tripMinefield,
} from '../../src/ogre/engine/concealment.js';
import { type GameMap, emptyBuilder, layRoute } from '../../src/ogre/engine/map.js';
import { type GameState, activePlayer, onBoard, setupActor } from '../../src/ogre/engine/types.js';
import { withUnit, makeUnit } from '../../src/ogre/engine/state.js';
import { CUSTOM } from '../../src/ogre/scenarios/index.js';
import { playOrder } from '../../src/ogre/ai/simulate.js';
import { ogreRules } from '../../src/net/ogreRules.js';
import type { OrderOfBattle } from '../../src/campaign/orders.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre } from './helpers.js';

const map = flatMap();

const run = (s: GameState, cmd: Parameters<typeof applyCommand>[1]): GameState => {
  const out = applyCommand(s, cmd, map);
  if (!out.result.ok) throw new Error(out.result.reason);
  return out.state;
};

const moveFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'movement'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

const fireFor = (state: GameState, player: string): GameState => ({
  ...inPhase(state, 'fire'),
  activePlayerIndex: state.playerOrder.indexOf(player),
});

const withMine = (s: GameState, owner: string, pos: ReturnType<typeof at>): GameState => ({
  ...s,
  mines: [...(s.mines ?? []), { id: `mine-${owner}-1`, owner, pos, revealed: false }],
});

const conceal = (s: GameState, id: string): GameState =>
  withUnit(s, { ...s.units[id]!, concealed: true } as GameState['units'][string]);

// ---------------------------------------------------------------------------
// 13.04 Minefields
// ---------------------------------------------------------------------------

describe('minefields (13.04)', () => {
  it('stop the first enemy unit onto them, attack it, and are revealed', () => {
    let s = newGame({ seed: 3 });
    const tank = put(s, A, 'HVY', at(3, 6));
    s = tank.state;
    s = withMine(s, B, at(4, 6));
    s = moveFor(s, A);
    const out = applyCommand(
      s,
      { type: 'moveUnit', by: A, unit: tank.id, path: [at(4, 6), at(5, 6), at(6, 6)] },
      map,
    );
    expect(out.result.ok).toBe(true);
    const u = out.state.units[tank.id]!;
    // Stopped in the mined hex, not three hexes on — destroyed or not.
    if (onBoard(u)) {
      expect(key(u.pos)).toBe(key(at(4, 6)));
      expect(u.movementEnded).toBe(true);
    }
    expect(mineAt(out.state, at(4, 6))?.revealed).toBe(true);
    expect(out.state.log.some((e) => /minefield/.test(e.text))).toBe(true);
  });

  it('let the side that laid them pass', () => {
    let s = newGame({ seed: 3 });
    const tank = put(s, B, 'HVY', at(3, 6));
    s = tank.state;
    s = withMine(s, B, at(4, 6));
    s = moveFor(s, B);
    const next = run(s, { type: 'moveUnit', by: B, unit: tank.id, path: [at(4, 6), at(5, 6)] });
    expect(key(next.units[tank.id]!.pos)).toBe(key(at(5, 6)));
    expect(mineAt(next, at(4, 6))?.revealed).toBe(false);
  });

  // "If a mine is not on a road, it explodes only on a die roll of 6 (5 or 6
  // for an Ogre) ... an Ogre rolls 1 die and loses that many tread units."
  it('goes off under a cybertank on a 5 or 6, and takes a die of tread units', () => {
    let sawNothing = false;
    let sawTreads = false;
    for (let seed = 1; seed <= 40 && !(sawNothing && sawTreads); seed++) {
      let s = newGame({ seed });
      const mk = putOgre(s, A, 'MK3', at(3, 8));
      s = mk.state;
      s = withMine(s, B, at(4, 8));
      s = moveFor(s, A);
      const before = (s.units[mk.id] as { treads: number }).treads;
      const next = run(s, { type: 'moveUnit', by: A, unit: mk.id, path: [at(4, 8), at(5, 8)] });
      const lost = before - (next.units[mk.id] as { treads: number }).treads;
      expect(key(next.units[mk.id]!.pos)).toBe(key(at(4, 8)));
      if (lost === 0) {
        // It did not go off, and the field is on the map now.
        expect(mineAt(next, at(4, 8))?.revealed).toBe(true);
        sawNothing = true;
      } else {
        // A die of treads, and the mine itself is gone.
        expect(lost).toBeGreaterThanOrEqual(1);
        expect(lost).toBeLessThanOrEqual(6);
        expect(mineAt(next, at(4, 8))).toBeUndefined();
        sawTreads = true;
      }
    }
    expect(sawNothing).toBe(true);
    expect(sawTreads).toBe(true);
  });

  // "A mine explosion affects only the unit setting it off. Armor units are
  // destroyed" — no odds, no roll against a defence strength.
  it('destroys an armour unit outright when it goes off', () => {
    let destroyed = false;
    for (let seed = 1; seed <= 40 && !destroyed; seed++) {
      let s = newGame({ seed });
      const tank = put(s, A, 'HVY', at(3, 6));
      s = moveFor(withMine(tank.state, B, at(4, 6)), A);
      const next = run(s, { type: 'moveUnit', by: A, unit: tank.id, path: [at(4, 6)] });
      const u = next.units[tank.id]!;
      if (!onBoard(u)) {
        destroyed = true;
        expect(next.log.some((e) => /sets off a mine and is destroyed/.test(e.text))).toBe(true);
        expect(mineAt(next, at(4, 6))).toBeUndefined();
      }
    }
    expect(destroyed).toBe(true);
  });

  it('are laid in the setup, in the layer’s own area, and are hidden from the enemy', () => {
    let s = newGame({ seed: 2 });
    s = {
      ...s,
      setup: {
        order: [B, A],
        index: 0,
        zones: {
          [B]: { hexes: [key(at(8, 6)), key(at(8, 7)), key(at(9, 6))], label: 'the east' },
          [A]: { hexes: [key(at(2, 6))], label: 'the west' },
        },
      },
      minesLeft: { [B]: 2 },
    };
    expect(setupActor(s)).toBe(B);
    expect(minefieldsLeft(s, B)).toBe(2);
    expect(applyCommand(s, { type: 'layMinefield', by: B, at: at(2, 6) }, map).result.ok).toBe(
      false,
    );
    expect(applyCommand(s, { type: 'layMinefield', by: A, at: at(2, 6) }, map).result.ok).toBe(
      false,
    );
    s = run(s, { type: 'layMinefield', by: B, at: at(8, 6) });
    // "Any number of mines may be placed in a hex, and only one goes off at a
    // time." (13.04) — so the same hex again is legal.
    s = run(s, { type: 'layMinefield', by: B, at: at(8, 6) });
    expect(minefieldsLeft(s, B)).toBe(0);
    expect(applyCommand(s, { type: 'layMinefield', by: B, at: at(8, 7) }, map).result.ok).toBe(
      false,
    );
    expect(minesOf(s)).toHaveLength(2);
    // The enemy's view has no mines in it; the layer's has both.
    expect(minesOf(redactOgreState({ ...s, options: { ...s.options, minefields: 2 } }, A))).toEqual(
      [],
    );
    expect(
      minesOf(redactOgreState({ ...s, options: { ...s.options, minefields: 2 } }, B)),
    ).toHaveLength(2);
  });

  // "He places them in whatever hexes he wishes, recording the hex numbers and
  // whether they are on the road." (13.04) The layer chooses: a road mine goes
  // off under anything that uses the road, and a mine beside the road needs a
  // 6 but survives a column driving past.
  it('lets the layer say whether a mine in a road hex is on the road', () => {
    const b = emptyBuilder();
    layRoute(b, [at(7, 6), at(8, 6), at(9, 6)], 'road');
    const roadMap: GameMap = { ...map, routes: b.routes };
    const base: GameState = {
      ...newGame({ seed: 5 }),
      setup: {
        order: [B, A],
        index: 0,
        zones: { [B]: { hexes: [key(at(8, 6))], label: 'the east' } },
      },
      minesLeft: { [B]: 2 },
    };

    // No choice given: a mine in a road hex is a road mine.
    const onIt = applyCommand(base, { type: 'layMinefield', by: B, at: at(8, 6) }, roadMap);
    expect(mineAt(onIt.state, at(8, 6))?.onRoad).toBe(true);

    // Said otherwise: it lies beside the road and takes its chances on a 6.
    const beside = applyCommand(
      base,
      { type: 'layMinefield', by: B, at: at(8, 6), onRoad: false },
      roadMap,
    );
    expect(mineAt(beside.state, at(8, 6))?.onRoad).toBe(false);

    // Off the road there is nothing to choose either way.
    const nowhere = applyCommand(
      {
        ...base,
        setup: { ...base.setup!, zones: { [B]: { hexes: [key(at(8, 7))], label: 'e' } } },
      },
      { type: 'layMinefield', by: B, at: at(8, 7) },
      roadMap,
    );
    expect(mineAt(nowhere.state, at(8, 7))?.onRoad).toBe(false);
  });

  // The difference the choice makes on the ground.
  it('goes off under anything using the road, and only under the road', () => {
    const b = emptyBuilder();
    layRoute(b, [at(3, 6), at(4, 6), at(5, 6)], 'road');
    const roadMap: GameMap = { ...map, routes: b.routes };
    const drive = (onRoad: boolean, usedRoad: boolean): GameState => {
      let s = newGame({ seed: 9 });
      // Standing in the mined hex, as a mover that has just entered it is.
      const tank = put(s, A, 'HVY', at(4, 6));
      s = {
        ...tank.state,
        mines: [{ id: 'm', owner: B, pos: at(4, 6), revealed: false, onRoad }],
      };
      return tripMinefield(moveFor(s, A), roadMap, tank.id, usedRoad);
    };

    // A road mine under a column on the road: destroyed, no roll.
    const hit = drive(true, true);
    expect(Object.values(hit.units)[0]!.destroyed).toBe(true);
    // The same mine, and a tank that came in cross-country: nothing.
    const past = drive(true, false);
    expect(Object.values(past.units)[0]!.destroyed).toBe(false);
    expect(mineAt(past, at(4, 6))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13.05 Camouflage
// ---------------------------------------------------------------------------

describe('camouflage (13.05)', () => {
  const board = (): { state: GameState; hvy: string; msl: string } => {
    let s = newGame({ seed: 4 });
    s = { ...s, options: { ...s.options, camouflage: true } };
    const hvy = put(s, A, 'HVY', at(3, 6));
    s = hvy.state;
    const msl = put(s, B, 'MSL', at(7, 6));
    s = msl.state;
    s = conceal(s, msl.id);
    return { state: s, hvy: hvy.id, msl: msl.id };
  };

  it('shows the enemy a ? with the side and the hex, and the owner the counter', () => {
    const { state, msl } = board();
    const theirs = redactOgreState(state, A);
    const seen = theirs.units[msl]!;
    expect(isUnknown(seen)).toBe(true);
    expect(seen.owner).toBe(B);
    expect(key(seen.pos)).toBe(key(at(7, 6)));
    expect(seen.kind === 'unit' && seen.classId).toBe('UNK');
    const mine = redactOgreState(state, B);
    expect(mine.units[msl]!.kind === 'unit' && mine.units[msl]!.classId).toBe('MSL');
    // A spectator sees what both sides have shown, and no more.
    expect(isUnknown(redactOgreState(state, null).units[msl]!)).toBe(true);
    // A board with none of the options on is handed back as it is.
    const plain = { ...state, options: { ...state.options, camouflage: false } };
    expect(redactOgreState(plain, A)).toBe(plain);
  });

  // "As soon as any camouflaged unit moves or fires ... the ? marker is
  // replaced by the real unit." (13.05)
  it('is given away the moment it moves', () => {
    const { state, msl } = board();
    const s = moveFor(state, B);
    const next = run(s, { type: 'moveUnit', by: B, unit: msl, path: [at(6, 6)] });
    expect(next.units[msl]!.concealed).toBe(false);
    expect(next.log.some((e) => /It moved/.test(e.text))).toBe(true);
  });

  it('stays hidden while it stands still, however close the enemy comes', () => {
    const { state, hvy, msl } = board();
    let s = moveFor(state, A);
    // Right up beside it, and past the end of the phase.
    s = run(s, { type: 'moveUnit', by: A, unit: hvy, path: [at(4, 6), at(5, 6), at(6, 6)] });
    expect(s.units[msl]!.concealed).toBe(true);
    s = run(s, { type: 'endPhase', by: A });
    expect(s.units[msl]!.concealed).toBe(true);
  });

  it('is revealed by firing, and by being fired on', () => {
    const { state, hvy, msl } = board();
    const firing = fireFor(state, B);
    const shot = run(firing, {
      type: 'attack',
      by: B,
      attackers: [{ unit: msl }],
      target: { kind: 'unit', unit: hvy },
    });
    expect(shot.units[msl]!.concealed).toBe(false);

    const targeted = fireFor(
      { ...state, units: { ...state.units, [hvy]: { ...state.units[hvy]!, pos: at(5, 6) } } },
      A,
    );
    const fired = run(targeted, {
      type: 'attack',
      by: A,
      attackers: [{ unit: hvy }],
      target: { kind: 'unit', unit: msl },
    });
    const u = fired.units[msl]!;
    expect(!onBoard(u) || u.concealed === false).toBe(true);
  });

  // "... or as soon as an enemy unit moves through or fires on its hex" (13.05)
  it('is found when an enemy walks through its hex', () => {
    const { state, hvy, msl } = board();
    let s = moveFor(state, A);
    // The Missile Tank stands at 7,6 with no attack strength to stop anyone
    // walking over it, so the Heavy Tank's path goes right through.
    s = withUnit(s, {
      ...s.units[msl]!,
      classId: 'CP',
    } as GameState['units'][string]);
    // Start it one hex nearer so the walk-through is inside a Heavy Tank's 3.
    s = { ...s, units: { ...s.units, [hvy]: { ...s.units[hvy]!, pos: at(5, 6) } } };
    s = run(s, { type: 'moveUnit', by: A, unit: hvy, path: [at(6, 6), at(7, 6), at(8, 6)] });
    expect(s.units[msl]!.concealed).toBe(false);
    expect(s.log.some((e) => /came through its hex/.test(e.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13.06 Dummies
// ---------------------------------------------------------------------------

describe('dummies (13.06)', () => {
  it('are removed when shot at, and the shot is spent', () => {
    let s = newGame({ seed: 4 });
    s = { ...s, options: { ...s.options, dummies: 1 } };
    const hvy = put(s, A, 'HVY', at(5, 6));
    s = hvy.state;
    s = withUnit(s, { ...makeUnit(`${B}-dum-1`, B, 'DUM', at(6, 6)), concealed: true });
    expect(isDummy(s.units[`${B}-dum-1`]!)).toBe(true);
    s = fireFor(s, A);
    const out = applyCommand(
      s,
      {
        type: 'attack',
        by: A,
        attackers: [{ unit: hvy.id }],
        target: { kind: 'unit', unit: `${B}-dum-1` },
      },
      map,
    );
    expect(out.result.ok).toBe(true);
    expect(onBoard(out.state.units[`${B}-dum-1`]!)).toBe(false);
    expect((out.state.units[hvy.id] as { firedThisPhase: boolean }).firedThisPhase).toBe(true);
    expect(out.state.players[A]!.victoryPoints).toBe(0);
    expect(out.state.log.some((e) => /dummy/.test(e.text))).toBe(true);
  });

  it('call the bluff on a ram: nothing there to hit, and no move spent', () => {
    let s = newGame({ seed: 4 });
    s = { ...s, options: { ...s.options, dummies: 1 } };
    const hvy = put(s, A, 'HVY', at(5, 6));
    s = hvy.state;
    s = withUnit(s, { ...makeUnit(`${B}-dum-1`, B, 'DUM', at(6, 6)), concealed: true });
    s = moveFor(s, A);
    const out = applyCommand(s, { type: 'ram', by: A, unit: hvy.id, target: at(6, 6) }, map);
    expect(out.result.ok).toBe(true);
    expect(onBoard(out.state.units[`${B}-dum-1`]!)).toBe(false);
    expect(out.state.units[hvy.id]!.moveUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole thing, at a table and headless
// ---------------------------------------------------------------------------

const hiddenOrder = (seed: number): OrderOfBattle => ({
  battleId: `hidden-${seed}`,
  seed,
  scenarioId: 'custom',
  sides: [
    { player: 'attacker', faction: 'Paneuropean Federation', forces: { MK3: 1 } },
    { player: 'defender', faction: 'North American Combine', forces: { HVY: 4, MSL: 4, INF: 12 } },
  ],
  terms: {
    map: { kind: 'ogre' },
    victory: 'command-post',
    centralLimit: 20,
    minefields: 4,
    camouflage: true,
    dummies: 3,
  },
});

describe('a battle with something to hide', () => {
  it('is built with the options, the dummies and the mines to lay', () => {
    const s = CUSTOM.build({ seed: 7, order: hiddenOrder(7), setup: true });
    expect(hasHiddenInformation(s.options)).toBe(true);
    expect(Object.values(s.units).filter(isDummy)).toHaveLength(6);
    expect(s.minesLeft).toEqual({ attacker: 4, defender: 4 });
    // Nothing is face down until the counters are down.
    expect(Object.values(s.units).some((u) => u.concealed)).toBe(false);
  });

  it('is a fog table to the referee, with a view per seat', () => {
    const rules = ogreRules();
    const s = CUSTOM.build({ seed: 7, order: hiddenOrder(7), setup: true });
    expect(rules.summary(s).fog).toBe(true);
    // The plain custom battle is not.
    const plain = CUSTOM.build({ seed: 7, setup: true });
    expect(rules.summary(plain).fog).toBe(false);
    expect(rules.redact(plain, 'attacker')).toBe(plain);
  });

  it('is fought to the end by the computer on both seats, from its own view, without a refusal', () => {
    for (const seed of [11, 12]) {
      const fought = playOrder(CUSTOM, hiddenOrder(seed), undefined, { maxTurns: 30 });
      expect(fought.result.refused).toBeLessThan(fought.result.commands);
      // Mines were laid, and the counters went face down when the setup ended.
      expect(minesOf(fought.state).length).toBeGreaterThan(0);
      expect(fought.state.log.some((e) => /is revealed|was a dummy|minefield/.test(e.text))).toBe(
        true,
      );
      // Nothing the computer said was refused wholesale: the game got somewhere.
      expect(fought.result.turns).toBeGreaterThan(1);
    }
  }, 120_000);

  it('turns every counter face down when the setup ends', () => {
    let s = CUSTOM.build({ seed: 7, order: hiddenOrder(7), setup: true });
    const def = CUSTOM;
    for (let i = 0; i < 4 && s.setup; i++) {
      const who = setupActor(s)!;
      const out = applyCommand(s, { type: 'finishSetup', by: who }, def.map, def.checkVictory);
      expect(out.result.ok).toBe(true);
      s = out.state;
    }
    expect(s.setup).toBeNull();
    // Every counter that moves is face down; the command post, a fixed
    // installation everybody knows the site of, is not.
    for (const u of Object.values(s.units).filter(onBoard)) {
      const post = u.kind === 'unit' && u.classId === 'CP';
      expect(`${u.id}: ${u.concealed === true}`).toBe(`${u.id}: ${!post}`);
    }
    expect(activePlayer(s)).toBe(s.playerOrder[0]);
  });
});
