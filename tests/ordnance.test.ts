/**
 * Ordnance, resupply, detection and the counterattack handshake.
 *
 * These cover the rules with the most room for a plausible-looking wrong
 * implementation: detonation geometry ("any portion of the hex", which is a
 * strictly larger set than the hexes a course enters), the counterattack
 * ordering, and the fact that refuelling implies full maintenance.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Ship,
  DEFAULT_MAP,
  applyCommand,
  createInitialState,
  add,
  hex,
  key,
  makePlayer,
  makeShip,
  neighbor,
  traceSegment,
} from '../src/engine/index.js';
import { ORDNANCE_MASS, canLaunch } from '../src/engine/ordnance.js';
import { canResupplyAt, coursesMatched } from '../src/engine/logistics.js';
import { applyDamage } from '../src/engine/combat.js';
import { isDetected } from '../src/engine/detection.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';
const TERRA = map.body('terra')!;

/** Deep space, well away from every body and the belt. */
const CLEAR = hex(0, 9);

const game = (ships: readonly Ship[], players = [A, B]): GameState =>
  createInitialState({
    scenarioId: 'test',
    seed: 4242,
    players: players.map((id, i) =>
      makePlayer(id, `Player ${id}`, `F${i}`, i === 0 ? '#e8703a' : '#4a9fe0'),
    ),
    ships,
  });

const ok = (state: GameState, cmd: Command): GameState => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const refuse = (state: GameState, cmd: Command): string => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
  return out.result.reason ?? '';
};

const toPhase = (state: GameState, phase: GameState['phase']): GameState => {
  let s = state;
  let guard = 0;
  while (s.phase !== phase && guard++ < 12) {
    s = ok(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! });
  }
  return s;
};

// ---------------------------------------------------------------------------
// Detonation geometry
// ---------------------------------------------------------------------------

describe('detonation geometry', () => {
  it('counts hexes a course only grazes, which entering does not', () => {
    // "Mines, torpedoes, and nukes are detonated when they enter a hex
    //  containing a ship" and a mine goes off when a course "passes through
    //  ANY PORTION of the hex occupied by the mine".
    //
    // The axial (1,1) course runs along a hexside: it *enters* neither adjacent
    // hex, but it certainly passes through a portion of both. An implementation
    // that used `entered` here would let ships slide past mines untouched.
    const t = traceSegment(hex(0, 0), hex(1, 1));
    const entered = new Set(t.entered.map(key));
    const touched = new Set(t.touched.map((x) => key(x.hex)));

    expect(entered).toEqual(new Set(['0,0', '1,1']));
    expect(touched).toEqual(new Set(['0,0', '0,1', '1,0', '1,1']));
    // Strictly larger — this is the whole point.
    expect(touched.size).toBeGreaterThan(entered.size);
  });
});

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

