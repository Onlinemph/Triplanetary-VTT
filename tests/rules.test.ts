/**
 * Rules integration tests.
 *
 * These drive the engine the way a player does — through `applyCommand` and the
 * phase machine — rather than poking at module internals, so they exercise the
 * rules modules and the reducer's wiring together.
 */

import { describe, expect, it } from 'vitest';
import { applyDamage } from '../src/engine/combat.js';
import {
  type Command,
  type GameState,
  type Ship,
  DEFAULT_MAP,
  applyCommand,
  createInitialState,
  hex,
  key,
  makePlayer,
  makeShip,
  neighbor,
  sub,
  add,
  distance,
  oddsColumn,
  predictedEndpoint,
  reachableEndpoints,
} from '../src/engine/index.js';

const map = DEFAULT_MAP;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const A = 'a';
const B = 'b';

interface RigOptions {
  readonly ships: readonly Ship[];
  readonly options?: Partial<GameState['options']>;
  readonly seed?: number;
}

const rig = (o: RigOptions): GameState =>
  createInitialState({
    scenarioId: 'test',
    seed: o.seed ?? 1234,
    players: [
      makePlayer(A, 'Player A', 'Alpha', '#e8703a'),
      makePlayer(B, 'Player B', 'Beta', '#4a9fe0'),
    ],
    ships: o.ships,
    options: o.options ?? {},
  });

/** Apply a command, asserting it was accepted. */
const ok = (state: GameState, cmd: Command): GameState => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, reason: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    reason: undefined,
  });
  return out.state;
};

/** Apply a command, asserting it was refused. */
const refused = (state: GameState, cmd: Command): string => {
  const out = applyCommand(state, cmd, map);
  expect(out.result.ok).toBe(false);
  expect(out.state).toBe(state); // rejections must not mutate
  return out.result.reason ?? '';
};

const endPhase = (state: GameState, by = state.playerOrder[state.activePlayerIndex]!): GameState =>
  ok(state, { type: 'endPhase', by });

/** Run a full player-turn, coasting every ship. */
const runTurn = (state: GameState): GameState => {
  let s = state;
  for (let i = 0; i < 5; i++) s = endPhase(s);
  return s;
};

/**
 * A one-player rig. With a single player a "player-turn" and a game turn
 * coincide, so `runTurn` advances the day — which is what the multi-turn
 * movement and repair tests want to reason about.
 */
const solo = (ships: readonly Ship[], options: Partial<GameState['options']> = {}): GameState =>
  createInitialState({
    scenarioId: 'test',
    seed: 1234,
    players: [makePlayer(A, 'Player A', 'Alpha', '#e8703a')],
    ships,
    options,
  });

const shipAt = (state: GameState, id: string): Ship => state.ships[id]!;

