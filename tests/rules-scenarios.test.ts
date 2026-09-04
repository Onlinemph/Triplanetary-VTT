/**
 * The ten scenarios, clause by clause (rulebook pp. 9-13).
 *
 * Each case quotes the printed clause it enforces and is written against that
 * clause, not against `src/scenarios/`. Setup (which ships, which classes, how
 * many, whose, and where they start), base ownership and presence, the options
 * a scenario turns on, its special rules, and its victory conditions.
 *
 * Deviations that are *not* tested here, because each is a live reading rather
 * than a contradiction, are recorded in docs/RULES-MAPPING.md instead: Lateral
 * 7's dreadnaught is free to move before a pirate is detected; Piracy's prizes
 * refit at any friendly base rather than at Luna or Clandestine; Nova's aliens
 * enter on an arc 11-14 hexes from Jupiter when the nearest rim hex is 7; Nova's
 * default victory applies the printed *variant* (both blocs win) rather than the
 * base rule; and Piracy's delivery cycles are unimplemented, so the Merchant
 * earns no points and the Pirates' eight-points-in-a-cycle win cannot fire.
 *
 * Where a scenario's fleet is fixed at build time instead of bought through a
 * point-buy or MegaCredit screen (Nova, Fleet Mutiny, Interplanetary War,
 * Prospecting), that is the known gap recorded in docs/RULES-MAPPING.md, and the
 * fixed fleets are checked here against the printed allowances instead.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type Hex,
  type Ship,
  CARGO,
  DEFAULT_MAP,
  SHIP_CLASSES,
  SUPPRESSED_SIDES_KEY,
  applyCommand,
  canResupplyAt,
  distance,
  hexSide,
  key,
  length as speed,
  logistics,
  neighbor,
  sideKey,
  sub,
} from '../src/engine/index.js';
import { BODIES } from '../src/engine/mapdata.js';
import { buildScenario, checkScenarioVictory, combatPointCost } from '../src/scenarios/index.js';
import { prospectorWorth } from '../src/scenarios/prospecting.js';

const map = DEFAULT_MAP;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const build = (id: string, seed?: number): GameState =>
  buildScenario(id, seed === undefined ? {} : { seed });

const ships = (s: GameState, owner?: string): Ship[] =>
  Object.values(s.ships).filter((x) => owner === undefined || x.owner === owner);

const live = (s: GameState, owner: string): Ship[] => ships(s, owner).filter((x) => !x.destroyed);

/** The world a ship is sitting on, or `null` if it is not on one. */
const landedOn = (ship: Ship): string | null =>
  ship.location.kind === 'landed' ? (map.bodyAt(ship.location.side.hex)?.id ?? null) : null;

/** The asteroid a ship is stopped at ("by simply stopping in the hex"). */
const stoppedAt = (ship: Ship): string | null =>
  ship.location.kind === 'asteroidBase' ? (map.bodyAt(ship.location.hex)?.id ?? null) : null;

/** The body a ship is in orbit around, per "one hex per turn from one gravity hex to an adjacent gravity hex of the same body". */
const orbiting = (ship: Ship): string | null => map.orbitOf(ship.pos, ship.velocity)?.id ?? null;

const basesInUse = (s: GameState) => Object.values(s.bases).filter((b) => !b.destroyed);

const baseBody = (id: string): string => (id.includes(':') ? id.slice(0, id.indexOf(':')) : id);

const patch = (s: GameState, id: string, p: Partial<Ship>): GameState => ({
  ...s,
  ships: { ...s.ships, [id]: { ...s.ships[id]!, ...p } },
});

const leg = (turn: number, from: Hex, to: Hex, accel: 0 | 1 | 2 = 1) => ({
  turn,
  from,
  to,
  accel,
});

const cargoMassOf = (ship: Ship): number =>
  ship.cargo.reduce((n, c) => n + CARGO[c.kind].mass * c.quantity, 0);

/** What a fleet cost to buy under the MegaCredit table, hulls plus ordnance. */
const megaCreditValue = (s: GameState, owner: string): number =>
  ships(s, owner).reduce(
    (n, x) =>
      n +
      SHIP_CLASSES[x.shipClass].cost +
      x.cargo.reduce((m, c) => m + (CARGO[c.kind].cost ?? 0) * c.quantity, 0),
    0,
  );

/** "Ships are acquired on the basis of combat strength points." */
const combatPoints = (s: GameState, owner: string): number =>
  ships(s, owner).reduce((n, x) => n + combatPointCost(x.shipClass), 0);

const run = (s: GameState, c: Command): { state: GameState; ok: boolean; why?: string } => {
  const out = applyCommand(s, c, map);
  return { state: out.state, ok: out.result.ok, why: out.result.reason };
};

/** Wind the phase machine on to a given player's phase. */
const at = (s: GameState, phase: GameState['phase'], who: string): GameState => {
  let cur = s;
  for (let i = 0; i < 60; i++) {
    if (cur.phase === phase && cur.playerOrder[cur.activePlayerIndex] === who) return cur;
    const out = run(cur, { type: 'endPhase', by: cur.playerOrder[cur.activePlayerIndex]! });
    if (!out.ok) throw new Error(out.why ?? 'phase machine stalled');
    cur = out.state;
  }
  throw new Error(`never reached ${phase} for ${who}`);
};

/**
 * Whole turns, all seats — stopping the moment somebody wins.
 *
 * A finished game refuses every order, which is correct: `applyCommand` turns
 * away anything once `state.victory` is set. Advancing past that point is not
 * something a caller can want, so this returns the winning state rather than
 * throwing "the game is over" from inside a clock helper.
 */
const turns = (s: GameState, n: number): GameState => {
  let cur = s;
  const phases = 5 * cur.playerOrder.length;
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < phases; i++) {
      if (cur.victory) return cur;
      const out = run(cur, { type: 'endPhase', by: cur.playerOrder[cur.activePlayerIndex]! });
      if (!out.ok) throw new Error(out.why ?? 'phase machine stalled');
      cur = out.state;
    }
  }
  return cur;
};

/** Park a ship on a world's base, ready to resupply. */
const putOnBase = (s: GameState, id: string, bodyId: string, dir: number): GameState => {
  const body = map.body(bodyId)!;
  return patch(s, id, {
    pos: body.hex,
    velocity: { q: 0, r: 0 },
    pendingGravity: { q: 0, r: 0 },
    optionalGravity: [],
    location: { kind: 'landed', side: hexSide(body.hex, dir) },
    fuel: 1,
  });
};

const HABITABLE_FULL_GRAVITY = BODIES.filter((b) => b.habitable && b.gravity === 'full').map(
  (b) => b.id,
);
const FULL_GRAVITY = BODIES.filter((b) => b.gravity === 'full').map((b) => b.id);

// ---------------------------------------------------------------------------
// Every scenario
// ---------------------------------------------------------------------------

