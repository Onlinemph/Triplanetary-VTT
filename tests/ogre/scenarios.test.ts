/**
 * Scenario setups and victory conditions, against the printed constraints.
 */

import { describe, expect, it } from 'vitest';
import { areaOf, terrainAt } from '../../src/ogre/engine/map.js';
import { printedAttack } from '../../src/ogre/engine/state.js';
import { type ConventionalUnit, isOgre, onBoard } from '../../src/ogre/engine/types.js';
import { GameSession } from '../../src/ogre/net/session.js';
import { SCENARIOS, scenarioById } from '../../src/ogre/scenarios/index.js';
import { DEFENSE_PLAYER, OGRE_PLAYER } from '../../src/ogre/scenarios/ogreAttack.js';

describe('every scenario', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const state = scenario.build({ seed: 1234 });

      it('builds a legal board', () => {
        expect(Object.keys(state.units).length).toBeGreaterThan(5);
        for (const u of Object.values(state.units)) {
          // "No units may start in, or enter, a crater hex."
          expect(terrainAt(scenario.map, u.pos)).not.toBe('crater');
        }
      });

      it('is deterministic for a seed', () => {
        const again = scenario.build({ seed: 1234 });
        expect(JSON.stringify(again)).toBe(JSON.stringify(state));
      });

      it('gives a different board for a different seed', () => {
        const other = scenario.build({ seed: 4321 });
        expect(JSON.stringify(other)).not.toBe(JSON.stringify(state));
      });

      it('has nobody winning at the start', () => {
        expect(scenario.checkVictory(state)).toBeNull();
      });
    });
  }
});

describe('Mark III Attack setup (1.00)', () => {
  const scenario = scenarioById('mark-iii-attack')!;
  const state = scenario.build({ seed: 99 });

  it('gives the defence 20 squads and 12 armour units', () => {
    const defenders = Object.values(state.units).filter(
      (u): u is ConventionalUnit => u.kind === 'unit' && u.owner === DEFENSE_PLAYER,
    );
    const squads = defenders.filter((u) => u.classId === 'INF').reduce((n, u) => n + u.squads, 0);
    expect(squads).toBe(20);

    const armourUnits = defenders
      .filter((u) => u.classId !== 'INF' && u.classId !== 'CP')
      .reduce((n, u) => n + armourCost(u.classId), 0);
    expect(armourUnits).toBeCloseTo(12, 5);
  });

  it('keeps the defence out of the South Area', () => {
    for (const u of Object.values(state.units)) {
      if (u.owner !== DEFENSE_PLAYER) continue;
      expect(areaOf(scenario.map, u.pos)).not.toBe('south');
    }
  });

  it('keeps the Central Area screen inside 20 attack strength points', () => {
    const central = Object.values(state.units)
      .filter((u): u is ConventionalUnit => u.kind === 'unit' && u.owner === DEFENSE_PLAYER)
      .filter((u) => areaOf(scenario.map, u.pos) === 'central')
      .reduce((n, u) => n + printedAttack(u), 0);
    expect(central).toBeLessThanOrEqual(20);
  });

  it('starts the Ogre on the south edge, and moving first', () => {
    const ogre = Object.values(state.units).find(isOgre)!;
    expect(ogre.owner).toBe(OGRE_PLAYER);
    expect(state.playerOrder[state.activePlayerIndex]).toBe(OGRE_PLAYER);
    expect(areaOf(scenario.map, ogre.pos)).toBe('south');
  });

  it('gives the defence exactly one command post', () => {
    const cps = Object.values(state.units).filter((u) => u.kind === 'unit' && u.classId === 'CP');
    expect(cps).toHaveLength(1);
    expect(areaOf(scenario.map, cps[0]!.pos)).toBe('north');
  });
});

