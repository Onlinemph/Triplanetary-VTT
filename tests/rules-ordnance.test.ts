/**
 * Mines, torpedoes and nukes, rule by rule.
 *
 * Each test quotes the rulebook clause it enforces (pp. 5-8) and is written
 * against that clause rather than against the implementation. Where a clause can
 * be satisfied by two different mechanisms — "any portion of the hex" versus
 * "enters the hex", the mine column versus the torpedo column, one target versus
 * all of them — the test picks a situation where the two answers differ, so that
 * a plausible-but-wrong engine fails rather than passes.
 *
 * Covers: the launch restrictions, hold capacity and masses, the mine's
 * inherited vector and the launcher's obligation to break away, the five-turn
 * life, whose movement phase ordnance flies in, gravity, contact geometry in
 * both directions, the mine and torpedo damage columns, the torpedo's launch
 * boost and single target, the nuke's blast, hexside devastation and the 2:1
 * gunnery it alone is vulnerable to, ordnance against ordnance, and asteroids.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Hex,
  type Ship,
  type ShipClass,
  DEFAULT_MAP,
  SHIP_CLASSES,
  add,
  applyCommand,
  createInitialState,
  distance,
  gunDamage,
  hex,
  key,
  legalCommands,
  makePlayer,
  makeShip,
  neighbor,
  sideKey,
  sub,
  traceSegment,
} from '../src/engine/index.js';
import {
  ORDNANCE_LIFETIME,
  ORDNANCE_MASS,
  canCarryOrdnance,
  canLaunch,
} from '../src/engine/ordnance.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

const TERRA = map.body('terra')!;
const CERES = map.body('ceres')!;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const game = (
  ships: readonly Ship[],
  seed = 4242,
  options: Partial<GameState['options']> = {},
): GameState =>
  createInitialState({
    scenarioId: 'ordnance',
    seed,
    players: [makePlayer(A, 'Layer', 'Test', '#e8703a'), makePlayer(B, 'Foe', 'Test', '#4a9fe0')],
    ships,
    options,
  });

const ok = (s: GameState, cmd: Command): GameState => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const refuse = (s: GameState, cmd: Command): string => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
  return out.result.reason ?? '';
};

const seat = (s: GameState): string => s.playerOrder[s.activePlayerIndex]!;

/** Advance until the named phase of the *current* player-turn opens. */
const toPhase = (s0: GameState, phase: GameState['phase']): GameState => {
  let s = s0;
  let guard = 0;
  while (s.phase !== phase && guard++ < 12) s = ok(s, { type: 'endPhase', by: seat(s) });
  return s;
};

/** One complete player-turn: all five phases. */
const playerTurn = (s0: GameState): GameState => {
  let s = s0;
  for (let i = 0; i < 5; i++) s = ok(s, { type: 'endPhase', by: seat(s) });
  return s;
};

/**
 * A hex with `radius` hexes of genuinely empty space around it — no chart edge,
 * no rock, no gravity arrow, no astral body. Eyeballing a "blank-looking" hex is
 * how a test ends up quietly flying a mine into Luna, which sits at 5,9.
 */
const openField = (radius: number): Hex => {
  for (let q = -32; q <= 32; q++) {
    for (let r = -32; r <= 32; r++) {
      const centre = hex(q, r);
      let clear = true;
      search: for (let dq = -radius; dq <= radius; dq++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (distance(hex(0, 0), hex(dq, dr)) > radius) continue;
          const h = add(centre, hex(dq, dr));
          if (!map.inBounds(h) || map.isAsteroid(h) || map.isGravityHex(h) || map.bodyAt(h)) {
            clear = false;
            break search;
          }
        }
      }
      if (clear) return centre;
    }
  }
  throw new Error('no open field');
};

const FIELD = openField(8);

/** A belt hex with clear space to its west, so ordnance can be flown into it. */
const beltTarget = (): Hex => {
  for (const k of map.belt.asteroids) {
    const [q, r] = k.split(',').map(Number);
    const rock = hex(q!, r!);
    if (map.isDenseAsteroid(rock)) continue;
    const west1 = add(rock, hex(-1, 0));
    const west2 = add(rock, hex(-2, 0));
    if (!map.inBounds(west2)) continue;
    if (map.isAsteroid(west1) || map.isAsteroid(west2)) continue;
    if (map.bodyAt(west1) || map.bodyAt(west2)) continue;
    return rock;
  }
  throw new Error('no reachable belt hex');
};

const ROCK = beltTarget();

/** A dense ("special") asteroid hex of Clandestine's cordon, reachable from the west. */
const denseTarget = (): Hex => {
  for (const k of map.belt.denseAsteroids) {
    const [q, r] = k.split(',').map(Number);
    const rock = hex(q!, r!);
    const west1 = add(rock, hex(-1, 0));
    const west2 = add(rock, hex(-2, 0));
    if (!map.inBounds(west2)) continue;
    if (map.isAsteroid(west1) || map.isAsteroid(west2)) continue;
    if (map.bodyAt(west1) || map.bodyAt(west2)) continue;
    return rock;
  }
  throw new Error('no reachable dense belt hex');
};

/**
 * A straight run at Terra from three hexes out. Left to itself an item on this
 * course clears the empty hex at two, is caught by the gravity ring at one, and
 * plunges into the planet's own hex on the turn after that.
 */
const PLUNGE_OUT = sub(neighbor(TERRA.hex, 0), TERRA.hex);
const PLUNGE_START = add(TERRA.hex, hex(PLUNGE_OUT.q * 3, PLUNGE_OUT.r * 3));
const PLUNGE_V = hex(-PLUNGE_OUT.q, -PLUNGE_OUT.r);

const armed = (
  id: string,
  owner: string,
  shipClass: ShipClass,
  pos: Hex,
  velocity: Hex,
  cargo: Ship['cargo'],
): Ship => makeShip({ id, owner, shipClass, pos, velocity, cargo });

const hurt = (s: GameState, id: string): boolean => {
  const ship = s.ships[id]!;
  return ship.destroyed || ship.disabled > 0;
};

// ---------------------------------------------------------------------------
// "Ships which carry mines, torpedoes, or nukes may launch them during the
//  ordnance launch phase."
// ---------------------------------------------------------------------------

