/**
 * The ship table, cargo, prices and the two purchase systems, rule by rule.
 *
 * Every case quotes the rulebook clause it enforces and is written against that
 * clause rather than against the implementation. Covers p. 1 (ship types and the
 * ship table), p. 4 (the overload manoeuvre), p. 6 (torpedoes and nukes), p. 7
 * (who may carry an orbital base, resupply loadouts), p. 8 (cargo) and p. 9
 * (prices: the combat strength point system, the MegaCredit system and the
 * equipment table) — the tables on p. 17 being a verbatim reprint of pp. 1 and 9.
 */

import { describe, expect, it } from 'vitest';
import {
  type CargoKind,
  type Command,
  type GameState,
  type Ship,
  type ShipClass,
  CARGO,
  DEFAULT_MAP,
  SHIP_CLASSES,
  applyCommand,
  canCarry,
  canLaunchTorpedoes,
  canOverload,
  cargoMass,
  cargoSpace,
  createInitialState,
  hex,
  isCommercial,
  logistics,
  makePlayer,
  makeShip,
  neighbor,
  shipClass,
} from '../src/engine/index.js';
import { SCENARIOS, buildScenario, combatPointCost } from '../src/scenarios/index.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RigOptions {
  readonly ships: readonly Ship[];
  readonly credits?: number;
  readonly scenarioData?: Record<string, unknown>;
  /** Ownership overrides for printed bases, by base id ("terra:0"). */
  readonly baseOwners?: Readonly<Record<string, string | null>>;
}

const rig = (o: RigOptions): GameState => {
  const s = createInitialState({
    scenarioId: 'ships',
    seed: 4242,
    players: [
      makePlayer(A, 'Player A', 'Alpha', '#e8703a', { megacredits: o.credits ?? 0 }),
      makePlayer(B, 'Player B', 'Beta', '#4a9fe0'),
    ],
    ships: o.ships,
    ...(o.scenarioData ? { scenarioData: o.scenarioData } : {}),
  });
  if (!o.baseOwners) return s;
  const bases = { ...s.bases };
  for (const [id, owner] of Object.entries(o.baseOwners)) {
    const base = bases[id];
    if (base) bases[id] = { ...base, owner };
  }
  return { ...s, bases };
};

const ok = (state: GameState, cmd: Command): GameState => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, reason: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    reason: undefined,
  });
  return out.state;
};

const refused = (state: GameState, cmd: Command): string => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
  expect(out.state).toBe(state);
  return out.result.reason ?? '';
};

const endPhase = (state: GameState): GameState =>
  ok(state, { type: 'endPhase', by: state.playerOrder[state.activePlayerIndex]! });

const toPhase = (state: GameState, phase: GameState['phase']): GameState => {
  let s = state;
  for (let i = 0; i < 10 && s.phase !== phase; i++) s = endPhase(s);
  expect(s.phase).toBe(phase);
  return s;
};

const TERRA = map.body('terra')!;
const TERRA_BASE = map.allPlanetaryBases().find((b) => b.bodyId === 'terra')!;
/** Somewhere with no body, no asteroid and no base within reach. */
const CLEAR = hex(0, 14);

/** A ship of `cls` with `cargo` in the hold, in clear space. */
const hull = (
  id: string,
  cls: ShipClass,
  cargo: readonly { kind: CargoKind; quantity: number }[] = [],
): Ship => makeShip({ id, owner: A, shipClass: cls, pos: CLEAR, cargo });

const ALL_CLASSES = Object.keys(SHIP_CLASSES) as ShipClass[];

// ---------------------------------------------------------------------------
// The ship table (pp. 1 and 17)
// ---------------------------------------------------------------------------