describe('all ten scenarios', () => {
  it('ships the rulebook’s ten, and nobody has won before the first die is rolled', () => {
    // pp. 9-13 print ten scenarios; a game that starts already decided is not a game.
    const ids = [
      'bi-planetary',
      'grand-tour',
      'escape',
      'lateral-7',
      'piracy',
      'nova',
      'retribution',
      'fleet-mutiny',
      'interplanetary-war',
      'prospecting',
    ];
    for (const id of ids) {
      const s = build(id);
      expect({ id, turn: s.turn, victory: checkScenarioVictory(s) }).toEqual({
        id,
        turn: 1,
        victory: null,
      });
    }
  });

  it('lands nobody on a hexside without a base', () => {
    // "Ships may land on any planet or satellite if the world has a base and the
    //  ship lands at that base... It may take off in the next turn, provided that
    //  that hex side contained a base."
    for (const def of [
      'bi-planetary',
      'grand-tour',
      'escape',
      'lateral-7',
      'piracy',
      'nova',
      'retribution',
      'interplanetary-war',
      'prospecting',
    ]) {
      const s = build(def);
      for (const ship of ships(s)) {
        if (ship.location.kind !== 'landed') continue;
        const site = map.planetaryBaseAt(ship.location.side);
        expect({ def, ship: ship.id, base: site !== undefined }).toEqual({
          def,
          ship: ship.id,
          base: true,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bi-Planetary (p. 9)
// ---------------------------------------------------------------------------

describe('Bi-Planetary (p. 9)', () => {
  it('starts one corvette on Mars and one on Venus, and nothing else', () => {
    // "One player starts with a corvette on Mars, one on Venus."
    const s = build('bi-planetary');
    const fleet = ships(s);
    expect(fleet).toHaveLength(2);
    expect(fleet.map((x) => `${x.shipClass}@${landedOn(x)}`).sort()).toEqual([
      'corvette@mars',
      'corvette@venus',
    ]);
    // Two players, one ship each.
    expect(new Set(fleet.map((x) => x.owner)).size).toBe(2);
    for (const x of fleet) expect(x.fuel).toBe(SHIP_CLASSES.corvette.fuelCapacity);
  });

  it('is won by whoever lands on the other world in the fewest turns', () => {
    // "Each player must navigate to the other world and land. The winner is the
    //  one who does it in the fewest turns."
    const venus = map.body('venus')!;
    const mars = map.body('mars')!;
    const s0 = build('bi-planetary');
    const marsShip = ships(s0).find((x) => landedOn(x) === 'mars')!;
    const venusShip = ships(s0).find((x) => landedOn(x) === 'venus')!;

    const s: GameState = {
      ...s0,
      turn: 14,
      ships: {
        ...s0.ships,
        [marsShip.id]: {
          ...marsShip,
          course: [leg(9, neighbor(venus.hex, 0), venus.hex)],
        },
        [venusShip.id]: {
          ...venusShip,
          course: [leg(12, neighbor(mars.hex, 0), mars.hex)],
        },
      },
    };
    const v = checkScenarioVictory(s);
    expect({ winners: v?.winners, level: v?.level }).toEqual({
      winners: [marsShip.owner],
      level: 'decisive',
    });
  });

  it('gives no credit for landing back on the world the racer came from', () => {
    // "Each player must navigate to the OTHER world and land."
    const mars = map.body('mars')!;
    const s0 = build('bi-planetary');
    const marsShip = ships(s0).find((x) => landedOn(x) === 'mars')!;
    const venusShip = ships(s0).find((x) => landedOn(x) === 'venus')!;

    const s: GameState = {
      ...s0,
      turn: 14,
      ships: {
        ...s0.ships,
        // Mars turns round and comes home on day 4: that is not the other world.
        [marsShip.id]: { ...marsShip, course: [leg(4, neighbor(mars.hex, 0), mars.hex)] },
        [venusShip.id]: { ...venusShip, course: [leg(11, neighbor(mars.hex, 3), mars.hex)] },
      },
    };
    expect(checkScenarioVictory(s)?.winners).toEqual([venusShip.owner]);
  });

  it('charges nothing for fuel, because the scenario gives no price', () => {
    // "Fuel is available at any friendly base. If no cost is given in the
    //  scenario, then fuel is too cheap to keep track of in the game – i.e., free."
    const s0 = build('bi-planetary');
    const racer = ships(s0)[0]!;
    const drained = patch(s0, racer.id, { fuel: 5 });
    const s = at(drained, 'resupply', racer.owner);
    const out = run(s, { type: 'resupply', by: racer.owner, ship: racer.id });
    expect({ ok: out.ok, why: out.why }).toEqual({ ok: true, why: undefined });
    expect(out.state.ships[racer.id]!.fuel).toBe(SHIP_CLASSES.corvette.fuelCapacity);
    expect(out.state.players[racer.owner]!.megacredits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grand Tour, 2037 AD (p. 9)
// ---------------------------------------------------------------------------

describe('Grand Tour, 2037 AD (p. 9)', () => {
  it('starts each racer with one corvette at a different habitable full-gravity world', () => {
    // "Ships: Each racer starts with one corvette at a different (if possible)
    //  habitable full-gravity world."
    const s = build('grand-tour');
    const fleet = ships(s);
    expect(fleet.length).toBe(s.playerOrder.length);

    const homes = fleet.map(landedOn);
    expect(new Set(homes).size).toBe(homes.length); // all different
    for (const ship of fleet) {
      const home = landedOn(ship);
      expect({
        ship: ship.id,
        cls: ship.shipClass,
        habitableFullGravity: home !== null && HABITABLE_FULL_GRAVITY.includes(home),
      }).toEqual({ ship: ship.id, cls: 'corvette', habitableFullGravity: true });
    }
  });

  it('is not complete until a gravity hex of every full-gravity body has been passed', () => {
    // "Each ship must pass through at least one gravity hex of each astral body
    //  with full gravity (the six habitable ones, plus Jupiter and the Sun) and
    //  return to land on its starting world."
    expect(new Set(FULL_GRAVITY)).toEqual(new Set([...HABITABLE_FULL_GRAVITY, 'jupiter', 'sol']));

    const s0 = build('grand-tour');
    const racer = ships(s0)[0]!;
    const home = landedOn(racer)!;

    // A tour of every body but one, then home: not a win, whichever body is
    // missed. The home world is not among the candidates — a ship landing there
    // has crossed its gravity ring by definition, so its own world is never the
    // one that can be left out.
    for (const skipped of FULL_GRAVITY.filter((b) => b !== home)) {
      const course = FULL_GRAVITY.filter((b) => b !== skipped).map((b, i) =>
        leg(i + 1, neighbor(map.body(b)!.hex, 0), neighbor(map.body(b)!.hex, 1), 0),
      );
      course.push(leg(20, neighbor(map.body(home)!.hex, 0), map.body(home)!.hex));
      const s: GameState = {
        ...s0,
        turn: 30,
        ships: { ...s0.ships, [racer.id]: { ...racer, course } },
      };
      expect({ skipped, victory: checkScenarioVictory(s) }).toEqual({ skipped, victory: null });
    }

    // The full round trip is a win.
    const full = FULL_GRAVITY.map((b, i) =>
      leg(i + 1, neighbor(map.body(b)!.hex, 0), neighbor(map.body(b)!.hex, 1), 0),
    );
    full.push(leg(20, neighbor(map.body(home)!.hex, 0), map.body(home)!.hex));
    const won: GameState = {
      ...s0,
      turn: 30,
      ships: { ...s0.ships, [racer.id]: { ...racer, course: full } },
    };
    expect(checkScenarioVictory(won)?.winners).toEqual([racer.owner]);
  });

  it('breaks a dead heat on fuel consumption', () => {
    // "The first ship to do so wins. In case of ties, the lowest fuel
    //  consumption wins."
    const s0 = build('grand-tour');
    const [a, b] = ships(s0);
    const tour = (home: string, accel: 0 | 1): ReturnType<typeof leg>[] => {
      const course = FULL_GRAVITY.map((body, i) =>
        leg(i + 1, neighbor(map.body(body)!.hex, 0), neighbor(map.body(body)!.hex, 1), accel),
      );
      course.push(leg(20, neighbor(map.body(home)!.hex, 0), map.body(home)!.hex, 1));
      return course;
    };
    const s: GameState = {
      ...s0,
      turn: 30,
      ships: {
        ...s0.ships,
        // Same finishing day; the second racer burned a point on every leg.
        [a!.id]: { ...a!, course: tour(landedOn(a!)!, 0) },
        [b!.id]: { ...b!, course: tour(landedOn(b!)!, 1) },
        // The other four never finish and are gone, so the race is over.
        ...Object.fromEntries(
          ships(s0)
            .slice(2)
            .map((x) => [x.id, { ...x, destroyed: true }]),
        ),
      },
    };
    const v = checkScenarioVictory(s);
    expect(v?.winners).toEqual([a!.owner]);
  });

  it('fuel is available only at bases on Terra, Venus, Mars and Callisto', () => {
    // "Special Rules: Fuel is available only at bases on Terra, Venus, Mars, and
    //  Callisto. There is no cost for fuel."
    //
    // The engine leaves every printed base in use and unowned, and an unowned
    // base is friendly to everyone (`logistics.baseIsFriendly`), so a racer can
    // top up at Ganymede, Mercury, Luna, Io, Ceres or Clandestine. The
    // restriction is recorded in `scenarioData.fuelBases` and read by nothing.
    // Fuel is this scenario's only currency and its tie-break; free refuelling
    // at the outer moons is the whole race.
    const s0 = build('grand-tour');
    const racer = ships(s0)[0]!;

    for (const [world, dir] of [
      ['terra', 0],
      ['venus', 0],
      ['mars', 0],
      ['callisto', 1],
    ] as const) {
      const s = putOnBase(s0, racer.id, world, dir);
      const check = canResupplyAt(s, s.ships[racer.id]!, map);
      expect({ world, refuels: check.ok }).toEqual({ world, refuels: true });
    }

    for (const [world, dir] of [
      ['ganymede', 4],
      ['mercury', 0],
      ['luna', 0],
      ['io', 3],
    ] as const) {
      const s = putOnBase(s0, racer.id, world, dir);
      const check = canResupplyAt(s, s.ships[racer.id]!, map);
      expect({ world, refuels: check.ok }).toEqual({ world, refuels: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Escape (pp. 9-10)
// ---------------------------------------------------------------------------

describe('Escape (pp. 9-10)', () => {
  it('gives the Pilgrims three transports on Terra and the Enforcers two ships in orbit', () => {
    // "Ships: The Pilgrims receive three transports (white on blue) on Terra. The
    //  Enforcers receive one corvette in orbit around Terra and a corsair in orbit
    //  around Venus (white on black counters)."
    const s = build('escape');
    const pilgrims = ships(s, 'pilgrims');
    expect(pilgrims.map((x) => `${x.shipClass}@${landedOn(x)}`).sort()).toEqual([
      'transport@terra',
      'transport@terra',
      'transport@terra',
    ]);

    const enforcers = ships(s, 'enforcers');
    expect(enforcers.map((x) => `${x.shipClass}@${orbiting(x)}`).sort()).toEqual([
      'corsair@venus',
      'corvette@terra',
    ]);
  });

  it('secretly designates one transport as the fugitive and two as decoys', () => {
    // "The Pilgrims secretly designate one transport to contain the fugitives;
    //  the other two are decoys crewed by volunteers."
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const s = build('escape', seed);
      const secret = s.scenarioData['secret'] as { fugitiveShip: string; decoyShips: string[] };
      const hulls = ships(s, 'pilgrims').map((x) => x.id);
      expect({
        seed,
        fugitiveIsATransport: hulls.includes(secret.fugitiveShip),
        decoys: secret.decoyShips.length,
        partition: [secret.fugitiveShip, ...secret.decoyShips].sort(),
      }).toEqual({ seed, fugitiveIsATransport: true, decoys: 2, partition: hulls.sort() });
    }
    // "Decoy ships are revealed only if the Enforcer matches course and inspects
    //  the ship in question."
    expect(build('escape').options.fogOfWar).toBe(true);
  });

  it('puts bases only on Terra, Venus and Io, and switches the planetary defences off', () => {
    // "Only Terra, Venus, and Io have bases." / "Planetary defenses are not operating."
    const s = build('escape');
    expect(new Set(basesInUse(s).map((b) => baseBody(b.id)))).toEqual(
      new Set(['terra', 'venus', 'io']),
    );
    for (const base of basesInUse(s)) {
      expect({ base: base.id, defences: base.hasPlanetaryDefences }).toEqual({
        base: base.id,
        defences: false,
      });
    }
  });

  it('keeps ships still on Terra safe from attack', () => {
    // "Ships still on Terra may not be attacked." Landed ships are already immune
    // to guns, mines, torpedoes and ramming; the only thing that reaches them is
    // a nuke, and this scenario has none.
    const s0 = build('escape');
    expect(s0.options.nukesAllowed).toBe(false);
    const s = at(s0, 'combat', 'enforcers');
    const shoot = (state: GameState) =>
      run(state, {
        type: 'attack',
        by: 'enforcers',
        attackers: ['enforcer-corvette'],
        targets: ['pilgrim-1'],
      });

    const onTerra = shoot(s);
    expect({ ok: onTerra.ok, why: onTerra.why }).toEqual({
      ok: false,
      why: expect.stringContaining('immune'),
    });

    // The control: the same shot at the same transport, once it has left the
    // ground, is a legal attack — so the refusal above is the landing, not the
    // phase, the range or the odds.
    const airborne = patch(s, 'pilgrim-1', {
      location: { kind: 'space' },
      pos: s.ships['enforcer-corvette']!.pos,
    });
    expect(shoot(airborne).ok).toBe(true);
  });

  it('grades the Pilgrim escape on the fuel left for a dead stop, plus one point', () => {
    // "The Pilgrims win a decisive victory if the fugitive ship exits the board
    //  beyond Jupiter with sufficient fuel remaining to make a dead stop, plus one
    //  fuel point. The Pilgrim transport may be disabled." / "The Pilgrims win a
    //  marginal victory if they exit as above but have less fuel than required."
    const s0 = build('escape');
    const fugitive = (s0.scenarioData['secret'] as { fugitiveShip: string }).fugitiveShip;
    const away = { q: 40, r: 0 };
    const velocity = { q: 3, r: 0 };
    expect(speed(velocity)).toBe(3);

    const gone = (fuel: number, disabled = 0): GameState =>
      patch(s0, fugitive, {
        pos: away,
        velocity,
        destroyed: true,
        destroyedBy: 'left the map',
        fuel,
        disabled,
      });

    expect(checkScenarioVictory(gone(4))).toEqual({
      winners: ['pilgrims'],
      level: 'decisive',
      reason: expect.any(String),
    });
    // Disablement is explicitly not a bar to the decisive win.
    expect(checkScenarioVictory(gone(4, 2))?.level).toBe('decisive');
    expect(checkScenarioVictory(gone(3))).toEqual({
      winners: ['pilgrims'],
      level: 'marginal',
      reason: expect.any(String),
    });
  });

  it('gives the Pilgrims a moral victory for bloodying an Enforcer on the way down', () => {
    // "The Pilgrims win a moral victory if they are destroyed or captured but
    //  disable at least one Enforcer ship, even temporarily, in the process." /
    // "The Enforcers win a marginal victory if they destroy the transport
    //  carrying the Pilgrims."
    const s0 = build('escape');
    const fugitive = (s0.scenarioData['secret'] as { fugitiveShip: string }).fugitiveShip;

    const shot = patch(s0, fugitive, { destroyed: true, destroyedBy: 'gunfire' });
    expect(checkScenarioVictory(shot)).toEqual({
      winners: ['enforcers'],
      level: 'marginal',
      reason: expect.any(String),
    });

    const bloodied = patch(shot, 'enforcer-corvette', { disabled: 2 });
    const v = checkScenarioVictory(bloodied);
    expect({ level: v?.level, pilgrims: v?.winners.includes('pilgrims') }).toEqual({
      level: 'moral',
      pilgrims: true,
    });
  });

  it('gives the Enforcers a decisive win once the fugitive transport is theirs', () => {
    // "The Enforcers win a decisive victory if they capture the Pilgrims (loot
    //  their transport) and return safely to a base."
    //
    // The engine reads "returned safely" off the prize rather than off the ship
    // that took it: `capture` sets `capturedBy` and the flag only clears into
    // full ownership at a base friendly to the captor ("A captured ship must be
    // returned to a base friendly to the captor before it may be used for any
    // other mission"), so an Enforcer-owned fugitive is one that has been taken
    // home. Which of the two the clause is really about — the prize or the
    // captor — is not settled by the printed text.
    const s0 = build('escape');
    const fugitive = (s0.scenarioData['secret'] as { fugitiveShip: string }).fugitiveShip;
    const prize = patch(s0, fugitive, { owner: 'enforcers', capturedBy: undefined });
    expect(checkScenarioVictory(prize)).toEqual({
      winners: ['enforcers'],
      level: 'decisive',
      reason: expect.any(String),
    });
  });

  it('gives every base to the Enforcers, and still lets the Pilgrims launch from Terra', () => {
    // "All bases on the map belong to the Enforcers." / "Beginning on Day 1, the
    //  Pilgrim may launch his ships from Terra in any manner he wishes."
    //
    // The launch permission is a rule about taking off, not about who owns the
    // pad. An unowned pad would grant more than the clause does: an unowned base
    // is friendly to everyone, so the Pilgrims would also get free fuel and a
    // full maintenance stop on the one world where they may not even be
    // attacked, in the one scenario graded on fuel remaining.
    const s0 = build('escape');
    for (const base of basesInUse(s0)) {
      expect({ base: base.id, owner: base.owner }).toEqual({ base: base.id, owner: 'enforcers' });
    }

    const thirsty = patch(s0, 'pilgrim-1', { fuel: 1 });
    expect(canResupplyAt(thirsty, thirsty.ships['pilgrim-1']!, map).ok).toBe(false);

    // But the boosters still fire: all three transports lift off Day 1.
    const day1 = at(s0, 'astrogation', 'pilgrims');
    for (const id of ['pilgrim-1', 'pilgrim-2', 'pilgrim-3']) {
      expect(run(day1, { type: 'takeOff', by: 'pilgrims', ship: id })).toMatchObject({ ok: true });
    }
    // The permission is Terra's alone, and the Pilgrims' alone: an Enforcer
    // corsair set down on Venus lifts off because the pad is *his*.
    const onVenus = putOnBase(s0, 'enforcer-corsair', 'venus', 0);
    expect(
      run(at(onVenus, 'astrogation', 'enforcers'), {
        type: 'takeOff',
        by: 'enforcers',
        ship: 'enforcer-corsair',
      }),
    ).toMatchObject({ ok: true });
  });

  it('mines and torpedoes are not available to either player', () => {
    // "Mines and torpedoes are not available to either player. The Pilgrim
    //  decoys may ram."
    //
    // Bases carry "an unlimited supply of fuel, mines, and torpedoes" and
    // `logistics.resupply` hands them out on request; nothing reads the
    // scenario's `ordnanceAvailable: []`. A Pilgrim transport (50 tons of hold)
    // can lift off Terra carrying two mines and a torpedo, and the Enforcer
    // corsair can arm a mine at Venus. The decoys are allowed to ram precisely
    // because they have nothing else.
    const s0 = build('escape');

    const pilgrimTurn = at(s0, 'resupply', 'pilgrims');
    const armed = run(pilgrimTurn, {
      type: 'resupply',
      by: 'pilgrims',
      ship: 'pilgrim-1',
      loadout: [
        { kind: 'mine', quantity: 2 },
        { kind: 'torpedo', quantity: 1 },
      ],
    });
    expect({ pilgrimArms: armed.ok }).toEqual({ pilgrimArms: false });

    const onVenus = putOnBase(s0, 'enforcer-corsair', 'venus', 0);
    const enforcerTurn = at(onVenus, 'resupply', 'enforcers');
    const mine = run(enforcerTurn, {
      type: 'resupply',
      by: 'enforcers',
      ship: 'enforcer-corsair',
      loadout: [{ kind: 'mine', quantity: 1 }],
    });
    expect({ enforcerArms: mine.ok }).toEqual({ enforcerArms: false });
  });
});

// ---------------------------------------------------------------------------
// Lateral 7 (p. 10)
// ---------------------------------------------------------------------------

describe('Lateral 7 (p. 10)', () => {
  it('gives the pirates two corsairs, a corvette and nine dummies, each corsair with one mine', () => {
    // "The pirates get two corsairs and one corvette (white on black), plus nine
    //  dummy counters (red, white, and blue corvettes and corsairs)... Each pirate
    //  corsair begins the game with one mine on board."
    const s = build('lateral-7');
    const pirates = ships(s, 'pirates');
    expect(pirates.map((x) => x.shipClass).sort()).toEqual(['corsair', 'corsair', 'corvette']);
    for (const corsair of pirates.filter((x) => x.shipClass === 'corsair')) {
      expect(corsair.cargo).toEqual([{ kind: 'mine', quantity: 1 }]);
    }
    expect(pirates.find((x) => x.shipClass === 'corvette')!.cargo).toEqual([]);

    const dummies = s.scenarioData['dummies'] as { owner: string; shipClass: string; hex: Hex }[];
    expect(dummies.filter((d) => d.owner === 'pirates')).toHaveLength(9);
    for (const d of dummies.filter((d) => d.owner === 'pirates')) {
      expect(['corvette', 'corsair']).toContain(d.shipClass);
    }
  });

  it('gives the Navy the Tycho Brahe, number 101, with one mine and one torpedo, three dummies and a liner on Venus', () => {
    // "The Navy gets one dreadnaught (red, white, and blue), three dummies (red,
    //  white, and blue frigates), and a liner (white on blue)... The dreadnaught
    //  begins with one mine and one torpedo on board." / "The liner is placed on
    //  Venus." — bound for "an interplanetary mining conference at Ganymede".
    const s = build('lateral-7');
    const navy = ships(s, 'navy');
    const dread = navy.find((x) => x.shipClass === 'dreadnaught')!;
    expect({ number: dread.number, name: dread.name }).toEqual({
      number: 101,
      name: 'Tycho Brahe',
    });
    expect(dread.cargo.map((c) => `${c.kind}x${c.quantity}`).sort()).toEqual([
      'minex1',
      'torpedox1',
    ]);

    const liner = navy.find((x) => x.shipClass === 'liner')!;
    expect(landedOn(liner)).toBe('venus');
    // The magnates themselves; a liner "has no weapons and no capacity for other cargo".
    expect(liner.cargo).toEqual([{ kind: 'passengers', quantity: 1 }]);

    const dummies = s.scenarioData['dummies'] as { owner: string; shipClass: string }[];
    expect(dummies.filter((d) => d.owner === 'navy').map((d) => d.shipClass)).toEqual([
      'frigate',
      'frigate',
      'frigate',
    ]);
  });

  it('hides every counter in a separate asteroid hex, all at zero velocity', () => {
    // "The dreadnaught and three dummies are placed in any asteroid hexes,
    //  inverted to conceal their identities. The pirate then places their three
    //  ships and nine dummies in any unoccupied asteroid hexes. All ships begin at
    //  zero velocity."
    for (const seed of [1, 2, 3, 20370101]) {
      const s = build('lateral-7', seed);
      const dummies = s.scenarioData['dummies'] as { hex: Hex }[];
      const belt = ships(s).filter((x) => x.location.kind === 'asteroidBase');
      const occupied = [...belt.map((x) => x.pos), ...dummies.map((d) => d.hex)];

      expect({
        seed,
        counters: occupied.length,
        distinct: new Set(occupied.map(key)).size,
      }).toEqual({ seed, counters: 16, distinct: 16 });
      for (const h of occupied) {
        expect({ seed, hex: key(h), asteroid: map.isAsteroid(h) }).toEqual({
          seed,
          hex: key(h),
          asteroid: true,
        });
      }
      for (const ship of ships(s)) {
        expect({ seed, ship: ship.id, v: key(ship.velocity) }).toEqual({
          seed,
          ship: ship.id,
          v: '0,0',
        });
      }
    }
  });

  it('gives the Navy Mars, Terra and Callisto, and the pirates Clandestine', () => {
    // "The Navy has bases on Mars, Terra, and Callisto." / "The pirate base is
    //  Clandestine (p. 7)."
    const s = build('lateral-7');
    const owners = new Map(basesInUse(s).map((b) => [b.id, b.owner]));
    for (const id of ['mars:0', 'terra:0', 'callisto:1']) {
      expect({ id, owner: owners.get(id) }).toEqual({ id, owner: 'navy' });
    }
    expect(owners.get('clandestine')).toBe('pirates');
    // The liner's port of departure and its destination are open to it.
    expect(owners.get('venus:0') ?? null).toBe(null);
    expect(owners.get('ganymede:4') ?? null).toBe(null);
  });

  it('is won by the pirate who ransoms the magnates at Clandestine, and decisively with the dreadnaught dead', () => {
    // "The pirate wins by matching courses with the liner, transferring the
    //  passengers, and taking them to Clandestine. He wins decisively if the
    //  dreadnaught is also destroyed."
    const s0 = build('lateral-7');
    const clandestine = map.body('clandestine')!;
    const corsair = ships(s0, 'pirates')[0]!;

    const ransom = patch(patch(s0, 'liner', { cargo: [] }), corsair.id, {
      pos: clandestine.hex,
      velocity: { q: 0, r: 0 },
      location: { kind: 'asteroidBase', hex: clandestine.hex },
      cargo: [{ kind: 'passengers', quantity: 1 }],
    });
    expect(checkScenarioVictory(ransom)).toEqual({
      winners: ['pirates'],
      level: 'marginal',
      reason: expect.any(String),
    });

    const alsoDead = patch(ransom, 'tycho-brahe', { destroyed: true, destroyedBy: 'gunfire' });
    expect(checkScenarioVictory(alsoDead)?.level).toBe('decisive');
  });

  it('is won by the Navy when the liner makes Ganymede, decisively with a pirate destroyed', () => {
    // "The Navy wins if the liner makes it to Ganymede. The win is decisive if a
    //  pirate ship is also destroyed."
    const s0 = build('lateral-7');
    const ganymede = map.body('ganymede')!;
    const arrived = patch(s0, 'liner', {
      pos: ganymede.hex,
      velocity: { q: 0, r: 0 },
      location: { kind: 'landed', side: hexSide(ganymede.hex, 4) },
    });
    expect(checkScenarioVictory(arrived)).toEqual({
      winners: ['navy'],
      level: 'marginal',
      reason: expect.any(String),
    });

    const pirateDead = patch(arrived, ships(s0, 'pirates')[0]!.id, {
      destroyed: true,
      destroyedBy: 'gunfire',
    });
    expect(checkScenarioVictory(pirateDead)?.level).toBe('decisive');
  });

  it('makes both players lose if the passengers are killed', () => {
    // "If the passengers of the liner, while on the liner or after transfer to
    //  another ship, are destroyed, both players lose."
    const s0 = build('lateral-7');
    const dead = patch(s0, 'liner', { destroyed: true, destroyedBy: 'gunfire' });
    expect(checkScenarioVictory(dead)?.winners).toEqual([]);
  });

  it('every base marked on the map is in use — this scenario never says otherwise', () => {
    // "All bases marked on the map are assumed to be in use unless a scenario
    //  indicates differently; the scenario will also indicate the ownership of the
    //  various bases." (p. 7)
    //
    // Lateral 7 names owners — "The Navy has bases on Mars, Terra, and Callisto",
    // "The pirate base is Clandestine" — and never strikes a base off the chart.
    // When the rulebook wants bases gone it says so in as many words, as Escape
    // does: "Only Terra, Venus, and Io have bases." Ceres is the one that would
    // bite: an asteroid base in the middle of the Belt this scenario is fought
    // in, with 3-hex detectors and a torpedo a turn.
    const s = build('lateral-7');
    const present = new Set(basesInUse(s).map((b) => baseBody(b.id)));
    for (const body of ['mercury', 'luna', 'io', 'ceres']) {
      expect({ body, inUse: present.has(body) }).toEqual({ body, inUse: true });
    }
    // Ceres is not merely present: a pirate who stops there can use it.
    const raider = patch(s, 'pirate-corsair-1', {
      pos: map.body('ceres')!.hex,
      velocity: { q: 0, r: 0 },
      location: { kind: 'asteroidBase', hex: map.body('ceres')!.hex },
      fuel: 1,
    });
    expect(canResupplyAt(raider, raider.ships['pirate-corsair-1']!, map).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Piracy (pp. 10-11)
// ---------------------------------------------------------------------------

describe('Piracy (pp. 10-11)', () => {
  it('opens with the Patrol on Luna, the Merchants on Terra and the Pirates on Clandestine', () => {
    // "The Patrol starts with a Dreadnaught and a Corsair on Luna." / "The
    //  Merchant starts with two Transports on Terra." / "The Pirates start with
    //  two Corsairs on Clandestine."
    const s = build('piracy');
    expect(
      ships(s, 'patrol')
        .map((x) => `${x.shipClass}@${landedOn(x)}`)
        .sort(),
    ).toEqual(['corsair@luna', 'dreadnaught@luna']);
    expect(
      ships(s, 'merchants')
        .map((x) => `${x.shipClass}@${landedOn(x)}`)
        .sort(),
    ).toEqual(['transport@terra', 'transport@terra']);
    expect(
      ships(s, 'pirates')
        .map((x) => `${x.shipClass}@${stoppedAt(x)}`)
        .sort(),
    ).toEqual(['corsair@clandestine', 'corsair@clandestine']);
    // "the Patrol and Merchant players must be willing to ignore undetected
    //  pirate ships until they are legally detected."
    expect(s.options.fogOfWar).toBe(true);
    expect(Object.values(s.bases).find((b) => b.id === 'clandestine')!.owner).toBe('pirates');
  });

  it('pays the Patrol the combat strength of every pirate hull it destroys', () => {
    // "The Patrol earns points equal to the combat strength of destroyed pirate
    //  ships." A corsair's printed strength is 4.
    const s0 = build('piracy');
    expect(s0.players['patrol']!.points).toBe(0);

    const sunk = patch(s0, 'pirate-corsair-1', { destroyed: true, destroyedBy: 'gunfire' });
    const scored = turns(sunk, 1);
    expect(scored.players['patrol']!.points).toBe(SHIP_CLASSES.corsair.combatStrength);

    // The wreck is on the board for the rest of the game; it pays once.
    expect(turns(scored, 3).players['patrol']!.points).toBe(SHIP_CLASSES.corsair.combatStrength);
  });

  it('docks the Merchant four points for a hull captured or destroyed', () => {
    // "The Merchant... loses 4 points when a merchant ship is captured or
    //  destroyed."
    const s0 = build('piracy');
    const lost = patch(s0, 'merchant-transport-1', { destroyed: true, destroyedBy: 'gunfire' });
    expect(turns(lost, 1).players['merchants']!.points).toBe(-4);

    const taken = patch(s0, 'merchant-transport-2', { capturedBy: 'pirates' });
    expect(turns(taken, 1).players['merchants']!.points).toBe(-4);
  });

  it('buys hulls with points, at the rate each side is quoted', () => {
    // "The Patrol may buy new ships on Luna at a cost of 2 points for every point
    //  of combat strength." / "New merchant ships may be purchased on Terra: 8
    //  points for a transport, 12 for a packet." A corvette's printed strength is
    //  2, so it costs the Patrol 4 points.
    const s0 = build('piracy');
    const luna = map.body('luna')!;
    const rich = (player: string, points: number): GameState => ({
      ...s0,
      phase: 'resupply',
      activePlayerIndex: s0.playerOrder.indexOf(player),
      players: { ...s0.players, [player]: { ...s0.players[player]!, points } },
    });

    const short = applyCommand(
      rich('patrol', 3),
      {
        type: 'purchaseShip',
        by: 'patrol',
        shipClass: 'corvette',
        at: luna.hex,
        side: hexSide(luna.hex, 0),
      },
      map,
    );
    expect({ ok: short.result.ok, why: short.result.reason }).toEqual({
      ok: false,
      why: expect.stringMatching(/4 points/),
    });

    const bought = applyCommand(
      rich('patrol', 10),
      {
        type: 'purchaseShip',
        by: 'patrol',
        shipClass: 'corvette',
        at: luna.hex,
        side: hexSide(luna.hex, 0),
      },
      map,
    );
    expect(bought.result.ok).toBe(true);
    expect(bought.state.players['patrol']!.points).toBe(6);
    // The MegaCredit treasury is untouched: this scenario is priced in points.
    expect(bought.state.players['patrol']!.megacredits).toBe(0);

    const terra = map.body('terra')!;
    const merchant = applyCommand(
      rich('merchants', 12),
      {
        type: 'purchaseShip',
        by: 'merchants',
        shipClass: 'transport',
        at: terra.hex,
        side: hexSide(terra.hex, 0),
      },
      map,
    );
    expect(merchant.result.ok).toBe(true);
    expect(merchant.state.players['merchants']!.points).toBe(4);
  });

  it('gives the Patrol the win for destroying the pirate fleet, and the Merchant too at four hulls', () => {
    // "If the Patrol destroys the pirate fleet, it wins; the Merchant also wins at
    //  that time if they have at least 4 ships."
    const s0 = build('piracy');
    const sunk: GameState = {
      ...s0,
      ships: Object.fromEntries(
        Object.entries(s0.ships).map(([id, x]) => [
          id,
          x.owner === 'pirates' ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
    };
    expect(checkScenarioVictory(sunk)?.winners).toEqual(['patrol']);

    const merchant = ships(s0, 'merchants')[0]!;
    const grown: GameState = {
      ...sunk,
      ships: {
        ...sunk.ships,
        m3: { ...merchant, id: 'm3' },
        m4: { ...merchant, id: 'm4' },
      },
    };
    expect(new Set(checkScenarioVictory(grown)?.winners)).toEqual(new Set(['patrol', 'merchants']));
  });

  it('gives the Merchant the win at six hulls, or twice the Pirate’s, whichever is greater', () => {
    // "If the Merchant fleet reaches 6 ships, or twice as many as the Pirate has
    //  (whichever is greater), the Merchant wins. The Patrol also wins a marginal
    //  victory if the Merchant wins."
    const s0 = build('piracy');
    const merchant = ships(s0, 'merchants')[0]!;
    const withHulls = (n: number): GameState => ({
      ...s0,
      ships: {
        ...s0.ships,
        ...Object.fromEntries(
          Array.from({ length: n - 2 }, (_, i) => [`extra${i}`, { ...merchant, id: `extra${i}` }]),
        ),
      },
    });
    // Two pirates are flying, so the bar is max(6, 4) = 6.
    expect(checkScenarioVictory(withHulls(5))).toBe(null);
    const won = checkScenarioVictory(withHulls(6));
    expect({ winners: new Set(won?.winners), level: won?.level }).toEqual({
      winners: new Set(['merchants', 'patrol']),
      level: 'marginal',
    });
  });

  it('lets the Pirates win by wiping out either fleet', () => {
    // "The Pirates may win either by wiping out either of the other fleets, or by
    //  scoring 8 points in a single trade cycle."
    //
    // Only the first half is exercised. The second needs the delivery cycle —
    // "once a planet has received a cargo, it may not get another cargo until all
    // worlds have received a cargo in that cycle" — which nothing implements, so
    // `pirateCyclePoints` is written by no production code and a test that set it
    // by hand would be testing its own fixture. Recorded in
    // docs/RULES-MAPPING.md under Known gaps.
    const s0 = build('piracy');
    const wipe = (owner: string): GameState => ({
      ...s0,
      ships: Object.fromEntries(
        Object.entries(s0.ships).map(([id, x]) => [
          id,
          x.owner === owner ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
    });
    expect(checkScenarioVictory(wipe('patrol'))?.winners).toEqual(['pirates']);
    expect(checkScenarioVictory(wipe('merchants'))?.winners).toEqual(['pirates']);
  });
});

// ---------------------------------------------------------------------------
// Nova (p. 11)
// ---------------------------------------------------------------------------

describe('Nova (p. 11)', () => {
  it('fields fifty combat points for each bloc', () => {
    // "Both the EastBloc and the WestBloc players select fleets of 50 combat
    //  points each." Commercial D-strengths cost half: "a liner costs 1 point, a
    //  transport or tanker costs 1/2 point."
    const s = build('nova');
    expect(combatPoints(s, 'westbloc')).toBe(50);
    expect(combatPoints(s, 'eastbloc')).toBe(50);
  });

  it('splits Terra three adjacent hexsides each and gives each bloc one Luna hexside', () => {
    // "The EastBloc selects three adjacent Terran hexsides; the WestBloc gets the
    //  other three. The WestBloc then selects one Luna hex side as a moon colony;
    //  the EastBloc then selects any other Luna hex side as its moon colony."
    const s = build('nova');
    const sidesFor = (body: string, owner: string): number[] =>
      basesInUse(s)
        .filter((b) => baseBody(b.id) === body && b.owner === owner)
        .map((b) => b.side!.dir)
        .sort((a, b) => a - b);

    const east = sidesFor('terra', 'eastbloc');
    const west = sidesFor('terra', 'westbloc');
    expect(east).toHaveLength(3);
    expect(west).toHaveLength(3);
    expect([...east, ...west].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    const adjacent = (dirs: number[]): boolean =>
      [0, 1, 2, 3, 4, 5].some((start) => [0, 1, 2].every((k) => dirs.includes((start + k) % 6)));
    expect({ east: adjacent(east), west: adjacent(west) }).toEqual({ east: true, west: true });

    const lunaEast = sidesFor('luna', 'eastbloc');
    const lunaWest = sidesFor('luna', 'westbloc');
    expect({ east: lunaEast.length, west: lunaWest.length }).toEqual({ east: 1, west: 1 });
    expect(lunaEast[0]).not.toBe(lunaWest[0]);
  });

  it('rolls one farther colony each, from the printed table, with a single base and no ties', () => {
    // "each side rolls one die to determine where their farther colony is
    //  located: 1=Venus, 2=Mars, 3=Ceres, 4=Callisto, 5=Clandestine, and
    //  6=Mercury. The colony has only one base... If both sides roll the same
    //  number, both roll again."
    const table = ['venus', 'mars', 'ceres', 'callisto', 'clandestine', 'mercury'];
    for (let seed = 1; seed <= 25; seed++) {
      const s = build('nova', seed);
      const colonyOf = (owner: string): string[] =>
        basesInUse(s)
          .filter(
            (b) => b.owner === owner && baseBody(b.id) !== 'terra' && baseBody(b.id) !== 'luna',
          )
          .map((b) => baseBody(b.id));
      const west = colonyOf('westbloc');
      const east = colonyOf('eastbloc');
      expect({ seed, west: west.length, east: east.length }).toEqual({ seed, west: 1, east: 1 });
      expect(table).toContain(west[0]);
      expect(table).toContain(east[0]);
      expect({ seed, tied: west[0] === east[0] }).toEqual({ seed, tied: false });
    }
  });

  it('sends four alien corsairs in over the map edge at one hex per turn, detected at once', () => {
    // "The Alien invader receives a fleet of four corsairs... they may enter at
    //  any point along the map edge closest to Jupiter at a speed of one hex per
    //  turn. They are detected immediately."
    //
    // Which edge is *closest to Jupiter* is not asserted: the entry arc the
    // engine picks sits 11-14 hexes from Jupiter where the nearest rim hex is 7,
    // and that is recorded in docs/RULES-MAPPING.md rather than smuggled in
    // under a test name that suggests it holds.
    const s = build('nova');
    const aliens = ships(s, 'alien');
    expect(aliens).toHaveLength(4);
    for (const alien of aliens) {
      const outward = { q: alien.pos.q - alien.velocity.q, r: alien.pos.r - alien.velocity.r };
      expect({
        id: alien.id,
        cls: alien.shipClass,
        speed: speed(alien.velocity),
        onChart: map.inBounds(alien.pos),
        cameFromOffChart: map.inBounds(outward),
        detected: [...alien.detectedBy].sort(),
      }).toEqual({
        id: alien.id,
        cls: 'corsair',
        speed: 1,
        onChart: true,
        cameFromOffChart: false,
        detected: ['eastbloc', 'westbloc'],
      });
    }
  });

  it('loads every alien with a full hold of mines and a nova bomb that costs no capacity', () => {
    // "Each one carries a nova bomb and automatically activates it if it reaches
    //  orbit around Sol... Nova bombs do not use any cargo capacity." / "Alien
    //  ships begin with a full load of mines but cannot resupply or refuel."
    const s = build('nova');
    const bombs = new Set(s.scenarioData['novaBombs'] as string[]);
    for (const alien of ships(s, 'alien')) {
      expect({
        id: alien.id,
        // A corsair's hold is ten tons, which is exactly one mine: the bomb
        // cannot be taking any of it.
        holdFullOfMines: cargoMassOf(alien) === SHIP_CLASSES.corsair.cargoCapacity,
        mines: alien.cargo.every((c) => c.kind === 'mine'),
        bomb: bombs.has(alien.id),
      }).toEqual({ id: alien.id, holdFullOfMines: true, mines: true, bomb: true });
    }
    // "note that aliens will not surrender."
    expect(s.scenarioData['noSurrender']).toEqual(['alien']);
  });

  it('lets no alien resupply or refuel anywhere on the chart', () => {
    // "Resupply is available at friendly bases... Alien ships begin with a full
    //  load of mines but cannot resupply or refuel." Not even at the bases no
    //  bloc has claimed, which serve everyone else.
    const s0 = build('nova');
    const alien = ships(s0, 'alien')[0]!;
    for (const base of basesInUse(s0)) {
      const parked =
        base.side !== undefined
          ? patch(s0, alien.id, {
              pos: base.side.hex,
              velocity: { q: 0, r: 0 },
              pendingGravity: { q: 0, r: 0 },
              optionalGravity: [],
              location: { kind: 'landed', side: base.side },
              fuel: 1,
            })
          : patch(s0, alien.id, {
              pos: base.hex,
              velocity: { q: 0, r: 0 },
              pendingGravity: { q: 0, r: 0 },
              optionalGravity: [],
              location: { kind: 'asteroidBase', hex: base.hex },
              fuel: 1,
            });
      const check = canResupplyAt(parked, parked.ships[alien.id]!, map);
      expect({ base: base.id, resupplies: check.ok }).toEqual({ base: base.id, resupplies: false });
    }
  });

  it('hands the Aliens the game the moment a nova bomb reaches orbit around Sol', () => {
    // "The Alien force wins, permanently and decisively, by successfully
    //  activating a nova bomb while in orbit around the sun." / "Each one carries
    //  a nova bomb and automatically activates it if it reaches orbit around Sol."
    const s0 = build('nova');
    const sol = map.body('sol')!;
    const from = neighbor(sol.hex, 0);
    const to = neighbor(sol.hex, 1);
    const alien = ships(s0, 'alien')[0]!;
    const s = patch(s0, alien.id, { pos: to, velocity: sub(to, from) });
    expect(checkScenarioVictory(s)).toEqual({
      winners: ['alien'],
      level: 'decisive',
      reason: expect.any(String),
    });
  });

  it('hands a bloc the game when the last alien ship is gone', () => {
    // "The EastBloc or the WestBloc wins by capturing or destroying the last
    //  Alien ship (note that aliens will not surrender)." / "When one player wins,
    //  both others lose."
    const s0 = build('nova');
    const s: GameState = {
      ...s0,
      ships: Object.fromEntries(
        Object.entries(s0.ships).map(([id, x]) => [
          id,
          x.owner === 'alien' ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
    };
    const v = checkScenarioVictory(s);
    expect({ decided: v !== null, aliensWin: v?.winners.includes('alien') ?? true }).toEqual({
      decided: true,
      aliensWin: false,
    });
  });

  it('leaves every printed base on the chart, since Nova never says otherwise', () => {
    // "All bases marked on the map are assumed to be in use unless a scenario
    //  indicates differently" (p. 7). Nova says only that "The colony has only
    //  one base", which fixes what a bloc *owns*, not what exists. The aliens are
    //  kept off the unclaimed ones by the clause that says so — "Alien ships...
    //  cannot resupply or refuel" — not by deleting the bases.
    const s = build('nova', 1);
    const printed = build('bi-planetary', 1);
    expect(
      basesInUse(s)
        .map((b) => b.id)
        .sort(),
    ).toEqual(
      basesInUse(printed)
        .map((b) => b.id)
        .sort(),
    );
  });

  it('a colony on a world is a planetary base, and planetary bases have defences', () => {
    // "Planetary Bases: Bases on planets and satellites are called planetary
    //  bases, and serve as a source of detector fields (p. 8) and planetary
    //  defense fire, as well as providing fuel and maintenance." (p. 7)
    //
    // Nova says nothing about planetary defences. The rulebook is explicit when a
    // scenario switches them off — Escape's "Planetary defenses are not
    // operating", Fleet Mutiny's "Planetary defenses are not in operation",
    // Retribution's "only the bases at Terra and Luna have planetary defenses" —
    // and Nova does none of that. `nova.ts` nonetheless passes
    // `defences: ['terra', 'luna']`, so a bloc whose farther colony lands on
    // Venus, Mars, Mercury or Callisto gets a base that cannot shoot at the alien
    // corsair passing overhead. (Ceres and Clandestine are asteroid bases and
    // correctly have none: "They serve the ordinary functions of a base but do
    // not have planetary defenses.")
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = build('nova', seed);
      for (const base of basesInUse(s)) {
        const body = baseBody(base.id);
        if (body === 'terra' || body === 'luna') continue;
        if (base.kind !== 'planetary') continue;
        checked++;
        expect({ seed, base: base.id, defences: base.hasPlanetaryDefences }).toEqual({
          seed,
          base: base.id,
          defences: true,
        });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Retribution (pp. 11-12)
// ---------------------------------------------------------------------------

describe('Retribution (pp. 11-12)', () => {
  it('puts two Enforcer corsairs in orbit around different planets and a frigate on Luna', () => {
    // "The Enforcers receive two corsairs, each in orbit around a different planet
    //  selected by the player, and one frigate on a base at Luna."
    const s = build('retribution');
    const enforcers = ships(s, 'enforcers');
    const corsairs = enforcers.filter((x) => x.shipClass === 'corsair');
    expect(corsairs).toHaveLength(2);
    const worlds = corsairs.map(orbiting);
    expect(worlds.every((w) => w !== null)).toBe(true);
    expect(new Set(worlds).size).toBe(2);
    for (const w of worlds) expect(map.body(w!)!.kind).toBe('planet');

    const frigates = enforcers.filter((x) => x.shipClass === 'frigate');
    expect(frigates).toHaveLength(1);
    expect(landedOn(frigates[0]!)).toBe('luna');
    expect(enforcers).toHaveLength(3);
  });

  it('releases the Sons of Liberty’s corvettes one at a time, never at Luna, Ceres or Terra', () => {
    // "The Sons of Liberty receive a total of ten corvettes (red, white, and blue
    //  counters) one at a time. A corvette does not appear until the previous one
    //  has accomplished its mission or been destroyed. Corvettes may appear at any
    //  base except Luna, Ceres, or Terra."
    const s = build('retribution');
    const rebels = ships(s, 'sons-of-liberty');
    expect(rebels).toHaveLength(1);
    expect(rebels[0]!.shipClass).toBe('corvette');
    const where = orbiting(rebels[0]!) ?? landedOn(rebels[0]!) ?? stoppedAt(rebels[0]!);
    expect(['luna', 'ceres', 'terra']).not.toContain(where);

    // Every one of the ten, across the whole run: the exclusion is a rule about
    // where a corvette may appear, not a fact about the opening position.
    let cur: GameState = s;
    const seen = new Set<string>([where!]);
    for (let i = 0; i < 9; i++) {
      const flying = live(cur, 'sons-of-liberty')[0];
      if (flying) cur = patch(cur, flying.id, { destroyed: true, destroyedBy: 'gunfire' });
      cur = turns(cur, 1);
      const next = live(cur, 'sons-of-liberty');
      expect(next).toHaveLength(1);
      expect(next[0]!.shipClass).toBe('corvette');
      seen.add(orbiting(next[0]!) ?? landedOn(next[0]!) ?? stoppedAt(next[0]!)!);
    }
    for (const world of seen) expect(['luna', 'ceres', 'terra']).not.toContain(world);
    expect(ships(cur, 'sons-of-liberty')).toHaveLength(10);
  });

  it('sends the next corvette out once the last one is destroyed, and ends when all ten are gone', () => {
    // "The Sons of Liberty receive a total of ten corvettes... one at a time. A
    //  corvette does not appear until the previous one has accomplished its
    //  mission or been destroyed." / "The Enforcers win by staying alive. They
    //  receive promotions and extra leave in Paris if they destroy the rebels."
    const s0 = build('retribution');
    const first = ships(s0, 'sons-of-liberty')[0]!;
    const shotDown = patch(s0, first.id, { destroyed: true, destroyedBy: 'gunfire' });

    const later = turns(shotDown, 1);
    const reinforcement = live(later, 'sons-of-liberty');
    expect({
      corvettesFlying: reinforcement.length,
      cls: reinforcement[0]?.shipClass ?? null,
    }).toEqual({ corvettesFlying: 1, cls: 'corvette' });

    // Only after the previous one is gone: while it still flies, nobody else comes.
    expect(live(turns(later, 3), 'sons-of-liberty')).toHaveLength(1);

    // And the rebellion can actually be spent, which is what the Enforcer win
    // is gated on. Shoot each corvette down as it appears.
    let cur = later;
    for (let i = 0; i < 12 && cur.victory === null; i++) {
      for (const rebel of live(cur, 'sons-of-liberty')) {
        cur = patch(cur, rebel.id, { destroyed: true, destroyedBy: 'gunfire' });
      }
      cur = turns(cur, 1);
    }
    // Read off the state, not by calling the checker: the point is that the
    // reducer declares the winner on its own, without anybody asking.
    expect(cur.victory?.winners).toEqual(['enforcers']);
  });

  it('declares the winner through the reducer, without anybody calling the checker', () => {
    // The wiring, not the condition. Every scenario's `checkVictory` was written,
    // exported and tested by direct call for a long time while nothing had
    // registered it with the reducer — so no game ever ended on its own. Calling
    // the function proves the function; only playing a game proves the wiring.
    const s0 = build('retribution');
    let cur = s0;
    for (const rebel of live(cur, 'sons-of-liberty')) {
      cur = patch(cur, rebel.id, { destroyed: true, destroyedBy: 'gunfire' });
    }
    for (const boss of live(cur, 'enforcers')) {
      cur = patch(cur, boss.id, { destroyed: true, destroyedBy: 'gunfire' });
    }
    expect(cur.victory).toBeNull();
    // "The Sons of Liberty win by destroying the Enforcer fleet."
    const out = run(cur, { type: 'endPhase', by: cur.playerOrder[cur.activePlayerIndex]! });
    expect(out.ok).toBe(true);
    expect(out.state.victory?.winners).toEqual(['sons-of-liberty']);
  });

  it('gives the Enforcers every base but Clandestine, with defences only on Terra and Luna', () => {
    // "The Enforcers have all bases on the map with the exception of Clandestine,
    //  but only the bases at Terra and Luna have planetary defenses." — and
    // "Because the Sons of Liberty own the base at Clandestine, they treat the
    //  special asteroids as ordinary asteroids."
    const s = build('retribution');
    for (const base of basesInUse(s)) {
      const body = baseBody(base.id);
      expect({ base: base.id, owner: base.owner }).toEqual({
        base: base.id,
        owner: body === 'clandestine' ? 'sons-of-liberty' : 'enforcers',
      });
      expect({ base: base.id, defences: base.hasPlanetaryDefences }).toEqual({
        base: base.id,
        defences: body === 'terra' || body === 'luna',
      });
    }
  });

  it('is won by the Sons of Liberty when the Enforcer fleet is destroyed', () => {
    // "The Sons of Liberty win by destroying the Enforcer fleet, and, as a result,
    //  freeing Terra."
    const s0 = build('retribution');
    const s: GameState = {
      ...s0,
      ships: Object.fromEntries(
        Object.entries(s0.ships).map(([id, x]) => [
          id,
          x.owner === 'enforcers' ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
    };
    expect(checkScenarioVictory(s)?.winners).toEqual(['sons-of-liberty']);
  });

  it('punishes twelve turns of hiding, on either side', () => {
    // "If the Enforcers hide, keeping their ships grounded for 12 or more turns,
    //  then the Sons of Liberty win is automatic." / "If the rebels are indecisive
    //  and ground their fleet for at least 12 turns, the rebellion has failed and
    //  the Enforcers win."
    const s0 = build('retribution');

    let grounded = s0;
    for (const corsair of ships(s0, 'enforcers').filter((x) => x.shipClass === 'corsair')) {
      grounded = putOnBase(grounded, corsair.id, 'mars', 0);
    }
    // "12 or more turns" of hiding, counted from the last leg anybody flew. The
    // rulebook does not fix the origin of the count, so the boundary itself is
    // an implementation choice and is not pinned here — well short of the limit
    // nobody has won, and well past it the rebellion carries.
    expect(checkScenarioVictory({ ...grounded, turn: 10 })).toBe(null);
    expect(checkScenarioVictory({ ...grounded, turn: 15 })?.winners).toEqual(['sons-of-liberty']);

    // The mirror: the Enforcers stay in orbit, the rebel sits on a base.
    const rebel = ships(s0, 'sons-of-liberty')[0]!;
    const idle = putOnBase(s0, rebel.id, 'venus', 0);
    expect(checkScenarioVictory({ ...idle, turn: 15 })?.winners).toEqual(['enforcers']);
  });

  it('torpedoes and mines are available only to the Enforcers, and only from Terran bases', () => {
    // "Torpedoes and mines are available only to the Enforcers, but also only from
    //  Terran bases."
    //
    // Nothing reads `scenarioData.ordnanceSources` / `ordnanceDeniedTo`. Every
    // base in the game — "All bases (planetary, asteroid, and orbital) carry an
    // unlimited supply of fuel, mines, and torpedoes" — rearms whoever can reach
    // it, so an Enforcer corsair arms a mine at Venus and a rebel warship arms one
    // at Clandestine, which the Sons of Liberty own.
    const s0 = build('retribution');

    const enforcerAtVenus = at(
      putOnBase(s0, 'enforcer-corsair-1', 'venus', 0),
      'resupply',
      'enforcers',
    );
    const offWorld = run(enforcerAtVenus, {
      type: 'resupply',
      by: 'enforcers',
      ship: 'enforcer-corsair-1',
      loadout: [{ kind: 'mine', quantity: 1 }],
    });
    expect({ enforcerArmsAwayFromTerra: offWorld.ok }).toEqual({
      enforcerArmsAwayFromTerra: false,
    });

    const clandestine = map.body('clandestine')!;
    const rebel = ships(s0, 'sons-of-liberty')[0]!;
    const atBase = patch(s0, rebel.id, {
      shipClass: 'corsair',
      pos: clandestine.hex,
      velocity: { q: 0, r: 0 },
      pendingGravity: { q: 0, r: 0 },
      optionalGravity: [],
      location: { kind: 'asteroidBase', hex: clandestine.hex },
      fuel: 1,
    });
    const rebelTurn = at(atBase, 'resupply', 'sons-of-liberty');
    const armed = run(rebelTurn, {
      type: 'resupply',
      by: 'sons-of-liberty',
      ship: rebel.id,
      loadout: [{ kind: 'mine', quantity: 1 }],
    });
    expect({ rebelArms: armed.ok }).toEqual({ rebelArms: false });
  });
});

// ---------------------------------------------------------------------------
// Fleet Mutiny (p. 12)
// ---------------------------------------------------------------------------

describe('Fleet Mutiny (p. 12)', () => {
  it('deploys twelve ships and two orbital bases, none closer than three hexes to another', () => {
    // "The Empire chooses a fleet of 12 ships and 2 orbital bases (using red,
    //  white, and blue counters). These may be placed anywhere on the map, but no
    //  ship may be closer than three hexes to any other."
    for (const seed of [1, 7, 42, 20370101]) {
      const s = build('fleet-mutiny', seed);
      const all = ships(s);
      const orbitalBases = all.filter((x) => x.shipClass === 'orbitalBase');
      expect({ seed, counters: all.length, orbitalBases: orbitalBases.length }).toEqual({
        seed,
        counters: 14,
        orbitalBases: 2,
      });
      // "no *ship* may be closer than three hexes to any other" — p. 1 lists
      // "nine different types of ship, plus orbital bases", so a base is not
      // one of them; the spacing is checked over the hulls.
      const hulls = all.filter((x) => x.shipClass !== 'orbitalBase');
      for (let i = 0; i < hulls.length; i++) {
        for (let j = i + 1; j < hulls.length; j++) {
          const gap = distance(hulls[i]!.pos, hulls[j]!.pos);
          expect({ seed, pair: `${hulls[i]!.id}/${hulls[j]!.id}`, close: gap < 3 }).toEqual({
            seed,
            pair: `${hulls[i]!.id}/${hulls[j]!.id}`,
            close: false,
          });
        }
      }
      // "Vessels in gravity hexes may be assumed to be in orbit."
      for (const ship of all) {
        if (map.gravityAt(ship.pos).length === 0) continue;
        if (ship.shipClass === 'orbitalBase') continue;
        expect({ seed, ship: ship.id, inOrbit: orbiting(ship) !== null }).toEqual({
          seed,
          ship: ship.id,
          inOrbit: true,
        });
      }
    }
  });

  it('starts every base under the Empire with the planetary defences switched off', () => {
    // "All bases begin under the control of the Empire. Planetary defenses are not
    //  in operation."
    const s = build('fleet-mutiny');
    for (const base of basesInUse(s)) {
      expect({ base: base.id, owner: base.owner, defences: base.hasPlanetaryDefences }).toEqual({
        base: base.id,
        owner: 'empire',
        defences: false,
      });
    }
  });

  it('designates five units and keeps only the sixes loyal', () => {
    // "The Rebel player designates five ships and/or orbital bases, and rolls a
    //  die for each one. On a roll of 6, the ship does not rebel. Otherwise it
    //  becomes part of the starting Rebel force."
    let designated = 0;
    let basesEverDesignated = 0;
    for (let seed = 1; seed <= 240; seed++) {
      const s = build('fleet-mutiny', seed);
      const data = s.scenarioData['fleetMutiny'] as Record<string, string[]>;
      const picked = data['designated']!;
      expect({ seed, picked: picked.length }).toEqual({ seed, picked: 5 });
      expect(new Set(picked).size).toBe(5);
      expect([...data['suborned']!, ...data['stayedLoyal']!].sort()).toEqual([...picked].sort());
      // Only the designated may change sides.
      for (const ship of ships(s, 'rebels')) expect(picked).toContain(ship.id);
      designated += picked.length;
      if (picked.some((id) => id.includes('orbital'))) basesEverDesignated++;
    }
    expect(designated).toBe(240 * 5);
    // "...five ships AND/OR orbital bases."
    expect(basesEverDesignated).toBeGreaterThan(0);
  });

  it('counts Terran hexsides: four for the Rebel, three for a marginal Empire win', () => {
    // "The Empire wins decisively if all Rebel ships and bases are eliminated and
    //  fewer than three Terran hexsides have been suppressed. The win is marginal
    //  if exactly three Terran hexsides have been suppressed. The Rebel wins
    //  decisively by suppressing at least four Terran hexsides, and loses
    //  otherwise."
    const s0 = build('fleet-mutiny');
    const terra = map.body('terra')!;
    const suppress = (s: GameState, n: number): GameState => ({
      ...s,
      scenarioData: {
        ...s.scenarioData,
        [SUPPRESSED_SIDES_KEY]: Array.from({ length: n }, (_, d) => sideKey(hexSide(terra.hex, d))),
      },
    });
    const crushRebellion = (s: GameState): GameState => ({
      ...s,
      ships: Object.fromEntries(
        Object.entries(s.ships).map(([id, x]) => [
          id,
          x.owner === 'rebels' ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
      bases: Object.fromEntries(
        Object.entries(s.bases).map(([id, b]) => [
          id,
          b.owner === 'rebels' ? { ...b, owner: 'empire' } : b,
        ]),
      ),
    });

    expect(checkScenarioVictory(suppress(s0, 4))).toEqual({
      winners: ['rebels'],
      level: 'decisive',
      reason: expect.any(String),
    });
    // Three is not enough on its own — the mutiny has to be alive or dead first.
    expect(checkScenarioVictory(suppress(s0, 3))).toBe(null);
    expect(checkScenarioVictory(crushRebellion(suppress(s0, 3)))).toEqual({
      winners: ['empire'],
      level: 'marginal',
      reason: expect.any(String),
    });
    expect(checkScenarioVictory(crushRebellion(suppress(s0, 2)))).toEqual({
      winners: ['empire'],
      level: 'decisive',
      reason: expect.any(String),
    });
  });

  it('an orbital base stays in its gravity hex — it does not literally orbit', () => {
    // "In a gravity hex of a planet or satellite. The ship carrying the base must
    //  be in orbit to emplace the base. The base remains in that gravity hex; it
    //  does not literally orbit." (p. 7)
    //
    // `fleetMutiny.ts` stations both orbital bases with `orbitAtHex`, which hands
    // them a one-hex velocity and the pull to match, so the counters walk round
    // Sol and Jupiter for ever — they have no fuel with which to stop. Their
    // `BaseState` records stay behind in the hex where they were placed, so from
    // turn 2 the base and its own 16-strength counter are in different hexes, and
    // `logistics.orbitalBaseCounter` can no longer pair them: the base resupplies
    // a ship on the same turn its guns fire, which is exactly what "An orbital
    // base resupplying any ship may not fire its guns or launch ordnance during
    // that player-turn" forbids.
    for (const seed of [20370101, 42]) {
      const s0 = build('fleet-mutiny', seed);
      const stations = new Map(
        Object.values(s0.bases)
          .filter((b) => b.kind === 'orbital')
          .map((b) => [b.id, key(b.hex)]),
      );
      expect(stations.size).toBe(2);

      const later = turns(s0, 3);
      for (const [id, where] of stations) {
        expect({ seed, id, hex: key(later.ships[id]!.pos) }).toEqual({ seed, id, hex: where });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Interplanetary War (p. 12)
// ---------------------------------------------------------------------------

describe('Interplanetary War (p. 12)', () => {
  it('buys the Terran fleet with MCr 1600 and the Rebel fleet with MCr 1000', () => {
    // "The Terran player selects a fleet using the MegaCredit system and an
    //  allowance of MCr 1600." / "The Rebel player selects a fleet using an
    //  allowance of MCr 1000." / "In addition to ships, mines, torpedoes, and
    //  nukes may be purchased by the players and stockpiled on ships or on bases."
    const s = build('interplanetary-war');
    // The printed allowances, spent to the MegaCredit: an under-spent fleet is
    // as much a failure to model the clause as an over-spent one.
    expect({ terra: megaCreditValue(s, 'terra'), rebels: megaCreditValue(s, 'rebels') }).toEqual({
      terra: 1600,
      rebels: 1000,
    });
    // The allowance is spent on the fleet, so the treasuries open empty.
    expect(s.players['terra']!.megacredits).toBe(0);
    expect(s.players['rebels']!.megacredits).toBe(0);
    // Nukes are the only thing that devastates a hexside, and the Rebel win is
    // written in devastated hexsides.
    expect(s.options.nukesAllowed).toBe(true);
  });

  it('places each fleet only at its own worlds', () => {
    // "Terran ships may be placed on – or in orbit around – Terra, Luna, and
    //  Venus, or stationary in space within detector range of those worlds." /
    // "Rebel ships may be placed on – or in orbit around – Callisto (the Rebel
    //  home world), Io, Ganymede, and Mars, or stationary in space within detector
    //  range of those worlds."
    const s = build('interplanetary-war');
    const allowed: Record<string, string[]> = {
      terra: ['terra', 'luna', 'venus'],
      rebels: ['callisto', 'io', 'ganymede', 'mars'],
    };
    for (const owner of ['terra', 'rebels']) {
      for (const ship of ships(s, owner)) {
        const home = landedOn(ship) ?? orbiting(ship);
        expect({
          owner,
          ship: ship.id,
          home,
          legal: home !== null && allowed[owner]!.includes(home),
        }).toEqual({
          owner,
          ship: ship.id,
          home,
          legal: true,
        });
      }
    }
    // Each side controls the bases at its own worlds.
    for (const base of basesInUse(s)) {
      const body = baseBody(base.id);
      if (allowed['terra']!.includes(body)) expect(base.owner).toBe('terra');
      else if (allowed['rebels']!.includes(body)) expect(base.owner).toBe('rebels');
    }
  });

  it('masses a MegaCredit at one ton of cargo space', () => {
    // "...they may only be transported in commercial ships; each MCr requires one
    //  ton of cargo space."
    //
    // Only the mass is checked, because only the mass is implemented: the
    // obligation itself — "The Terran player must physically transport all MCr to
    // Terra before they may be used" — has no mechanism behind it, and no command
    // can put MegaCredits in a hold in the first place. See
    // docs/RULES-MAPPING.md.
    expect(CARGO.megacredits.mass).toBe(1);
  });

  it('is won by the Rebel on three Terran hexsides and one on Luna', () => {
    // "The Rebel player wins if three or more Terran hexsides and one Luna Hexside
    //  have been devastated."
    const s0 = build('interplanetary-war');
    const terra = map.body('terra')!;
    const luna = map.body('luna')!;
    const devastate = (terraSides: number, lunaSides: number): GameState => ({
      ...s0,
      devastatedSides: [
        ...Array.from({ length: terraSides }, (_, d) => sideKey(hexSide(terra.hex, d))),
        ...Array.from({ length: lunaSides }, (_, d) => sideKey(hexSide(luna.hex, d))),
      ],
    });
    expect(checkScenarioVictory(devastate(3, 0))).toBe(null);
    expect(checkScenarioVictory(devastate(2, 1))).toBe(null);
    expect(checkScenarioVictory(devastate(3, 1))?.winners).toEqual(['rebels']);
  });

  it('is won decisively by Terra only if no Terran hexside was devastated', () => {
    // "The Terran player wins decisively if the Rebel fleet is destroyed. That
    //  victory is reduced to marginal if any Terran hexside has been devastated."
    const s0 = build('interplanetary-war');
    const terra = map.body('terra')!;
    const rebelFleetGone: GameState = {
      ...s0,
      ships: Object.fromEntries(
        Object.entries(s0.ships).map(([id, x]) => [
          id,
          x.owner === 'rebels' ? { ...x, destroyed: true, destroyedBy: 'gunfire' } : x,
        ]),
      ),
    };
    expect(checkScenarioVictory(rebelFleetGone)).toEqual({
      winners: ['terra'],
      level: 'decisive',
      reason: expect.any(String),
    });
    const scarred: GameState = {
      ...rebelFleetGone,
      devastatedSides: [sideKey(hexSide(terra.hex, 2))],
    };
    expect(checkScenarioVictory(scarred)?.level).toBe('marginal');
  });

  it('pays each player MCr 0.1 a turn for every base they hold', () => {
    // "Each player controls bases which can produce replacement spacecraft and
    //  ordnance. Each base generates MCr 0.1 per turn."
    //
    // Measured as a rate across one game turn rather than as a running total
    // from turn 1: the rulebook fixes how much a base pays and how often, not
    // when in the turn it is booked.
    const s0 = build('interplanetary-war');
    const held = (s: GameState, owner: string): number =>
      basesInUse(s).filter((b) => b.owner === owner).length;
    expect(held(s0, 'terra')).toBeGreaterThan(0);

    const before = turns(s0, 3);
    const after = turns(before, 1);
    expect(after.turn - before.turn).toBe(1);
    for (const owner of ['terra', 'rebels']) {
      const earned = after.players[owner]!.megacredits - before.players[owner]!.megacredits;
      expect({ owner, earned: Math.round(earned * 100) / 100 }).toEqual({
        owner,
        earned: Math.round(held(before, owner) * 0.1 * 100) / 100,
      });
    }
  });

  it('commissions ships only on a world the player controls', () => {
    // "Ships appear immediately on any world controlled by the player." Mercury,
    // Ceres and Clandestine "take no side in this war" — an unowned base serves
    // anyone's fuel pumps, but it is nobody's shipyard.
    const s0 = build('interplanetary-war');
    const rich: GameState = {
      ...s0,
      phase: 'resupply',
      players: { ...s0.players, terra: { ...s0.players['terra']!, megacredits: 500 } },
    };
    const buy = (bodyId: string, dir: number) => {
      const body = map.body(bodyId)!;
      return run(rich, {
        type: 'purchaseShip',
        by: 'terra',
        shipClass: 'corvette',
        at: body.hex,
        side: hexSide(body.hex, dir),
      });
    };
    expect(buy('terra', 0).ok).toBe(true);
    expect(buy('mercury', 0)).toMatchObject({ ok: false, why: expect.stringMatching(/control/i) });
    // A world the *enemy* holds is no better.
    expect(buy('mars', 0)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Prospecting (p. 13)
// ---------------------------------------------------------------------------

describe('Prospecting (p. 13)', () => {
  it('starts every player with MCr 25, spent or in hand', () => {
    // "Each player begins the scenario with MCr 25. With that, ships and equipment
    //  must be purchased (only freighters and packets are available; all new ships
    //  start with a full fuel load)."
    for (const seats of [2, 3, 5]) {
      const s = buildScenario('prospecting', {
        playerNames: Array.from({ length: seats }, (_, i) => `P${i + 1}`),
      });
      expect(s.playerOrder).toHaveLength(seats);
      for (const id of s.playerOrder) {
        // Net worth counts "all property at full purchase value", so the opening
        // position — hull, equipment and cash — must come to the allowance exactly.
        expect({ id, worth: prospectorWorth(s, id) }).toEqual({ id, worth: 25 });
      }
      for (const ship of ships(s)) {
        expect(['transport', 'packet']).toContain(ship.shipClass);
        expect(ship.fuel).toBe(SHIP_CLASSES[ship.shipClass].fuelCapacity);
      }
    }
  });

  it('sells nothing but freighters and packets', () => {
    // "only freighters and packets are available"
    const s0 = build('prospecting');
    const buyer = s0.playerOrder[0]!;
    const ceres = map.body('ceres')!;
    const rich: GameState = {
      ...s0,
      players: { ...s0.players, [buyer]: { ...s0.players[buyer]!, megacredits: 1000 } },
    };
    const s = at(rich, 'resupply', buyer);
    for (const cls of [
      'corvette',
      'corsair',
      'frigate',
      'dreadnaught',
      'liner',
      'tanker',
    ] as const) {
      const out = run(s, { type: 'purchaseShip', by: buyer, shipClass: cls, at: ceres.hex });
      expect({ cls, sold: out.ok }).toEqual({ cls, sold: false });
    }
    for (const cls of ['transport', 'packet'] as const) {
      const out = run(s, { type: 'purchaseShip', by: buyer, shipClass: cls, at: ceres.hex });
      expect({ cls, sold: out.ok, why: out.why }).toEqual({ cls, sold: true, why: undefined });
    }
  });

  it('pays MCr 2 a ton for ore at Ceres and MCr 3 at Luna, and 100 or 200 for a shard', () => {
    // "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton). CT
    //  shards sell for MCr 100 at Ceres or MCr 200 at Luna."
    const s0 = build('prospecting');
    const seller = ships(s0)[0]!;
    const withCargo = (s: GameState): GameState =>
      patch(s, seller.id, {
        cargo: [
          { kind: 'ore', quantity: 4 },
          { kind: 'ctShard', quantity: 1 },
        ],
      });
    const opening = s0.players[seller.owner]!.megacredits;

    const atCeres = withCargo(s0);
    const ceres = logistics.sellCargo(atCeres, seller.id, ['ore', 'ctShard'], map);
    expect(ceres.result.ok).toBe(true);
    expect(ceres.state.players[seller.owner]!.megacredits).toBeCloseTo(opening + 4 * 2 + 100, 5);

    const onLuna = withCargo(putOnBase(s0, seller.id, 'luna', 0));
    const luna = logistics.sellCargo(onLuna, seller.id, ['ore', 'ctShard'], map);
    expect(luna.result.ok).toBe(true);
    expect(luna.state.players[seller.owner]!.megacredits).toBeCloseTo(opening + 4 * 3 + 200, 5);
  });

  it('charges MCr 0.5 per point of fuel', () => {
    // "Fuel: MCr .5 per point of fuel, available at any friendly base."
    const s0 = build('prospecting');
    const ship = ships(s0)[0]!;
    const capacity = SHIP_CLASSES[ship.shipClass].fuelCapacity;
    const drained = patch(s0, ship.id, { fuel: capacity - 6 });
    const s = at(drained, 'resupply', ship.owner);
    const before = s.players[ship.owner]!.megacredits;
    const out = run(s, { type: 'resupply', by: ship.owner, ship: ship.id });
    expect({ ok: out.ok, why: out.why }).toEqual({ ok: true, why: undefined });
    expect(out.state.ships[ship.id]!.fuel).toBe(capacity);
    expect(out.state.players[ship.owner]!.megacredits).toBeCloseTo(before - 3, 5);
  });

  it('is won at the end of the agreed game length by the richest miner', () => {
    // "Decide on a game length (perhaps 120 days) before the game. The miner with
    //  the most money wins, counting all property at full purchase value and
    //  unsold ore at MCr 2 per ton."
    const s0 = build('prospecting');
    const [first, second] = s0.playerOrder;
    const config = s0.scenarioData['prospectingScenario'] as { gameLengthTurns: number };
    expect(config.gameLengthTurns).toBe(120);

    const richer: GameState = {
      ...s0,
      players: {
        ...s0.players,
        [second!]: { ...s0.players[second!]!, megacredits: 60 },
      },
    };
    // Not over yet on the last day.
    expect(checkScenarioVictory({ ...richer, turn: 120 })).toBe(null);
    const done = checkScenarioVictory({ ...richer, turn: 121 });
    expect(done?.winners).toEqual([second]);

    // Unsold ore counts at MCr 2 a ton, not at the Luna price.
    const withOre: GameState = {
      ...s0,
      turn: 121,
      ships: {
        ...s0.ships,
        [ships(s0, first!)[0]!.id]: {
          ...ships(s0, first!)[0]!,
          cargo: [
            { kind: 'automatedMine', quantity: 1 },
            { kind: 'ore', quantity: 10 },
          ],
        },
      },
    };
    expect(prospectorWorth(withOre, first!)).toBeCloseTo(25 + 10 * 2, 5);
  });
});
