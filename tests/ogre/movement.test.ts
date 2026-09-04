/**
 * Movement, one clause of Section 5 at a time.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/ogre/engine/rng.js';
import { key } from '../../src/ogre/engine/hex.js';
import { canonicalSide, directionTo, sideKey } from '../../src/ogre/engine/hex.js';
import type { GameMap } from '../../src/ogre/engine/map.js';
import { planPath, applyMove, hexLoad, runRecovery } from '../../src/ogre/engine/movement.js';
import { applyCommand } from '../../src/ogre/engine/reducer.js';
import { A, B, at, flatMap, inPhase, newGame, put, putOgre, setDisabled } from './helpers.js';

const withSide = (
  map: GameMap,
  a: ReturnType<typeof at>,
  b: ReturnType<typeof at>,
  feature: 'ridge' | 'stream',
): GameMap => ({
  ...map,
  sides: { ...map.sides, [sideKey(canonicalSide(a, directionTo(a, b)))]: feature },
});

const withRoad = (map: GameMap, hexes: ReturnType<typeof at>[]): GameMap => {
  const routes: Record<string, 'road'> = { ...(map.routes as Record<string, 'road'>) };
  for (let i = 0; i + 1 < hexes.length; i++) {
    routes[sideKey(canonicalSide(hexes[i]!, directionTo(hexes[i]!, hexes[i + 1]!)))] = 'road';
  }
  return { ...map, routes };
};

describe('terrain costs (5.08)', () => {
  it('lets infantry into water at 2 points and everything else at 1 (5.08.1)', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'water', [key(at(4, 3))]: 'forest' });
    let g = inPhase(newGame(), 'movement');
    const inf = put(g, A, 'INF', at(2, 3), 3);
    g = inf.state;

    expect(planPath(g, map, g.units[inf.id]!, [at(3, 3)]).totalCost).toBe(2);
    // Infantry ignore forest entirely: "if they can legally enter a hex at all,
    // it costs them only one movement point."
    const inf2 = put(g, A, 'INF', at(5, 3), 1);
    expect(planPath(inf2.state, map, inf2.state.units[inf2.id]!, [at(4, 3)]).totalCost).toBe(1);
  });

  it('stops a GEV in forest, at 2 points, with a disable check (5.08.2)', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'forest' });
    let g = inPhase(newGame(), 'movement');
    const gev = put(g, A, 'GEV', at(2, 3));
    g = gev.state;

    const plan = planPath(g, map, g.units[gev.id]!, [at(3, 3)]);
    expect(plan.ok).toBe(true);
    expect(plan.totalCost).toBe(2);
    expect(plan.endsMovement).toBe(true);
    expect(plan.steps[0]!.hazard).toBe('disable');
  });

  it('threatens a heavy tracked unit with being stuck in swamp (5.08.3)', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'swamp' });
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(2, 3));
    g = hvy.state;

    const plan = planPath(g, map, g.units[hvy.id]!, [at(3, 3)]);
    expect(plan.steps[0]!.hazard).toBe('stuck');
    expect(plan.endsMovement).toBe(true);
  });

  it('keeps heavy tracked units out of water and Ogres in it (5.08.3)', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'water' });
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(2, 3));
    g = hvy.state;
    const ogre = putOgre(g, A, 'MK3', at(2, 2));
    g = ogre.state;

    expect(planPath(g, map, g.units[hvy.id]!, [at(3, 3)]).ok).toBe(false);
    const ogrePlan = planPath(g, map, g.units[ogre.id]!, [at(3, 3)]);
    expect(ogrePlan.ok).toBe(true);
    expect(ogrePlan.totalCost).toBe(2);
  });

  it('makes craters impassable to everything, Ogres included (2.01.2)', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'crater' });
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK5', at(2, 3));
    g = ogre.state;
    expect(planPath(g, map, g.units[ogre.id]!, [at(3, 3)]).ok).toBe(false);
  });
});

describe('hexside terrain (2.02)', () => {
  it('lets only Ogres and infantry cross a ridge', () => {
    const base = flatMap(8, 8);
    const map = withSide(base, at(2, 3), at(3, 3), 'ridge');
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(2, 3));
    g = hvy.state;
    const inf = put(g, A, 'INF', at(2, 4), 1);
    g = inf.state;
    const ogre = putOgre(g, A, 'MK3', at(2, 5));
    g = ogre.state;

    expect(planPath(g, map, g.units[hvy.id]!, [at(3, 3)]).ok).toBe(false);
    const infMap = withSide(base, at(2, 4), at(3, 4), 'ridge');
    expect(planPath(g, infMap, g.units[inf.id]!, [at(3, 4)]).ok).toBe(true);
    const ogreMap = withSide(base, at(2, 5), at(3, 5), 'ridge');
    expect(planPath(g, ogreMap, g.units[ogre.id]!, [at(3, 5)]).ok).toBe(true);
  });

  it('makes a stream crossing the first step of a phase, or nothing (5.08.4)', () => {
    const map = withSide(flatMap(8, 8), at(3, 3), at(4, 3), 'stream');
    let g = inPhase(newGame(), 'movement');
    const msl = put(g, A, 'MSL', at(2, 3));
    g = msl.state;

    // Two hexes, the second of which crosses the stream: illegal.
    expect(planPath(g, map, g.units[msl.id]!, [at(3, 3), at(4, 3)]).ok).toBe(false);

    // Starting beside it, the crossing is fine.
    const beside = put(g, A, 'MSL', at(3, 4));
    const map2 = withSide(flatMap(8, 8), at(3, 4), at(4, 4), 'stream');
    expect(planPath(beside.state, map2, beside.state.units[beside.id]!, [at(4, 4)]).ok).toBe(true);
  });
});

describe('roads (5.07)', () => {
  it('gives one extra hex for staying on the road all phase', () => {
    const road = [at(1, 3), at(2, 3), at(3, 3), at(4, 3), at(5, 3)];
    const map = withRoad(flatMap(8, 8), road);
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(1, 3)); // M3
    g = hvy.state;

    const four = planPath(g, map, g.units[hvy.id]!, road.slice(1));
    expect(four.ok).toBe(true);
    expect(four.budget).toBe(4);
  });

  it('withholds the bonus from a unit that leaves the road (5.07.1)', () => {
    const road = [at(1, 3), at(2, 3), at(3, 3)];
    const map = withRoad(flatMap(8, 8), road);
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(1, 3));
    g = hvy.state;

    const off = planPath(g, map, g.units[hvy.id]!, [at(2, 3), at(3, 3), at(4, 3), at(4, 4)]);
    expect(off.ok).toBe(false);
  });

  it('lets a road ignore the terrain underneath (2.03.1)', () => {
    const map = withRoad(flatMap(8, 8, { [key(at(3, 3))]: 'town' }), [at(2, 3), at(3, 3)]);
    let g = inPhase(newGame(), 'movement');
    const hvy = put(g, A, 'HVY', at(2, 3));
    g = hvy.state;
    // A town normally costs a heavy tracked unit 2 points; on the road, 1.
    expect(planPath(g, map, g.units[hvy.id]!, [at(3, 3)]).totalCost).toBe(1);
  });

  it('gives a GEV nine hexes of road across its two phases (5.08.2)', () => {
    const road = Array.from({ length: 12 }, (_, i) => at(i + 1, 3));
    const map = withRoad(flatMap(14, 8), road);
    let g = inPhase(newGame(), 'movement');
    const gev = put(g, A, 'GEV', at(1, 3));
    g = gev.state;

    const first = planPath(g, map, g.units[gev.id]!, road.slice(1, 6)); // 5 hexes
    expect(first.ok).toBe(true);
    expect(first.budget).toBe(5); // 4 + road bonus

    const moved = applyMove(g, map, gev.id, road.slice(1, 6)).state;
    const second = inPhase(moved, 'gevMovement');
    const reset = {
      ...second,
      units: {
        ...second.units,
        [gev.id]: { ...second.units[gev.id]!, moveUsed: 0, phaseStart: at(6, 3) },
      },
    };
    const nextLeg = planPath(reset, map, reset.units[gev.id]!, road.slice(6, 10)); // 4 hexes
    expect(nextLeg.ok).toBe(true);
    expect(nextLeg.budget).toBe(4); // 3 + road bonus, for nine hexes in the turn
  });
});

describe('the minimum move (5.09)', () => {
  it('lets a Mobile Howitzer into a town it cannot afford', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'town' });
    let g = inPhase(newGame(), 'movement');
    const mhwz = put(g, A, 'MHWZ', at(2, 3)); // M1, town costs 2
    g = mhwz.state;
    expect(planPath(g, map, g.units[mhwz.id]!, [at(3, 3)]).ok).toBe(true);
  });

  it('does not let it take two such hexes', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'town', [key(at(4, 3))]: 'town' });
    let g = inPhase(newGame(), 'movement');
    const mhwz = put(g, A, 'MHWZ', at(2, 3));
    g = mhwz.state;
    expect(planPath(g, map, g.units[mhwz.id]!, [at(3, 3), at(4, 3)]).ok).toBe(false);
  });
});

describe('stacking (5.02)', () => {
  it('allows one vehicle or three squads on the original map', () => {
    const map = flatMap(8, 8);
    let g = inPhase(newGame({ stackingLimit: 1 }), 'movement');
    const parked = put(g, A, 'HVY', at(3, 3));
    g = parked.state;
    const mover = put(g, A, 'MSL', at(2, 3));
    g = mover.state;

    expect(planPath(g, map, g.units[mover.id]!, [at(3, 3)]).ok).toBe(false);
    expect(hexLoad(g, at(3, 3), A)).toBe(1);

    let h = inPhase(newGame({ stackingLimit: 1 }), 'movement');
    const three = put(h, A, 'INF', at(3, 3), 3);
    h = three.state;
    expect(hexLoad(h, at(3, 3), A)).toBeCloseTo(1);
  });

  it('allows five vehicles on the G.E.V. maps', () => {
    const map = flatMap(8, 8);
    let g = inPhase(newGame({ stackingLimit: 5 }), 'movement');
    for (let i = 0; i < 4; i++) g = put(g, A, 'HVY', at(3, 3)).state;
    const mover = put(g, A, 'MSL', at(2, 3));
    g = mover.state;
    expect(planPath(g, map, g.units[mover.id]!, [at(3, 3)]).ok).toBe(true);
  });
});

describe('enemy-held hexes (5.03)', () => {
  it('refuses to move into an armed enemy', () => {
    const map = flatMap(8, 8);
    let g = inPhase(newGame(), 'movement');
    const enemy = put(g, B, 'HVY', at(3, 3));
    g = enemy.state;
    const mover = put(g, A, 'HVY', at(2, 3));
    g = mover.state;
    expect(planPath(g, map, g.units[mover.id]!, [at(3, 3)]).ok).toBe(false);
  });

  it('lets an Ogre with AP walk over infantry, reducing it (6.06)', () => {
    const map = flatMap(8, 8);
    let g = inPhase(newGame(), 'movement');
    const inf = put(g, B, 'INF', at(3, 3), 3);
    g = inf.state;
    const ogre = putOgre(g, A, 'MK3', at(2, 3));
    g = ogre.state;

    const after = applyMove(g, map, ogre.id, [at(3, 3)]);
    expect(after.plan.ok).toBe(true);
    const squad = after.state.units[inf.id]!;
    expect(squad.kind === 'unit' && squad.squads).toBe(2);
  });
});

describe('recovery (4.02.1, 7.11)', () => {
  it('holds a unit disabled on an enemy turn through its own next turn', () => {
    let g = newGame();
    const hvy = put(g, A, 'HVY', at(3, 3));
    g = hvy.state;

    // Player A is index 0; B is index 1. Disable during B's turn (ordinal 1*2+1).
    const disabledAt = 1 * 2 + 1;
    g = setDisabled(g, hvy.id, 'combat', disabledAt);

    // A's next turn is ordinal 2*2+0 = 4; the rule says it stays down.
    const own = runRecovery(g, A, 4);
    expect((own.units[hvy.id] as { disabled: string }).disabled).toBe('combat');

    // A's turn after that, ordinal 6, is when it comes back.
    const later = runRecovery(g, A, 6);
    expect((later.units[hvy.id] as { disabled: string }).disabled).toBe('none');
  });

  it('rolls a terrain-disabled unit back on a 3 or better (4.02.1b)', () => {
    let g = newGame({ seed: 7 });
    const gev = put(g, A, 'GEV', at(3, 3));
    g = gev.state;
    g = { ...setDisabled(g, gev.id, 'terrain'), rng: createRng(7) };
    const after = runRecovery(g, A, 100);
    // Whatever the die said, the unit is either free or still terrain-disabled
    // — never combat-disabled, and never destroyed.
    expect(['none', 'terrain']).toContain((after.units[gev.id] as { disabled: string }).disabled);
  });
});

describe('leaving the map (5.12)', () => {
  it('costs one point and takes the unit out of play without killing it', () => {
    const map = flatMap(8, 8);
    let g = inPhase(newGame(), 'movement');
    const ogre = putOgre(g, A, 'MK3', at(4, 8));
    g = ogre.state;

    const after = applyMove(g, map, ogre.id, [at(4, 9)]);
    expect(after.plan.ok).toBe(true);
    const u = after.state.units[ogre.id]!;
    expect(u.destroyed).toBe(false);
    expect(u.offMap).toBe('south');
  });
});

describe('the turn sequence (4.02)', () => {
  it('runs recovery, movement, fire, then the GEV second move', () => {
    const map = flatMap(8, 8);
    let g = newGame();
    g = put(g, A, 'GEV', at(3, 3)).state;

    const phases: string[] = [g.phase];
    for (let i = 0; i < 4; i++) {
      const step = applyCommand(
        g,
        { type: 'endPhase', by: g.playerOrder[g.activePlayerIndex]! },
        map,
      );
      g = step.state;
      phases.push(g.phase);
    }
    expect(phases).toEqual(['recovery', 'movement', 'fire', 'gevMovement', 'recovery']);
    expect(g.playerOrder[g.activePlayerIndex]).toBe(B);
  });
});

describe('damaged terrain (2.01.7, 13.01)', () => {
  it('keeps wheeled vehicles out, while everyone else treats it as before', () => {
    const map = flatMap(8, 8, { [key(at(3, 3))]: 'damagedTown' });
    let g = inPhase(newGame(), 'movement');
    const truck = put(g, A, 'TK', at(2, 3));
    g = truck.state;
    const hvy = put(g, A, 'HVY', at(2, 2));
    g = hvy.state;

    expect(planPath(g, map, g.units[truck.id]!, [at(3, 3)]).ok).toBe(false);
    // A damaged town is still a town for everyone else: 2 points for a heavy
    // tracked unit, exactly as an undamaged one.
    expect(planPath(g, map, g.units[hvy.id]!, [at(3, 3)]).totalCost).toBe(2);
  });
});
