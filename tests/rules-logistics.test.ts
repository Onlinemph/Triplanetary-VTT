/**
 * Bases, resupply, cargo, looting, capture, surrender, detection, prospecting
 * and the sequence of play — rule by rule.
 *
 * Every test quotes the rulebook clause it enforces and is written against that
 * clause rather than against the implementation. A test that merely restates
 * what the code already does catches nothing, so each expectation below is
 * worked out from the printed wording first and only then run against the
 * engine.
 *
 * Covers p. 2 (the five phases), p. 7 (bases: planetary, asteroid, orbital),
 * p. 8 (resupply, planetary defences, torch ships, looting and rescue, capture,
 * surrender, detectors, cargo), p. 9 (the price list) and p. 13 (prospecting,
 * mining and the Belt's markets).
 *
 * Two things this file deliberately does not assert, because the printed text
 * does not settle them, are argued at the tests concerned: how long a ship
 * moored to an orbital base stays put, and whether "on any world" restricts a
 * shipyard to a world the buyer holds.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_MINE_RATE,
  CARGO,
  DEFAULT_MAP,
  DETECTION_RANGE_PLANETARY_BASE,
  DETECTION_RANGE_SHIP,
  FUEL_PRICE,
  MANUAL_MINE_RATE,
  MARKETS,
  PHASES,
  RESUPPLY_ORDNANCE,
  SHIP_CLASSES,
  type BaseState,
  type CargoKind,
  type Command,
  type GameState,
  type Hex,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipClass,
  applyCommand,
  canCarry,
  canFire,
  canResupplyAt,
  cargoMass,
  cargoSpace,
  coursesMatched,
  createInitialState,
  createRng,
  detectionRangeOfBase,
  distance,
  fuelCapacity,
  guardsAt,
  hasUnlimitedFuel,
  hex,
  hexSide,
  isDetected,
  key,
  logistics,
  makePlayer,
  makeShip,
  mineAt,
  previewAttack,
  rollDie,
  runProspecting,
  runResupplyPhase,
  sideGravityHex,
  sub,
  surrenderFuelReserve,
  updateDetection,
} from '../src/engine/index.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

const TERRA = map.body('terra')!;
const CERES = map.body('ceres')!;
const CLANDESTINE = map.body('clandestine')!;
const IO = map.body('io')!;

/**
 * Empty space, 23 hexes from the nearest astral body: far enough that no
 * printed base's five-hex detection field and no stray gravity arrow can reach
 * a test set up there.
 */
const DEEP = hex(-28, -10);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RigOptions {
  /** Ownership overrides for printed bases, by base id ("terra:0", "ceres"). */
  readonly owners?: Readonly<Record<string, PlayerId | null>>;
  /** Extra bases the scenario places (orbital bases). */
  readonly bases?: readonly BaseState[];
  /** Start the state in this phase instead of astrogation. */
  readonly phase?: Phase;
  readonly seat?: PlayerId;
  readonly scenarioData?: Record<string, unknown>;
  readonly seed?: number;
}

const rig = (ships: readonly Ship[], o: RigOptions = {}): GameState => {
  const s = createInitialState({
    scenarioId: 'rules-logistics',
    seed: o.seed ?? 4242,
    players: [
      makePlayer(A, 'Player A', 'Alpha', '#e8703a'),
      makePlayer(B, 'Player B', 'Beta', '#4a9fe0'),
    ],
    ships,
    bases: o.bases,
    options: { nukesAllowed: true },
    scenarioData: o.scenarioData ?? {},
  });
  const bases = { ...s.bases };
  for (const [id, owner] of Object.entries(o.owners ?? {})) {
    const base = bases[id];
    if (base) bases[id] = { ...base, owner };
  }
  return {
    ...s,
    bases,
    phase: o.phase ?? 'astrogation',
    activePlayerIndex: o.seat === B ? 1 : 0,
  };
};

const ok = (state: GameState, cmd: Command): GameState => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const refused = (state: GameState, cmd: Command): string => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
  expect(out.state).toBe(state); // a refusal is not an event in the game's history
  return out.result.reason ?? '';
};

const seatOf = (s: GameState): PlayerId => s.playerOrder[s.activePlayerIndex]!;

const advance = (s: GameState): GameState => ok(s, { type: 'endPhase', by: seatOf(s) });

/** Run the phase machine until `phase` comes round for `player`. */
const reach = (s: GameState, phase: Phase, player: PlayerId = A): GameState => {
  let x = s;
  for (let i = 0; i < 40; i += 1) {
    if (x.phase === phase && seatOf(x) === player) return x;
    x = advance(x);
  }
  throw new Error(`never reached ${player}'s ${phase} phase`);
};

/** One full game turn: every seat plays all five phases. */
const wholeTurn = (s: GameState): GameState => {
  const day = s.turn;
  let x = s;
  for (let i = 0; i < 40 && x.turn === day; i += 1) x = advance(x);
  return x;
};

const shipIn = (s: GameState, id: string): Ship => s.ships[id]!;

const ship = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  pos: Hex = DEEP,
  extra: Partial<Ship> = {},
): Ship => ({ ...makeShip({ id, owner, shipClass, pos }), ...extra });

/**
 * A ship in orbit, sitting in the gravity hex above hexside `dir` of `body`,
 * having flown there from the neighbouring gravity hex. "A ship which moves at
 * one hex per turn from one gravity hex to an adjacent gravity hex of the same
 * body is in orbit."
 */
const inOrbitAbove = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  body: typeof TERRA,
  dir: number,
  extra: Partial<Ship> = {},
): Ship => {
  const here = sideGravityHex(hexSide(body.hex, dir));
  const ring = [0, 1, 2, 3, 4, 5].map((d) => sideGravityHex(hexSide(body.hex, d)));
  const from = ring.find((h) => !eqHex(h, here) && map.orbitOf(here, sub(here, h)) !== undefined)!;
  const velocity = sub(here, from);
  expect(map.orbitOf(here, velocity)?.id).toBe(body.id);
  return { ...makeShip({ id, owner, shipClass, pos: here, velocity }), ...extra };
};

const eqHex = (a: Hex, b: Hex): boolean => key(a) === key(b);

const landedOn = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  body: typeof TERRA,
  dir: number,
  extra: Partial<Ship> = {},
): Ship => ({
  ...makeShip({
    id,
    owner,
    shipClass,
    pos: body.hex,
    location: { kind: 'landed', side: hexSide(body.hex, dir) },
  }),
  ...extra,
});

const orbitalBaseAt = (id: string, owner: PlayerId, at: Hex): BaseState => ({
  id,
  kind: 'orbital',
  owner,
  hex: at,
  destroyed: false,
  suppressed: false,
  hasPlanetaryDefences: false,
  firedThisTurn: false,
  launchedThisTurn: false,
  resuppliedThisTurn: false,
});

/** Every Terran hexside to `owner`, so "friendly base" is unambiguous. */
const terraOwners = (owner: PlayerId | null): Record<string, PlayerId | null> =>
  Object.fromEntries([0, 1, 2, 3, 4, 5].map((d) => [`terra:${d}`, owner]));

// Dice ---------------------------------------------------------------------

const seedCache = new Map<string, number>();
/** A generator seed whose next rolls are exactly `faces`, in order. */
const seedFor = (faces: readonly number[]): number => {
  const k = faces.join(',');
  const cached = seedCache.get(k);
  if (cached !== undefined) return cached;
  for (let s = 1; s < 2_000_000; s += 1) {
    let r = createRng(s);
    let good = true;
    for (const want of faces) {
      const roll = rollDie(r);
      r = roll.state;
      if (roll.value !== want) {
        good = false;
        break;
      }
    }
    if (good) {
      seedCache.set(k, s);
      return s;
    }
  }
  throw new Error(`no seed rolls ${k}`);
};

const forceRolls = (state: GameState, faces: readonly number[]): GameState => ({
  ...state,
  rng: createRng(seedFor(faces)),
});

// The Belt -----------------------------------------------------------------

const DIR_Q = [1, 1, 0, -1, -1, 0];
const DIR_R = [0, -1, -1, 0, 1, 1];

/** Two adjacent ordinary asteroid hexes, so a ship can enter one at speed 1. */
const asteroidPair = (): { from: Hex; to: Hex } => {
  for (let q = -30; q <= 30; q += 1) {
    for (let r = -30; r <= 30; r += 1) {
      const a = hex(q, r);
      if (!map.isAsteroid(a) || map.isDenseAsteroid(a)) continue;
      for (let d = 0; d < 6; d += 1) {
        const b = hex(a.q + DIR_Q[d]!, a.r + DIR_R[d]!);
        if (map.isAsteroid(b) && !map.isDenseAsteroid(b)) return { from: a, to: b };
      }
    }
  }
  throw new Error('no adjacent pair of ordinary asteroid hexes');
};

const BELT = asteroidPair();
const BELT_VELOCITY = sub(BELT.to, BELT.from);

// ---------------------------------------------------------------------------
// Sequence of play (p. 2)
// ---------------------------------------------------------------------------