describe('launching', () => {
  it('allows one item per ship per turn, of any kind', () => {
    // "Each ship may release only one item per turn (one mine, one torpedo, or
    //  one nuke)." The limit is on *items*, not on items of a kind: a frigate
    //  holding both may not drop a mine and then also fire a torpedo.
    let s = game([
      armed('w', A, 'frigate', FIELD, hex(1, 0), [
        { kind: 'mine', quantity: 1 },
        { kind: 'torpedo', quantity: 1 },
      ]),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    expect(refuse(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'torpedo' })).toBeTruthy();
    expect(Object.keys(s.ordnance)).toHaveLength(1);
  });

  it('reloads the allowance on the next turn', () => {
    // The allowance is per turn, not per game.
    let s = game([armed('w', A, 'frigate', FIELD, hex(1, 0), [{ kind: 'mine', quantity: 2 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(1, 1)) });
    s = playerTurn(s); // finish A
    s = playerTurn(s); // B does nothing
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    expect(Object.keys(s.ordnance)).toHaveLength(2);
  });

  it('forbids launching at a base, taking off, or landing', () => {
    // "Ordnance may not be launched while the ship is at a base, refueling
    //  (including transferring fuel between ships in space), or taking off from
    //  or landing on a planet." And, for the landed case specifically: "Ships
    //  landed at planetary bases may not fire guns or launch ordnance."
    const site = map.allPlanetaryBases().find((b) => b.bodyId === 'terra')!;
    const hold: Ship['cargo'] = [{ kind: 'mine', quantity: 1 }];

    const landed = makeShip({
      id: 'w',
      owner: A,
      shipClass: 'frigate',
      pos: TERRA.hex,
      location: { kind: 'landed', side: site.side },
      cargo: hold,
    });
    const onTerra = toPhase(game([landed]), 'ordnance');
    expect(canLaunch(onTerra, onTerra.ships['w']!, 'mine', map).ok).toBe(false);

    // Taking off: declared in astrogation, resolved in movement, so the ordnance
    // phase in between must still refuse.
    let lifting = ok(game([landed]), { type: 'takeOff', by: A, ship: 'w' });
    lifting = toPhase(lifting, 'ordnance');
    expect(canLaunch(lifting, lifting.ships['w']!, 'mine', map).ok).toBe(false);

    // Landing: likewise declared before the ordnance phase.
    const from = neighbor(TERRA.hex, 0);
    const to = neighbor(TERRA.hex, 1);
    let diving = game([armed('w', A, 'frigate', to, sub(to, from), hold)]);
    diving = {
      ...diving,
      ships: {
        w: { ...diving.ships['w']!, pendingGravity: map.gravityFromMove(from, to).mandatory },
      },
    };
    diving = ok(diving, { type: 'land', by: A, ship: 'w', side: site.side });
    diving = toPhase(diving, 'ordnance');
    expect(canLaunch(diving, diving.ships['w']!, 'mine', map).ok).toBe(false);

    // "For asteroid bases, matching courses requires that the ship stop in the
    //  base hex" — a ship stopped on Ceres is at a base.
    const parked = toPhase(
      game([armed('w', A, 'frigate', CERES.hex, hex(0, 0), hold)]),
      'ordnance',
    );
    expect(canLaunch(parked, parked.ships['w']!, 'mine', map).ok).toBe(false);

    // ...but merely crossing the base's hex at speed is not being *at* a base.
    const passing = toPhase(
      game([armed('w', A, 'frigate', CERES.hex, hex(3, 0), hold)]),
      'ordnance',
    );
    expect(canLaunch(passing, passing.ships['w']!, 'mine', map).ok).toBe(true);
  });

  it('forbids launching on a player-turn in which the ship resupplies', () => {
    // "No ship may fire its guns or launch ordnance during a player-turn in
    //  which it resupplies."
    //
    // The ship refuels the way p. 8 allows without ever stopping — "pass through
    // the gravity hex directly above the base's hex side while in orbit" — so it
    // is never *at* a base, and the resupply clause is the only thing that can
    // silence it.
    const site = map.allPlanetaryBases().find((b) => b.bodyId === 'terra' && b.side.dir === 0)!;
    const from = neighbor(TERRA.hex, 1);
    const to = site.gravityHex;

    let s = game([armed('w', A, 'frigate', to, sub(to, from), [{ kind: 'mine', quantity: 1 }])]);
    s = {
      ...s,
      ships: {
        w: { ...s.ships['w']!, fuel: 4, pendingGravity: map.gravityFromMove(from, to).mandatory },
      },
    };
    for (const b of Object.values(s.bases)) {
      if (b.kind === 'planetary') s = { ...s, bases: { ...s.bases, [b.id]: { ...b, owner: A } } };
    }
    expect(map.orbitOf(s.ships['w']!.pos, s.ships['w']!.velocity)?.id).toBe('terra');

    s = toPhase(s, 'resupply');
    expect(canLaunch(s, s.ships['w']!, 'mine', map).ok).toBe(true); // not at a base
    s = ok(s, { type: 'resupply', by: A, ship: 'w' });
    expect(canLaunch(s, s.ships['w']!, 'mine', map).ok).toBe(false);
  });

  it('reserves torpedoes to warships and opens mines to everyone with a hold', () => {
    // "A torpedo masses 20 tons; a carrying ship must have hold capacity to carry
    //  it. Only warships may launch torpedoes." / "Any ship with sufficient
    //  capacity to carry a mine may also launch it."
    //
    // The commercial classes are named on p. 4: "Commercial ships (transports,
    // packets, tankers, liners) may not perform the overload maneuver."
    const commercial: ShipClass[] = ['transport', 'packet', 'tanker', 'liner'];
    for (const cls of Object.keys(SHIP_CLASSES) as ShipClass[]) {
      // "a carrying ship must have hold capacity to carry it" — a tanker and a
      // liner have none, so a tanker holding a torpedo is a position the rules
      // cannot reach and says nothing about who may launch one.
      const capacity = SHIP_CLASSES[cls].cargoCapacity;
      const cargo = [
        ...(capacity >= ORDNANCE_MASS.torpedo ? [{ kind: 'torpedo' as const, quantity: 1 }] : []),
        ...(capacity >= ORDNANCE_MASS.mine ? [{ kind: 'mine' as const, quantity: 1 }] : []),
      ];
      if (cargo.length === 0) continue;
      const s = toPhase(game([armed('w', A, cls, FIELD, hex(1, 0), cargo)]), 'ordnance');
      const ship = s.ships['w']!;
      if (capacity >= ORDNANCE_MASS.torpedo) {
        expect({ cls, torpedo: canLaunch(s, ship, 'torpedo', map).ok }).toEqual({
          cls,
          torpedo: !commercial.includes(cls),
        });
      }
      // Every class that can *hold* a mine may lay it; capacity is the only gate.
      expect({ cls, mine: canLaunch(s, ship, 'mine', map).ok }).toEqual({ cls, mine: true });
    }
    // And the classes with no hold at all cannot carry one to begin with.
    for (const cls of ['tanker', 'liner'] as ShipClass[]) {
      expect({ cls, capacity: SHIP_CLASSES[cls].cargoCapacity }).toEqual({ cls, capacity: 0 });
    }
  });

  it('keeps nukes out of scenarios that do not offer them', () => {
    // "Nukes are available only if the scenario specifies."
    const hold: Ship['cargo'] = [{ kind: 'nuke', quantity: 1 }];
    const off = toPhase(game([armed('w', A, 'frigate', FIELD, hex(1, 0), hold)]), 'ordnance');
    expect(canLaunch(off, off.ships['w']!, 'nuke', map).ok).toBe(false);
    const on = toPhase(
      game([armed('w', A, 'frigate', FIELD, hex(1, 0), hold)], 1, { nukesAllowed: true }),
      'ordnance',
    );
    expect(canLaunch(on, on.ships['w']!, 'nuke', map).ok).toBe(true);
  });

  it('silences a disabled ship, except an orbital base at D1 firing torpedoes', () => {
    // "A disabled ship cannot maneuver, launch ordnance, or attack." / "An
    //  orbital base may launch torpedoes, fire guns, and resupply friendly ships
    //  while the base itself is slightly (D1) damaged."
    const hold: Ship['cargo'] = [
      { kind: 'mine', quantity: 1 },
      { kind: 'torpedo', quantity: 1 },
    ];
    const disabledAt = (cls: ShipClass, d: number): GameState => {
      let s = game([armed('w', A, cls, FIELD, hex(1, 0), hold)]);
      s = { ...s, ships: { w: { ...s.ships['w']!, disabled: d } } };
      return toPhase(s, 'ordnance');
    };

    const frigate = disabledAt('frigate', 1);
    expect(canLaunch(frigate, frigate.ships['w']!, 'mine', map).ok).toBe(false);
    expect(canLaunch(frigate, frigate.ships['w']!, 'torpedo', map).ok).toBe(false);

    const base1 = disabledAt('orbitalBase', 1);
    expect(canLaunch(base1, base1.ships['w']!, 'torpedo', map).ok).toBe(true);
    // The exception names torpedoes, guns and resupply — not mines.
    expect(canLaunch(base1, base1.ships['w']!, 'mine', map).ok).toBe(false);

    const base2 = disabledAt('orbitalBase', 2);
    expect(canLaunch(base2, base2.ships['w']!, 'torpedo', map).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mass and hold capacity
// ---------------------------------------------------------------------------

describe('mass and hold capacity', () => {
  it('fills the hold up to capacity and no further', () => {
    // "A ship may carry cargo whose total mass is less than or equal to its
    //  cargo capacity" — so a hold exactly filled is legal and one ton over is
    //  not. Ship table, p. 1: corvette 5, corsair 10, frigate 40, tanker 0.
    const holder = (cls: ShipClass, cargo: Ship['cargo'] = []): Ship =>
      makeShip({ id: 'h', owner: A, shipClass: cls, pos: FIELD, cargo });

    expect(canCarryOrdnance(holder('tanker'), 'mine').ok).toBe(false); // 10 into 0
    expect(canCarryOrdnance(holder('corvette'), 'mine').ok).toBe(false); // 10 into 5
    expect(canCarryOrdnance(holder('corsair'), 'mine').ok).toBe(true); // 10 into 10, exactly
    expect(canCarryOrdnance(holder('corsair'), 'mine', 2).ok).toBe(false); // 20 into 10
    expect(canCarryOrdnance(holder('corsair'), 'torpedo').ok).toBe(false); // 20 into 10
    expect(canCarryOrdnance(holder('frigate'), 'mine', 4).ok).toBe(true); // 40 into 40
    expect(canCarryOrdnance(holder('frigate'), 'mine', 5).ok).toBe(false); // 50 into 40
    // Mixed loads consume the same hold.
    expect(
      canCarryOrdnance(holder('frigate', [{ kind: 'torpedo', quantity: 1 }]), 'mine', 2).ok,
    ).toBe(true); // 20 + 20 into 40
    expect(
      canCarryOrdnance(holder('frigate', [{ kind: 'torpedo', quantity: 1 }]), 'mine', 3).ok,
    ).toBe(false); // 20 + 30 into 40
  });

  it('lets a non-warship carry only one nuke, whatever its hold', () => {
    // "Any ship may carry and launch a nuke if it has sufficient hold capacity,
    //  but non-warships are restricted to carrying only one nuke at a time."
    // A transport's 50-ton hold has room for two, so capacity is not what stops
    // it.
    const holder = (cls: ShipClass, nukes = 0): Ship =>
      makeShip({
        id: 'h',
        owner: A,
        shipClass: cls,
        pos: FIELD,
        cargo: nukes > 0 ? [{ kind: 'nuke', quantity: nukes }] : [],
      });

    for (const cls of ['transport', 'packet'] as const) {
      expect({ cls, one: canCarryOrdnance(holder(cls), 'nuke').ok }).toEqual({ cls, one: true });
      expect({ cls, two: canCarryOrdnance(holder(cls), 'nuke', 2).ok }).toEqual({
        cls,
        two: false,
      });
      expect({ cls, second: canCarryOrdnance(holder(cls, 1), 'nuke').ok }).toEqual({
        cls,
        second: false,
      });
    }
    // A warship with the hold for them is not restricted.
    expect(canCarryOrdnance(holder('frigate'), 'nuke', 2).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// "When a mine is launched, it assumes the vector of its launching ship."
// ---------------------------------------------------------------------------

describe('the launched item’s vector', () => {
  it('gives a mine the launcher’s hex and vector', () => {
    // "When a mine is launched, it assumes the vector of its launching ship."
    // The same is said of nukes: "When launched, they assume the vector of the
    // launching ship."
    for (const kind of ['mine', 'nuke'] as const) {
      let s = game([armed('w', A, 'frigate', FIELD, hex(2, -1), [{ kind, quantity: 1 }])], 1, {
        nukesAllowed: true,
      });
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind });
      const item = Object.values(s.ordnance)[0]!;
      expect({ kind, pos: key(item.pos), v: key(item.velocity) }).toEqual({
        kind,
        pos: key(FIELD),
        v: key(hex(2, -1)),
      });
    }
  });

  it('makes the launcher break away from its own mine before the phase closes', () => {
    // "That ship must execute an immediate course change to insure that it does
    //  not remain in the same hex as the mine."
    let s = game([armed('w', A, 'frigate', FIELD, hex(2, 0), [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });

    // Left alone, ship and mine fly the identical course, so the phase may not
    // be closed.
    expect(refuse(s, { type: 'endPhase', by: A })).toBeTruthy();

    // A course change that still lands on the mine is no escape.
    const together = ok(s, {
      type: 'plotCourse',
      by: A,
      ship: 'w',
      endpoint: add(FIELD, hex(2, 0)),
    });
    expect(refuse(together, { type: 'endPhase', by: A })).toBeTruthy();

    // A real one releases it, and the two end the turn in different hexes.
    let apart = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(2, 1)) });
    apart = toPhase(apart, 'combat');
    const mine = Object.values(apart.ordnance)[0]!;
    expect(key(apart.ships['w']!.pos)).not.toBe(key(mine.pos));
  });

  it('makes no one break away from a torpedo or a nuke — it just kills them', () => {
    // The course-change sentence is printed in the mine rule and nowhere else.
    // Reading it into "A torpedo is treated as a mine, except:" would be
    // defensible, but the engine's narrower reading is not a licence either way:
    // what it costs is the launcher, since the trigger rule applies regardless —
    // a nuke "explodes when it enters any hex containing a ship... It destroys
    // everything in the hex automatically", and a torpedo rolls on its own
    // column. So the test asserts the consequence, not just the absence of a
    // block.
    for (const kind of ['torpedo', 'nuke'] as const) {
      let s = game([armed('w', A, 'frigate', FIELD, hex(2, 0), [{ kind, quantity: 1 }])], 1, {
        nukesAllowed: true,
      });
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind });
      s = ok(s, { type: 'endPhase', by: A }); // not blocked
      expect(s.phase).toBe('movement');

      // Fly the turn out on the shared vector and see what it costs.
      s = toPhase(s, 'resupply');
      const launcher = s.ships['w']!;
      expect({
        kind,
        hurt: launcher.destroyed || launcher.disabled > 0,
      }).toEqual({ kind, hurt: true });
      if (kind === 'nuke') expect(launcher.destroyed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// "Mines remain active for five turns, after which they self-destruct."
// ---------------------------------------------------------------------------

describe('the five-turn life', () => {
  it('keeps an item alive for exactly five of its owner’s turns', () => {
    // "Mines remain active for five turns, after which they self-destruct." The
    // same sentence is repeated for torpedoes ("it maintains its new vector for
    // five turns, after which it self-destructs") and nukes ("Nukes remain
    // active for five turns, and then self-destruct").
    expect(ORDNANCE_LIFETIME).toBe(5);

    let s = game([armed('w', A, 'frigate', FIELD, hex(0, 0), [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    // Break away, as the mine rule requires, and keep clear thereafter.
    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(1, 0)) });

    const alive: boolean[] = [];
    for (let day = 1; day <= 6; day++) {
      s = playerTurn(s); // finish this player-turn (the item moves and then ages)
      alive.push(Object.keys(s.ordnance).length > 0);
      s = playerTurn(s); // the other player's turn
    }
    // Turn 1 is the launch turn; the mine is still on the board at the end of
    // turns 1-4 and gone once the fifth has been played.
    expect(alive).toEqual([true, true, true, true, false, false]);
  });

  it('gives a player no way to take a live item off the board early', () => {
    // The five-turn clock and detonation are the only two exits the rules
    // provide: "Mines remain active for five turns, after which they
    // self-destruct", and "mines, torpedoes, and nukes automatically destroy
    // mines and are themselves destroyed". Nothing on pp. 5-8 hands a player a
    // detonator — which matters, because a mine the owner could dismiss on
    // command would dissolve the very next sentence of the mine rule ("That ship
    // must execute an immediate course change...") and let a fleet walk through
    // its own minefield for free.
    let s = game([armed('w', A, 'frigate', FIELD, hex(2, 0), [{ kind: 'mine', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    const laid = Object.keys(s.ordnance);
    expect(laid).toHaveLength(1);

    // The launcher must now buy its way clear with a course change, and there is
    // no order that would spare it the fuel.
    expect(refuse(s, { type: 'endPhase', by: A })).toMatch(/change course/i);
    const orders = legalCommands(s, A, map);
    expect(orders.filter((c) => /scuttle|discard|disarm/i.test(c))).toEqual([]);

    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(2, 1)) });
    s = playerTurn(s);
    expect(Object.keys(s.ordnance)).toEqual(laid); // still armed, still there
  });
});

// ---------------------------------------------------------------------------
// "Mines move in the movement phase of the player who launched them."
// ---------------------------------------------------------------------------

describe('whose movement phase ordnance flies in', () => {
  it('moves ordnance only on the launching player’s turn', () => {
    // "Mines, torpedoes, and nukes launched by the phasing player (on this or
    //  previous turns) also move at this time." / "Mines move in the movement
    //  phase of the player who launched them."
    let s = game([
      armed('w', A, 'frigate', FIELD, hex(2, 0), [{ kind: 'mine', quantity: 1 }]),
      armed('idler', B, 'corvette', add(FIELD, hex(0, -6)), hex(0, 0), []),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(2, 1)) });

    const track: string[] = [];
    s = toPhase(s, 'combat');
    track.push(key(Object.values(s.ordnance)[0]!.pos)); // after A's movement
    s = playerTurn(s); // finish A
    s = toPhase(s, 'combat');
    track.push(key(Object.values(s.ordnance)[0]!.pos)); // after B's movement
    s = playerTurn(s); // finish B
    s = toPhase(s, 'combat');
    track.push(key(Object.values(s.ordnance)[0]!.pos)); // after A's next movement

    expect(track).toEqual([
      key(add(FIELD, hex(2, 0))),
      key(add(FIELD, hex(2, 0))), // B's phase does not budge it
      key(add(FIELD, hex(4, 0))),
    ]);
  });
});

// ---------------------------------------------------------------------------
// "All are affected by gravity."
// ---------------------------------------------------------------------------

describe('gravity', () => {
  it('bends a mine’s course exactly as it bends a ship’s', () => {
    // "All are affected by gravity", and gravity's own rule is the ship rule:
    // "Each gravity hex has the effect of one hex of acceleration in the
    //  direction of the arrow, on every object passing through that hex. Gravity
    //  takes effect on the turn after an object enters the gravity hex."
    //
    // Flown side by side in two separate games — a ship on one course and a mine
    // launched onto the identical one — the two tracks must coincide hex for
    // hex. A mine that ignored gravity, or felt it a turn early, would peel off.
    //
    // The lane skims Terra's gravity ring without ever touching the planet: a
    // straight run would end three hexes east of the start, and gravity bends it
    // away from there.
    const start = hex(4, 7);
    const v = hex(1, 0);

    // The ship's track, coasting past Terra with no fuel burned.
    let shipGame = game([
      makeShip({ id: 'c', owner: A, shipClass: 'corvette', pos: start, velocity: v }),
    ]);
    const shipTrack: string[] = [];
    for (let d = 0; d < 3; d++) {
      shipGame = toPhase(shipGame, 'combat');
      expect(shipGame.ships['c']!.destroyed).toBe(false);
      shipTrack.push(key(shipGame.ships['c']!.pos));
      shipGame = playerTurn(shipGame);
      shipGame = playerTurn(shipGame);
    }

    // The mine's track, launched onto the same vector from the same hex. Its
    // launcher immediately turns aside, as the mine rule demands.
    let mineGame = game([armed('w', A, 'frigate', start, v, [{ kind: 'mine', quantity: 1 }])]);
    mineGame = toPhase(mineGame, 'ordnance');
    mineGame = ok(mineGame, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    mineGame = ok(mineGame, {
      type: 'plotCourse',
      by: A,
      ship: 'w',
      endpoint: add(add(start, v), hex(0, -1)),
    });
    const mineTrack: string[] = [];
    for (let d = 0; d < 3; d++) {
      mineGame = toPhase(mineGame, 'combat');
      const item = Object.values(mineGame.ordnance)[0];
      mineTrack.push(item ? key(item.pos) : 'gone');
      mineGame = playerTurn(mineGame);
      mineGame = playerTurn(mineGame);
    }

    // The lane must actually be bent, or the test proves nothing.
    expect(shipTrack[2]).not.toBe(key(add(start, hex(3, 0))));
    expect(mineTrack).toEqual(shipTrack);
  });
});

// ---------------------------------------------------------------------------
// "...passes through ANY PORTION of the hex..."
// ---------------------------------------------------------------------------

/**
 * A course whose arrow touches `GRAZE` at a single point without ever entering
 * it: from the origin to (4,1) the traced entries are 0,0 1,0 2,0 2,1 3,1 4,1,
 * and (1,1) is met only at a vertex. It is the sharpest available separation
 * between "enters the hex" and "passes through any portion of the hex".
 */
const RUN = hex(4, 1);
const GRAZE = hex(1, 1);

describe('contact geometry', () => {
  it('detonates a mine the course runs alongside but never enters', () => {
    // "A mine detonates when the course of a ship (or ordnance) passes through
    //  any portion of the hex occupied by the mine."
    //
    // The plainest case of the clause, and the one that decides most games: a
    // course from a hex to the one two away on the flat runs down the shared
    // hexside of two hexes and *enters* neither. A mine in either of them is on
    // the arrow.
    const RUN_SIDE = hex(2, -1);
    const ALONGSIDE = hex(1, -1);
    const trace = traceSegment(hex(0, 0), RUN_SIDE);
    expect(trace.entered.map(key)).not.toContain(key(ALONGSIDE));
    expect(trace.touched.find((t) => key(t.hex) === key(ALONGSIDE))?.mode).toBe('edge');

    const minePos = add(FIELD, ALONGSIDE);
    let s = game([
      armed('layer', A, 'frigate', minePos, hex(0, 0), [{ kind: 'mine', quantity: 1 }]),
      armed('foe', B, 'corsair', FIELD, RUN_SIDE, []),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'layer', endpoint: add(minePos, hex(0, -1)) });
    s = playerTurn(s);
    expect(Object.keys(s.ordnance)).toHaveLength(1);

    s = toPhase(s, 'combat'); // B flies down the hexside
    expect(key(s.ships['foe']!.pos)).toBe(key(add(FIELD, RUN_SIDE)));
    expect(Object.keys(s.ordnance)).toHaveLength(0);
  });

  it('detonates a mine a ship’s course only grazes at a vertex', () => {
    // "A mine detonates when the course of a ship (or ordnance) passes through
    //  any portion of the hex occupied by the mine."
    //
    // The limiting case, and a reading rather than a certainty: a single point of
    // contact at a corner is "any portion of the hex" taken literally, and the
    // engine takes it literally. The clause plainly covers the hexside run
    // above; whether it reaches a corner is the engine's call.
    const minePos = add(FIELD, GRAZE);
    let s = game([
      armed('layer', A, 'frigate', minePos, hex(0, 0), [{ kind: 'mine', quantity: 1 }]),
      armed('foe', B, 'corsair', FIELD, RUN, []),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'layer', endpoint: add(minePos, hex(0, -1)) });
    s = playerTurn(s); // finish A; the mine stays where it was laid
    expect(Object.keys(s.ordnance)).toHaveLength(1);

    s = toPhase(s, 'combat'); // B flies its leg
    expect(key(s.ships['foe']!.pos)).toBe(key(add(FIELD, RUN))); // it did not stop
    expect(Object.keys(s.ordnance)).toHaveLength(0); // ...but it set the mine off
  });

  it('detonates a mine whose own course only grazes a ship', () => {
    // "...or when the mine's course passes through any portion of a hex occupied
    //  by a ship or ordnance." The other half of the same sentence.
    let s = game([
      armed('layer', A, 'frigate', FIELD, RUN, [{ kind: 'mine', quantity: 1 }]),
      armed('foe', B, 'corsair', add(FIELD, GRAZE), hex(0, 0), []),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind: 'mine' });
    s = ok(s, {
      type: 'plotCourse',
      by: A,
      ship: 'layer',
      endpoint: add(add(FIELD, RUN), hex(0, -1)),
    });
    s = toPhase(s, 'combat');
    expect(Object.keys(s.ordnance)).toHaveLength(0);
  });

  it('leaves a mine alone when nothing touches its hex', () => {
    // The control: the same geometry with the mine one hex off the arrow.
    const clearOf = add(FIELD, hex(0, -3));
    let s = game([
      armed('layer', A, 'frigate', clearOf, hex(0, 0), [{ kind: 'mine', quantity: 1 }]),
      armed('foe', B, 'corsair', FIELD, RUN, []),
    ]);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'layer', endpoint: add(clearOf, hex(0, -1)) });
    s = playerTurn(s);
    s = toPhase(s, 'combat');
    expect(Object.keys(s.ordnance)).toHaveLength(1);
    expect(hurt(s, 'foe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The damage columns
// ---------------------------------------------------------------------------

/** Fly one mine (or torpedo) into a hex holding `count` stationary enemy ships. */
const runIntoCrowd = (
  kind: 'mine' | 'torpedo',
  count: number,
  seed: number,
): { state: GameState; victims: string[] } => {
  const target = add(FIELD, hex(2, 0));
  const victims = Array.from({ length: count }, (_, i) => `v${i}`);
  let s = game(
    [
      armed('layer', A, 'frigate', FIELD, hex(2, 0), [{ kind, quantity: 1 }]),
      ...victims.map((id) => armed(id, B, 'corsair', target, hex(0, 0), [])),
    ],
    seed,
  );
  s = toPhase(s, 'ordnance');
  s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind });
  s = ok(s, { type: 'plotCourse', by: A, ship: 'layer', endpoint: add(FIELD, hex(2, 1)) });
  return { state: toPhase(s, 'combat'), victims };
};

describe('the mine column', () => {
  it('rolls separately for every ship in the affected hex', () => {
    // "If more than one ship is in the hex affected by the mine, each ship rolls
    //  separately for a mine result." One shared roll would make the three ships
    //  always share a fate; separate rolls must produce mixed outcomes.
    const patterns = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const { state, victims } = runIntoCrowd('mine', 3, seed);
      patterns.add(victims.map((id) => (hurt(state, id) ? 'X' : '.')).join(''));
    }
    const mixed = [...patterns].filter((p) => p.includes('X') && p.includes('.'));
    expect(mixed.length).toBeGreaterThan(0);
  });

  it('consults the mine column, not the torpedo column', () => {
    // "an affected ship rolls one die and consults the mine column of the damage
    //  table." The printed OTHER DAMAGE table (p. 6) reads, for mines:
    //  1 – / 2 – / 3 – / 4 – / 5 D2 / 6 D2. So the only result a mine can ever
    //  produce is D2 — never the D1 or D3 of the torpedo column beside it.
    const results = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const { state, victims } = runIntoCrowd('mine', 2, seed);
      for (const id of victims) {
        const ship = state.ships[id]!;
        expect(ship.destroyed).toBe(false); // a corsair survives a D2
        results.add(ship.disabled);
      }
    }
    expect([...results].sort((x, y) => x - y)).toEqual([0, 2]);
  });
});

describe('torpedoes', () => {
  it('accelerates one or two hexes on the launch turn and never again', () => {
    // "On the turn in which a torpedo is launched (and only on that turn), it may
    //  accelerate one or two hexes in any direction; it maintains its new vector
    //  for five turns."
    let s = game([armed('w', A, 'frigate', FIELD, hex(1, 0), [{ kind: 'torpedo', quantity: 1 }])]);
    s = toPhase(s, 'ordnance');
    // Three hexes of acceleration is beyond the drive.
    expect(
      refuse(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'torpedo', aim: hex(4, 0) }),
    ).toBeTruthy();
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'torpedo', aim: hex(3, 0) });
    expect(key(Object.values(s.ordnance)[0]!.velocity)).toBe(key(hex(3, 0)));
    // Keep the launcher out of its own torpedo's path.
    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(FIELD, hex(1, -1)) });

    const track: string[] = [];
    for (let d = 0; d < 3; d++) {
      s = toPhase(s, 'combat');
      const t = Object.values(s.ordnance)[0]!;
      track.push(key(t.velocity));
      s = playerTurn(s);
      s = playerTurn(s);
    }
    // The boost is spent; the vector is held for the rest of its life.
    expect(track).toEqual([key(hex(3, 0)), key(hex(3, 0)), key(hex(3, 0))]);
  });

  it('hits only a single target in a crowded hex', () => {
    // "A torpedo hits only a single target. In the event that there is more than
    //  one ship in the affected hex, damage is rolled for each, in a randomly
    //  chosen order, until one ship (only) is damaged or destroyed, or all ships
    //  have been rolled for without damage resulting."
    const struck = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const { state, victims } = runIntoCrowd('torpedo', 3, seed);
      const hits = victims.filter((id) => hurt(state, id));
      expect({ seed, hits: hits.length <= 1 }).toEqual({ seed, hits: true });
      for (const id of hits) struck.add(id);
    }
    // "in a randomly chosen order": over many launches the victim must vary, or
    // the order is not random at all.
    expect(struck.size).toBeGreaterThan(1);
  });

  it('runs on when it misses, and is spent when it hits', () => {
    // "A torpedo which misses all targets continues on its path and may
    //  conceivably find new targets."
    let misses = 0;
    let hits = 0;
    for (let seed = 0; seed < 60; seed++) {
      const { state, victims } = runIntoCrowd('torpedo', 1, seed);
      const survived = Object.keys(state.ordnance).length === 1;
      if (hurt(state, victims[0]!)) {
        hits++;
        expect({ seed, survived }).toEqual({ seed, survived: false });
      } else {
        misses++;
        expect({ seed, survived }).toEqual({ seed, survived: true });
        // ...and it has moved on past its target rather than stopping there.
        expect(key(Object.values(state.ordnance)[0]!.pos)).toBe(key(add(FIELD, hex(2, 0))));
      }
    }
    expect(misses).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Nukes
// ---------------------------------------------------------------------------

describe('nukes', () => {
  it('destroys everything in the hex automatically, with no die roll', () => {
    // "It destroys everything in the hex automatically." No column, no roll — so
    // a dreadnaught dies as surely as a tanker, on every seed.
    const target = add(FIELD, hex(2, 0));
    for (let seed = 0; seed < 8; seed++) {
      let s = game(
        [
          armed('layer', A, 'frigate', FIELD, hex(2, 0), [{ kind: 'nuke', quantity: 1 }]),
          armed('big', B, 'dreadnaught', target, hex(0, 0), []),
          armed('small', B, 'tanker', target, hex(0, 0), []),
        ],
        seed,
        { nukesAllowed: true },
      );
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'layer', kind: 'nuke' });
      s = ok(s, { type: 'plotCourse', by: A, ship: 'layer', endpoint: add(FIELD, hex(2, 1)) });
      s = toPhase(s, 'combat');
      expect({ seed, big: s.ships['big']!.destroyed, small: s.ships['small']!.destroyed }).toEqual({
        seed,
        big: true,
        small: true,
      });
    }
  });

  it('turns an asteroid hex into clear space', () => {
    // "It destroys everything in the hex automatically (an asteroid hex becomes
    //  clear space as a result)." / "A nuke detonating in any asteroid hex
    //  converts the hex to clear space."
    const start = add(ROCK, hex(-2, 0));
    let s = game([armed('w', A, 'frigate', start, hex(2, 0), [{ kind: 'nuke', quantity: 1 }])], 5, {
      nukesAllowed: true,
    });
    expect(map.isAsteroid(ROCK, new Set(s.clearedAsteroids))).toBe(true);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'nuke' });
    s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(start, hex(1, 1)) });
    s = toPhase(s, 'combat');
    expect(map.isAsteroid(ROCK, new Set(s.clearedAsteroids))).toBe(false);
  });

  it('devastates the hexside it comes in over, and only that one', () => {
    // "If a nuke reaches a moon or planet without detonating against a target in
    //  the hex, it devastates one entire hex side... Any ships on the planet
    //  which landed through that hex side, and any base on that side, are
    //  destroyed."
    //
    // Two readings meet here and the rulebook does not separate them: a landed
    // ship is, on the map, in the planet's own hex, so "without detonating
    // against a target in the hex" could be read to send every nuke arriving at
    // an occupied world down the other branch ("It destroys everything in the hex
    // automatically") instead. The engine treats a world as the devastation case
    // and the printed hexside rule as the thing being described; that is a
    // reading, not a quotation.
    //
    // Which side is struck is only decided here because the run-in is radial:
    // "If it is not clear which hex side has been affected, the suffering player
    // makes the choice" — an affordance the engine does not offer (see
    // docs/RULES-MAPPING.md).
    const start = PLUNGE_START;
    const inward = PLUNGE_V;
    const struckSide = { hex: TERRA.hex, dir: 0 };
    const spared = { hex: TERRA.hex, dir: 3 };

    let s = game(
      [
        armed('w', A, 'frigate', start, inward, [{ kind: 'nuke', quantity: 1 }]),
        makeShip({
          id: 'onSide',
          owner: B,
          shipClass: 'corsair',
          pos: TERRA.hex,
          location: { kind: 'landed', side: struckSide },
        }),
        makeShip({
          id: 'farSide',
          owner: B,
          shipClass: 'corsair',
          pos: TERRA.hex,
          location: { kind: 'landed', side: spared },
        }),
      ],
      3,
      { nukesAllowed: true },
    );
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'nuke' });
    s = ok(s, {
      type: 'plotCourse',
      by: A,
      ship: 'w',
      endpoint: add(add(start, inward), hex(0, 1)),
    });
    for (let d = 0; d < 4 && Object.keys(s.ordnance).length > 0; d++) {
      s = toPhase(s, 'combat');
      s = playerTurn(s);
      s = playerTurn(s);
    }

    expect(s.devastatedSides).toEqual([sideKey(struckSide)]);
    expect(s.ships['onSide']!.destroyed).toBe(true);
    expect(s.ships['farSide']!.destroyed).toBe(false);
    expect(s.bases['terra:0']!.destroyed).toBe(true);
    expect(s.bases['terra:3']!.destroyed).toBe(false);
  });

  it('does not shelter a landed ship, though a mine or torpedo would', () => {
    // "Once landed at a planetary base, a ship is immune from gunfire, mines,
    //  torpedoes, and ramming, but not from nukes."
    //
    // All three items are flown down the same lane into Terra's own hex, where
    // the sheltered ship is sitting on the hexside they arrive over. Only the
    // nuke may touch it.
    const site = map.allPlanetaryBases().find((b) => b.bodyId === 'terra' && b.side.dir === 0)!;

    const run = (kind: 'mine' | 'torpedo' | 'nuke', seed: number): GameState => {
      let s = game(
        [
          armed('w', A, 'frigate', PLUNGE_START, PLUNGE_V, [{ kind, quantity: 1 }]),
          makeShip({
            id: 'sheltered',
            owner: B,
            shipClass: 'corsair',
            pos: TERRA.hex,
            location: { kind: 'landed', side: site.side },
          }),
        ],
        seed,
        { nukesAllowed: true },
      );
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind });
      // Get the launcher off the lane it just fired down.
      s = ok(s, {
        type: 'plotCourse',
        by: A,
        ship: 'w',
        endpoint: add(add(PLUNGE_START, PLUNGE_V), hex(0, 1)),
      });
      for (let d = 0; d < 4 && Object.keys(s.ordnance).length > 0; d++) {
        s = toPhase(s, 'combat');
        s = playerTurn(s);
        s = playerTurn(s);
      }
      // Every kind must actually reach the planet's own hex and go off there,
      // or the immunity is never put to the question.
      expect({ kind, seed, left: Object.keys(s.ordnance) }).toEqual({ kind, seed, left: [] });
      expect({
        kind,
        seed,
        onTerra: s.log.some((l) =>
          /(detonates|strikes|devastates).*Terra|Terra.*devastates/.test(l.text),
        ),
      }).toEqual({ kind, seed, onTerra: true });
      return s;
    };

    // Mine and torpedo results are die rolls, so the shelter has to hold on
    // every roll, not merely on a lucky one.
    for (const kind of ['mine', 'torpedo'] as const) {
      for (let seed = 0; seed < 20; seed++) {
        const ship = run(kind, seed).ships['sheltered']!;
        expect({ kind, seed, dead: ship.destroyed, disabled: ship.disabled }).toEqual({
          kind,
          seed,
          dead: false,
          disabled: 0,
        });
      }
    }
    // The nuke is not a die roll: the ship dies every time.
    for (let seed = 0; seed < 5; seed++) {
      expect({ seed, dead: run('nuke', seed).ships['sheltered']!.destroyed }).toEqual({
        seed,
        dead: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Shooting at ordnance
// ---------------------------------------------------------------------------

/**
 * Put an enemy nuke in flight with a gun ship `range` hexes away, and take one
 * shot at it. Returns the die that was rolled and whether the nuke died.
 */
const shootAtNuke = (
  seed: number,
  range: number,
  gunClass: ShipClass = 'corvette',
): { die: number; destroyed: boolean; odds: string } | null => {
  const lane = add(FIELD, hex(-2, 0));
  let s = game(
    [
      armed('layer', B, 'frigate', lane, hex(1, 0), [{ kind: 'nuke', quantity: 1 }]),
      armed('gun', A, gunClass, add(FIELD, hex(-1, range)), hex(0, 0), []),
    ],
    seed,
    { nukesAllowed: true },
  );
  s = playerTurn(s); // A idles through day 1
  s = toPhase(s, 'ordnance');
  s = ok(s, { type: 'launchOrdnance', by: B, ship: 'layer', kind: 'nuke' });
  s = ok(s, { type: 'plotCourse', by: B, ship: 'layer', endpoint: add(lane, hex(1, 1)) });
  s = playerTurn(s); // finish B, ordnance flies
  const nuke = Object.keys(s.ordnance)[0];
  if (!nuke) return null;
  s = toPhase(s, 'combat'); // A's combat phase on day 2
  if (!s.ordnance[nuke]) return null;

  const out = applyCommand(s, { type: 'attack', by: A, attackers: ['gun'], targets: [nuke] }, map);
  expect(out.result.ok).toBe(true);
  const line = out.state.log[out.state.log.length - 1]!.text;
  const die = Number(/die (\d+)/.exec(line)?.[1]);
  const odds = /at (\d+:\d+)/.exec(line)?.[1] ?? '';
  const reportedRange = Number(/range (\d+)/.exec(line)?.[1]);
  expect({ seed, range: reportedRange }).toEqual({ seed, range });
  return { die, destroyed: Object.keys(out.state.ordnance).length === 0, odds };
};

describe('gunnery against ordnance', () => {
  it('has no effect at all on mines or torpedoes', () => {
    // "Guns and planetary defenses have no effect on mines"; a torpedo "is
    //  treated as a mine, except" for a list that never restores vulnerability
    //  to gunfire.
    //
    // The engine refuses the order outright rather than letting the shot be
    // fired and fall flat. Friendlier, but not identical: a shot that happened
    // and achieved nothing would still spend the firer's one attack per combat
    // phase. The rules do not say which it is.
    for (const kind of ['mine', 'torpedo'] as const) {
      let s = game(
        [
          armed('layer', B, 'frigate', FIELD, hex(1, 0), [{ kind, quantity: 1 }]),
          armed('gun', A, 'corsair', add(FIELD, hex(0, -2)), hex(0, 0), []),
        ],
        3,
      );
      s = playerTurn(s);
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: B, ship: 'layer', kind });
      s = ok(s, { type: 'plotCourse', by: B, ship: 'layer', endpoint: add(FIELD, hex(1, 1)) });
      s = playerTurn(s);
      s = toPhase(s, 'combat');
      const id = Object.keys(s.ordnance)[0]!;
      expect(refuse(s, { type: 'attack', by: A, attackers: ['gun'], targets: [id] })).toBeTruthy();
      expect(Object.keys(s.ordnance)).toHaveLength(1);
    }
  });

  it('attacks a nuke at 2:1 whatever the gun, and any damage result kills it', () => {
    // "Guns and planetary defenses may attack nukes at odds of 2:1 (with
    //  modifications for range and relative velocity). A 'disabled' nuke is
    //  destroyed."
    //
    // The 2:1 column of the gun table reads – – D2 D3 D4 D5, and every one of
    // those D results destroys the nuke, so at range 1 (a -1 modifier, "Subtract
    // 1 from the die roll for each hex of range") the nuke dies on a natural 4
    // or better and survives on 3 or less.
    let seen = 0;
    for (let seed = 0; seed < 30; seed++) {
      for (const gunClass of ['corvette', 'dreadnaught'] as const) {
        const shot = shootAtNuke(seed, 1, gunClass);
        if (!shot) continue;
        seen++;
        expect({ seed, gunClass, odds: shot.odds }).toEqual({ seed, gunClass, odds: '2:1' });
        expect({ seed, gunClass, destroyed: shot.destroyed }).toEqual({
          seed,
          gunClass,
          destroyed: gunDamage('2:1', shot.die - 1) !== null,
        });
        expect({ seed, gunClass, expected: shot.destroyed }).toEqual({
          seed,
          gunClass,
          expected: shot.die >= 4,
        });
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('applies the range modifier, so a distant gun needs a better die', () => {
    // "Subtract 1 from the die roll for each hex of range separating the attacker
    //  and the target." At range 3 the 2:1 column needs a modified 3, so only a
    //  natural 6 will do.
    let seen = 0;
    for (let seed = 0; seed < 30; seed++) {
      const shot = shootAtNuke(seed, 3);
      if (!shot) continue;
      seen++;
      expect({ seed, destroyed: shot.destroyed }).toEqual({ seed, destroyed: shot.die >= 6 });
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('lets planetary defences engage a nuke overhead, but nothing else', () => {
    // The envelope is the engine's reading, not a quotation. p. 8 scopes
    // planetary defence fire to "enemy ships in the gravity hex directly above
    // the base's hex side", and the nuke clause that grants the capability —
    // "Guns and planetary defenses may attack nukes at odds of 2:1 (with
    // modifications for range and relative velocity)" — offers a range modifier,
    // which is dead text if the only legal target is always exactly one hex out.
    // "Guns and planetary defenses may attack nukes at odds of 2:1." The
    // envelope is the base's own: "Planetary bases may fire at enemy ships in
    // the gravity hex directly above the base's hex side."
    const site = map
      .allPlanetaryBases()
      .find((b) => b.bodyId === 'terra' && b.side.dir === 0 && b.hasPlanetaryDefences)!;
    const above = site.gravityHex;
    const outer = add(above, sub(above, TERRA.hex));
    expect(key(outer)).toBe(key(add(PLUNGE_START, PLUNGE_V)));

    // A warhead still two hexes out is outside the envelope, and the base may
    // not reach it: "Planetary bases may fire at enemy ships in the gravity hex
    // directly above the base's hex side."
    {
      let far = game(
        [armed('layer', B, 'frigate', PLUNGE_START, PLUNGE_V, [{ kind: 'nuke', quantity: 1 }])],
        1,
        { nukesAllowed: true },
      );
      far = { ...far, bases: { ...far.bases, [site.id]: { ...far.bases[site.id]!, owner: A } } };
      far = playerTurn(far);
      far = toPhase(far, 'ordnance');
      far = ok(far, { type: 'launchOrdnance', by: B, ship: 'layer', kind: 'nuke' });
      far = ok(far, {
        type: 'plotCourse',
        by: B,
        ship: 'layer',
        endpoint: add(add(PLUNGE_START, PLUNGE_V), hex(0, 1)),
      });
      far = playerTurn(far); // B's movement carries the nuke to `outer`
      const id = Object.keys(far.ordnance)[0]!;
      expect(key(far.ordnance[id]!.pos)).toBe(key(outer));
      far = toPhase(far, 'combat');
      expect(
        refuse(far, { type: 'firePlanetaryDefence', by: A, base: site.id, targets: [id] }),
      ).toBeTruthy();
      expect(Object.keys(far.ordnance)).toHaveLength(1);
    }

    let killed = 0;
    let spared = 0;
    for (let seed = 0; seed < 12; seed++) {
      let s = game(
        [armed('layer', B, 'frigate', outer, sub(above, outer), [{ kind: 'nuke', quantity: 1 }])],
        seed,
        { nukesAllowed: true },
      );
      s = { ...s, bases: { ...s.bases, [site.id]: { ...s.bases[site.id]!, owner: A } } };
      s = playerTurn(s);
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: B, ship: 'layer', kind: 'nuke' });
      s = ok(s, {
        type: 'plotCourse',
        by: B,
        ship: 'layer',
        endpoint: neighbor(add(outer, sub(above, outer)), 2),
      });
      s = playerTurn(s);
      const nuke = Object.keys(s.ordnance)[0];
      if (!nuke) continue;
      expect(key(s.ordnance[nuke]!.pos)).toBe(key(above));
      s = toPhase(s, 'combat');
      const out = applyCommand(
        s,
        { type: 'firePlanetaryDefence', by: A, base: site.id, targets: [nuke] },
        map,
      );
      expect(out.result.ok).toBe(true);
      const line = out.state.log[out.state.log.length - 1]!.text;
      expect(line).toContain('2:1');
      if (Object.keys(out.state.ordnance).length === 0) killed++;
      else spared++;
    }
    // A "disabled" nuke is destroyed outright — there is no half-wrecked nuke.
    expect(killed).toBeGreaterThan(0);
    expect(killed + spared).toBeGreaterThan(6);
  });
});

// ---------------------------------------------------------------------------
// Ordnance against ordnance, and astrogation hazards
// ---------------------------------------------------------------------------

describe('ordnance against ordnance', () => {
  it('destroys an enemy mine it runs into, and is destroyed with it', () => {
    // "Mines, torpedoes, and nukes automatically destroy mines and are
    //  themselves destroyed." Both halves: a minefield must be sweepable, and
    //  the sweeper must not survive.
    for (const kind of ['mine', 'torpedo', 'nuke'] as const) {
      const picket = add(FIELD, hex(4, 0));
      let s = game(
        [
          armed('picket', B, 'frigate', picket, hex(0, 0), [{ kind: 'mine', quantity: 1 }]),
          armed('sweeper', A, 'frigate', FIELD, hex(2, 0), [{ kind, quantity: 1 }]),
        ],
        11,
        { nukesAllowed: true },
      );
      // Day 1: A's sweeper coasts to two hexes short of the picket...
      s = playerTurn(s);
      // ...and B lays the picket mine on its own player-turn, then steps aside.
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: B, ship: 'picket', kind: 'mine' });
      s = ok(s, { type: 'plotCourse', by: B, ship: 'picket', endpoint: add(picket, hex(0, -1)) });
      s = playerTurn(s);
      expect(Object.keys(s.ordnance)).toHaveLength(1);
      expect(key(s.ships['sweeper']!.pos)).toBe(key(add(FIELD, hex(2, 0))));

      // Day 2: A launches its own item down the lane, straight onto the picket.
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'sweeper', kind });
      const swerve = add(FIELD, hex(4, 1));
      s = ok(s, { type: 'plotCourse', by: A, ship: 'sweeper', endpoint: swerve });
      // The sweeper itself must not touch the picket hex, or the ship rather
      // than its ordnance would be what set the mine off.
      expect(
        traceSegment(s.ships['sweeper']!.pos, swerve).touched.map((t) => key(t.hex)),
      ).not.toContain(key(picket));

      s = toPhase(s, 'combat');
      expect({ kind, left: Object.keys(s.ordnance) }).toEqual({ kind, left: [] });
      expect({ kind, at: s.log.some((l) => l.text.includes(`${picket.q},${picket.r}`)) }).toEqual({
        kind,
        at: true,
      });
    }
  });

  it('is not a ramming target', () => {
    // "Mines, torpedoes, and nukes explode when they are in a hex occupied by a
    //  ship; they are not capable of ramming or being rammed."
    let s = game([
      armed('layer', B, 'frigate', FIELD, hex(0, 0), [{ kind: 'mine', quantity: 1 }]),
      armed('rammer', A, 'corsair', add(FIELD, hex(-2, 0)), hex(2, 0), []),
    ]);
    s = playerTurn(s);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: B, ship: 'layer', kind: 'mine' });
    s = ok(s, { type: 'plotCourse', by: B, ship: 'layer', endpoint: add(FIELD, hex(0, -1)) });
    s = playerTurn(s);
    const mineId = Object.keys(s.ordnance)[0]!;
    expect(refuse(s, { type: 'declareRam', by: A, ship: 'rammer', target: mineId })).toBeTruthy();
  });
});

describe('astrogation hazards', () => {
  it('detonates a mine or torpedo that enters an asteroid hex', () => {
    // "Mines and torpedoes detonate upon entering an asteroid hex."
    for (const kind of ['mine', 'torpedo'] as const) {
      const start = add(ROCK, hex(-2, 0));
      let s = game([armed('w', A, 'frigate', start, hex(2, 0), [{ kind, quantity: 1 }])], 5);
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind });
      s = ok(s, { type: 'plotCourse', by: A, ship: 'w', endpoint: add(start, hex(1, 1)) });
      s = toPhase(s, 'combat');
      expect({ kind, left: Object.keys(s.ordnance) }).toEqual({ kind, left: [] });
      expect({
        kind,
        atRock: s.log.some(
          (l) => l.text.includes('asteroids') && l.text.includes(`${ROCK.q},${ROCK.r}`),
        ),
      }).toEqual({ kind, atRock: true });
      // ...and, unlike a nuke, it leaves the rocks where they were.
      expect({ kind, cleared: s.clearedAsteroids }).toEqual({ kind, cleared: [] });
    }
  });

  it('lets Clandestine’s owner shoot through the dense asteroids, and nobody else', () => {
    // "The mines and torpedoes of Clandestine's owner are unaffected by the
    //  special asteroids. Other mines and torpedoes entering those asteroids
    //  detonate without harming ships."
    const dense = denseTarget();
    const start = add(dense, hex(-2, 0));

    const fly = (owner: string, bystander: boolean): GameState => {
      let s = game(
        [
          armed('w', owner, 'frigate', start, hex(2, 0), [{ kind: 'mine', quantity: 1 }]),
          ...(bystander
            ? [armed('rock-sitter', owner === A ? B : A, 'corsair', dense, hex(0, 0), [])]
            : []),
        ],
        5,
      );
      s = { ...s, bases: { ...s.bases, clandestine: { ...s.bases['clandestine']!, owner: A } } };
      if (owner !== A) s = playerTurn(s); // wait for the launcher's own player-turn
      s = toPhase(s, 'ordnance');
      s = ok(s, { type: 'launchOrdnance', by: owner, ship: 'w', kind: 'mine' });
      s = ok(s, { type: 'plotCourse', by: owner, ship: 'w', endpoint: add(start, hex(1, 1)) });
      return toPhase(s, 'combat');
    };

    // The owner's mine rides straight through the special rocks...
    expect(Object.keys(fly(A, false).ordnance)).toHaveLength(1);
    // ...an outsider's does not, and takes nobody with it.
    const outsider = fly(B, true);
    expect(Object.keys(outsider.ordnance)).toHaveLength(0);
    expect(outsider.ships['rock-sitter']!.disabled).toBe(0);
    expect(outsider.ships['rock-sitter']!.destroyed).toBe(false);
  });

  it('detonates ordnance that enters an astral body’s hex', () => {
    // "Mines, torpedoes, and nukes are detonated when they enter a hex containing
    //  a ship, astral body, mine, torpedo, or nuke." For ordnance the test is the
    //  hex, not the printed disc a ship has to actually strike.
    const start = PLUNGE_START;
    const inward = PLUNGE_V;
    let s = game([armed('w', A, 'frigate', start, inward, [{ kind: 'mine', quantity: 1 }])], 5);
    s = toPhase(s, 'ordnance');
    s = ok(s, { type: 'launchOrdnance', by: A, ship: 'w', kind: 'mine' });
    s = ok(s, {
      type: 'plotCourse',
      by: A,
      ship: 'w',
      endpoint: add(add(start, inward), hex(0, 1)),
    });
    for (let d = 0; d < 4 && Object.keys(s.ordnance).length > 0; d++) {
      s = toPhase(s, 'combat');
      s = playerTurn(s);
      s = playerTurn(s);
    }
    expect(Object.keys(s.ordnance)).toHaveLength(0);
    expect(s.log.some((l) => /Mine M1 detonates at .* strikes Terra/.test(l.text))).toBe(true);
  });
});