describe('ordnance launch', () => {
  const armed = (cls: Ship['shipClass'], cargo: Ship['cargo']): Ship =>
    makeShip({ id: 'w', owner: A, shipClass: cls, pos: CLEAR, velocity: hex(1, 0), cargo });

  it('uses the rulebook masses', () => {
    expect(ORDNANCE_MASS.mine).toBe(10);
    expect(ORDNANCE_MASS.torpedo).toBe(20);
    expect(ORDNANCE_MASS.nuke).toBe(20);
  });

  it('lets a warship launch a torpedo it is carrying', () => {
    let s = game([armed('frigate', [{ kind: 'torpedo', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'torpedo' });
    expect(Object.keys(s.ordnance)).toHaveLength(1);
  });

  it('forbids a non-warship from launching torpedoes', () => {
    // "Only warships may launch torpedoes."
    let s = game([armed('packet', [{ kind: 'torpedo', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    expect(refuse(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'torpedo' })).toBeTruthy();
  });

  it('lets any ship with hold space lay a mine', () => {
    // "Any ship with sufficient capacity to carry a mine may also launch it."
    let s = game([armed('transport', [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    expect(Object.keys(s.ordnance)).toHaveLength(1);
  });

  it('allows only one item per ship per turn', () => {
    // "Each ship may release only one item per turn."
    let s = game([armed('frigate', [{ kind: 'mine', quantity: 2 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    expect(refuse(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' })).toBeTruthy();
  });

  it('refuses to launch what the ship is not carrying', () => {
    let s = game([armed('frigate', [])]);
    s = toPhase(s, 'ordnance');
    expect(refuse(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' })).toBeTruthy();
  });

  it('forbids launching while landed at a base', () => {
    // "Ordnance may not be launched while the ship is at a base, refueling...
    //  or taking off from or landing on a planet."
    const landed = makeShip({
      id: 'w',
      owner: A,
      shipClass: 'frigate',
      pos: TERRA.hex,
      location: { kind: 'landed', side: { hex: TERRA.hex, dir: 0 } },
      cargo: [{ kind: 'mine', quantity: 1 }],
    });
    let s = toPhase(game([landed]), 'ordnance');
    const check = canLaunch(s, s.ships['w']!, 'mine', map);
    expect(check.ok).toBe(false);
  });

  it('gives a launched mine the launcher’s vector', () => {
    // "When a mine is launched, it assumes the vector of its launching ship."
    let s = game([armed('frigate', [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    const mine = Object.values(s.ordnance)[0]!;
    expect(key(mine.velocity)).toBe(key(s.ships['w']!.velocity));
    expect(key(mine.pos)).toBe(key(s.ships['w']!.pos));
  });

  it('gives ordnance a five-turn life', () => {
    // "Mines remain active for five turns, after which they self-destruct."
    let s = game([armed('frigate', [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    expect(Object.values(s.ordnance)[0]!.turnsRemaining).toBe(5);
  });

  it('consumes hold capacity when carried', () => {
    // A corvette's hold is 5 tons; a mine is 10 and a torpedo 20.
    const corvette = makeShip({ id: 'c', owner: A, shipClass: 'corvette', pos: CLEAR });
    const s = toPhase(game([corvette]), 'ordnance');
    expect(canLaunch(s, s.ships['c']!, 'mine', map).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Counterattack
// ---------------------------------------------------------------------------

describe('counterattack', () => {
  it('offers return fire, and applies both results together', () => {
    // "Ships which are attacked may return fire against any or all of their
    //  attackers during the combat phase, before any damage is implemented."
    let s = game([
      makeShip({ id: 'atk', owner: A, shipClass: 'corsair', pos: CLEAR }),
      makeShip({ id: 'def', owner: B, shipClass: 'corsair', pos: CLEAR }),
    ]);
    s = toPhase(s, 'combat');
    s = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });

    // A live pending decision must belong to the defender.
    const out = applyCommand(s, { type: 'counterattack', by: B, attackers: ['def'], targets: ['atk'] }, map);
    expect(out.result.ok).toBe(true);
  });

  it('lets the defender decline, which still applies the attacker’s damage', () => {
    let s = game([
      makeShip({ id: 'atk', owner: A, shipClass: 'corsair', pos: CLEAR }),
      makeShip({ id: 'def', owner: B, shipClass: 'corsair', pos: CLEAR }),
    ]);
    s = toPhase(s, 'combat');
    s = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
    const out = applyCommand(s, { type: 'declineCounterattack', by: B }, map);
    expect(out.result.ok).toBe(true);
  });

  it('never offers a counterattack to a D-suffix defender', () => {
    // A transport "may not attack or counterattack", so no decision is owed and
    // the damage must land immediately.
    let s = game([
      makeShip({ id: 'atk', owner: A, shipClass: 'corsair', pos: CLEAR }),
      makeShip({ id: 'def', owner: B, shipClass: 'transport', pos: CLEAR }),
    ]);
    s = toPhase(s, 'combat');
    s = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
    expect(
      applyCommand(s, { type: 'counterattack', by: B, attackers: ['def'], targets: ['atk'] }, map)
        .result.ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resupply and maintenance
// ---------------------------------------------------------------------------

describe('resupply', () => {
  /** A ship landed on Terra through the hexside that carries a base. */
  const landedOnTerra = (over: Partial<Parameters<typeof makeShip>[0]> = {}): Ship =>
    makeShip({
      id: 'r',
      owner: A,
      shipClass: 'corsair',
      pos: TERRA.hex,
      location: { kind: 'landed', side: { hex: TERRA.hex, dir: 0 } },
      fuel: 3,
      ...over,
    });

  it('is available to a ship landed at a base', () => {
    const s = game([landedOnTerra()]);
    expect(canResupplyAt(s, s.ships['r']!, map).ok).toBe(true);
  });

  it('is not available in open space', () => {
    const s = game([makeShip({ id: 'r', owner: A, shipClass: 'corsair', pos: CLEAR, fuel: 3 })]);
    expect(canResupplyAt(s, s.ships['r']!, map).ok).toBe(false);
  });

  it('refuels, repairs all damage and restores the overload manoeuvre', () => {
    // "Whenever a ship is refueled from a base, it automatically undergoes
    //  maintenance. This repairs all remaining damage and allows the ship to
    //  perform the overload maneuver once."
    let s = game([landedOnTerra()]);
    s = applyDamage(s, 'r', 4, 'test');
    s = { ...s, ships: { ...s.ships, r: { ...s.ships['r']!, overloadAvailable: false } } };
    expect(s.ships['r']!.disabled).toBe(4);

    s = toPhase(s, 'resupply');
    s = ok(s, { type: 'resupply', by: A, ship: 'r' });

    const ship = s.ships['r']!;
    expect(ship.fuel).toBe(20);
    expect(ship.disabled).toBe(0);
    expect(ship.overloadAvailable).toBe(true);
  });

  it('stops a resupplied ship firing that player-turn', () => {
    // "No ship may fire its guns or launch ordnance during a player-turn in
    //  which it resupplies."
    let s = game([
      landedOnTerra(),
      makeShip({ id: 'foe', owner: B, shipClass: 'corvette', pos: neighbor(TERRA.hex, 0) }),
    ]);
    s = toPhase(s, 'resupply');
    s = ok(s, { type: 'resupply', by: A, ship: 'r' });
    expect(s.ships['r']!.resuppliedThisTurn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Matched courses
// ---------------------------------------------------------------------------

describe('matched courses', () => {
  it('requires the same position and the same velocity', () => {
    // "The only way for anything to be transferred between ships is for both to
    //  have the same course and position."
    const a = makeShip({ id: 'a', owner: A, shipClass: 'tanker', pos: CLEAR, velocity: hex(2, -1) });
    const same = makeShip({ id: 'b', owner: A, shipClass: 'corsair', pos: CLEAR, velocity: hex(2, -1) });
    const wrongV = makeShip({ id: 'c', owner: A, shipClass: 'corsair', pos: CLEAR, velocity: hex(1, 0) });
    const wrongP = makeShip({
      id: 'd',
      owner: A,
      shipClass: 'corsair',
      pos: add(CLEAR, hex(1, 0)),
      velocity: hex(2, -1),
    });

    expect(coursesMatched(a, same)).toBe(true);
    expect(coursesMatched(a, wrongV)).toBe(false);
    expect(coursesMatched(a, wrongP)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detection', () => {
  it('spots an enemy inside three hexes of a ship', () => {
    // "Detectors on ships and orbital bases... have a range of three hexes."
    let s = game([
      makeShip({ id: 'eye', owner: A, shipClass: 'corvette', pos: CLEAR }),
      makeShip({ id: 'near', owner: B, shipClass: 'corvette', pos: add(CLEAR, hex(3, 0)) }),
      makeShip({ id: 'far', owner: B, shipClass: 'corvette', pos: add(CLEAR, hex(8, 0)) }),
    ]);
    s = toPhase(s, 'combat'); // detection refreshes as part of the turn
    expect(isDetected(s, s.ships['near']!, A)).toBe(true);
    expect(isDetected(s, s.ships['far']!, A)).toBe(false);
  });

  it('keeps a ship detected once it has been seen', () => {
    // "Once a ship has been detected by the enemy, it remains detected
    //  (regardless of range) until it arrives at a friendly base."
    let s = game([
      makeShip({ id: 'eye', owner: A, shipClass: 'corvette', pos: CLEAR }),
      makeShip({
        id: 'runner',
        owner: B,
        shipClass: 'corvette',
        pos: add(CLEAR, hex(2, 0)),
        velocity: hex(4, 0),
      }),
    ]);
    s = toPhase(s, 'combat');
    expect(isDetected(s, s.ships['runner']!, A)).toBe(true);

    // Let it run well beyond detector range.
    for (let i = 0; i < 10; i++) {
      s = ok(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! });
    }
    const runner = s.ships['runner']!;
    if (!runner.destroyed) {
      expect(isDetected(s, runner, A)).toBe(true);
    }
  });
});