describe('the sequence of play (p. 2)', () => {
  it('runs five phases in the printed order, one player-turn each, then a new day', () => {
    // "Each player-turn is composed of five phases: 1. Astrogation Phase...
    //  2. Ordnance Phase... 3. Movement Phase... 4. Combat Phase... 5. Resupply
    //  Phase." And: "At the end of the resupply phase, the next player turn
    //  begins. At the end of the complete set of player turns, a new game turn
    //  begins."
    expect([...PHASES]).toEqual(['astrogation', 'ordnance', 'movement', 'combat', 'resupply']);

    let s = rig([ship('s', A, 'corvette'), ship('t', B, 'corvette', hex(DEEP.q + 8, DEEP.r))]);
    const seen: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      seen.push(`${s.turn}:${seatOf(s)}:${s.phase}`);
      s = advance(s);
    }
    expect(seen).toEqual([
      '1:a:astrogation',
      '1:a:ordnance',
      '1:a:movement',
      '1:a:combat',
      '1:a:resupply',
      '1:b:astrogation',
      '1:b:ordnance',
      '1:b:movement',
      '1:b:combat',
      '1:b:resupply',
      '2:a:astrogation',
    ]);
  });

  it('keeps refuelling, cargo, looting and capture in the resupply phase', () => {
    // "5. Resupply Phase. Spaceships may refuel, resupply, load and unload
    //  cargo, loot captured ships, or rescue, as appropriate."
    const raider = ship('p', A, 'corsair');
    const prey = ship('v', B, 'transport', DEEP, { disabled: 2 });
    for (const phase of PHASES) {
      const s = rig([raider, prey], { phase });
      const orders: Command[] = [
        { type: 'resupply', by: A, ship: 'p' },
        { type: 'loot', by: A, ship: 'p', target: 'v', items: [{ kind: 'freight', quantity: 1 }] },
        { type: 'capture', by: A, ship: 'p', target: 'v' },
        { type: 'transferCargo', by: A, from: 'p', to: 'v', kind: 'freight', quantity: 1 },
      ];
      for (const order of orders) {
        const out = applyCommand(s, order, map);
        const rejectedForPhase = (out.result.reason ?? '').includes('resupply phase');
        expect({ phase, order: order.type, rejectedForPhase }).toEqual({
          phase,
          order: order.type,
          rejectedForPhase: phase !== 'resupply',
        });
      }
    }
  });

  it('recovers one turn of damage at the end of the resupply phase', () => {
    // "Damage is recovered" (p. 2, phase 5); "A damaged ship will repair itself
    //  at the rate of one 'D' per turn. It recovers at the end of the Resupply
    //  phase" (p. 6).
    let s = rig([ship('s', A, 'corvette', DEEP, { disabled: 3 })]);
    expect(shipIn(s, 's').disabled).toBe(3);
    s = wholeTurn(s);
    expect(shipIn(s, 's').disabled).toBe(2);
    s = wholeTurn(s);
    expect(shipIn(s, 's').disabled).toBe(1);
    s = wholeTurn(s);
    expect(shipIn(s, 's').disabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bases (p. 7)
// ---------------------------------------------------------------------------

describe('bases (p. 7)', () => {
  it('puts planetary bases on exactly the hexsides the rulebook names', () => {
    // "Io and Callisto have only one base each, shown by symbols. Mercury has
    //  two. Terra, Luna, Mars, and Venus have bases on all six sides."
    const sidesOf = (bodyId: string): number =>
      map.allPlanetaryBases().filter((b) => b.bodyId === bodyId).length;

    expect(sidesOf('io')).toBe(1);
    expect(sidesOf('callisto')).toBe(1);
    expect(sidesOf('mercury')).toBe(2);
    for (const world of ['terra', 'luna', 'mars', 'venus']) expect(sidesOf(world)).toBe(6);

    // "The two bases in the asteroid belt (Ceres and Clandestine) are asteroid
    //  bases" — and they sit in a hex, not on a hexside.
    expect(
      map
        .allAsteroidBases()
        .map((b) => b.bodyId)
        .sort(),
    ).toEqual(['ceres', 'clandestine']);
    expect(sidesOf('ceres')).toBe(0);
    expect(sidesOf('clandestine')).toBe(0);

    // Sol and Jupiter are not landing sites, so they carry no bases at all.
    expect(sidesOf('sol')).toBe(0);
    expect(sidesOf('jupiter')).toBe(0);
  });

  it('gives asteroid bases no planetary defences, and leaves ships there open to fire', () => {
    // "They serve the ordinary functions of a base but do not have planetary
    //  defenses... Ships at asteroid bases may attack and be attacked normally."
    const s0 = rig([]);
    for (const id of ['ceres', 'clandestine']) {
      const base = s0.bases[id]!;
      expect({ id, kind: base.kind, defences: base.hasPlanetaryDefences }).toEqual({
        id,
        kind: 'asteroid',
        defences: false,
      });
    }

    const docked = ship('d', A, 'corvette', CERES.hex, {
      location: { kind: 'asteroidBase', hex: CERES.hex },
    });
    const raider = ship('r', B, 'corsair', hex(CERES.hex.q + 1, CERES.hex.r));
    const s = rig([docked, raider], { owners: { ceres: A }, phase: 'combat', seat: B });
    expect(previewAttack(s, ['r'], ['d'], map).legal).toBe(true);
    expect(previewAttack(s, ['d'], ['r'], map).legal).toBe(true);
  });

  it('lets nothing but a nuke harm an asteroid base', () => {
    // "They may not be harmed except by a nuke (scenarios may vary this rule)."
    const raider = ship('r', B, 'corsair', hex(CERES.hex.q + 1, CERES.hex.r));
    const guns = rig([raider], { owners: { ceres: A }, phase: 'combat', seat: B });
    // The base is not a target the gunnery rules can even name.
    expect(previewAttack(guns, ['r'], ['ceres'], map).legal).toBe(false);
    refused(guns, { type: 'attack', by: B, attackers: ['r'], targets: ['ceres'] });

    // "A nuke explodes when it enters any hex containing a ship, base, asteroid,
    //  mine, or torpedo... It destroys everything in the hex automatically."
    const bomber = ship('n', B, 'frigate', hex(CERES.hex.q - 1, CERES.hex.r), {
      velocity: hex(1, 0),
      cargo: [{ kind: 'nuke', quantity: 1 }],
    });
    let s = rig([bomber], { owners: { ceres: A }, phase: 'ordnance', seat: B });
    s = ok(s, { type: 'launchOrdnance', by: B, ship: 'n', kind: 'nuke' });
    s = reach(s, 'combat', B); // the movement phase flies the nuke into Ceres
    expect(s.bases['ceres']!.destroyed).toBe(true);
  });

  it('fires one torpedo a turn from an asteroid base, out of stores it never runs down', () => {
    // "The two bases in the asteroid belt (Ceres and Clandestine) are asteroid
    //  bases... They are capable of launching one torpedo per turn." The base
    //  needs no hold to draw from: "All bases (planetary, asteroid, and orbital)
    //  carry an unlimited supply of fuel, mines, and torpedoes."
    const aim = hex(2, 0);
    let s = rig([], { owners: { ceres: A }, phase: 'ordnance' });
    s = ok(s, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim });

    const fired = Object.values(s.ordnance);
    expect(fired.map((o) => ({ kind: o.kind, from: key(o.pos), vector: key(o.velocity) }))).toEqual(
      [{ kind: 'torpedo', from: key(CERES.hex), vector: key(aim) }],
    );

    // "one torpedo per turn" — and only one.
    expect(refused(s, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim })).toMatch(
      /already launched/i,
    );

    // Next turn it is loaded again; no magazine was ever debited.
    const later = reach(wholeTurn(s), 'ordnance', A);
    ok(later, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim });
  });

  it('gives a base torpedo the one or two hexes of boost a torpedo gets, and no more', () => {
    // "On the turn in which a torpedo is launched (and only on that turn), it may
    //  accelerate one or two hexes in any direction." A base stands still, so
    //  that boost is the torpedo's whole vector.
    const s = rig([], { owners: { ceres: A }, phase: 'ordnance' });
    expect(refused(s, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim: hex(3, 0) })).toMatch(
      /one or two hexes/i,
    );
    expect(refused(s, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim: hex(0, 0) })).toMatch(
      /one or two hexes/i,
    );
    ok(s, { type: 'launchBaseTorpedo', by: A, base: 'ceres', aim: hex(-1, 2) });
  });

  it('arms a base bought in play, and keeps its torpedo and its pumps out of the same turn', () => {
    // "It may fire one torpedo per turn, providing resupply operations are not in
    //  progress", and its mirror: "An orbital base resupplying any ship may not
    //  fire its guns or launch ordnance during that player-turn."
    const carrier = inOrbitAbove('c', A, 'transport', TERRA, 0, {
      cargo: [{ kind: 'orbitalBase', quantity: 1 }],
    });
    let s = rig([carrier]);
    s = ok(s, { type: 'emplaceEquipment', by: A, ship: 'c', kind: 'orbitalBase' });
    const placed = Object.values(s.bases).find((b) => b.kind === 'orbital')!;
    expect(placed.owner).toBe(A);

    // A ship moored alongside it: "it stops moving and remains with the base".
    const client = ship('f', A, 'frigate', placed.hex, { fuel: 2 });
    s = { ...s, ships: { ...s.ships, f: client } };

    const armed = reach(s, 'ordnance', A);
    const fired = ok(armed, { type: 'launchBaseTorpedo', by: A, base: placed.id, aim: hex(1, 0) });
    expect(Object.values(fired.ordnance).map((o) => o.kind)).toEqual(['torpedo']);

    // Having launched, the base may not also run the pumps this player-turn.
    expect(
      refused({ ...fired, phase: 'resupply' }, { type: 'resupply', by: A, ship: 'f' }),
    ).toMatch(/already fired/i);

    // And the other way round: a base that has resupplied has spent its turn.
    const supplied = ok({ ...s, phase: 'resupply' }, { type: 'resupply', by: A, ship: 'f' });
    expect(
      refused(
        { ...supplied, phase: 'ordnance' },
        { type: 'launchBaseTorpedo', by: A, base: placed.id, aim: hex(1, 0) },
      ),
    ).toMatch(/resupplying/i);
  });

  it('emplaces a bought base in a gravity hex only from orbit, and only from a transport or packet', () => {
    // "In a gravity hex of a planet or satellite. The ship carrying the base
    //  must be in orbit to emplace the base." / "A base may be carried only by
    //  a transport or packet."
    const hold = [{ kind: 'orbitalBase' as CargoKind, quantity: 1 }];

    const orbiting = inOrbitAbove('c', A, 'transport', TERRA, 0, { cargo: hold });
    const fromOrbit = ok(rig([orbiting]), {
      type: 'emplaceEquipment',
      by: A,
      ship: 'c',
      kind: 'orbitalBase',
    });
    const placed = Object.values(fromOrbit.bases).find((b) => b.kind === 'orbital')!;
    expect(key(placed.hex)).toBe(key(orbiting.pos));
    // "Once placed, a base cannot be picked up again or moved" — it has left the hold.
    expect(fromOrbit.ships['c']!.cargo).toEqual([]);

    // Adrift in the same hex, not in orbit: no emplacement.
    const drifting = ship('c', A, 'transport', orbiting.pos, { velocity: hex(2, 0), cargo: hold });
    refused(rig([drifting]), { type: 'emplaceEquipment', by: A, ship: 'c', kind: 'orbitalBase' });

    // A warship may not carry one at all, so it can hardly emplace one. The
    // cargo chapter is narrower still ("only a transport may carry an orbital
    // base", p. 8); both readings agree that a frigate may not.
    const frigate = ship('f', A, 'frigate', orbiting.pos);
    expect(canCarry(frigate, 'orbitalBase', 1)).not.toBeNull();
    expect(canCarry(ship('t', A, 'transport'), 'orbitalBase', 1)).toBeNull();
  });

  it('keeps a lightly damaged orbital base firing, and silences a wrecked one', () => {
    // "Exceptions: ... An orbital base may launch torpedoes, fire guns, and
    //  resupply friendly ships while the base itself is slightly (D1) damaged."
    // A D1 base is therefore an exception to "A disabled ship cannot maneuver,
    // launch ordnance, or attack"; a D2 base is not.
    const client = inOrbitAbove('f', A, 'corvette', TERRA, 0, { fuel: 1 });
    const enemy = ship('e', B, 'corvette', hex(client.pos.q + 1, client.pos.r));
    const base = orbitalBaseAt('orb', A, client.pos);

    for (const [damage, working] of [
      [1, true],
      [2, false],
    ] as const) {
      const counter = ship('obs', A, 'orbitalBase', client.pos, {
        disabled: damage,
        cargo: [{ kind: 'torpedo', quantity: 1 }],
      });
      const s = rig([counter, client, enemy], {
        bases: [base],
        owners: terraOwners(B),
        phase: 'ordnance',
      });
      const launch = applyCommand(
        s,
        {
          type: 'launchOrdnance',
          by: A,
          ship: 'obs',
          kind: 'torpedo',
        },
        map,
      );
      expect({ damage, fire: canFire(counter), torpedo: launch.result.ok }).toEqual({
        damage,
        fire: working,
        torpedo: working,
      });

      // The third of the three — resupplying friendly ships — is still open to
      // the D1 base.
      if (working) {
        ok({ ...s, phase: 'resupply' }, { type: 'resupply', by: A, ship: 'f' });
      }
      // The third verb — resupply — is deliberately not asserted for the D2
      // base. The general prohibition is an exhaustive-looking list that never
      // mentions it ("A disabled ship cannot maneuver, launch ordnance, or
      // attack"), so a wrecked base that still runs its pumps contradicts no
      // printed sentence; that it should stop is an inference from the wording
      // of the exception. Recorded in docs/RULES-MAPPING.md.
    }
  });

  it('turns a base emplaced on a bare hexside into a planetary base', () => {
    // "On a world surface hex side which does not already have a base present.
    //  It is now treated as a planetary base and can provide detection and
    //  planetary defense fire."
    const side = hexSide(TERRA.hex, 4);
    const carrier = landedOn('c', A, 'transport', TERRA, 4, {
      cargo: [{ kind: 'orbitalBase', quantity: 1 }],
    });
    // Clear the printed base off that hexside first.
    const bare = rig([carrier]);
    let s: GameState = {
      ...bare,
      bases: Object.fromEntries(Object.entries(bare.bases).filter(([id]) => id !== 'terra:4')),
    };
    s = ok(s, { type: 'emplaceEquipment', by: A, ship: 'c', kind: 'orbitalBase', side });

    const built = Object.values(s.bases).find(
      (b) => b.side !== undefined && b.side.dir === 4 && eqHex(b.hex, TERRA.hex),
    )!;
    expect({ kind: built.kind, defences: built.hasPlanetaryDefences, owner: built.owner }).toEqual({
      kind: 'planetary',
      defences: true,
      owner: A,
    });
    // "detectors on planetary bases have a range of five hexes" (p. 8).
    expect(detectionRangeOfBase(built)).toBe(DETECTION_RANGE_PLANETARY_BASE);

    // "Planetary bases may fire at enemy ships in the gravity hex directly
    //  above the base's hex side."
    const withEnemy: GameState = {
      ...s,
      phase: 'combat',
      ships: { ...s.ships, e: ship('e', B, 'corvette', sideGravityHex(side)) },
    };
    ok(withEnemy, { type: 'firePlanetaryDefence', by: A, base: built.id, targets: ['e'] });

    // "...which does not already have a base present."
    const occupied = rig([carrier]);
    refused(occupied, {
      type: 'emplaceEquipment',
      by: A,
      ship: 'c',
      kind: 'orbitalBase',
      side,
    });
  });
});