const TERRA = map.body('terra')!;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('every scenario builds a coherent state', async () => {
    const { SCENARIOS, buildScenario } = await import('../src/scenarios/index.js');
    expect(SCENARIOS.length).toBe(10);

    for (const def of SCENARIOS) {
      const state = buildScenario(def.id, { seed: 42 });
      expect({ id: def.id, players: state.playerOrder.length >= def.players.min }).toEqual({
        id: def.id,
        players: true,
      });
      expect({ id: def.id, hasShips: Object.keys(state.ships).length > 0 }).toEqual({
        id: def.id,
        hasShips: true,
      });

      for (const ship of Object.values(state.ships)) {
        // Nobody starts off the chart, inside a planet, or over capacity.
        expect({ id: def.id, ship: ship.id, inBounds: map.inBounds(ship.pos) }).toEqual({
          id: def.id,
          ship: ship.id,
          inBounds: true,
        });
        expect({ id: def.id, ship: ship.id, owned: ship.owner in state.players }).toEqual({
          id: def.id,
          ship: ship.id,
          owned: true,
        });
        expect(ship.fuel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('builds deterministically from a seed', async () => {
    const { buildScenario } = await import('../src/scenarios/index.js');
    for (const id of ['lateral-7', 'nova', 'prospecting']) {
      const a = JSON.stringify(buildScenario(id, { seed: 7 }));
      const b = JSON.stringify(buildScenario(id, { seed: 7 }));
      expect(a).toEqual(b);
    }
  });

  it('starts Bi-Planetary with a corvette landed on each of Mars and Venus', async () => {
    const { buildScenario } = await import('../src/scenarios/index.js');
    const state = buildScenario('bi-planetary', { seed: 1 });
    const ships = Object.values(state.ships);
    expect(ships).toHaveLength(2);
    const worlds = ships
      .map((s) => (s.location.kind === 'landed' ? map.bodyAt(s.location.side.hex)?.id : null))
      .sort();
    expect(worlds).toEqual(['mars', 'venus']);
    for (const s of ships) expect(s.shipClass).toBe('corvette');
  });
});

// ---------------------------------------------------------------------------
// Astrogation and movement
// ---------------------------------------------------------------------------

describe('astrogation', () => {
  const corvetteAt = (pos: ReturnType<typeof hex>, velocity = hex(0, 0), fuel = 20): Ship =>
    makeShip({ id: 's1', owner: A, shipClass: 'corvette', pos, velocity, fuel });

  it('coasts to position + velocity when no fuel is burned', () => {
    // "A ship which is not accelerated by thrust or gravity will move as it did
    //  in the previous turn, in the same direction, and traveling an equal distance."
    const start = hex(0, 8);
    const v = hex(2, 0);
    const state = rig({ ships: [corvetteAt(start, v)] });
    expect(key(predictedEndpoint(state, shipAt(state, 's1'), map))).toBe(key(add(start, v)));

    const after = runTurn(state);
    const ship = shipAt(after, 's1');
    expect(key(ship.pos)).toBe(key(add(start, v)));
    expect(key(ship.velocity)).toBe(key(v));
    expect(ship.fuel).toBe(20); // coasting is free
  });

  it('offers exactly the predicted hex and its six neighbours for one fuel point', () => {
    const state = rig({ ships: [corvetteAt(hex(0, 8), hex(2, 0))] });
    const opts = reachableEndpoints(state, shipAt(state, 's1'), map);
    const byAccel = new Map<number, number>();
    for (const o of opts) byAccel.set(o.accel, (byAccel.get(o.accel) ?? 0) + 1);
    expect(byAccel.get(0)).toBe(1); // the coast
    expect(byAccel.get(1)).toBe(6); // "one hex in any direction"
  });

  it('charges one fuel point for a one-hex course change', () => {
    const start = hex(0, 8);
    const v = hex(2, 0);
    const state = rig({ ships: [corvetteAt(start, v)] });
    const target = neighbor(add(start, v), 1);

    const plotted = ok(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: target });
    const after = runTurn(plotted);
    const ship = shipAt(after, 's1');
    expect(key(ship.pos)).toBe(key(target));
    expect(ship.fuel).toBe(19);
    // The new velocity is the whole leg, not the old vector plus a nudge.
    expect(key(ship.velocity)).toBe(key(sub(target, start)));
  });

  it('refuses an endpoint more than one hex from the prediction without overload', () => {
    const state = rig({ ships: [corvetteAt(hex(0, 8), hex(2, 0))] });
    const far = add(add(hex(0, 8), hex(2, 0)), hex(2, 0));
    expect(refused(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: far })).toBeTruthy();
  });

  it('allows a two-hex change on overload, and only once', () => {
    // "Warships may perform one overload maneuver between maintenance stopovers."
    const start = hex(0, 8);
    const v = hex(2, 0);
    let state = rig({ ships: [corvetteAt(start, v)] });
    const two = add(add(start, v), hex(2, 0));

    state = ok(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: two, overload: true });
    state = runTurn(state);
    expect(shipAt(state, 's1').fuel).toBe(18); // two fuel points
    expect(shipAt(state, 's1').overloadAvailable).toBe(false);

    const again = add(add(shipAt(state, 's1').pos, shipAt(state, 's1').velocity), hex(2, 0));
    expect(
      refused(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: again, overload: true }),
    ).toBeTruthy();
  });

  it('forbids commercial ships the overload manoeuvre', () => {
    // "Commercial ships (transports, packets, tankers, liners) may not perform
    //  the overload maneuver."
    for (const cls of ['transport', 'packet', 'tanker', 'liner'] as const) {
      const state = rig({
        ships: [makeShip({ id: 'c', owner: A, shipClass: cls, pos: hex(0, 8), velocity: hex(2, 0) })],
      });
      const two = add(add(hex(0, 8), hex(2, 0)), hex(2, 0));
      expect(
        refused(state, { type: 'plotCourse', by: A, ship: 'c', endpoint: two, overload: true }),
      ).toBeTruthy();
    }
  });

  it('cannot burn fuel it does not have', () => {
    const state = rig({ ships: [corvetteAt(hex(0, 8), hex(2, 0), 0)] });
    const target = neighbor(add(hex(0, 8), hex(2, 0)), 1);
    expect(refused(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: target })).toBeTruthy();
  });

  it('destroys a ship whose course intersects a planet', () => {
    // "If a ship's course vector intersects the printed outline of an astral
    //  body, it has crashed. The ship is eliminated."
    const start = add(TERRA.hex, hex(-3, 0));
    const state = rig({
      ships: [makeShip({ id: 's1', owner: A, shipClass: 'corvette', pos: start, velocity: hex(3, 0) })],
    });
    const after = runTurn(state);
    expect(shipAt(after, 's1').destroyed).toBe(true);
  });

  it('destroys a ship whose final endpoint leaves the chart', () => {
    // "Any ship whose final course places it off the map is considered eliminated."
    const edge = hex(33, 0);
    expect(map.inBounds(edge)).toBe(true);
    const state = rig({
      ships: [makeShip({ id: 's1', owner: A, shipClass: 'corvette', pos: edge, velocity: hex(4, 0) })],
    });
    const after = runTurn(state);
    expect(shipAt(after, 's1').destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Takeoff, orbit and landing — the canonical flight
// ---------------------------------------------------------------------------

describe('takeoff, orbit and landing', () => {
  const landedCorvette = (dir: number): Ship =>
    makeShip({
      id: 's1',
      owner: A,
      shipClass: 'corvette',
      pos: TERRA.hex,
      location: { kind: 'landed', side: { hex: TERRA.hex, dir } },
    });

  it('lifts to the gravity hex above the base, stationary and free', () => {
    // "Boosters provide an acceleration of one hex... takeoff requires no fuel
    //  points. The planetary surface gravity immediately cancels takeoff
    //  velocity, leaving the ship stationary in the gravity hex."
    let state = solo([landedCorvette(0)]);
    state = ok(state, { type: 'takeOff', by: A, ship: 's1' });
    // Declared in astrogation, executed in the movement phase.
    state = runTurn(state);
    const ship = shipAt(state, 's1');
    expect(key(ship.pos)).toBe(key(neighbor(TERRA.hex, 0)));
    expect(key(ship.velocity)).toBe('0,0');
    expect(ship.fuel).toBe(20);
    expect(ship.location.kind).toBe('space');
  });

  it('falls back onto the planet if no fuel is spent next turn', () => {
    let state = solo([landedCorvette(0)]);
    state = ok(state, { type: 'takeOff', by: A, ship: 's1' });
    state = runTurn(state); // the takeoff turn: boosters lift it clear
    expect(shipAt(state, 's1').destroyed).toBe(false);
    state = runTurn(state); // coast: gravity pulls it back down
    expect(shipAt(state, 's1').destroyed).toBe(true);
  });

  it('enters a stable orbit for one fuel point and stays there for many turns', () => {
    let state = solo([landedCorvette(0)]);
    state = ok(state, { type: 'takeOff', by: A, ship: 's1' });
    state = runTurn(state);

    // Find the burn that produces an orbit.
    const ring = new Set([0, 1, 2, 3, 4, 5].map((d) => key(neighbor(TERRA.hex, d))));
    const options = reachableEndpoints(state, shipAt(state, 's1'), map).filter(
      (o) => o.accel === 1 && ring.has(key(o.endpoint)) && !o.crashesInto,
    );
    expect(options.length).toBeGreaterThan(0);

    let orbited = 0;
    for (const opt of options) {
      let s = ok(state, { type: 'plotCourse', by: A, ship: 's1', endpoint: opt.endpoint });
      s = runTurn(s);
      let stayed = true;
      for (let t = 0; t < 24; t++) {
        s = runTurn(s);
        const sh = shipAt(s, 's1');
        if (sh.destroyed || !ring.has(key(sh.pos))) {
          stayed = false;
          break;
        }
      }
      if (stayed) {
        orbited++;
        // Still full fuel bar one point, 25 turns later: orbit is free.
        expect(shipAt(s, 's1').fuel).toBe(19);
        expect(map.orbitOf(shipAt(s, 's1').pos, shipAt(s, 's1').velocity)?.id).toBe('terra');
      }
    }
    // Clockwise and counter-clockwise both work.
    expect(orbited).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

describe('gun combat', () => {
  const clear = hex(0, 14); // empty space, clear of every body

  const pair = (attacker: Parameters<typeof makeShip>[0], target: Parameters<typeof makeShip>[0]) =>
    rig({ ships: [makeShip(attacker), makeShip(target)] });

  const toCombat = (state: GameState): GameState => {
    let s = state;
    while (s.phase !== 'combat') s = endPhase(s);
    return s;
  };

  it('resolves the rulebook’s worked example at 2:1', () => {
    // "A corsair (combat strength 4) attacks a corvette (combat strength 2).
    //  4 to 2 reduces to 2-to-1"
    expect(oddsColumn(4, 2)).toBe('2:1');
  });

  it('refuses an attack by a D-suffix ship', () => {
    // "Commercial ships have a suffix D in their combat strengths and may not
    //  attack or counterattack."
    for (const cls of ['transport', 'tanker', 'liner'] as const) {
      const state = toCombat(
        pair(
          { id: 'atk', owner: A, shipClass: cls, pos: clear },
          { id: 'def', owner: B, shipClass: 'corvette', pos: clear },
        ),
      );
      expect(
        refused(state, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
      ).toBeTruthy();
    }
  });

  it('lets a packet attack despite being commercial', () => {
    // A packet's strength has no D suffix.
    const state = toCombat(
      pair(
        { id: 'atk', owner: A, shipClass: 'packet', pos: clear },
        { id: 'def', owner: B, shipClass: 'corvette', pos: clear },
      ),
    );
    ok(state, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
  });

  it('blocks a sight line that passes through a planet', () => {
    // "Attacks may be made through other ships, ordnance, and asteroids, but not
    //  through moons, planets, or Sol."
    const state = toCombat(
      pair(
        { id: 'atk', owner: A, shipClass: 'corsair', pos: add(TERRA.hex, hex(-3, 0)) },
        { id: 'def', owner: B, shipClass: 'corvette', pos: add(TERRA.hex, hex(3, 0)) },
      ),
    );
    expect(
      refused(state, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    ).toBeTruthy();
  });

  it('forbids a second attack by the same ship in one combat phase', () => {
    // "No ship may attack or be attacked more than once per combat phase."
    let state = toCombat(
      rig({
        ships: [
          makeShip({ id: 'atk', owner: A, shipClass: 'corsair', pos: clear }),
          makeShip({ id: 'd1', owner: B, shipClass: 'corvette', pos: clear }),
          makeShip({ id: 'd2', owner: B, shipClass: 'corvette', pos: add(clear, hex(1, 0)) }),
        ],
      }),
    );
    state = ok(state, { type: 'attack', by: A, attackers: ['atk'], targets: ['d1'] });
    // Clear any counterattack handshake before trying again.
    const out = applyCommand(state, { type: 'declineCounterattack', by: B }, map);
    if (out.result.ok) state = out.state;
    expect(
      refused(state, { type: 'attack', by: A, attackers: ['atk'], targets: ['d2'] }),
    ).toBeTruthy();
  });

  it('accumulates damage and destroys at D6', () => {
    // "if a ship which will be disabled for 3 more turns receives a D3 result,
    //  it is destroyed."
    const state = rig({
      ships: [makeShip({ id: 'v', owner: B, shipClass: 'corvette', pos: clear })],
    });
    let s = applyDamage(state, 'v', 3, 'test');
    expect(shipAt(s, 'v').disabled).toBe(3);
    expect(shipAt(s, 'v').destroyed).toBe(false);
    s = applyDamage(s, 'v', 3, 'test');
    expect(shipAt(s, 'v').destroyed).toBe(true);
  });

  it('recovers one point of disablement per turn', () => {
    // "A damaged ship will repair itself at the rate of one 'D' per turn."
    let state = solo([makeShip({ id: 'v', owner: A, shipClass: 'corvette', pos: clear })]);
    state = applyDamage(state, 'v', 3, 'test');
    expect(shipAt(state, 'v').disabled).toBe(3);
    state = runTurn(state);
    expect(shipAt(state, 'v').disabled).toBe(2);
    state = runTurn(state);
    expect(shipAt(state, 'v').disabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism — the property multiplayer depends on
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('replays a command log to a byte-identical state', async () => {
    const { buildScenario } = await import('../src/scenarios/index.js');

    const play = (): GameState => {
      let s = buildScenario('lateral-7', { seed: 99 });
      const log: Command[] = [];
      for (let turn = 0; turn < 20; turn++) {
        const by = s.playerOrder[s.activePlayerIndex]!;
        const cmd: Command = { type: 'endPhase', by };
        log.push(cmd);
        const out = applyCommand(s, cmd, map);
        if (!out.result.ok) break;
        s = out.state;
      }
      return s;
    };

    expect(JSON.stringify(play())).toEqual(JSON.stringify(play()));
  });

  it('produces different games from different seeds', async () => {
    const { buildScenario } = await import('../src/scenarios/index.js');
    const run = (seed: number): string => {
      let s = buildScenario('nova', { seed });
      for (let i = 0; i < 30; i++) {
        const out = applyCommand(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! }, map);
        if (!out.result.ok) break;
        s = out.state;
      }
      return JSON.stringify(s.rng);
    };
    expect(run(1)).not.toEqual(run(2));
  });
});

// ---------------------------------------------------------------------------
// Whole-game smoke test
// ---------------------------------------------------------------------------

describe('phase machine', () => {
  it('cycles five phases per player and advances the day', async () => {
    const { buildScenario } = await import('../src/scenarios/index.js');
    let s = buildScenario('bi-planetary', { seed: 3 });
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('astrogation');

    const players = s.playerOrder.length;
    for (let i = 0; i < 5 * players; i++) {
      s = ok(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! });
    }
    expect(s.turn).toBe(2);
    expect(s.phase).toBe('astrogation');
    expect(s.activePlayerIndex).toBe(0);
  });

  it('refuses commands from the player who is not on turn', () => {
    const state = rig({
      ships: [makeShip({ id: 's1', owner: A, shipClass: 'corvette', pos: hex(0, 14) })],
    });
    expect(refused(state, { type: 'endPhase', by: B })).toBeTruthy();
  });

  it('survives a long unattended game on every scenario', async () => {
    const { SCENARIOS, buildScenario } = await import('../src/scenarios/index.js');
    for (const def of SCENARIOS) {
      let s = buildScenario(def.id, { seed: 11 });
      for (let i = 0; i < 200; i++) {
        const out = applyCommand(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! }, map);
        expect({ id: def.id, step: i, ok: out.result.ok }).toEqual({
          id: def.id,
          step: i,
          ok: true,
        });
        s = out.state;
        if (s.victory) break;
      }
      // Nothing should have drifted off the chart or gone negative.
      for (const ship of Object.values(s.ships)) {
        if (ship.destroyed) continue;
        expect({ id: def.id, ship: ship.id, inBounds: map.inBounds(ship.pos) }).toEqual({
          id: def.id,
          ship: ship.id,
          inBounds: true,
        });
        expect(ship.fuel).toBeGreaterThanOrEqual(0);
        expect(ship.disabled).toBeLessThan(6);
      }
    }
  });
});