describe('Mark III Attack victory (1.00)', () => {
  const scenario = scenarioById('mark-iii-attack')!;

  const kill = (
    state: ReturnType<typeof scenario.build>,
    pred: (u: { owner: string; kind: string }) => boolean,
  ) => ({
    ...state,
    units: Object.fromEntries(
      Object.entries(state.units).map(([id, u]) => [id, pred(u) ? { ...u, destroyed: true } : u]),
    ),
  });

  it('is an Ogre victory when the CP is gone and the Ogre escapes south', () => {
    let state = scenario.build({ seed: 7 });
    const cp = Object.values(state.units).find((u) => u.kind === 'unit' && u.classId === 'CP')!;
    const ogre = Object.values(state.units).find(isOgre)!;
    state = {
      ...state,
      units: {
        ...state.units,
        [cp.id]: { ...state.units[cp.id]!, destroyed: true },
        [ogre.id]: { ...state.units[ogre.id]!, offMap: 'south' },
      },
    };
    const victory = scenario.checkVictory(state)!;
    expect(victory.winners).toEqual([OGRE_PLAYER]);
    expect(victory.level).toBe('standard');
  });

  it('is a marginal defence victory when the CP survives but the Ogre gets away', () => {
    let state = scenario.build({ seed: 7 });
    const ogre = Object.values(state.units).find(isOgre)!;
    state = {
      ...state,
      units: { ...state.units, [ogre.id]: { ...state.units[ogre.id]!, offMap: 'south' } },
    };
    const victory = scenario.checkVictory(state)!;
    expect(victory.winners).toEqual([DEFENSE_PLAYER]);
    expect(victory.level).toBe('marginal');
  });

  it('is a complete defence victory only with 30 points of strength left', () => {
    let state = scenario.build({ seed: 7 });
    const ogre = Object.values(state.units).find(isOgre)!;
    state = {
      ...state,
      units: { ...state.units, [ogre.id]: { ...state.units[ogre.id]!, destroyed: true } },
    };
    expect(scenario.checkVictory(state)!.level).toBe('complete');

    // Strip the defence down below the threshold and it is only a plain win.
    const thinned = kill(state, (u) => u.owner === DEFENSE_PLAYER && u.kind === 'unit');
    const cp = Object.values(state.units).find((u) => u.kind === 'unit' && u.classId === 'CP')!;
    const withCp = {
      ...thinned,
      units: { ...thinned.units, [cp.id]: { ...state.units[cp.id]!, destroyed: false } },
    };
    expect(scenario.checkVictory(withCp)!.level).toBe('standard');
  });

  it('is a complete Ogre victory when nothing of the defence is left', () => {
    const state = scenario.build({ seed: 7 });
    const wiped = kill(state, (u) => u.owner === DEFENSE_PLAYER);
    const victory = scenario.checkVictory(wiped)!;
    expect(victory.winners).toEqual([OGRE_PLAYER]);
    expect(victory.level).toBe('complete');
  });
});

describe('replay', () => {
  it('reproduces a game exactly from its command log', () => {
    const scenario = scenarioById('mark-iii-attack')!;
    const session = new GameSession(scenario.build({ seed: 5 }), scenario.map, {
      victoryCheck: scenario.checkVictory,
    });

    for (let i = 0; i < 12; i++) {
      const by = session.state.playerOrder[session.state.activePlayerIndex]!;
      session.dispatch({ type: 'endPhase', by });
    }
    const after = JSON.stringify(session.state);

    const replayed = new GameSession(scenario.build({ seed: 5 }), scenario.map, {
      victoryCheck: scenario.checkVictory,
    });
    replayed.replay(session.log);
    expect(JSON.stringify(replayed.state)).toBe(after);
  });

  it('undoes by replaying a shorter log', () => {
    const scenario = scenarioById('mark-iii-attack')!;
    const session = new GameSession(scenario.build({ seed: 5 }), scenario.map);
    const before = JSON.stringify(session.state);

    session.dispatch({ type: 'endPhase', by: session.state.playerOrder[0]! });
    expect(JSON.stringify(session.state)).not.toBe(before);
    session.undo();
    expect(JSON.stringify(session.state)).toBe(before);
  });

  it('saves and reloads a game as its starting position plus a log', () => {
    const scenario = scenarioById('crossing')!;
    const session = new GameSession(scenario.build({ seed: 3 }), scenario.map);
    session.dispatch({ type: 'endPhase', by: session.state.playerOrder[0]! });

    const restored = GameSession.deserialise(session.serialise(), scenario.map);
    expect(JSON.stringify(restored.state)).toBe(JSON.stringify(session.state));
  });
});

/** 1.07: Light Tanks and LGEVs count half; Howitzers, MHWZ and SHVY double. */
const armourCost = (classId: string): number => {
  if (classId === 'LT' || classId === 'LGEV') return 0.5;
  if (classId === 'HWZ' || classId === 'MHWZ' || classId === 'SHVY') return 2;
  if (classId === 'MCRL') return 3;
  return 1;
};

it('leaves every unit that is still on the board un-destroyed', () => {
  const scenario = scenarioById('mark-v-attack')!;
  const state = scenario.build({ seed: 11 });
  for (const u of Object.values(state.units)) expect(onBoard(u)).toBe(true);
});