describe('the ship table', () => {
  /**
   * Transcribed from the printed table, cell for cell:
   *
   *   Ship Type    Combat Strength  Fuel Capacity  Cargo Capacity  Cost (MCr)
   *   Transport    1D               10             50              10
   *   Packet       2                10             50              20
   *   Tanker       1D               50             0               10
   *   Liner        2D               10             0               50
   *   Corvette     2                20             5               40
   *   Corsair      4                20             10              80
   *   Frigate      8                20             40              150
   *   Dreadnaught  15               15            50              600
   *   Torch        8                *              10              400
   *   Orbital Base 16               0              **              1000
   *
   * "* Torchships have unlimited fuel."
   * "** Orbital bases have an unlimited fuel store and cargo hold to resupply
   *  friendly ships."
   */
  const PRINTED: Readonly<
    Record<ShipClass, { strength: string; fuel: number; cargo: number; cost: number }>
  > = {
    transport: { strength: '1D', fuel: 10, cargo: 50, cost: 10 },
    packet: { strength: '2', fuel: 10, cargo: 50, cost: 20 },
    tanker: { strength: '1D', fuel: 50, cargo: 0, cost: 10 },
    liner: { strength: '2D', fuel: 10, cargo: 0, cost: 50 },
    corvette: { strength: '2', fuel: 20, cargo: 5, cost: 40 },
    corsair: { strength: '4', fuel: 20, cargo: 10, cost: 80 },
    frigate: { strength: '8', fuel: 20, cargo: 40, cost: 150 },
    dreadnaught: { strength: '15', fuel: 15, cargo: 50, cost: 600 },
    torch: { strength: '8', fuel: Infinity, cargo: 10, cost: 400 },
    orbitalBase: { strength: '16', fuel: 0, cargo: Infinity, cost: 1000 },
  };

  it('carries every printed cell', () => {
    for (const cls of ALL_CLASSES) {
      const d = shipClass(cls);
      const printed = PRINTED[cls];
      expect({
        cls,
        strength: `${d.combatStrength}${d.defensiveOnly ? 'D' : ''}`,
        fuel: d.fuelCapacity,
        cargo: d.cargoCapacity,
        cost: d.cost,
      }).toEqual({
        cls,
        strength: printed.strength,
        fuel: printed.fuel,
        cargo: printed.cargo,
        cost: printed.cost,
      });
    }
  });

  it('lists nine ship types plus orbital bases, and no more', () => {
    // "Triplanetary depicts nine different types of ship, plus orbital bases."
    expect(ALL_CLASSES.filter((c) => c !== 'orbitalBase')).toHaveLength(9);
    expect(ALL_CLASSES).toContain('orbitalBase');
  });

  it('gives the D suffix to exactly the transport, tanker and liner', () => {
    // "Ships with a D after their combat strength may not attack or
    //  counterattack; their strength is defensive only. Warships and packets
    //  have a combat strength without the D suffix; they may attack normally."
    const suffixed = ALL_CLASSES.filter((c) => shipClass(c).defensiveOnly).sort();
    expect(suffixed).toEqual(['liner', 'tanker', 'transport']);
  });

  it('gives the torch unlimited fuel and the orbital base an unlimited hold', () => {
    // "* Torchships have unlimited fuel."
    expect(shipClass('torch').fuelCapacity).toBe(Infinity);
    expect(logistics.hasUnlimitedFuel(hull('t', 'torch'))).toBe(true);
    // "** Orbital bases have an unlimited fuel store and cargo hold."
    expect(shipClass('orbitalBase').cargoCapacity).toBe(Infinity);
    expect(cargoSpace(hull('ob', 'orbitalBase', [{ kind: 'nuke', quantity: 40 }]))).toBe(Infinity);
  });

  it('gives the torch a frigate’s guns but not its hold', () => {
    // "Torch – ... It has the guns, but not the hold capacity, of a frigate."
    expect(shipClass('torch').combatStrength).toBe(shipClass('frigate').combatStrength);
    expect(shipClass('torch').cargoCapacity).toBeLessThan(shipClass('frigate').cargoCapacity);
  });

  it('gives the dreadnaught fewer fuel points than the smaller warships', () => {
    // "Dreadnaught – ... It has fewer fuel points than do smaller warships."
    const dread = shipClass('dreadnaught').fuelCapacity;
    for (const cls of ['corvette', 'corsair', 'frigate'] as const) {
      expect({ cls, less: dread < shipClass(cls).fuelCapacity }).toEqual({ cls, less: true });
    }
  });

  it('leaves the tanker and the liner no hold at all', () => {
    // "Tanker – Nothing but drive, crew quarters, and fuel tanks."
    // "Liner – ... It has no weapons and no capacity for other cargo."
    for (const cls of ['tanker', 'liner'] as const) {
      expect({ cls, cargo: shipClass(cls).cargoCapacity }).toEqual({ cls, cargo: 0 });
      expect(canCarry(hull('c', cls), 'mine', 1)).toBeTruthy();
      expect(canCarry(hull('c', cls), 'ore', 1)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// The D suffix: "may not attack or counterattack"
// ---------------------------------------------------------------------------

describe('the D suffix', () => {
  it('refuses a D-suffix ship the counterattack, not merely the attack', () => {
    // "Ships with a D after their combat strength may not attack or
    //  counterattack; their strength is defensive only."
    for (const cls of ['transport', 'tanker', 'liner'] as const) {
      let s = rig({
        ships: [
          makeShip({ id: 'gun', owner: B, shipClass: 'corsair', pos: CLEAR }),
          makeShip({ id: 'victim', owner: A, shipClass: cls, pos: CLEAR }),
        ],
      });
      // B is not the first player, so hand the turn over before shooting.
      s = toPhase(s, 'resupply');
      s = endPhase(s);
      s = toPhase(s, 'combat');
      s = ok(s, { type: 'attack', by: B, attackers: ['gun'], targets: ['victim'] });
      expect(
        refused(s, { type: 'counterattack', by: A, attackers: ['victim'], targets: ['gun'] }),
      ).toBeTruthy();
    }
  });

  it('lets a packet counterattack, because its strength carries no D', () => {
    // "Warships and packets have a combat strength without the D suffix; they
    //  may attack normally." — and the counterattack clause names only the
    //  D-suffix ships: "Commercial ships have a suffix D in their combat
    //  strengths and may not attack or counterattack."
    let s = rig({
      ships: [
        makeShip({ id: 'gun', owner: B, shipClass: 'corsair', pos: CLEAR }),
        makeShip({ id: 'victim', owner: A, shipClass: 'packet', pos: CLEAR }),
      ],
    });
    s = toPhase(s, 'resupply');
    s = endPhase(s);
    s = toPhase(s, 'combat');
    s = ok(s, { type: 'attack', by: B, attackers: ['gun'], targets: ['victim'] });
    ok(s, { type: 'counterattack', by: A, attackers: ['victim'], targets: ['gun'] });
  });
});

// ---------------------------------------------------------------------------
// Warships, commercial ships, and the packet in between
// ---------------------------------------------------------------------------

describe('warships and commercial ships', () => {
  it('counts transports, packets, tankers and liners as commercial', () => {
    // "Commercial ships (transports, packets, tankers, liners) may not perform
    //  the overload maneuver."
    expect(ALL_CLASSES.filter(isCommercial).sort()).toEqual([
      'liner',
      'packet',
      'tanker',
      'transport',
    ]);
  });

  it('refuses every commercial class the overload manoeuvre, packets included', () => {
    // "Warships may perform one overload maneuver between maintenance stopovers.
    //  Overload allows expenditure of two fuel points in one turn... Commercial
    //  ships (transports, packets, tankers, liners) may not perform the overload
    //  maneuver."
    for (const cls of ALL_CLASSES) {
      const ship = makeShip({ id: 's', owner: A, shipClass: cls, pos: CLEAR, fuel: 10 });
      const s = rig({ ships: [ship] });
      const commercial = isCommercial(cls);
      // An orbital base has no fuel and never manoeuvres; it is neither.
      if (cls === 'orbitalBase') continue;
      expect({ cls, overload: canOverload(s, s.ships['s']!) }).toEqual({
        cls,
        overload: !commercial,
      });
    }
  });

  it('refuses a packet a two-hex course change on the map', () => {
    // The same clause, driven through the astrogation phase: two hexes of course
    // change is exactly what the overload buys, and a packet may not buy it.
    const target = hex(CLEAR.q + 2, CLEAR.r);
    for (const [cls, allowed] of [
      ['packet', false],
      ['transport', false],
      ['corvette', true],
    ] as const) {
      const s = rig({
        ships: [makeShip({ id: 's', owner: A, shipClass: cls, pos: CLEAR, fuel: 10 })],
      });
      const cmd: Command = {
        type: 'plotCourse',
        by: A,
        ship: 's',
        endpoint: target,
        overload: true,
      };
      const out = applyCommand(s, cmd, map);
      expect({ cls, ok: out.result.ok }).toEqual({ cls, ok: allowed });
    }
  });

  it('gives a commercial ship no overload to spend even after a maintenance stopover', () => {
    // "Whenever a ship is refueled from a base, it automatically undergoes
    //  maintenance... and allows the ship to perform the overload maneuver once."
    // A commercial ship never gets that credit: it "may not perform the overload
    // maneuver" at all.
    let s = rig({
      ships: [
        makeShip({
          id: 'p',
          owner: A,
          shipClass: 'packet',
          pos: TERRA.hex,
          location: { kind: 'landed', side: TERRA_BASE.side },
          fuel: 0,
        }),
      ],
    });
    s = toPhase(s, 'resupply');
    s = ok(s, { type: 'resupply', by: A, ship: 'p' });
    expect(s.ships['p']!.fuel).toBe(shipClass('packet').fuelCapacity);
    expect(s.ships['p']!.overloadAvailable).toBe(false);
  });

  it('lets only warships launch torpedoes', () => {
    // "A torpedo masses 20 tons; a carrying ship must have hold capacity to
    //  carry it. Only warships may launch torpedoes."
    for (const cls of ALL_CLASSES) {
      expect({ cls, launch: canLaunchTorpedoes(cls) }).toEqual({
        cls,
        launch: !isCommercial(cls),
      });
    }
  });

  it('lets a packet carry a torpedo but never fire one', () => {
    // The two halves of the same clause: hold capacity is what lets a ship carry
    // a torpedo (a packet has 50 tons of it), but "Only warships may launch
    // torpedoes", and a packet is commercial.
    const packet = hull('p', 'packet', [{ kind: 'torpedo', quantity: 1 }]);
    expect(canCarry(hull('p', 'packet'), 'torpedo', 1)).toBeNull();

    let s = rig({ ships: [packet] });
    s = toPhase(s, 'ordnance');
    expect(refused(s, { type: 'launchOrdnance', by: A, ship: 'p', kind: 'torpedo' })).toMatch(
      /warship/i,
    );

    // A frigate in the same position launches without complaint.
    let w = rig({ ships: [hull('f', 'frigate', [{ kind: 'torpedo', quantity: 1 }])] });
    w = toPhase(w, 'ordnance');
    ok(w, { type: 'launchOrdnance', by: A, ship: 'f', kind: 'torpedo' });
  });

  it('lets a commercial ship launch a mine, which needs only a hold', () => {
    // Nothing in the mine rules restricts the launcher: "Mines are clusters of
    // explosive charges with no motive power of their own. When a mine is
    // launched, it assumes the vector of its launching ship." Only the torpedo
    // rule names warships.
    let s = rig({
      ships: [
        makeShip({
          id: 'tr',
          owner: A,
          shipClass: 'transport',
          pos: CLEAR,
          velocity: hex(1, 0),
          cargo: [{ kind: 'mine', quantity: 1 }],
        }),
      ],
    });
    s = toPhase(s, 'ordnance');
    ok(s, { type: 'launchOrdnance', by: A, ship: 'tr', kind: 'mine' });
  });
});

// ---------------------------------------------------------------------------
// The equipment table (pp. 9 and 17)
// ---------------------------------------------------------------------------

describe('the equipment table', () => {
  /**
   * Transcribed from the printed table:
   *
   *   Equipment Type   Cost (MCr)  Mass
   *   Fuel             *           –
   *   Mine             10          10
   *   Torpedo          20          20
   *   Nuke             300         20
   *   Scanners         30          –
   *   PM Grapples      40          10
   *   Automated Mine   5           10
   *   Robot Guards     50          10
   *   Ore              varies      1
   *   CT Shard         varies      10
   */
  const PRINTED: readonly [CargoKind, number | 'varies', number][] = [
    ['mine', 10, 10],
    ['torpedo', 20, 20],
    ['nuke', 300, 20],
    ['scanners', 30, 0],
    ['pmGrapples', 40, 10],
    ['automatedMine', 5, 10],
    ['robotGuards', 50, 10],
    ['ore', 'varies', 1],
    ['ctShard', 'varies', 10],
  ];

  it('prices and masses every printed row', () => {
    for (const [kind, cost, mass] of PRINTED) {
      const def = CARGO[kind];
      expect({ kind, cost: def.cost === null ? 'varies' : def.cost, mass: def.mass }).toEqual({
        kind,
        cost,
        mass,
      });
    }
  });

  it('leaves ore and CT shards without a list price', () => {
    // "Ore ... varies"; "CT Shard ... varies". Their price is set by the market,
    // not by the table: "Ore may be sold at Ceres (MCr 2 per ton) or at Luna
    // (MCr 3 per ton). CT shards sell for MCr 100 at Ceres or MCr 200 at Luna."
    expect(CARGO.ore.cost).toBeNull();
    expect(CARGO.ctShard.cost).toBeNull();
    expect(logistics.MARKETS['ceres']).toEqual({ ore: 2, ctShard: 100 });
    expect(logistics.MARKETS['luna']).toEqual({ ore: 3, ctShard: 200 });
    // "Stolen ore and CT shards may be sold at Clandestine, at prices as for
    //  Ceres" (p. 14).
    expect(logistics.MARKETS['clandestine']).toEqual(logistics.MARKETS['ceres']);
  });

  it('charges no mass for scanners', () => {
    // The Mass column reads "–" for scanners, as it does for fuel: a ship with
    // no hold at all may still carry them.
    expect(CARGO.scanners.mass).toBe(0);
    expect(canCarry(hull('l', 'liner'), 'scanners', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cargo (p. 8)
// ---------------------------------------------------------------------------

describe('cargo', () => {
  it('allows a load equal to capacity and refuses one ton more', () => {
    // "Every ship has a cargo capacity (in tons) shown on the counter. A ship
    //  may carry cargo whose total mass is less than or equal to its cargo
    //  capacity."
    const transport = hull('tr', 'transport'); // 50 tons
    expect(canCarry(transport, 'mine', 5)).toBeNull(); // 50 tons exactly
    expect(canCarry(transport, 'mine', 6)).toBeTruthy(); // 60 tons
    const full = hull('tr', 'transport', [{ kind: 'mine', quantity: 5 }]);
    expect(cargoMass(full)).toBe(50);
    expect(cargoSpace(full)).toBe(0);
    expect(canCarry(full, 'ore', 1)).toBeTruthy();
  });

  it('will not fit a ten-ton mine into a corvette’s five-ton hold', () => {
    // Corvette cargo capacity 5; "Mine ... Mass 10".
    expect(shipClass('corvette').cargoCapacity).toBe(5);
    expect(canCarry(hull('c', 'corvette'), 'mine', 1)).toBeTruthy();
    // What does fit is ore, at one ton a piece — five tons of it.
    expect(canCarry(hull('c', 'corvette'), 'ore', 5)).toBeNull();
    expect(canCarry(hull('c', 'corvette'), 'ore', 5.1)).toBeTruthy();
  });

  it('disregards fuel and its mass', () => {
    // "Fuel is not 'cargo' and its mass is disregarded."
    const laden = makeShip({
      id: 'tk',
      owner: A,
      shipClass: 'tanker',
      pos: CLEAR,
      fuel: 50, // a full tanker, and a tanker's cargo capacity is 0
    });
    expect(laden.fuel).toBe(50);
    expect(cargoMass(laden)).toBe(0);
    expect(cargoSpace(laden)).toBe(0);

    // And moving fuel between ships costs the receiver no hold space.
    let s = rig({
      ships: [
        makeShip({ id: 'tk', owner: A, shipClass: 'tanker', pos: CLEAR, fuel: 50 }),
        makeShip({
          id: 'tr',
          owner: A,
          shipClass: 'transport',
          pos: CLEAR,
          fuel: 0,
          cargo: [{ kind: 'mine', quantity: 5 }], // hold completely full
        }),
      ],
    });
    s = toPhase(s, 'resupply');
    s = ok(s, { type: 'transferCargo', by: A, from: 'tk', to: 'tr', kind: 'fuel', quantity: 10 });
    expect(s.ships['tr']!.fuel).toBe(10);
    expect(cargoMass(s.ships['tr']!)).toBe(50);
  });

  it('will not split an item of cargo between two ships', () => {
    // "An item of cargo may not be split among two or more ships for transport."
    const transport = hull('tr', 'transport');
    for (const kind of ['mine', 'torpedo', 'nuke', 'orbitalBase', 'pmGrapples'] as const) {
      expect({ kind, why: canCarry(transport, kind, 0.5) }).not.toEqual({ kind, why: null });
    }
    // Half an orbital base does not fit in a dreadnaught's hold "because it is
    // only half" — it is refused outright.
    expect(canCarry(hull('tr', 'transport'), 'orbitalBase', 0.5)).toMatch(/split/i);
  });

  it('restricts a non-warship to one nuke however big its hold', () => {
    // "A nuke masses 20 tons. Any ship may carry and launch a nuke if it has
    //  sufficient hold capacity, but non-warships are restricted to carrying
    //  only one nuke at a time."
    for (const cls of ['transport', 'packet'] as const) {
      // 50 tons of hold: two nukes would fit by mass alone.
      expect(shipClass(cls).cargoCapacity).toBe(50);
      expect(canCarry(hull('n', cls), 'nuke', 1)).toBeNull();
      expect(canCarry(hull('n', cls), 'nuke', 2)).toMatch(/nuke/i);
      const carrying = hull('n', cls, [{ kind: 'nuke', quantity: 1 }]);
      expect(canCarry(carrying, 'nuke', 1)).toMatch(/nuke/i);
    }
    // A warship's only limit is the hold: a frigate's 40 tons take two nukes.
    expect(canCarry(hull('f', 'frigate'), 'nuke', 2)).toBeNull();
    expect(canCarry(hull('f', 'frigate'), 'nuke', 3)).toBeTruthy();
  });

  it('refuses to move a second nuke onto a non-warship in space', () => {
    // The same clause driven through a transfer: a transport already carrying a
    // nuke may not take another off a frigate.
    let s = rig({
      ships: [
        hull('f', 'frigate', [{ kind: 'nuke', quantity: 2 }]),
        hull('tr', 'transport', [{ kind: 'nuke', quantity: 1 }]),
      ],
    });
    s = toPhase(s, 'resupply');
    expect(
      refused(s, { type: 'transferCargo', by: A, from: 'f', to: 'tr', kind: 'nuke', quantity: 1 }),
    ).toMatch(/nuke/i);
  });

  it('lets only a transport or packet carry an orbital base', () => {
    // "Note that non-warships may carry only one nuke at a time, and that only a
    //  transport may carry an orbital base" (p. 8), widened by one word on p. 7:
    //  "A base may be carried only by a transport or packet."
    for (const cls of ALL_CLASSES) {
      const allowed = cls === 'transport' || cls === 'packet';
      const why = canCarry(hull('s', cls), 'orbitalBase', 1);
      // A dreadnaught has a 50-ton hold, the same as a transport, so this test
      // discriminates class from capacity rather than restating a mass check.
      expect({ cls, allowed: why === null }).toEqual({ cls, allowed });
    }
    expect(shipClass('dreadnaught').cargoCapacity).toBe(shipClass('transport').cargoCapacity);
  });

  it('refuses a dreadnaught the job of emplacing a base', () => {
    // The same clause at the moment it bites: "A base may be carried only by a
    //  transport or packet."
    const s = rig({
      ships: [
        makeShip({
          id: 'd',
          owner: A,
          shipClass: 'dreadnaught',
          pos: neighbor(TERRA.hex, 0),
          cargo: [{ kind: 'orbitalBase', quantity: 1 }],
        }),
      ],
    });
    expect(s.phase).toBe('astrogation');
    expect(refused(s, { type: 'emplaceEquipment', by: A, ship: 'd', kind: 'orbitalBase' })).toMatch(
      /transport or packet/i,
    );
  });

  it('lets a liner carry its passengers and nothing else', () => {
    // "Liner – A specialized craft for carrying passengers. It has no weapons
    //  and no capacity for other cargo."
    // Only the refusal half is a clause. That a liner may carry passengers at
    // all is modelled by giving `passengers` no mass, which the printed
    // equipment table neither lists nor contradicts — the liner's printed Cargo
    // Capacity is 0.
    const liner = hull('l', 'liner');
    for (const kind of ['mine', 'torpedo', 'nuke', 'ore', 'pmGrapples'] as const) {
      expect({ kind, why: canCarry(liner, kind, 1) }).not.toEqual({ kind, why: null });
    }
  });

  it('keeps every scenario’s opening hold inside its printed capacity', () => {
    // The same clause applied to the shipping the rulebook hands out: "A ship
    // may carry cargo whose total mass is less than or equal to its cargo
    // capacity", plus "non-warships may carry only one nuke at a time" and "A
    // base may be carried only by a transport or packet".
    for (const def of SCENARIOS) {
      const s = def.build({ seed: 5 });
      for (const ship of Object.values(s.ships)) {
        const d = shipClass(ship.shipClass);
        const nukes = ship.cargo.find((c) => c.kind === 'nuke')?.quantity ?? 0;
        const bases = ship.cargo.find((c) => c.kind === 'orbitalBase')?.quantity ?? 0;
        expect({
          scenario: def.id,
          ship: ship.id,
          overloaded: cargoMass(ship) > d.cargoCapacity,
          tooManyNukes: !d.warship && nukes > 1,
          illegalBase: bases > 0 && ship.shipClass !== 'transport' && ship.shipClass !== 'packet',
          overFuelled: ship.fuel > d.fuelCapacity,
        }).toEqual({
          scenario: def.id,
          ship: ship.id,
          overloaded: false,
          tooManyNukes: false,
          illegalBase: false,
          overFuelled: false,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Resupply loadouts (p. 7)
// ---------------------------------------------------------------------------

describe('resupply loadouts', () => {
  const landed = (
    cls: ShipClass,
    cargo: readonly { kind: CargoKind; quantity: number }[] = [],
  ): Ship =>
    makeShip({
      id: 's',
      owner: A,
      shipClass: cls,
      pos: TERRA.hex,
      location: { kind: 'landed', side: TERRA_BASE.side },
      fuel: 0,
      cargo,
    });

  it('takes any assortment of mines and torpedoes that fits the hold', () => {
    // "In addition, all ordnance is automatically reloaded; the ship may select
    //  any assortment of mines and torpedoes which fits in the hold capacity of
    //  the ship."
    let s = toPhase(rig({ ships: [landed('frigate')] }), 'resupply'); // 40 tons
    s = ok(s, {
      type: 'resupply',
      by: A,
      ship: 's',
      loadout: [
        { kind: 'torpedo', quantity: 1 }, // 20
        { kind: 'mine', quantity: 2 }, // 20
      ],
    });
    expect(cargoMass(s.ships['s']!)).toBe(40);
  });

  it('refuses a loadout that overflows the hold', () => {
    const s = toPhase(rig({ ships: [landed('frigate')] }), 'resupply');
    refused(s, { type: 'resupply', by: A, ship: 's', loadout: [{ kind: 'torpedo', quantity: 3 }] });
  });

  it('counts cargo already aboard against the loadout', () => {
    // The hold is one hold: a frigate carrying a 20-ton nuke has 20 tons left.
    const s = toPhase(
      rig({ ships: [landed('frigate', [{ kind: 'nuke', quantity: 1 }])] }),
      'resupply',
    );
    refused(s, { type: 'resupply', by: A, ship: 's', loadout: [{ kind: 'torpedo', quantity: 2 }] });
    ok(s, { type: 'resupply', by: A, ship: 's', loadout: [{ kind: 'torpedo', quantity: 1 }] });
  });

  it('stocks bases with fuel, mines and torpedoes only', () => {
    // "All bases (planetary, asteroid, and orbital) carry an unlimited supply of
    //  fuel, mines, and torpedoes." A nuke is not on that list — "Nukes are
    //  available only if the scenario specifies" — and neither is anything from
    //  the mining catalogue.
    expect([...logistics.RESUPPLY_ORDNANCE].sort()).toEqual(['mine', 'torpedo']);
    const s = toPhase(rig({ ships: [landed('frigate')] }), 'resupply');
    refused(s, { type: 'resupply', by: A, ship: 's', loadout: [{ kind: 'nuke', quantity: 1 }] });
  });

  it('lets a torch give fuel to nobody, however full its tanks', () => {
    // The price of the ship table's "*": "Torch ships employ an experimental
    // fusion drive not yet suitable for mass production. They have unlimited
    // fuel but may not transfer fuel to other ships."
    let s = rig({
      ships: [
        makeShip({ id: 'torch', owner: A, shipClass: 'torch', pos: CLEAR }),
        makeShip({ id: 'c', owner: A, shipClass: 'corvette', pos: CLEAR, fuel: 0 }),
      ],
    });
    s = toPhase(s, 'resupply');
    expect(
      refused(s, {
        type: 'transferCargo',
        by: A,
        from: 'torch',
        to: 'c',
        kind: 'fuel',
        quantity: 5,
      }),
    ).toMatch(/torch/i);
    expect(s.ships['c']!.fuel).toBe(0);
  });

  it('fills a visitor to its own printed capacity from an orbital base', () => {
    // The ship table prints an orbital base's Fuel Capacity as 0, but the
    // footnote is what governs resupply: "** Orbital bases have an unlimited
    // fuel store and cargo hold to resupply friendly ships." The base's own 0
    // must not cap what it hands out.
    const gravity = neighbor(TERRA.hex, 0);
    let s = createInitialState({
      scenarioId: 'ships',
      seed: 4242,
      players: [makePlayer(A, 'Player A', 'Alpha', '#e8703a')],
      ships: [
        makeShip({ id: 'ob', owner: A, shipClass: 'orbitalBase', pos: gravity }),
        makeShip({ id: 'd', owner: A, shipClass: 'dreadnaught', pos: gravity, fuel: 1 }),
      ],
      bases: [
        {
          id: 'orbital:test',
          kind: 'orbital',
          owner: A,
          hex: gravity,
          destroyed: false,
          suppressed: false,
          hasPlanetaryDefences: false,
          firedThisTurn: false,
          launchedThisTurn: false,
          resuppliedThisTurn: false,
        },
      ],
    });
    expect(shipClass('orbitalBase').fuelCapacity).toBe(0);
    s = toPhase(s, 'resupply');
    s = ok(s, {
      type: 'resupply',
      by: A,
      ship: 'd',
      loadout: [
        { kind: 'torpedo', quantity: 2 },
        { kind: 'mine', quantity: 1 },
      ],
    });
    expect(s.ships['d']!.fuel).toBe(shipClass('dreadnaught').fuelCapacity);
    expect(cargoMass(s.ships['d']!)).toBe(50); // the dreadnaught's whole hold
  });

  it('refuels free when the scenario names no price for fuel', () => {
    // "* Fuel is available at any friendly base. If no cost is given in the
    //  scenario, then fuel is too cheap to keep track of in the game – i.e., free."
    let s = toPhase(rig({ ships: [landed('frigate')], credits: 7 }), 'resupply');
    s = ok(s, { type: 'resupply', by: A, ship: 's' });
    expect(s.ships['s']!.fuel).toBe(shipClass('frigate').fuelCapacity);
    expect(s.players[A]!.megacredits).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Prices: the MegaCredit system (p. 9)
// ---------------------------------------------------------------------------

describe('the MegaCredit system', () => {
  const yard = (credits: number, extra: readonly Ship[] = []): GameState =>
    rig({ ships: [...extra], credits });

  it('charges the printed cost for a ship and deducts it', () => {
    // "Ships, equipment, ordnance, and other items are purchased for MegaCredits
    //  (abbreviated MCr) which are given or earned in the scenario."
    for (const cls of ALL_CLASSES) {
      if (cls === 'orbitalBase') continue; // bought as cargo, see below
      const cost = shipClass(cls).cost;
      let s = toPhase(yard(cost), 'resupply');
      s = ok(s, {
        type: 'purchaseShip',
        by: A,
        shipClass: cls,
        at: TERRA.hex,
        side: TERRA_BASE.side,
      });
      expect({ cls, left: s.players[A]!.megacredits }).toEqual({ cls, left: 0 });
      const bought = Object.values(s.ships).find((sh) => sh.shipClass === cls)!;
      // "All new ships start with a full fuel load."
      expect(bought.fuel).toBe(shipClass(cls).fuelCapacity);
    }
  });

  it('builds only where the scenario says a player may build', () => {
    // "New ships and equipment may be purchased on any world as soon as a player
    //  accumulates enough money" (Prospecting, p. 13) — a world, not a world you
    //  own, which is why the default gate is only friendliness. Interplanetary
    //  War narrows it: "Ships appear immediately on any world controlled by the
    //  player", and it deliberately leaves Mercury, Ceres and Clandestine
    //  unowned ("take no side in this war"). An unowned base sells fuel to
    //  anyone but is nobody's shipyard.
    const unclaimed = { 'terra:0': null } as Record<string, null>;
    const open = toPhase(rig({ ships: [], credits: 1000, baseOwners: unclaimed }), 'resupply');
    ok(open, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'transport',
      at: TERRA.hex,
      side: TERRA_BASE.side,
    });

    const controlled = toPhase(
      rig({
        ships: [],
        credits: 1000,
        baseOwners: unclaimed,
        scenarioData: { purchaseRequiresControl: true },
      }),
      'resupply',
    );
    expect(
      refused(controlled, {
        type: 'purchaseShip',
        by: A,
        shipClass: 'transport',
        at: TERRA.hex,
        side: TERRA_BASE.side,
      }),
    ).toMatch(/control/i);
  });

  it('refuses a ship a MegaCredit short of its printed price', () => {
    for (const cls of ['transport', 'corvette', 'dreadnaught'] as const) {
      const s = toPhase(yard(shipClass(cls).cost - 1), 'resupply');
      expect(
        refused(s, {
          type: 'purchaseShip',
          by: A,
          shipClass: cls,
          at: TERRA.hex,
          side: TERRA_BASE.side,
        }),
      ).toMatch(/afford/i);
    }
  });

  it('sells an orbital base as cargo at MCr 1000, not as a hull', () => {
    // "Orbital bases are similar to bases but can be purchased in-game and moved
    //  by the owning player. A base may be carried only by a transport or
    //  packet." The ship table prices it at MCr 1000.
    expect(CARGO.orbitalBase.cost).toBe(shipClass('orbitalBase').cost);
    expect(CARGO.orbitalBase.cost).toBe(1000);

    const s = toPhase(yard(1000), 'resupply');
    refused(s, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'orbitalBase',
      at: TERRA.hex,
      side: TERRA_BASE.side,
    });
  });

  it('charges the equipment table price, times the quantity', () => {
    const ship = makeShip({
      id: 's',
      owner: A,
      shipClass: 'transport',
      pos: TERRA.hex,
      location: { kind: 'landed', side: TERRA_BASE.side },
    });
    const s = rig({ ships: [ship], credits: 100 });
    const out = logistics.purchaseEquipment(s, 's', 'mine', 3, map);
    expect(out.result.ok).toBe(true);
    // "Mine ... 10" MCr each.
    expect(out.state.players[A]!.megacredits).toBe(100 - 30);
    expect(cargoMass(out.state.ships['s']!)).toBe(30);
  });

  it('will not sell equipment the table prices as "varies"', () => {
    const ship = makeShip({
      id: 's',
      owner: A,
      shipClass: 'transport',
      pos: TERRA.hex,
      location: { kind: 'landed', side: TERRA_BASE.side },
    });
    const s = rig({ ships: [ship], credits: 1000 });
    for (const kind of ['ore', 'ctShard'] as const) {
      expect(logistics.purchaseEquipment(s, 's', kind, 1, map).result.ok).toBe(false);
    }
  });

  it('pays the printed market price for ore and shards, and only at a market', () => {
    // "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton). CT
    //  shards sell for MCr 100 at Ceres or MCr 200 at Luna."
    const load = [
      { kind: 'ore' as const, quantity: 10 },
      { kind: 'ctShard' as const, quantity: 1 },
    ];
    const ceres = map.allAsteroidBases().find((b) => b.id === 'ceres')!;
    const atCeres = rig({
      ships: [
        makeShip({
          id: 's',
          owner: A,
          shipClass: 'transport',
          pos: ceres.hex,
          location: { kind: 'asteroidBase', hex: ceres.hex },
          cargo: load,
        }),
      ],
    });
    expect(
      logistics.sellCargo(atCeres, 's', ['ore', 'ctShard'], map).state.players[A]!.megacredits,
    ).toBe(10 * 2 + 100);

    const lunaBase = map.allPlanetaryBases().find((b) => b.bodyId === 'luna')!;
    const atLuna = rig({
      ships: [
        makeShip({
          id: 's',
          owner: A,
          shipClass: 'transport',
          pos: map.body('luna')!.hex,
          location: { kind: 'landed', side: lunaBase.side },
          cargo: load,
        }),
      ],
    });
    expect(
      logistics.sellCargo(atLuna, 's', ['ore', 'ctShard'], map).state.players[A]!.megacredits,
    ).toBe(10 * 3 + 200);

    // Terra is not one of the two markets the clause names.
    const atTerra = rig({
      ships: [
        makeShip({
          id: 's',
          owner: A,
          shipClass: 'transport',
          pos: TERRA.hex,
          location: { kind: 'landed', side: TERRA_BASE.side },
          cargo: load,
        }),
      ],
    });
    expect(logistics.sellCargo(atTerra, 's', ['ore', 'ctShard'], map).result.ok).toBe(false);
  });

  it('will not sell more equipment than the hold will take', () => {
    // "A ship may carry cargo whose total mass is less than or equal to its
    //  cargo capacity."
    const ship = makeShip({
      id: 's',
      owner: A,
      shipClass: 'corsair', // 10 tons
      pos: TERRA.hex,
      location: { kind: 'landed', side: TERRA_BASE.side },
    });
    const s = rig({ ships: [ship], credits: 1000 });
    expect(logistics.purchaseEquipment(s, 's', 'mine', 1, map).result.ok).toBe(true);
    expect(logistics.purchaseEquipment(s, 's', 'mine', 2, map).result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prices: the combat strength point system (p. 9)
// ---------------------------------------------------------------------------

describe('the combat strength point system', () => {
  it('halves the printed strength for D-suffix ships and nothing else', () => {
    // "Ships are acquired on the basis of combat strength points. Commercial
    //  ships with D-suffix strengths cost half the printed strength (a liner
    //  costs 1 point, a transport or tanker costs 1/2 point)."
    // The rulebook's own worked examples, and the only three it gives.
    expect(combatPointCost('liner')).toBe(1);
    expect(combatPointCost('transport')).toBe(0.5);
    expect(combatPointCost('tanker')).toBe(0.5);
    // "...and nothing else": a warship pays its printed strength.
    expect(combatPointCost('corvette')).toBe(2);
    // Ship table, p. 17: "Dreadnaught 15".
    expect(combatPointCost('dreadnaught')).toBe(15);
  });

  it('charges a packet its full printed strength, D-less though commercial', () => {
    // The discount is written for "Commercial ships with D-suffix strengths",
    // and "Warships and packets have a combat strength without the D suffix".
    expect(isCommercial('packet')).toBe(true);
    expect(shipClass('packet').defensiveOnly).toBe(false);
    expect(combatPointCost('packet')).toBe(shipClass('packet').combatStrength);
    expect(combatPointCost('packet')).toBe(2);
  });

  it('charges a warship exactly its printed strength', () => {
    for (const [cls, points] of [
      ['corvette', 2],
      ['corsair', 4],
      ['frigate', 8],
      ['dreadnaught', 15],
      ['torch', 8],
      ['orbitalBase', 16],
    ] as const) {
      expect({ cls, points: combatPointCost(cls) }).toEqual({ cls, points });
    }
  });

  it('deals only with the cost of ships — fuel is free in this system', () => {
    // "This system is basic, and deals only with the costs of ships. Fuel is
    //  free in this system and available at any base." Nova is the scenario that
    //  uses it, so a refuelling there must actually leave the treasury alone.
    const s0 = buildScenario('nova', { seed: 11 });
    const thirsty = Object.values(s0.ships).find(
      (sh) => sh.location.kind === 'landed' && sh.owner !== 'alien',
    )!;
    const before = s0.players[thirsty.owner]!.megacredits;
    let s: GameState = {
      ...s0,
      phase: 'resupply',
      activePlayerIndex: s0.playerOrder.indexOf(thirsty.owner),
      ships: { ...s0.ships, [thirsty.id]: { ...thirsty, fuel: 1 } },
    };
    const out = applyCommand(s, { type: 'resupply', by: thirsty.owner, ship: thirsty.id }, map);
    expect(out.result.ok).toBe(true);
    s = out.state;
    expect(s.ships[thirsty.id]!.fuel).toBe(shipClass(thirsty.shipClass).fuelCapacity);
    expect(s.players[thirsty.owner]!.megacredits).toBe(before);
  });

  it('buys Nova’s two blocs fleets of exactly 50 points each', () => {
    // "Both the EastBloc and the WestBloc players select fleets of 50 combat
    //  points each."
    const s = buildScenario('nova', { seed: 11 });
    const allowance = s.scenarioData['combatPointAllowance'] as Record<string, number>;
    expect(Object.values(allowance)).toEqual([50, 50]);
    for (const [player, budget] of Object.entries(allowance)) {
      const spent = Object.values(s.ships)
        .filter((sh) => sh.owner === player)
        .reduce((n, sh) => n + combatPointCost(sh.shipClass), 0);
      expect({ player, spent }).toEqual({ player, spent: budget });
    }
  });
});

// ---------------------------------------------------------------------------
// Who may buy what
// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('offers a packet wherever it offers a transport', () => {
    // "Packet – ... May be used by both civilian and military; packets are
    //  allowed to anyone who could buy a transport unless a scenario states
    //  otherwise."
    for (const def of SCENARIOS) {
      const s = def.build({ seed: 5 });
      const list = s.scenarioData['purchasableClasses'] as ShipClass[] | undefined;
      if (!list || !list.includes('transport')) continue;
      expect({ scenario: def.id, packet: list.includes('packet') }).toEqual({
        scenario: def.id,
        packet: true,
      });
    }
  });

  it('sells only freighters and packets in a Prospecting game', () => {
    // "With that, ships and equipment must be purchased (only freighters and
    //  packets are available; all new ships start with a full fuel load)."
    const s = buildScenario('prospecting', { seed: 5 });
    expect(s.scenarioData['purchasableClasses']).toEqual(['transport', 'packet']);
  });

  it('refuses a class the scenario does not stock', () => {
    let s = rig({
      ships: [],
      credits: 10_000,
      scenarioData: { purchasableClasses: ['transport', 'packet'] },
    });
    s = toPhase(s, 'resupply');
    expect(
      refused(s, {
        type: 'purchaseShip',
        by: A,
        shipClass: 'dreadnaught',
        at: TERRA.hex,
        side: TERRA_BASE.side,
      }),
    ).toBeTruthy();
    ok(s, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'packet',
      at: TERRA.hex,
      side: TERRA_BASE.side,
    });
  });
});
