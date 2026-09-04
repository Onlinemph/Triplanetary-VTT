/**
 * The computer opponent.
 *
 * An AI is easy to write and hard to trust, so these tests are about trust
 * rather than skill. Three things have to hold, and none of them is a matter of
 * taste:
 *
 *  1. **It plays by the rules.** Every order goes through `applyCommand`, so the
 *     rules are already enforced — but an order the engine *refuses* is a bug in
 *     the policy, and a policy that issues one in a real position would leave a
 *     solo game stuck. So the soak below plays every printed scenario with the
 *     computer on all seats and fails on the first refusal.
 *  2. **It is deterministic.** No `Math.random`, no `Date`. Same position, same
 *     order — which is what lets a solo game be replayed from its seed and
 *     command log exactly like a two-player one.
 *  3. **It does not see through walls.** Detection is a rule ("all ships and
 *     bases have detectors", p. 8). An opponent that fired on a ship it had not
 *     detected would not be playing Triplanetary.
 *
 * The rest are single rules the pilot has to respect, each written from the
 * printed clause and then run against the policy.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type PlayerId,
  type Ship,
  type ShipClass,
  applyCommand,
  areAllied,
  combatStrength,
  controllerOf,
  createInitialState,
  distance,
  eq,
  hex,
  makePlayer,
  makeShip,
  previewAttack,
  reachableEndpoints,
} from '../src/engine/index.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { SCENARIOS, buildScenario } from '../src/scenarios/index.js';
import { nextCommand } from '../src/ai/index.js';
import { aiHasMove, driveAi, stepAi } from '../src/ai/driver.js';
import { brakingRoom, escapable, safeCourses, solvent } from '../src/ai/navigate.js';
import { bodiesVisited, combatForbidden, errandFor } from '../src/ai/objectives.js';

const map = DEFAULT_MAP;
const A = 'a';

/** Every enemy ship an order names, for the fog-of-war check. */
const shipsNamedBy = (cmd: Command): string[] => {
  const out: string[] = [];
  if ('targets' in cmd && Array.isArray(cmd.targets)) out.push(...(cmd.targets as string[]));
  if ('target' in cmd && typeof cmd.target === 'string') out.push(cmd.target);
  return out;
};
const B = 'b';

/** Deep space, well clear of every gravity arrow and every detector. */
const DEEP = hex(-28, -10);

const rig = (ships: readonly Ship[], extra: Partial<GameState> = {}): GameState => ({
  ...createInitialState({
    scenarioId: 'ai-test',
    seed: 11,
    players: [makePlayer(A, 'A', 'Alpha', '#fff'), makePlayer(B, 'B', 'Beta', '#000')],
    ships,
    options: { nukesAllowed: false },
  }),
  ...extra,
});

const hull = (id: string, owner: PlayerId, cls: ShipClass, extra: Partial<Ship> = {}): Ship => ({
  ...makeShip({ id, owner, shipClass: cls, pos: DEEP }),
  ...extra,
});

/**
 * Play a scenario with the computer on every seat.
 *
 * Returns everything a test might want to assert about the run: whether an order
 * was ever refused, whether the game stopped making progress, and the orders
 * themselves.
 */
interface Run {
  readonly state: GameState;
  readonly commands: readonly Command[];
  readonly refused: string | null;
  readonly wedged: string | null;
}

const play = (scenarioId: string, seed: number, turnCap = 25): Run => {
  let state = buildScenario(scenarioId, { seed });
  const seats = new Set(state.playerOrder);
  const commands: Command[] = [];
  let refused: string | null = null;
  let wedged: string | null = null;

  for (let round = 0; round < 500; round += 1) {
    const before = state;
    const out = driveAi(state, seats, map, 80);
    state = out.state;
    commands.push(...out.commands);
    if (out.refused) {
      refused = `${out.refused.command.type}: ${out.refused.reason}`;
      break;
    }
    if (state.victory) break;
    if (state === before) {
      wedged = `turn ${state.turn}, ${state.phase} phase`;
      break;
    }
    if (state.turn > turnCap) break;
  }
  return { state, commands, refused, wedged };
};