// ---------------------------------------------------------------------------
// Resupply from bases (p. 8): matching courses
// ---------------------------------------------------------------------------

describe('resupply from bases (p. 8): matching courses', () => {
  it('resupplies a ship landed on the base’s own hexside', () => {
    // "For planetary bases, the ship must either land on the world in the same
    //  hex side as the base, or pass through the gravity hex directly above the
    //  base's hex side while in orbit."
    const landed = landedOn('s', A, 'corvette', TERRA, 0, { fuel: 1 });
    const s = rig([landed], { owners: { ...terraOwners(B), 'terra:0': A } });
    expect(canResupplyAt(s, shipIn(s, 's'), map)).toEqual({ ok: true, baseId: 'terra:0' });

    // Landed on a hexside whose base belongs to the enemy: no fuel here.
    const enemy = rig([landed], { owners: terraOwners(B) });
    expect(canResupplyAt(enemy, shipIn(enemy, 's'), map).ok).toBe(false);

    // Landed on a hexside with no base at all.
    const stripped = rig([landed]);
    const bare: GameState = {
      ...stripped,
      bases: Object.fromEntries(Object.entries(stripped.bases).filter(([id]) => id !== 'terra:0')),
    };
    expect(canResupplyAt(bare, shipIn(bare, 's'), map).ok).toBe(false);
  });

  it('resupplies a ship in orbit over the gravity hex directly above the base', () => {
    // Same clause: "...or pass through the gravity hex directly above the base's
    //  hex side while in orbit."
    const orbiter = inOrbitAbove('s', A, 'corvette', TERRA, 0, { fuel: 1 });
    const s = rig([orbiter], { owners: { ...terraOwners(B), 'terra:0': A } });
    expect(canResupplyAt(s, shipIn(s, 's'), map)).toEqual({ ok: true, baseId: 'terra:0' });

    // The same hex, at speed, is not orbit: "A ship which moves at one hex per
    // turn from one gravity hex to an adjacent gravity hex of the same body is
    // in orbit."
    const fast = ship('s', A, 'corvette', orbiter.pos, { velocity: hex(2, 0), fuel: 1 });
    const t = rig([fast], { owners: terraOwners(A) });
    expect(map.orbitOf(fast.pos, fast.velocity)).toBeUndefined();
    expect(canResupplyAt(t, shipIn(t, 's'), map).ok).toBe(false);

    // Stationary above the base — the position a ship holds straight after
    // takeoff — is not orbit either.
    const hanging = ship('s', A, 'corvette', orbiter.pos, { fuel: 1 });
    const u = rig([hanging], { owners: terraOwners(A) });
    expect(canResupplyAt(u, shipIn(u, 's'), map).ok).toBe(false);

    // It has to be *that* base's gravity hex. Io "has only one base", on
    // hexside 3, so the far side of its orbital ring is over nothing at all.
    const ioBase = map.allPlanetaryBases().find((b) => b.bodyId === 'io')!;
    expect(ioBase.side.dir).toBe(3);
    const overTheBase = inOrbitAbove('s', A, 'corvette', IO, 3, { fuel: 1 });
    const w = rig([overTheBase], { owners: { [ioBase.id]: A } });
    expect(canResupplyAt(w, shipIn(w, 's'), map)).toEqual({ ok: true, baseId: ioBase.id });

    const elsewhereInOrbit = inOrbitAbove('s', A, 'corvette', IO, 1, { fuel: 1 });
    const x = rig([elsewhereInOrbit], { owners: { [ioBase.id]: A } });
    expect(map.orbitOf(elsewhereInOrbit.pos, elsewhereInOrbit.velocity)?.id).toBe('io');
    expect(canResupplyAt(x, shipIn(x, 's'), map).ok).toBe(false);
  });

  it('makes an asteroid base require a full stop in its hex', () => {
    // "For asteroid bases, matching courses requires that the ship stop in the
    //  base hex."
    const stopped = ship('s', A, 'corvette', CERES.hex, {
      fuel: 1,
      location: { kind: 'asteroidBase', hex: CERES.hex },
    });
    const s = rig([stopped], { owners: { ceres: A } });
    expect(canResupplyAt(s, shipIn(s, 's'), map)).toEqual({ ok: true, baseId: 'ceres' });

    const passing = ship('s', A, 'corvette', CERES.hex, { velocity: hex(1, 0), fuel: 1 });
    const t = rig([passing], { owners: { ceres: A } });
    expect(canResupplyAt(t, shipIn(t, 's'), map).ok).toBe(false);

    // Stopping on a bare belt rock is a landing but not a resupply: "Ships may
    // land at Ceres and Clandestine, or at any unnamed asteroid in the Belt, by
    // simply stopping in the hex" — only two of those rocks carry a base.
    const rock = ship('s', A, 'corvette', BELT.to, {
      fuel: 1,
      location: { kind: 'asteroidBase', hex: BELT.to },
    });
    const u = rig([rock]);
    expect(canResupplyAt(u, shipIn(u, 's'), map).ok).toBe(false);
  });

  it('makes an orbital base require orbit and the same hex', () => {
    // "For orbital bases, the ship must match courses with the base by being in
    //  orbit and in the same hex."
    const orbiter = inOrbitAbove('s', A, 'corvette', TERRA, 2, { fuel: 1 });
    const base = orbitalBaseAt('orb', A, orbiter.pos);
    const s = rig([orbiter], { bases: [base], owners: terraOwners(B) });
    expect(canResupplyAt(s, shipIn(s, 's'), map)).toEqual({ ok: true, baseId: 'orb' });

    // Barrelling through the hex at speed 2 matches nothing.
    const fast = ship('s', A, 'corvette', orbiter.pos, { velocity: hex(2, 0), fuel: 1 });
    const t = rig([fast], { bases: [base], owners: terraOwners(B) });
    expect(canResupplyAt(t, shipIn(t, 's'), map).ok).toBe(false);

    // An enemy's orbital base is no use either.
    const enemyBase = orbitalBaseAt('orb', B, orbiter.pos);
    const u = rig([orbiter], { bases: [enemyBase], owners: terraOwners(B) });
    expect(canResupplyAt(u, shipIn(u, 's'), map).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refuelling is maintenance (p. 8)
// ---------------------------------------------------------------------------

describe('refuelling is maintenance (p. 8)', () => {
  it('fills the tanks, repairs every point of damage and hands back the overload', () => {
    // "Whenever a ship is refueled from a base, it automatically undergoes
    //  maintenance. This repairs all remaining damage and allows the ship to
    //  perform the overload maneuver once."
    const wreck = landedOn('s', A, 'frigate', TERRA, 0, {
      fuel: 1,
      disabled: 4,
      overloadAvailable: false,
      advancedDamage: { weapon: 3, drive: 2, structure: 1 },
      detectedBy: [B],
    });
    let s = rig([wreck], { owners: { 'terra:0': A }, phase: 'resupply' });
    s = ok(s, { type: 'resupply', by: A, ship: 's' });

    const after = shipIn(s, 's');
    expect({
      fuel: after.fuel,
      disabled: after.disabled,
      damage: after.advancedDamage,
      overload: after.overloadAvailable,
    }).toEqual({
      fuel: SHIP_CLASSES.frigate.fuelCapacity,
      disabled: 0,
      damage: { weapon: 0, drive: 0, structure: 0 },
      overload: true,
    });

    // "Once a ship has been detected by the enemy, it remains detected
    //  (regardless of range) until it arrives at a friendly base." It has.
    expect(after.detectedBy).toEqual([]);
  });

  it('never hands a commercial ship an overload manoeuvre', () => {
    // "Commercial ships (transports, packets, tankers, liners) may not perform
    //  the overload maneuver" (p. 4) — maintenance cannot grant what the class
    //  never had.
    for (const cls of ['transport', 'packet', 'tanker', 'liner'] as const) {
      const trader = landedOn('s', A, cls, TERRA, 0, { fuel: 0, overloadAvailable: false });
      let s = rig([trader], { owners: { 'terra:0': A }, phase: 'resupply' });
      s = ok(s, { type: 'resupply', by: A, ship: 's' });
      expect({ cls, overload: shipIn(s, 's').overloadAvailable }).toEqual({
        cls,
        overload: false,
      });
    }
  });

  it('reloads any assortment of mines and torpedoes that fits the hold, and nothing else', () => {
    // "In addition, all ordnance is automatically reloaded; the ship may select
    //  any assortment of mines and torpedoes which fits in the hold capacity of
    //  the ship." A frigate's hold is 40 tons; a mine is 10 and a torpedo 20.
    const empty = landedOn('f', A, 'frigate', TERRA, 0, { fuel: 1 });
    const base = rig([empty], { owners: { 'terra:0': A }, phase: 'resupply' });

    const mixed = ok(base, {
      type: 'resupply',
      by: A,
      ship: 'f',
      loadout: [
        { kind: 'torpedo', quantity: 1 },
        { kind: 'mine', quantity: 2 },
      ],
    });
    expect(cargoMass(shipIn(mixed, 'f'))).toBe(40);

    // 3 torpedoes is 60 tons: over the side.
    refused(base, {
      type: 'resupply',
      by: A,
      ship: 'f',
      loadout: [{ kind: 'torpedo', quantity: 3 }],
    });

    // "All bases (planetary, asteroid, and orbital) carry an unlimited supply of
    //  fuel, mines, and torpedoes" — nukes are not on the shelf, and are
    //  "available only if the scenario specifies" (p. 6).
    expect([...RESUPPLY_ORDNANCE].sort()).toEqual(['mine', 'torpedo']);
    refused(base, { type: 'resupply', by: A, ship: 'f', loadout: [{ kind: 'nuke', quantity: 1 }] });

    // A corvette's 5-ton hold cannot take even one mine.
    const corvette = landedOn('c', A, 'corvette', TERRA, 0, { fuel: 1 });
    const small = rig([corvette], { owners: { 'terra:0': A }, phase: 'resupply' });
    refused(small, {
      type: 'resupply',
      by: A,
      ship: 'c',
      loadout: [{ kind: 'mine', quantity: 1 }],
    });
  });

  it('fills the tank and repairs everything in one stop', () => {
    // "Whenever a ship is refueled from a base, it automatically undergoes
    //  maintenance. This repairs all remaining damage and allows the ship to
    //  perform the overload maneuver once."
    //
    // A single stop is the whole of it: the rulebook nowhere rations calls at
    // the pumps, and it has no reason to — a second one would find the tank
    // already full and the damage already gone. That is what is checked here,
    // rather than the engine's once-a-turn flag.
    const thirsty = landedOn('s', A, 'corvette', TERRA, 0, {
      fuel: 2,
      disabled: 3,
      overloadAvailable: false,
    });
    let s = rig([thirsty], { owners: { 'terra:0': A }, phase: 'resupply' });
    s = ok(s, { type: 'resupply', by: A, ship: 's' });
    const fuelled = shipIn(s, 's');
    expect({
      fuel: fuelled.fuel,
      disabled: fuelled.disabled,
      overload: fuelled.overloadAvailable,
    }).toEqual({
      fuel: SHIP_CLASSES.corvette.fuelCapacity,
      disabled: 0,
      overload: true,
    });
  });

  it('refuses a ship that has fired its guns or launched ordnance this player-turn', () => {
    // "No ship may fire its guns or launch ordnance during a player-turn in
    //  which it resupplies." Resupply is phase 5 and gunnery phase 4, so within
    //  a player-turn the rule can only bite backwards.
    const gunner = inOrbitAbove('g', A, 'corsair', TERRA, 0, { fuel: 1 });
    const target = ship('e', B, 'corvette', gunner.pos);
    let s = rig([gunner, target], { owners: { 'terra:0': A }, phase: 'combat' });
    s = ok(s, { type: 'attack', by: A, attackers: ['g'], targets: ['e'] });
    s = ok(s, { type: 'declineCounterattack', by: B });
    s = { ...s, phase: 'resupply' };
    expect(canResupplyAt(s, shipIn(s, 'g'), map).ok).toBe(true);
    expect(refused(s, { type: 'resupply', by: A, ship: 'g' })).toMatch(/fire its guns|launch/);

    // The same for a mine dropped in the ordnance phase.
    const layer = inOrbitAbove('m', A, 'frigate', TERRA, 0, {
      fuel: 5,
      cargo: [{ kind: 'mine', quantity: 1 }],
    });
    let t = rig([layer], { owners: { 'terra:0': A }, phase: 'ordnance' });
    t = ok(t, { type: 'launchOrdnance', by: A, ship: 'm', kind: 'mine' });
    t = { ...t, phase: 'resupply' };
    expect(refused(t, { type: 'resupply', by: A, ship: 'm' })).toMatch(/fire its guns|launch/);
  });

  it('silences an orbital base that resupplies anybody, and refuses one that has fired', () => {
    // "An orbital base resupplying any ship may not fire its guns or launch
    //  ordnance during that player-turn." The base is a counter for gunnery and
    //  a base record for supply, so both halves have to move together.
    const client = inOrbitAbove('f', A, 'corvette', TERRA, 0, { fuel: 1 });
    const counter = ship('obs', A, 'orbitalBase', client.pos);
    const enemy = ship('e', B, 'corvette', hex(client.pos.q + 1, client.pos.r));
    const base = orbitalBaseAt('orb', A, client.pos);

    // Resupply first: the base has spent its player-turn.
    let s = rig([counter, client, enemy], {
      bases: [base],
      owners: terraOwners(B),
      phase: 'resupply',
    });
    s = ok(s, { type: 'resupply', by: A, ship: 'f' });
    expect(s.ships['obs']!.resuppliedThisTurn).toBe(true);
    expect(canFire(s.ships['obs']!)).toBe(false);
    expect(previewAttack(s, ['obs'], ['e'], map).legal).toBe(false);

    // Fire first: the pumps are closed for the rest of the player-turn.
    let t = rig([counter, client, enemy], {
      bases: [base],
      owners: terraOwners(B),
      phase: 'combat',
    });
    t = ok(t, { type: 'attack', by: A, attackers: ['obs'], targets: ['e'] });
    t = ok(t, { type: 'declineCounterattack', by: B });
    t = { ...t, phase: 'resupply' };
    expect(canResupplyAt(t, t.ships['f']!, map).ok).toBe(true);
    expect(refused(t, { type: 'resupply', by: A, ship: 'f' })).toMatch(/fired/);
  });

  it('stops a ship that has matched courses with an orbital base', () => {
    // "For orbital bases, the ship must match courses with the base by being in
    //  orbit and in the same hex. Having done so, it stops moving and remains
    //  with the base."
    //
    // How long "remains with the base" lasts is not tested here, and the reading
    // is genuinely open: the sentence sits in the matching-courses paragraph,
    // parallel to "For asteroid bases, matching courses requires that the ship
    // stop in the base hex", so it reads as how you dock rather than as a
    // standing exemption from a gravity the rules elsewhere call "cumulative and
    // mandatory" — and p. 4 says of exactly this position that "Unless fuel is
    // spent on the next turn, the ship would fall back to the planet and crash."
    // What the clause plainly does say is that the ship stops.
    const client = inOrbitAbove('f', A, 'corvette', TERRA, 0, { fuel: 4 });
    const base = orbitalBaseAt('orb', A, client.pos);
    let s = rig([client], { bases: [base], owners: terraOwners(B), phase: 'resupply' });
    expect(key(shipIn(s, 'f').velocity)).not.toBe('0,0');

    s = ok(s, { type: 'resupply', by: A, ship: 'f' });
    const moored = shipIn(s, 'f');
    expect({ velocity: key(moored.velocity), where: key(moored.pos) }).toEqual({
      velocity: '0,0',
      where: key(base.hex),
    });
  });

  it('charges MCr .5 a point for fuel in a Prospecting game, and nothing elsewhere', () => {
    // "Fuel: MCr .5 per point of fuel, available at any friendly base" (p. 13).
    expect(FUEL_PRICE).toBe(0.5);
    const thirsty = landedOn('s', A, 'corvette', TERRA, 0, { fuel: 4 });
    const prospecting = rig([thirsty], {
      owners: { 'terra:0': A },
      phase: 'resupply',
      scenarioData: { prospecting: true },
    });
    const rich: GameState = {
      ...prospecting,
      players: { ...prospecting.players, [A]: { ...prospecting.players[A]!, megacredits: 10 } },
    };
    const paid = ok(rich, { type: 'resupply', by: A, ship: 's' });
    // 16 points to fill a corvette's 20-point tank, at MCr .5 each.
    expect(paid.players[A]!.megacredits).toBe(2);
    expect(shipIn(paid, 's').fuel).toBe(20);

    const broke: GameState = {
      ...prospecting,
      players: { ...prospecting.players, [A]: { ...prospecting.players[A]!, megacredits: 1 } },
    };
    refused(broke, { type: 'resupply', by: A, ship: 's' });

    // "If no cost is given in the scenario, then fuel is too cheap to keep track
    //  of in the game — i.e., free" (p. 9).
    const elsewhere = rig([thirsty], { owners: { 'terra:0': A }, phase: 'resupply' });
    const free = ok(elsewhere, { type: 'resupply', by: A, ship: 's' });
    expect(shipIn(free, 's').fuel).toBe(20);
    expect(free.players[A]!.megacredits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Torch ships (p. 8)
// ---------------------------------------------------------------------------

describe('torch ships (p. 8)', () => {
  it('never run out of fuel and never give any away', () => {
    // "Torch ships employ an experimental fusion drive not yet suitable for mass
    //  production. They have unlimited fuel but may not transfer fuel to other
    //  ships." The ship table backs it: fuel capacity "*", "Torchships have
    //  unlimited fuel."
    const torch = ship('t', A, 'torch', DEEP);
    expect(hasUnlimitedFuel(torch)).toBe(true);
    expect(fuelCapacity(torch)).toBe(Infinity);
    expect(torch.fuel).toBe(Infinity);

    const friend = ship('f', A, 'corvette', DEEP, { fuel: 5 });
    const s = rig([torch, friend], { phase: 'resupply' });
    expect(coursesMatched(torch, friend)).toBe(true);
    expect(
      refused(s, { type: 'transferCargo', by: A, from: 't', to: 'f', kind: 'fuel', quantity: 5 }),
    ).toMatch(/torch/i);

    // Nor may an enemy siphon it: looting is a transfer like any other.
    const prize = ship('t', B, 'torch', DEEP, { disabled: 2 });
    const raider = ship('r', A, 'corsair', DEEP, { fuel: 1 });
    const t = rig([prize, raider], { phase: 'resupply' });
    expect(
      refused(t, {
        type: 'loot',
        by: A,
        ship: 'r',
        target: 't',
        items: [{ kind: 'fuel', quantity: 5 }],
      }),
    ).toMatch(/torch/i);

    // Its guns and hold are a frigate's: "It has the guns, but not the hold
    // capacity, of a frigate."
    expect(SHIP_CLASSES.torch.combatStrength).toBe(SHIP_CLASSES.frigate.combatStrength);
    expect(SHIP_CLASSES.torch.cargoCapacity).toBeLessThan(SHIP_CLASSES.frigate.cargoCapacity);
  });
});

// ---------------------------------------------------------------------------
// Cargo (p. 8) and the price list (p. 9)
// ---------------------------------------------------------------------------

describe('cargo (p. 8)', () => {
  it('holds cargo up to the printed capacity, and disregards fuel', () => {
    // "Every ship has a cargo capacity (in tons) shown on the counter. A ship
    //  may carry cargo whose total mass is less than or equal to its cargo
    //  capacity." And: "Fuel is not 'cargo' and its mass is disregarded."
    const frigate = ship('f', A, 'frigate', DEEP, { cargo: [{ kind: 'torpedo', quantity: 2 }] });
    expect(cargoMass(frigate)).toBe(40);
    expect(cargoSpace(frigate)).toBe(0);
    expect(canCarry(frigate, 'mine', 1)).not.toBeNull();

    const tanker = ship('k', A, 'tanker', DEEP, { fuel: 50 });
    expect(cargoMass(tanker)).toBe(0); // 50 points of fuel weigh nothing
    expect(cargoSpace(tanker)).toBe(0); // "Cargo Capacity 0"
    expect(canCarry(tanker, 'mine', 1)).not.toBeNull();

    // The printed capacities themselves (p. 1).
    const printed: Record<string, [number, number]> = {
      transport: [10, 50],
      packet: [10, 50],
      tanker: [50, 0],
      liner: [10, 0],
      corvette: [20, 5],
      corsair: [20, 10],
      frigate: [20, 40],
      dreadnaught: [15, 50],
    };
    for (const [cls, [fuel, hold]] of Object.entries(printed)) {
      const def = SHIP_CLASSES[cls as ShipClass];
      expect({ cls, fuel: def.fuelCapacity, hold: def.cargoCapacity }).toEqual({ cls, fuel, hold });
    }
  });

  it('lets non-warships carry only one nuke, and ships ordnance whole', () => {
    // "Note that non-warships may carry only one nuke at a time, and that only a
    //  transport may carry an orbital base."
    const transport = ship('t', A, 'transport', DEEP);
    expect(canCarry(transport, 'nuke', 1)).toBeNull();
    expect(canCarry(transport, 'nuke', 2)).not.toBeNull();
    const loaded = ship('t', A, 'transport', DEEP, { cargo: [{ kind: 'nuke', quantity: 1 }] });
    expect(canCarry(loaded, 'nuke', 1)).not.toBeNull();

    // A warship's only limit is its hold: a frigate's 40 tons takes two nukes.
    const frigate = ship('f', A, 'frigate', DEEP);
    expect(canCarry(frigate, 'nuke', 2)).toBeNull();
    expect(canCarry(frigate, 'nuke', 3)).not.toBeNull();

    // Half a mine is not a thing that can be shipped. The rulebook does not say
    // so in as many words — "An item of cargo may not be split among two or more
    // ships for transport" is about one item divided between two hulls — but a
    // mine, a torpedo and a nuke are each named as single objects with a fixed
    // mass, and half of one appears nowhere. Ore is the counter-case the mining
    // rules force: it comes out of the rock "at .1 ton per turn" (p. 13).
    expect(canCarry(transport, 'mine', 0.5)).not.toBeNull();
    expect(canCarry(transport, 'ore', 0.5)).toBeNull();
  });

  it('prices and masses equipment as the table prints it (p. 9)', () => {
    // "Mine 10/10 · Torpedo 20/20 · Nuke 300/20 · Scanners 30/– · PM Grapples
    //  40/10 · Automated Mine 5/10 · Robot Guards 50/10 · Ore varies/1 · CT
    //  Shard varies/10."
    const printed: Record<string, { cost: number | null; mass: number }> = {
      mine: { cost: 10, mass: 10 },
      torpedo: { cost: 20, mass: 20 },
      nuke: { cost: 300, mass: 20 },
      scanners: { cost: 30, mass: 0 },
      pmGrapples: { cost: 40, mass: 10 },
      automatedMine: { cost: 5, mass: 10 },
      robotGuards: { cost: 50, mass: 10 },
      ore: { cost: null, mass: 1 },
      ctShard: { cost: null, mass: 10 },
    };
    for (const [kind, want] of Object.entries(printed)) {
      const def = CARGO[kind as CargoKind];
      expect({ kind, cost: def.cost, mass: def.mass }).toEqual({ kind, ...want });
    }

    // Ship costs, in MCr, from the counter table (p. 1).
    const ships: Record<string, number> = {
      transport: 10,
      packet: 20,
      tanker: 10,
      liner: 50,
      corvette: 40,
      corsair: 80,
      frigate: 150,
      dreadnaught: 600,
      torch: 400,
      orbitalBase: 1000,
    };
    for (const [cls, cost] of Object.entries(ships)) {
      expect({ cls, cost: SHIP_CLASSES[cls as ShipClass].cost }).toEqual({ cls, cost });
    }
  });

  it('sells ships only at a base open to the buyer, and only for money in hand', () => {
    // "New ships and equipment may be purchased on any world as soon as a player
    //  accumulates enough money" (p. 13) — a world, and enough money. That a
    //  world held by the *enemy* is not one of them is the engine's reading of
    //  "on any world"; the scenario that speaks to it narrows things further
    //  still ("Ships appear immediately on any world controlled by the player"),
    //  which is tested in tests/rules-ships.test.ts.
    const yard = rig([], { owners: { 'terra:0': A }, phase: 'resupply' });
    const funded: GameState = {
      ...yard,
      players: { ...yard.players, [A]: { ...yard.players[A]!, megacredits: 100 } },
    };
    const bought = ok(funded, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'corvette',
      at: TERRA.hex,
      side: hexSide(TERRA.hex, 0),
    });
    expect(bought.players[A]!.megacredits).toBe(60);
    // "All new ships start with a full fuel load."
    const built = Object.values(bought.ships).find((x) => x.shipClass === 'corvette')!;
    expect(built.fuel).toBe(SHIP_CLASSES.corvette.fuelCapacity);

    refused(funded, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'dreadnaught',
      at: TERRA.hex,
      side: hexSide(TERRA.hex, 0),
    });

    const enemyYard: GameState = {
      ...funded,
      bases: { ...funded.bases, 'terra:0': { ...funded.bases['terra:0']!, owner: B } },
    };
    refused(enemyYard, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'corvette',
      at: TERRA.hex,
      side: hexSide(TERRA.hex, 0),
    });
  });
});

// ---------------------------------------------------------------------------
// Looting and rescue (p. 8)
// ---------------------------------------------------------------------------

describe('looting and rescue (p. 8)', () => {
  it('moves nothing between ships that have not matched course and position', () => {
    // "The only way for anything to be transferred between ships is for both to
    //  have the same course and position."
    const a = ship('a', A, 'corsair', DEEP, { velocity: hex(1, 0), fuel: 4 });
    const sameCourse = ship('b', B, 'transport', DEEP, { velocity: hex(1, 0), disabled: 1 });
    const otherSpeed = ship('c', B, 'transport', DEEP, { velocity: hex(2, 0), disabled: 1 });
    const otherHex = ship('d', B, 'transport', hex(DEEP.q + 1, DEEP.r), {
      velocity: hex(1, 0),
      disabled: 1,
    });
    expect(coursesMatched(a, sameCourse)).toBe(true);
    expect(coursesMatched(a, otherSpeed)).toBe(false);
    expect(coursesMatched(a, otherHex)).toBe(false);

    const s = rig([a, sameCourse, otherSpeed, otherHex], { phase: 'resupply' });
    ok(s, { type: 'loot', by: A, ship: 'a', target: 'b', items: [{ kind: 'fuel', quantity: 1 }] });
    refused(s, {
      type: 'loot',
      by: A,
      ship: 'a',
      target: 'c',
      items: [{ kind: 'fuel', quantity: 1 }],
    });
    refused(s, {
      type: 'loot',
      by: A,
      ship: 'a',
      target: 'd',
      items: [{ kind: 'fuel', quantity: 1 }],
    });

    // Two ships on the ground share a hex without being alongside each other:
    // a ship "must take off from the hex side where it landed" (p. 4).
    const here = landedOn('x', A, 'transport', TERRA, 0);
    const there = landedOn('y', A, 'transport', TERRA, 3);
    const alongside = landedOn('z', A, 'transport', TERRA, 0);
    expect(coursesMatched(here, there)).toBe(false);
    expect(coursesMatched(here, alongside)).toBe(true);
  });

  it('loots only the disabled and the surrendered, and never a wreck', () => {
    // "Only disabled (or surrendered) ships may be looted. A ship which is
    //  eliminated has broken up or exploded and may not be looted."
    const raider = ship('p', A, 'corsair', DEEP, { fuel: 10 });
    const healthy = ship('v', B, 'transport', DEEP, {
      fuel: 10,
      cargo: [{ kind: 'freight', quantity: 1 }],
    });
    const s = rig([raider, healthy], { phase: 'resupply' });
    expect(
      refused(s, {
        type: 'loot',
        by: A,
        ship: 'p',
        target: 'v',
        items: [{ kind: 'freight', quantity: 1 }],
      }),
    ).toMatch(/disabled|surrender/);

    const crippled: GameState = {
      ...s,
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 2 } },
    };
    const robbed = ok(crippled, {
      type: 'loot',
      by: A,
      ship: 'p',
      target: 'v',
      items: [
        { kind: 'freight', quantity: 1 },
        { kind: 'fuel', quantity: 4 },
      ],
    });
    expect(shipIn(robbed, 'p').cargo).toEqual([{ kind: 'freight', quantity: 1 }]);
    expect(shipIn(robbed, 'v').cargo).toEqual([]);
    expect(shipIn(robbed, 'v').fuel).toBe(6);
    expect(shipIn(robbed, 'p').fuel).toBe(14);

    const wreck: GameState = {
      ...s,
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 3, destroyed: true } },
    };
    refused(wreck, {
      type: 'loot',
      by: A,
      ship: 'p',
      target: 'v',
      items: [{ kind: 'freight', quantity: 1 }],
    });
  });

  it('calls the same manoeuvre rescue when it is done between friends', () => {
    // "When a friendly ship matches courses to save personnel from a disabled
    //  ship or to provide additional fuel, this is called rescue."
    const tanker = ship('k', A, 'tanker', DEEP, { fuel: 50 });
    const stranded = ship('s', A, 'corvette', DEEP, { fuel: 0 });
    let s = rig([tanker, stranded], { phase: 'resupply' });
    s = ok(s, { type: 'transferCargo', by: A, from: 'k', to: 's', kind: 'fuel', quantity: 8 });
    expect({ tanker: shipIn(s, 'k').fuel, saved: shipIn(s, 's').fuel }).toEqual({
      tanker: 42,
      saved: 8,
    });

    // A ship cannot be filled past its own capacity.
    refused(s, { type: 'transferCargo', by: A, from: 'k', to: 's', kind: 'fuel', quantity: 13 });

    // Taking goods off an enemy is looting, and looting has its own conditions.
    const enemy = ship('e', B, 'transport', DEEP, { cargo: [{ kind: 'freight', quantity: 1 }] });
    const mixed = rig([tanker, enemy], { phase: 'resupply' });
    refused(mixed, {
      type: 'transferCargo',
      by: A,
      from: 'e',
      to: 'k',
      kind: 'freight',
      quantity: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Capture (p. 8)
// ---------------------------------------------------------------------------

describe('capture (p. 8)', () => {
  it('takes only a disabled enemy, and only alongside', () => {
    // "While a ship is disabled, it may be captured by an enemy that matches
    //  courses."
    const captor = ship('p', A, 'corsair', DEEP, { velocity: hex(1, 0) });
    const healthy = ship('v', B, 'corvette', DEEP, { velocity: hex(1, 0) });
    const s = rig([captor, healthy], { phase: 'resupply' });
    expect(refused(s, { type: 'capture', by: A, ship: 'p', target: 'v' })).toMatch(/disabled/);

    const adrift: GameState = {
      ...s,
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 3 } },
    };
    const taken = ok(adrift, { type: 'capture', by: A, ship: 'p', target: 'v' });
    expect(shipIn(taken, 'v').capturedBy).toBe(A);

    // Not from a different course, though.
    const passing: GameState = {
      ...s,
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 3, velocity: hex(2, 0) } },
    };
    refused(passing, { type: 'capture', by: A, ship: 'p', target: 'v' });
  });

  it('silences the prize', () => {
    // "It may not fire, or return fire if fired upon."
    const captor = ship('p', A, 'corsair', DEEP);
    const prize = ship('v', B, 'corvette', DEEP, { disabled: 2 });
    let s = rig([captor, prize], { phase: 'resupply' });
    s = ok(s, { type: 'capture', by: A, ship: 'p', target: 'v' });
    // Even once the damage is repaired, the prize crew may not shoot.
    const repaired: GameState = {
      ...s,
      phase: 'combat',
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 0 } },
    };
    const enemy = ship('e', B, 'corvette', DEEP);
    const withEnemy: GameState = { ...repaired, ships: { ...repaired.ships, e: enemy } };
    expect(canFire(withEnemy.ships['v']!)).toBe(false);
    expect(previewAttack(withEnemy, ['v'], ['e'], map).legal).toBe(false);
  });

  it('holds the prize until it reaches a base friendly to the captor', () => {
    // "A captured ship must be returned to a base friendly to the captor before
    //  it may be used for any other mission."
    const captor = ship('p', A, 'corsair', DEEP);
    const prize = ship('v', B, 'corvette', DEEP, { disabled: 2 });
    let s = rig([captor, prize], { phase: 'resupply' });
    s = ok(s, { type: 'capture', by: A, ship: 'p', target: 'v' });

    const home = (baseOwner: PlayerId): GameState => ({
      ...s,
      bases: { ...s.bases, 'terra:0': { ...s.bases['terra:0']!, owner: baseOwner } },
      ships: {
        ...s.ships,
        v: {
          ...s.ships['v']!,
          pos: TERRA.hex,
          velocity: hex(0, 0),
          location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
        },
      },
    });

    // Its own side's base is no release: the prize crew flies it.
    const atOwnersBase = runResupplyPhase(home(B), map);
    expect(atOwnersBase.ships['v']!.capturedBy).toBe(A);
    expect(atOwnersBase.ships['v']!.owner).toBe(B);

    // The captor's base refits her: "The Patrol may take captured pirate vessels
    // into service" (p. 14).
    const atCaptorsBase = runResupplyPhase(home(A), map);
    expect(atCaptorsBase.ships['v']!.capturedBy).toBeUndefined();
    expect(atCaptorsBase.ships['v']!.owner).toBe(A);
    // Refitted, she is a warship again rather than a silenced prize. (Two
    // unrelated rules would still keep her quiet where she stands: "Ships
    // landed at planetary bases may not fire guns or launch ordnance", and she
    // is still working off her disablement — so the check is made on a
    // spaceborne, repaired copy.)
    const relaunched: Ship = {
      ...atCaptorsBase.ships['v']!,
      location: { kind: 'space' },
      pos: DEEP,
      disabled: 0,
    };
    expect(canFire(relaunched)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surrender (p. 8)
// ---------------------------------------------------------------------------

describe('surrender (p. 8)', () => {
  const strikeColours = (state: GameState): GameState => {
    let s = ok(state, { type: 'demandSurrender', by: A, ship: 'p', target: 'v' });
    s = ok(s, { type: 'respondToSurrender', by: B, ship: 'v', to: 'p', accept: true });
    return s;
  };

  it('binds both parties, and only the two ships that struck the bargain', () => {
    // "Surrender is a binding bargain. Both parties agree not to attack the
    //  other specific ship."
    const victor = ship('p', A, 'corsair', DEEP);
    const beaten = ship('v', B, 'corsair', DEEP);
    const bystanderA = ship('x', A, 'frigate', DEEP);
    const bystanderB = ship('y', B, 'frigate', DEEP);
    const s = strikeColours(rig([victor, beaten, bystanderA, bystanderB], { phase: 'combat' }));
    expect(shipIn(s, 'v').surrenderedTo).toEqual(['p']);

    expect(previewAttack(s, ['p'], ['v'], map).legal).toBe(false); // the victor may not fire
    expect(previewAttack(s, ['v'], ['p'], map).legal).toBe(false); // nor may the prize

    // "the other *specific* ship" — nobody else is bound.
    expect(previewAttack(s, ['x'], ['v'], map).legal).toBe(true);
    expect(previewAttack(s, ['v'], ['x'], map).legal).toBe(true);

    // A refusal binds nothing.
    let t = ok(rig([victor, beaten], { phase: 'combat' }), {
      type: 'demandSurrender',
      by: A,
      ship: 'p',
      target: 'v',
    });
    t = ok(t, { type: 'respondToSurrender', by: B, ship: 'v', to: 'p', accept: false });
    expect(shipIn(t, 'v').surrenderedTo).toEqual([]);
    expect(previewAttack(t, ['p'], ['v'], map).legal).toBe(true);
  });

  it('lets the victor loot without disabling, but leaves fuel enough to get home', () => {
    // "If it does surrender, the attacking ship may then match courses and loot
    //  it without first being required to disable it... the surrendered ship
    //  must be left with enough fuel to reach a friendly base."
    const victor = ship('p', A, 'corsair', DEEP, { fuel: 4 });
    const beaten = ship('v', B, 'transport', DEEP, {
      fuel: 10,
      cargo: [{ kind: 'freight', quantity: 2 }],
    });
    let s = strikeColours(rig([victor, beaten], { owners: terraOwners(B), phase: 'combat' }));
    s = { ...s, phase: 'resupply' };

    // Undamaged, yet lootable.
    expect(shipIn(s, 'v').disabled).toBe(0);
    const goods = ok(s, {
      type: 'loot',
      by: A,
      ship: 'p',
      target: 'v',
      items: [{ kind: 'freight', quantity: 1 }],
    });
    expect(shipIn(goods, 'p').cargo).toEqual([{ kind: 'freight', quantity: 1 }]);

    const reserve = surrenderFuelReserve(s, shipIn(s, 'v'), map);
    expect(reserve).toBeGreaterThan(0);
    refused(s, {
      type: 'loot',
      by: A,
      ship: 'p',
      target: 'v',
      items: [{ kind: 'fuel', quantity: 10 }],
    });
    const drained = ok(s, {
      type: 'loot',
      by: A,
      ship: 'p',
      target: 'v',
      items: [{ kind: 'fuel', quantity: 10 - reserve }],
    });
    expect(shipIn(drained, 'v').fuel).toBe(reserve);

    // "Surrendered ships may not be captured."
    const crippled: GameState = {
      ...s,
      ships: { ...s.ships, v: { ...s.ships['v']!, disabled: 2 } },
    };
    expect(refused(crippled, { type: 'capture', by: A, ship: 'p', target: 'v' })).toMatch(
      /surrender/,
    );
  });
});

// ---------------------------------------------------------------------------
// Detectors (p. 8)
// ---------------------------------------------------------------------------

describe('detectors (p. 8)', () => {
  it('reaches three hexes from a ship or an orbital or asteroid base, five from a planetary one', () => {
    // "Detectors on ships and orbital bases (including Ceres and Clandestine)
    //  have a range of three hexes; detectors on planetary bases have a range of
    //  five hexes."
    expect(DETECTION_RANGE_SHIP).toBe(3);
    expect(DETECTION_RANGE_PLANETARY_BASE).toBe(5);

    const s0 = rig([], { bases: [orbitalBaseAt('orb', A, DEEP)] });
    expect(detectionRangeOfBase(s0.bases['orb']!)).toBe(3);
    expect(detectionRangeOfBase(s0.bases['ceres']!)).toBe(3);
    expect(detectionRangeOfBase(s0.bases['clandestine']!)).toBe(3);
    expect(detectionRangeOfBase(s0.bases['terra:0']!)).toBe(5);

    // A ship's own detectors, at three hexes and at four.
    for (const range of [3, 4]) {
      const watcher = ship('m', A, 'corvette', DEEP);
      const quarry = ship('f', B, 'corvette', hex(DEEP.q + range, DEEP.r));
      const s = updateDetection(rig([watcher, quarry]), map);
      expect({ range, seen: isDetected(s, s.ships['f']!, A) }).toEqual({
        range,
        seen: range <= 3,
      });
    }

    // A planetary base's, at five hexes and at six.
    for (const range of [5, 6]) {
      const quarry = ship('f', B, 'corvette', hex(TERRA.hex.q + range, TERRA.hex.r));
      expect(distance(TERRA.hex, quarry.pos)).toBe(range);
      const s = updateDetection(rig([quarry], { owners: { 'terra:0': A } }), map);
      expect({ range, seen: isDetected(s, s.ships['f']!, A) }).toEqual({
        range,
        seen: range <= 5,
      });
    }
  });

  it('keeps a contact once made, whatever the range', () => {
    // "Once a ship has been detected by the enemy, it remains detected
    //  (regardless of range) until it arrives at a friendly base."
    const watcher = ship('m', A, 'corvette', DEEP);
    const quarry = ship('f', B, 'corvette', hex(DEEP.q + 2, DEEP.r));
    let s = updateDetection(rig([watcher, quarry]), map);
    expect(isDetected(s, s.ships['f']!, A)).toBe(true);

    s = {
      ...s,
      ships: { ...s.ships, f: { ...s.ships['f']!, pos: hex(DEEP.q + 20, DEEP.r) } },
    };
    s = updateDetection(s, map);
    expect(distance(s.ships['m']!.pos, s.ships['f']!.pos)).toBe(20);
    expect(isDetected(s, s.ships['f']!, A)).toBe(true);
  });

  it('drops the contact when the ship reaches a base of its own side', () => {
    // Same clause: the contact lasts "until it arrives at a friendly base".
    const runner = inOrbitAbove('f', B, 'corvette', TERRA, 0, { fuel: 5, detectedBy: [A] });
    let s = rig([runner], { owners: terraOwners(B), seat: B });
    s = ok(s, { type: 'land', by: B, ship: 'f', side: hexSide(TERRA.hex, 0) });
    s = reach(s, 'combat', B); // the movement phase puts her on the ground
    expect(shipIn(s, 'f').location.kind).toBe('landed');
    expect(shipIn(s, 'f').detectedBy).toEqual([]);

    // An enemy base is no refuge.
    let t = rig([runner], { owners: terraOwners(A), seat: B });
    t = ok(t, { type: 'land', by: B, ship: 'f', side: hexSide(TERRA.hex, 0) });
    t = reach(t, 'combat', B);
    expect(shipIn(t, 'f').location.kind).toBe('landed');
    expect(shipIn(t, 'f').detectedBy).toEqual([A]);
  });

  it('hides a ship that has reached Clandestine', () => {
    // "Ships which reach Clandestine drop off the detectors of the opposing
    //  side" (p. 7).
    const approach = hex(CLANDESTINE.hex.q - 1, CLANDESTINE.hex.r);
    // The pirate owns Clandestine, so her ships "automatically have scanners"
    // and may fly the dense cordon around it.
    const pirate = ship('f', B, 'corvette', approach, {
      velocity: hex(1, 0),
      fuel: 5,
      detectedBy: [A],
    });
    const hunter = ship('m', A, 'corvette', hex(CLANDESTINE.hex.q + 1, CLANDESTINE.hex.r));
    let s = rig([pirate, hunter], { owners: { clandestine: B }, seat: B });
    s = reach(s, 'combat', B); // coast one hex, into the rock's own hex
    expect(key(shipIn(s, 'f').pos)).toBe(key(CLANDESTINE.hex));
    // Still under way, so she has not *reached* it yet: "Ships may land at
    // Ceres and Clandestine... by simply stopping in the hex" (p. 4).
    expect(shipIn(s, 'f').detectedBy).toEqual([A]);

    // Burn the last hex of velocity off and settle onto the rock.
    s = reach(s, 'astrogation', B);
    s = ok(s, { type: 'plotCourse', by: B, ship: 'f', endpoint: CLANDESTINE.hex });
    s = reach(s, 'combat', B);
    expect(shipIn(s, 'f').location.kind).toBe('asteroidBase');
    expect(shipIn(s, 'f').detectedBy).toEqual([]);

    // And she stays off the plot while she is there, with a hunter one hex away.
    const swept = updateDetection(s, map);
    expect(isDetected(swept, swept.ships['f']!, A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prospecting (p. 13)
// ---------------------------------------------------------------------------

describe('prospecting (p. 13)', () => {
  const prospector = (velocity: Hex, extra: Partial<Ship> = {}): Ship =>
    ship('s', A, 'transport', BELT.to, { velocity, ...extra });

  const belt = (ships: readonly Ship[], faces: readonly number[]): GameState =>
    forceRolls(rig(ships, { phase: 'movement', scenarioData: { prospecting: true } }), faces);

  it('prospects only at a speed of one hex per turn', () => {
    // "Any ship may prospect by passing through an asteroid hex at a speed of 1."
    const slow = runProspecting(belt([prospector(BELT_VELOCITY)], [6, 3]), map);
    expect(slow.prospected[key(BELT.to)]).toBe('ore');

    const fast = runProspecting(
      belt([prospector(hex(BELT_VELOCITY.q * 2, BELT_VELOCITY.r * 2))], [6, 3]),
      map,
    );
    expect(fast.prospected[key(BELT.to)]).toBeUndefined();

    const parked = runProspecting(belt([prospector(hex(0, 0))], [6, 3]), map);
    expect(parked.prospected[key(BELT.to)]).toBeUndefined();
  });

  it('finds ore on a 6 and nothing on anything else, and surveys each hex once', () => {
    // "Two dice are rolled. On the first roll, a 6 indicates that ore is present
    //  (mark the hex O if ore is present; X if not)... Each hex may only be
    //  prospected once."
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const s = runProspecting(belt([prospector(BELT_VELOCITY)], [face, 3]), map);
      expect({ face, found: s.prospected[key(BELT.to)] }).toEqual({
        face,
        found: face === 6 ? 'ore' : 'barren',
      });
    }

    // A second pass over a surveyed hex rolls nothing at all.
    const once = runProspecting(belt([prospector(BELT_VELOCITY)], [5, 3]), map);
    const twice = runProspecting(once, map);
    expect(twice.prospected[key(BELT.to)]).toBe('barren');
    expect(twice.rng).toEqual(once.rng);
  });

  it('explodes an ungrappled contraterrene shard and stows a grappled one', () => {
    // "On the second roll, a 1 indicates the ship has encountered a CT
    //  (contraterrene) shard. If the ship is equipped with PM grapples, the
    //  shard may be picked up and sold, or left for later; otherwise, it
    //  explodes and the ship suffers an attack as per asteroids."
    //
    // The asteroid column of the damage table (p. 6) reads: 1-4 no effect,
    // 5 D1, 6 D2.
    for (const [face, disabled] of [
      [4, 0],
      [5, 1],
      [6, 2],
    ] as const) {
      const s = runProspecting(belt([prospector(BELT_VELOCITY)], [3, 1, face]), map);
      expect({ face, disabled: s.ships['s']!.disabled }).toEqual({ face, disabled });
      expect(s.ships['s']!.cargo).toEqual([]);
    }

    // With grapples aboard, the shard comes with them instead.
    const grappler = prospector(BELT_VELOCITY, { cargo: [{ kind: 'pmGrapples', quantity: 1 }] });
    const s = runProspecting(belt([grappler], [3, 1, 6]), map);
    expect(s.ships['s']!.disabled).toBe(0);
    expect(s.ships['s']!.cargo).toContainEqual({ kind: 'ctShard', quantity: 1 });

    // A second die of anything but 1 leaves the rock alone.
    const quiet = runProspecting(belt([prospector(BELT_VELOCITY)], [3, 2, 6]), map);
    expect(quiet.ships['s']!.disabled).toBe(0);
  });

  it('digs a tenth of a ton a turn by hand and a ton a turn by machine', () => {
    // "Mining: A stationary ship on an ore hex may mine ore at .1 ton per turn;
    //  this takes place on the movement phase, instead of movement." And:
    // "Automated Mines... automatically mine ore (at the rate of one ton per
    //  turn) in an asteroid hex where they have been emplaced. Mined ore is
    //  stockpiled until picked up."
    expect(MANUAL_MINE_RATE).toBe(0.1);
    expect(AUTOMATED_MINE_RATE).toBe(1);

    const digger = ship('s', A, 'transport', BELT.to);
    const base = rig([digger], { scenarioData: { prospecting: true } });
    const oreHex: GameState = { ...base, prospected: { [key(BELT.to)]: 'ore' } };

    const dug = ok(oreHex, { type: 'mineOre', by: A, ship: 's' });
    expect(shipIn(dug, 's').cargo).toEqual([{ kind: 'ore', quantity: 0.1 }]);
    // A rate, not a price per order.
    refused(dug, { type: 'mineOre', by: A, ship: 's' });

    // Nothing to dig on a hex the survey called barren.
    const barren: GameState = { ...base, prospected: { [key(BELT.to)]: 'barren' } };
    refused(barren, { type: 'mineOre', by: A, ship: 's' });

    // A moving ship cannot work a claim: mining replaces movement.
    const underway: GameState = {
      ...oreHex,
      ships: { ...oreHex.ships, s: { ...oreHex.ships['s']!, velocity: BELT_VELOCITY } },
    };
    refused(underway, { type: 'mineOre', by: A, ship: 's' });

    // The machine version, a ton per turn, stockpiled where it stands.
    const rig1 = ship('s', A, 'transport', BELT.to, {
      cargo: [{ kind: 'automatedMine', quantity: 1 }],
    });
    let m: GameState = {
      ...rig([rig1], { scenarioData: { prospecting: true } }),
      prospected: { [key(BELT.to)]: 'ore' },
    };
    m = ok(m, { type: 'emplaceEquipment', by: A, ship: 's', kind: 'automatedMine' });
    expect(mineAt(m, BELT.to)).toEqual({ owner: A, stockpile: 0 });
    m = runResupplyPhase(m, map);
    expect(mineAt(m, BELT.to)!.stockpile).toBe(1);
    m = runResupplyPhase(m, map);
    expect(mineAt(m, BELT.to)!.stockpile).toBe(2);

    // "Only one mine may be placed per asteroid hex."
    const second = ship('t', A, 'transport', BELT.to, {
      cargo: [{ kind: 'automatedMine', quantity: 1 }],
    });
    const crowded: GameState = { ...m, ships: { ...m.ships, t: second }, phase: 'astrogation' };
    expect(
      refused(crowded, { type: 'emplaceEquipment', by: A, ship: 't', kind: 'automatedMine' }),
    ).toMatch(/one mine/);
  });

  it('keeps claim jumpers off a guarded hex', () => {
    // "Robot guards protect automated mines from claim jumpers and prevent
    //  anyone other than the owner from removing stockpiled ore."
    const owner = ship('s', A, 'transport', BELT.to, {
      cargo: [{ kind: 'robotGuards', quantity: 1 }],
    });
    let s: GameState = {
      ...rig([owner], { scenarioData: { prospecting: true } }),
      prospected: { [key(BELT.to)]: 'ore' },
    };
    s = ok(s, { type: 'emplaceEquipment', by: A, ship: 's', kind: 'robotGuards' });
    expect(guardsAt(s, BELT.to)).toBe(A);

    const jumper = ship('x', B, 'transport', BELT.to);
    const raided: GameState = {
      ...s,
      phase: 'astrogation',
      activePlayerIndex: 1,
      ships: { ...s.ships, x: jumper },
    };
    expect(refused(raided, { type: 'mineOre', by: B, ship: 'x' })).toMatch(/guard/i);
  });

  it('buys ore and shards at the printed prices', () => {
    // "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton). CT
    //  shards sell for MCr 100 at Ceres or MCr 200 at Luna." The variant adds:
    // "Clandestine is available as a base, and buys ore at Ceres prices."
    //
    // `sellCargo` is called directly because there is no command that reaches
    // it: the market is implemented and unreachable in play. Recorded in
    // docs/RULES-MAPPING.md.
    expect(MARKETS['ceres']).toEqual({ ore: 2, ctShard: 100 });
    expect(MARKETS['luna']).toEqual({ ore: 3, ctShard: 200 });
    expect(MARKETS['clandestine']).toEqual({ ore: 2, ctShard: 100 });

    const LUNA = map.body('luna')!;
    const hauler = landedOn('s', A, 'transport', LUNA, 0, {
      cargo: [
        { kind: 'ore', quantity: 10 },
        { kind: 'ctShard', quantity: 1 },
      ],
    });
    const atLuna = rig([hauler], { owners: { 'luna:0': A }, phase: 'resupply' });
    const sold = logistics.sellCargo(atLuna, 's', ['ore', 'ctShard'], map);
    expect(sold.result.ok).toBe(true);
    expect(sold.state.players[A]!.megacredits).toBe(10 * 3 + 200);

    const atCeres = rig(
      [
        ship('s', A, 'transport', CERES.hex, {
          location: { kind: 'asteroidBase', hex: CERES.hex },
          cargo: [
            { kind: 'ore', quantity: 10 },
            { kind: 'ctShard', quantity: 1 },
          ],
        }),
      ],
      { owners: { ceres: A }, phase: 'resupply' },
    );
    const soldThere = logistics.sellCargo(atCeres, 's', ['ore', 'ctShard'], map);
    expect(soldThere.result.ok).toBe(true);
    expect(soldThere.state.players[A]!.megacredits).toBe(10 * 2 + 100);
  });
});