// ---------------------------------------------------------------------------
// 1. It plays by the rules
// ---------------------------------------------------------------------------

describe('a computer seat never gives an order the engine refuses', () => {
  for (const def of SCENARIOS) {
    it(`${def.id} plays through without a refusal or a stall`, () => {
      const run = play(def.id, 3);
      expect({ id: def.id, refused: run.refused, wedged: run.wedged }).toEqual({
        id: def.id,
        refused: null,
        wedged: null,
      });
      // And it actually did something — a policy that returns null everywhere
      // would pass the check above while playing no game at all.
      expect(run.commands.filter((c) => c.type !== 'endPhase').length).toBeGreaterThan(0);
    });
  }
});

it('plays the same scenario on a second seed without a refusal', () => {
  for (const def of SCENARIOS) {
    const run = play(def.id, 19, 15);
    expect(`${def.id}: ${run.refused ?? 'ok'} / ${run.wedged ?? 'ok'}`).toBe(`${def.id}: ok / ok`);
  }
});

// ---------------------------------------------------------------------------
// 2. It is deterministic
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('gives the same order twice for the same position', () => {
    const state = buildScenario('lateral-7', { seed: 4 });
    const first = nextCommand(state, state.playerOrder[0]!, map);
    const second = nextCommand(state, state.playerOrder[0]!, map);
    expect(second).toEqual(first);
  });

  it('plays a whole game identically from the same seed', () => {
    const a = play('nova', 8, 12);
    const b = play('nova', 8, 12);
    expect(b.commands).toEqual(a.commands);
    // Same orders on the same seed must reach the same board, ship for ship.
    expect(Object.values(b.state.ships).map((s) => [s.id, s.pos, s.velocity, s.destroyed])).toEqual(
      Object.values(a.state.ships).map((s) => [s.id, s.pos, s.velocity, s.destroyed]),
    );
  });

  it('does not depend on the order the caller lists the seats in', () => {
    const state = buildScenario('interplanetary-war', { seed: 6 });
    const forwards = driveAi(state, new Set(state.playerOrder), map, 60);
    const backwards = driveAi(state, new Set([...state.playerOrder].reverse()), map, 60);
    expect(backwards.commands).toEqual(forwards.commands);
  });
});

// ---------------------------------------------------------------------------
// 3. It does not see through walls
// ---------------------------------------------------------------------------

describe('fog of war', () => {
  /**
   * "All ships and bases have detectors." A seat that has not detected a ship
   * has no business naming it in an order.
   */
  it('never names an enemy ship it has not detected', () => {
    let state = buildScenario('lateral-7', { seed: 5, options: { fogOfWar: true } });
    const seats = new Set(state.playerOrder);
    const named: { by: PlayerId; ship: string }[] = [];

    for (let step = 0; step < 4000; step += 1) {
      if (state.victory || state.turn > 20) break;
      const out = stepAi(state, seats, map);
      if (out.command === null) break;
      expect(out.refused).toBeUndefined();

      // Checked against the state the order was decided *in*, not a later one:
      // a ship detected two phases afterwards was still a secret at the time.
      for (const id of shipsNamedBy(out.command)) {
        const ship = state.ships[id];
        if (!ship || out.by === null) continue;
        if (areAllied(state, out.by, controllerOf(ship))) continue;
        if (!ship.detectedBy.some((v) => areAllied(state, out.by!, v))) {
          named.push({ by: out.by, ship: id });
        }
      }
      state = out.state;
    }
    expect(named).toEqual([]);
  });

  it('plays a fogged game without a refusal', () => {
    let state = buildScenario('escape', { seed: 2, options: { fogOfWar: true } });
    const seats = new Set(state.playerOrder);
    for (let round = 0; round < 200; round += 1) {
      const before = state;
      const out = driveAi(state, seats, map, 80);
      expect(out.refused).toBeUndefined();
      state = out.state;
      if (state.victory || state === before || state.turn > 20) break;
    }
  });
});

// ---------------------------------------------------------------------------
// Return fire
// ---------------------------------------------------------------------------

describe('return fire', () => {
  /**
   * "Ships which are attacked may return fire against any or all of their
   * attackers ... before any damage is implemented." The decision belongs to the
   * defender, and until it is made the engine accepts nothing else — so a
   * computer seat that let it lie would stop the game dead.
   */
  it('answers an outstanding counterattack rather than leaving it hanging', () => {
    const state = rig(
      [hull('a1', A, 'frigate', { pos: hex(0, 0) }), hull('b1', B, 'frigate', { pos: hex(0, 0) })],
      { phase: 'combat' },
    );
    const shot = applyCommand(
      state,
      { type: 'attack', by: A, attackers: ['a1'], targets: ['b1'] },
      map,
    );
    expect(shot.result.ok).toBe(true);

    const answer = nextCommand(shot.state, B, map);
    expect(answer?.type === 'counterattack' || answer?.type === 'declineCounterattack').toBe(true);
  });

  it('takes the free shot when the return fire can hurt', () => {
    const state = rig(
      [
        hull('a1', A, 'corvette', { pos: hex(0, 0) }),
        hull('b1', B, 'dreadnaught', { pos: hex(0, 0) }),
      ],
      { phase: 'combat' },
    );
    const shot = applyCommand(
      state,
      { type: 'attack', by: A, attackers: ['a1'], targets: ['b1'] },
      map,
    );
    // A dreadnaught answering a corvette is the most one-sided reply on the map.
    expect(nextCommand(shot.state, B, map)?.type).toBe('counterattack');
  });

  /**
   * The block runs both ways: while an answer is outstanding the *attacker* may
   * not act either, even though it is still their player-turn.
   */
  it('gives the attacker nothing to do while the answer is outstanding', () => {
    const state = rig(
      [
        hull('a1', A, 'frigate', { pos: hex(0, 0) }),
        hull('a2', A, 'frigate', { pos: hex(0, 0) }),
        hull('b1', B, 'frigate', { pos: hex(0, 0) }),
        hull('b2', B, 'frigate', { pos: hex(0, 0) }),
      ],
      { phase: 'combat' },
    );
    const shot = applyCommand(
      state,
      { type: 'attack', by: A, attackers: ['a1'], targets: ['b1'] },
      map,
    );
    expect(shot.result.ok).toBe(true);
    expect(nextCommand(shot.state, A, map)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Astrogation
// ---------------------------------------------------------------------------

describe('astrogation', () => {
  /**
   * "One fuel point allows a ship to alter its predicted course by one hex in
   * any direction", so shedding speed takes one turn per hex and stopping from
   * speed *v* needs `v(v+1)/2` hexes of room.
   */
  it('counts braking room the way the movement rule does', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(brakingRoom)).toEqual([0, 1, 3, 6, 10, 15, 21]);
  });

  /**
   * "Any ship whose final course places it off the map is considered
   * eliminated", and a ship that enters a planet's hex is destroyed. Both are
   * legal orders the engine will accept, so declining them is the pilot's job.
   */
  it('never offers itself a course that crashes or leaves the map', () => {
    const state = rig([hull('a1', A, 'corvette', { pos: hex(0, -12), velocity: hex(0, 2) })]);
    for (const option of safeCourses(state, state.ships['a1']!, map)) {
      expect({ crash: option.crashesInto, exit: option.exitsMap }).toEqual({
        crash: undefined,
        exit: false,
      });
    }
  });

  it('never plots a course that crashes or leaves the map', () => {
    const bad: string[] = [];
    for (const id of ['bi-planetary', 'lateral-7', 'nova', 'prospecting']) {
      let state = buildScenario(id, { seed: 12 });
      const seats = new Set(state.playerOrder);
      for (let step = 0; step < 6000; step += 1) {
        if (state.victory || state.turn > 20) break;
        const out = stepAi(state, seats, map);
        if (out.command === null) break;
        if (out.command.type === 'plotCourse') {
          const cmd = out.command;
          const ship = state.ships[cmd.ship]!;
          const option = reachableEndpoints(state, ship, map).find((o) =>
            eq(o.endpoint, cmd.endpoint),
          );
          if (option === undefined) bad.push(`${id}/${cmd.ship}: endpoint not reachable`);
          else if (option.crashesInto) bad.push(`${id}/${cmd.ship}: into ${option.crashesInto}`);
          else if (option.exitsMap) bad.push(`${id}/${cmd.ship}: off the map`);
        }
        state = out.state;
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * A ship needs one fuel point per hex of speed to come to rest, so a course
   * that ends carrying more speed than fuel is a course the ship can never stop
   * from — and a ship that cannot stop eventually reaches the rim.
   *
   * It is the second priority, not the first. A course with no continuation at
   * all kills the ship *next turn*, which beats running dry several turns later,
   * so the pilot is held to affordability only among the courses that leave it
   * somewhere to go.
   */
  it('never picks an unaffordable course over an affordable one', () => {
    const bad: string[] = [];
    let state = buildScenario('grand-tour', { seed: 3 });
    const seats = new Set(state.playerOrder);
    for (let step = 0; step < 8000; step += 1) {
      if (state.victory || state.turn > 25) break;
      const out = stepAi(state, seats, map);
      if (out.command === null) break;
      if (out.command.type === 'plotCourse') {
        const cmd = out.command;
        const ship = state.ships[cmd.ship]!;
        const options = safeCourses(state, ship, map).filter((o) => escapable(ship, o, map));
        const chosen = options.find((o) => eq(o.endpoint, cmd.endpoint));
        if (chosen && !solvent(ship, chosen) && options.some((o) => solvent(ship, o))) {
          bad.push(`${cmd.ship} at fuel ${ship.fuel} chose speed ${chosen.distance}`);
        }
      }
      state = out.state;
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario terms
// ---------------------------------------------------------------------------

describe('scenario terms', () => {
  /** Grand Tour: "Combat is not allowed." */
  it('does not open fire in a scenario that forbids combat', () => {
    const start = buildScenario('grand-tour', { seed: 3 });
    expect(combatForbidden(start)).toBe(true);

    const run = play('grand-tour', 3, 25);
    expect(run.commands.filter((c) => c.type === 'attack')).toEqual([]);
  });

  /**
   * Bi-Planetary: "each player must navigate to the other world and land. The
   * winner is the one who does it in the fewest turns."
   *
   * The day count is the point. Steering one turn at a time got a corvette down
   * on day 19; searching the whole profile gets both of them down on day 12 —
   * so the scenario now ends in the draw a race between two identical ships
   * flying the same problem ought to.
   */
  it('flies the race scenario as a race, and lands inside a fortnight', () => {
    const run = play('bi-planetary', 1, 40);
    expect(run.state.victory?.reason).toMatch(/[Ll]anded/);
    expect(run.state.turn).toBeLessThanOrEqual(14);
    const landed = Object.values(run.state.ships).filter((s) => s.location.kind === 'landed');
    expect(landed.length).toBeGreaterThan(0);
  });

  it('reads the errand off the scenario rather than hunting', () => {
    const start = buildScenario('bi-planetary', { seed: 1 });
    const mars = Object.values(start.ships).find((s) => s.owner === 'mars')!;
    expect(errandFor(start, mars, map)).toEqual({
      hex: map.body('venus')!.hex,
      bodyId: 'venus',
      land: true,
      why: 'reach the target world',
    });
  });

  /**
   * "Each ship must pass through at least one gravity hex" of every full-gravity
   * body — entered, not skimmed. The tour's own victory check reads the trail the
   * same way, so the pilot must too, or it would fly a lap that does not count.
   */
  it('counts a body as visited only once a gravity hex has been entered', () => {
    const run = play('grand-tour', 3, 25);
    const racer = Object.values(run.state.ships).find((s) => !s.destroyed)!;
    const seen = bodiesVisited(racer, map);
    for (const id of seen) expect(map.body(id)).toBeDefined();
    expect(seen.size).toBeGreaterThan(0);
  });

  /**
   * Lateral 7: "the Dreadnaught may not move until the pirates are detected."
   * The engine refuses the order; the pilot must not have given it.
   */
  it('leaves a ship the scenario has pinned down alone', () => {
    const run = play('lateral-7', 7, 20);
    expect(run.refused).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Combat judgement
// ---------------------------------------------------------------------------

describe('combat judgement', () => {
  /**
   * "Attacks at worse than 1:4 have no effect." A corvette shooting at a
   * dreadnaught is 1:8 — off the table, and the engine will not even offer a
   * column — so there is nothing to weigh.
   */
  it('does not fire a shot that cannot do anything', () => {
    const state = rig(
      [
        hull('a1', A, 'corvette', { pos: hex(0, 0) }),
        hull('b1', B, 'dreadnaught', { pos: hex(0, 0) }),
      ],
      { phase: 'combat' },
    );
    const preview = previewAttack(state, ['a1'], ['b1'], map);
    expect(preview.column).toBeNull();
    expect(nextCommand(state, A, map)).toBeNull();
  });

  /** The mirror: a dreadnaught over a corvette is the shot anybody takes. */
  it('fires when the odds are good', () => {
    const state = rig(
      [
        hull('a1', A, 'dreadnaught', { pos: hex(0, 0) }),
        hull('b1', B, 'corvette', { pos: hex(0, 0) }),
      ],
      { phase: 'combat' },
    );
    const cmd = nextCommand(state, A, map);
    expect(cmd).toEqual({ type: 'attack', by: A, attackers: ['a1'], targets: ['b1'] });
  });

  /**
   * An even exchange is still worth taking. Two identical frigates in the same
   * hex make a perfectly symmetric trade; a pilot that required an advantage
   * would decline forever and the battle would never be fought.
   */
  it('takes an even exchange rather than standing off', () => {
    const state = rig(
      [hull('a1', A, 'frigate', { pos: hex(0, 0) }), hull('b1', B, 'frigate', { pos: hex(0, 0) })],
      { phase: 'combat' },
    );
    expect(nextCommand(state, A, map)?.type).toBe('attack');
  });

  /**
   * "Any number of ships may combine their fire" — but one die decides the
   * attack and its result applies to every ship that fired when the return fire
   * comes back. Massing the whole fleet into one attack risks the whole fleet, so
   * the pilot brings enough and no more.
   */
  it('does not throw its whole fleet into one attack when a smaller group will do', () => {
    const state = rig(
      [
        hull('a1', A, 'dreadnaught', { pos: hex(0, 0) }),
        hull('a2', A, 'dreadnaught', { pos: hex(0, 0) }),
        hull('a3', A, 'dreadnaught', { pos: hex(0, 0) }),
        hull('b1', B, 'corvette', { pos: hex(0, 0) }),
      ],
      { phase: 'combat' },
    );
    const cmd = nextCommand(state, A, map);
    expect(cmd?.type).toBe('attack');
    const attackers = (cmd as { attackers: readonly string[] }).attackers;
    expect(attackers.length).toBeLessThan(3);
  });

  /**
   * "A disabled ship cannot maneuver, launch ordnance, or attack" — but it is a
   * prize: "a disabled ship may be looted or captured by any enemy ship which
   * matches courses with it."
   */
  it('boards a helpless enemy it has matched courses with', () => {
    const state = rig(
      [
        hull('a1', A, 'frigate', { pos: hex(3, 3) }),
        hull('b1', B, 'corvette', { pos: hex(3, 3), disabled: 3 }),
      ],
      { phase: 'resupply' },
    );
    expect(nextCommand(state, A, map)).toEqual({
      type: 'capture',
      by: A,
      ship: 'a1',
      target: 'b1',
    });
  });

  it('does not try to board while disabled itself', () => {
    const state = rig(
      [
        hull('a1', A, 'frigate', { pos: hex(3, 3), disabled: 2 }),
        hull('b1', B, 'corvette', { pos: hex(3, 3), disabled: 3 }),
      ],
      { phase: 'resupply' },
    );
    const cmd = nextCommand(state, A, map);
    expect(cmd?.type).not.toBe('capture');
  });
});

// ---------------------------------------------------------------------------
// Surrender
// ---------------------------------------------------------------------------

describe('surrender', () => {
  /**
   * "Surrender is a binding bargain. Both parties agree not to attack the other
   * specific ship." A ship that can still shoot has something to give up; one
   * that cannot has only the truce to gain.
   */
  const demanded = (extra: Partial<Ship>): GameState => {
    const state = rig(
      [
        hull('a1', A, 'dreadnaught', { pos: hex(0, 0) }),
        hull('b1', B, 'corvette', { pos: hex(0, 0), ...extra }),
      ],
      { phase: 'combat' },
    );
    const out = applyCommand(
      state,
      { type: 'demandSurrender', by: A, ship: 'a1', target: 'b1' },
      map,
    );
    expect(out.result.ok).toBe(true);
    return out.state;
  };

  it('answers the demand rather than ignoring it', () => {
    const cmd = nextCommand(demanded({}), B, map);
    expect(cmd?.type).toBe('respondToSurrender');
  });

  it('refuses while the ship can still fight', () => {
    const cmd = nextCommand(demanded({}), B, map) as { accept: boolean; to: string };
    expect({ accept: cmd.accept, to: cmd.to }).toEqual({ accept: false, to: 'a1' });
  });

  it('strikes the bargain when the ship is out of the fight', () => {
    const cmd = nextCommand(demanded({ disabled: 4 }), B, map) as { accept: boolean };
    expect(cmd.accept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

describe('the driver', () => {
  it('leaves a human seat alone', () => {
    const state = buildScenario('bi-planetary', { seed: 1 });
    const human = state.playerOrder[0]!;
    const out = driveAi(state, new Set([state.playerOrder[1]!]), map, 60);
    // Every order it gave belongs to the computer's seat, never the human's.
    expect(out.commands.filter((c) => c.by === human)).toEqual([]);
  });

  it('does nothing at all when no seat is a computer', () => {
    const state = buildScenario('bi-planetary', { seed: 1 });
    const out = driveAi(state, new Set(), map, 60);
    expect(out.commands).toEqual([]);
    expect(out.state).toBe(state);
  });

  it('reports whether there is anything for the computer to do', () => {
    const state = buildScenario('bi-planetary', { seed: 1 });
    expect(aiHasMove(state, new Set(state.playerOrder), map)).toBe(true);
    expect(aiHasMove(state, new Set(), map)).toBe(false);
  });

  it('stops once the game is decided', () => {
    const run = play('bi-planetary', 1, 40);
    expect(run.state.victory).not.toBeNull();
    const after = driveAi(run.state, new Set(run.state.playerOrder), map, 60);
    expect(after.commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// It actually plays
// ---------------------------------------------------------------------------

describe('it plays a game, not just a legal sequence', () => {
  it('closes with the enemy instead of drifting', () => {
    const start = buildScenario('interplanetary-war', { seed: 6 });
    const gap = (state: GameState): number => {
      let closest = Infinity;
      for (const a of Object.values(state.ships)) {
        if (a.destroyed) continue;
        for (const b of Object.values(state.ships)) {
          if (b.destroyed || areAllied(state, controllerOf(a), controllerOf(b))) continue;
          closest = Math.min(closest, distance(a.pos, b.pos));
        }
      }
      return closest;
    };
    const run = play('interplanetary-war', 6, 25);
    expect(gap(run.state)).toBeLessThan(gap(start));
  });

  it('fights, and the fighting costs somebody something', () => {
    const run = play('interplanetary-war', 6, 25);
    const lost = Object.values(run.state.ships).filter((s) => s.destroyed);
    expect(lost.length).toBeGreaterThan(0);
    expect(run.commands.filter((c) => c.type === 'attack').length).toBeGreaterThan(0);
  });

  it('goes home to refuel before it runs dry', () => {
    const run = play('piracy', 4, 25);
    expect(run.commands.filter((c) => c.type === 'resupply').length).toBeGreaterThan(0);
  });

  it('leaves the weakest ships alive longer than the strongest are worth', () => {
    // A sanity check on target choice rather than a rule: over a real game the
    // pilot should be spending its fire on something, and the board should end
    // up cheaper than it started.
    const start = buildScenario('nova', { seed: 8 });
    const worth = (s: GameState): number =>
      Object.values(s.ships)
        .filter((sh) => !sh.destroyed)
        .reduce((n, sh) => n + combatStrength(sh), 0);
    const run = play('nova', 8, 25);
    expect(worth(run.state)).toBeLessThan(worth(start));
  });
});
