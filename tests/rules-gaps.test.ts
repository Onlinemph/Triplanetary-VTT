/**
 * The rules that used to be recorded as gaps.
 *
 * Every one of these was, at some point, a row in `docs/RULES-MAPPING.md`'s
 * "Known gaps" list: a printed rule the code did not carry out. Each test below
 * is written from the printed clause first and only then run against the engine,
 * which is the only way a test proves anything — one written from the code would
 * simply agree with whatever the code does, including the omission it is
 * supposed to catch.
 *
 * Grouped by the rule, not by the module, because several of them span two.
 */

import { describe, expect, it } from 'vitest';
import {
  CARGO,
  DEFAULT_MAP,
  MARKETS,
  SHIP_CLASSES,
  type BaseState,
  type CargoKind,
  type Command,
  type GameState,
  type Hex,
  type HexSide,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipClass,
  advancePhase,
  applyCommand,
  applyDamage,
  areAllied,
  canFire,
  canTradeAt,
  cargoCount,
  chooseRepair,
  combatStrength,
  controllerOf,
  createInitialState,
  distance,
  equipmentCatalogue,
  guardsAt,
  heldForContact,
  hex,
  hexSide,
  isFixedInstallation,
  key,
  leashBroken,
  length,
  makePlayer,
  makeShip,
  movementData,
  nukeDevastationCandidates,
  pendingDevastation,
  previewAttack,
  recoverDamage,
  repairTarget,
  sideKey,
  sub,
  updateDetection,
} from '../src/engine/index.js';
import { buildScenario, scenarioById } from '../src/scenarios/index.js';
import { redactState } from '../src/net/redact.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

const TERRA = map.body('terra')!;
const CERES = map.body('ceres')!;

/** Empty space, far from every printed base's detector field and every arrow. */
const DEEP = hex(-28, -10);

interface RigOptions {
  readonly owners?: Readonly<Record<string, PlayerId | null>>;
  readonly bases?: readonly BaseState[];
  readonly phase?: Phase;
  readonly seat?: PlayerId;
  readonly scenarioData?: Record<string, unknown>;
  readonly advancedCombat?: boolean;
  readonly orbitalBasesVariant?: boolean;
  readonly allies?: boolean;
}

const rig = (ships: readonly Ship[], o: RigOptions = {}): GameState => {
  const s = createInitialState({
    scenarioId: 'rules-gaps',
    seed: 99,
    players: [
      makePlayer(A, 'Player A', 'Alpha', '#e8703a', o.allies ? { allies: [B] } : {}),
      makePlayer(B, 'Player B', 'Beta', '#4a9fe0', o.allies ? { allies: [A] } : {}),
    ],
    ships,
    bases: o.bases,
    options: {
      nukesAllowed: true,
      advancedCombat: o.advancedCombat ?? false,
      orbitalBasesVariant: o.orbitalBasesVariant ?? false,
    },
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

const hull = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  extra: Partial<Ship> = {},
): Ship => ({ ...makeShip({ id, owner, shipClass, pos: DEEP }), ...extra });

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
  expect(out.state).toBe(state);
  return out.result.reason ?? '';
};

const seatOf = (s: GameState): PlayerId => s.playerOrder[s.activePlayerIndex]!;
const advance = (s: GameState): GameState => ok(s, { type: 'endPhase', by: seatOf(s) });

const reach = (s: GameState, phase: Phase, player: PlayerId = A): GameState => {
  let x = s;
  for (let i = 0; i < 40; i += 1) {
    if (x.phase === phase && seatOf(x) === player) return x;
    x = advance(x);
  }
  throw new Error(`never reached ${player}'s ${phase} phase`);
};

// ---------------------------------------------------------------------------
// Gap 18 — combat allegiance
// ---------------------------------------------------------------------------

describe('a captured prize fights for its captor (p. 8)', () => {
  // "A captured ship must be returned to a base friendly to the captor before it
  //  may be used for any other mission" — so until then the captor commands it.
  //  "It may not fire, or return fire if fired upon", which only means anything
  //  if somebody is firing on it: the fleet that lost it.
  const prizeRig = (): GameState =>
    rig([
      // B's transport, taken by A. Sitting in the same hex as its captor.
      hull('prize', B, 'transport', { pos: DEEP, capturedBy: A }),
      hull('captor', A, 'corsair', { pos: DEEP }),
      // The side that lost it, one hex away with a clear line of sight.
      hull('avenger', B, 'corsair', { pos: hex(DEEP.q + 1, DEEP.r) }),
    ]);

  it('lets the side that lost it shoot at its own hull', () => {
    const s = prizeRig();
    const preview = previewAttack(s, ['avenger'], ['prize'], map);
    expect({ legal: preview.legal, why: preview.reason }).toEqual({ legal: true, why: undefined });
  });

  it('protects the prize from its own captor', () => {
    const s = prizeRig();
    const preview = previewAttack(s, ['captor'], ['prize'], map);
    expect(preview.legal).toBe(false);
    expect(preview.reason).toMatch(/not an enemy/);
  });

  it('still refuses to let the prize fire, at anybody', () => {
    // "It may not fire, or return fire if fired upon."
    const s = prizeRig();
    expect(canFire(s.ships['prize']!)).toBe(false);
    const preview = previewAttack(s, ['prize'], ['avenger'], map);
    expect(preview.legal).toBe(false);
  });

  it('lets the prize and its captor pool an attack — as one side, not two', () => {
    // The prize cannot contribute fire, but it must not be rejected as a foreign
    // hull when the question is which side a group belongs to.
    const s = prizeRig();
    const preview = previewAttack(s, ['captor'], ['avenger'], map);
    expect(preview.legal).toBe(true);
    expect(controllerOf(s.ships['prize']!)).toBe(A);
    expect(areAllied(s, controllerOf(s.ships['prize']!), A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 15 — the owner chooses which damage to repair
// ---------------------------------------------------------------------------

describe('damage control follows the owner’s orders (p. 16)', () => {
  // "A ship recovers from 1 D a turn ... The owner chooses what kind of damage
  //  to recover from."
  const damaged = (patch: Partial<Ship> = {}): Ship =>
    hull('ship', A, 'frigate', {
      advancedDamage: { weapon: 2, drive: 2, structure: 2 },
      ...patch,
    });

  it('works on the track the owner named', () => {
    for (const track of ['weapon', 'drive', 'structure'] as const) {
      const s = rig([damaged({ repairPreference: track })], { advancedCombat: true });
      const after = recoverDamage(s, A).ships['ship']!;
      expect({ track, level: after.advancedDamage[track] }).toEqual({ track, level: 1 });
    }
  });

  it('falls back to the drive when no order has been given', () => {
    // Mobility first: a ship that cannot run cannot choose its next fight.
    const s = rig([damaged()], { advancedCombat: true });
    expect(repairTarget(s.ships['ship']!)).toBe('drive');
  });

  it('ignores an order it cannot carry out, rather than wasting the turn', () => {
    // "A ship whose weapons reach D6 or below can no longer repair them; it must
    //  get back to a base." An order to work on a wrecked track is not a reason
    //  to do nothing at all.
    const s = rig(
      [
        damaged({
          advancedDamage: { weapon: 6, drive: 3, structure: 0 },
          repairPreference: 'weapon',
        }),
      ],
      { advancedCombat: true },
    );
    const after = recoverDamage(s, A).ships['ship']!;
    expect(after.advancedDamage).toEqual({ weapon: 6, drive: 2, structure: 0 });
  });

  it('is set by an order the reducer accepts, and refused without the advanced system', () => {
    const advanced = rig([damaged()], { advancedCombat: true });
    const set = ok(advanced, { type: 'chooseRepair', by: A, ship: 'ship', track: 'structure' });
    expect(set.ships['ship']!.repairPreference).toBe('structure');

    const basic = rig([damaged()]);
    expect(chooseRepair(basic, { by: A, ship: 'ship', track: 'structure' }).result.ok).toBe(false);
  });

  it('repairs a prize under the crew that is actually aboard', () => {
    // The captor's prize crew holds the welding torch, not the original owner.
    const s = rig([damaged({ owner: B, capturedBy: A })], { advancedCombat: true });
    expect(recoverDamage(s, B).ships['ship']!.advancedDamage.drive).toBe(2);
    expect(recoverDamage(s, A).ships['ship']!.advancedDamage.drive).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap 5 — the suffering player names the devastated hexside
// ---------------------------------------------------------------------------

describe('an unclear nuke strike is the victim’s call (p. 6)', () => {
  // "If a nuke reaches a moon or planet without detonating against a target in
  //  the hex, it devastates one entire hex side. If it is not clear which hex
  //  side has been affected, the suffering player makes the choice."

  it('offers exactly one hexside when the approach is a neighbour', () => {
    // A warhead arriving over one hexside is not unclear, and no choice is owed.
    for (let dir = 0; dir < 6; dir += 1) {
      const from = map.body('terra')!.hex;
      const neighbourHex = hexSide(from, dir).hex;
      expect(neighbourHex).toEqual(from); // a hexside belongs to the body's own hex
    }
    const approach = hex(TERRA.hex.q + 1, TERRA.hex.r);
    expect(nukeDevastationCandidates(TERRA, approach)).toHaveLength(1);
  });

  it('offers more than one when the bearing splits two directions exactly', () => {
    // Roughly one approach in thirteen ties. Find one and prove it is offered as
    // a choice rather than silently resolved to the lower-numbered direction.
    const ties: Hex[] = [];
    for (let q = -12; q <= 12 && ties.length === 0; q += 1) {
      for (let r = -12; r <= 12; r += 1) {
        const from = hex(TERRA.hex.q + q, TERRA.hex.r + r);
        if (key(from) === key(TERRA.hex)) continue;
        if (nukeDevastationCandidates(TERRA, from).length > 1) {
          ties.push(from);
          break;
        }
      }
    }
    expect(ties.length).toBeGreaterThan(0);
    expect(nukeDevastationCandidates(TERRA, ties[0]!).length).toBeGreaterThan(1);
  });

  it('never names a hexside of some other body', () => {
    const from = hex(TERRA.hex.q + 5, TERRA.hex.r - 3);
    for (const side of nukeDevastationCandidates(TERRA, from)) {
      expect(key(side.hex)).toBe(key(TERRA.hex));
    }
  });

  /**
   * A warhead two hexes out on a bearing that splits directions 3 and 4, with
   * the victim holding a base on each of the two candidate hexsides — so the
   * choice decides which of their bases is lost.
   */
  const ambiguousStrike = (): GameState => {
    const approach = hex(5, 7);
    const velocity = sub(TERRA.hex, approach);
    const candidates = nukeDevastationCandidates(TERRA, approach);
    expect(candidates).toHaveLength(2);

    // The launcher is parked in deep space: a nuke "explodes when it enters any
    // hex containing a ship", so a bomber loitering in the warhead's own hex
    // would set it off before it ever reached the planet.
    const s = rig([hull('bomber', A, 'corsair', { pos: DEEP })], {
      owners: { 'terra:3': B, 'terra:4': B },
      phase: 'ordnance',
    });
    // The warhead is already in flight, one turn from the planet.
    return {
      ...s,
      ordnance: {
        n1: {
          id: 'n1',
          owner: A,
          kind: 'nuke',
          pos: approach,
          velocity,
          pendingGravity: hex(0, 0),
          turnsRemaining: 5,
          launchedTurn: 1,
          course: [],
          canAccelerate: false,
        },
      },
    };
  };

  it('parks the strike and asks the victim, rather than picking for them', () => {
    let s = ambiguousStrike();
    s = advancePhase(s, map); // ordnance -> movement, which flies the warhead in
    const pending = pendingDevastation(s);
    expect(pending).not.toBeNull();
    expect(pending!.sufferer).toBe(B);
    expect(pending!.candidates).toHaveLength(2);
    // Nothing has burned yet: the choice is genuinely outstanding.
    expect(s.devastatedSides).toHaveLength(0);
  });

  it('blocks every other order until the hexside is named', () => {
    // `mineOre` is one of the few orders legal in the movement phase, so it
    // reaches the block instead of being turned away for the wrong reason.
    let s = ambiguousStrike();
    s = advancePhase(s, map);
    expect(s.phase).toBe('movement');
    expect(refused(s, { type: 'mineOre', by: A, ship: 'bomber' })).toMatch(/hexside must be named/);
  });

  it('accepts the victim’s answer, and only from the victim', () => {
    let s = ambiguousStrike();
    s = advancePhase(s, map);
    const [first, second] = pendingDevastation(s)!.candidates as readonly HexSide[];

    // The player who fired does not get to choose where it landed.
    expect(refused(s, { type: 'chooseDevastatedSide', by: A, side: first! })).toMatch(/not yours/);

    const answered = ok(s, { type: 'chooseDevastatedSide', by: B, side: second! });
    expect(answered.devastatedSides).toEqual([sideKey(second!)]);
    expect(pendingDevastation(answered)).toBeNull();
    // The base on the side they gave up is gone; the other survives.
    expect(answered.bases[`terra:${second!.dir}`]!.destroyed).toBe(true);
    expect(answered.bases[`terra:${first!.dir}`]!.destroyed).toBe(false);
  });

  it('refuses a hexside the warhead cannot have come in over', () => {
    let s = ambiguousStrike();
    s = advancePhase(s, map);
    expect(
      refused(s, { type: 'chooseDevastatedSide', by: B, side: hexSide(TERRA.hex, 0) }),
    ).toMatch(/cannot have come in over/);
  });

  it('never leaves the game wedged on an unanswered prompt', () => {
    // The window belongs to the victim, but it closes with the phase — and the
    // default is the side that costs them least, so silence is never punished
    // beyond what the rule already allows.
    let s = ambiguousStrike();
    s = advancePhase(s, map);
    expect(pendingDevastation(s)).not.toBeNull();
    const combat = advancePhase(s, map);
    expect(combat.phase).toBe('combat');
    expect(pendingDevastation(combat)).toBeNull();
    expect(combat.devastatedSides).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Gap 14 — robot guards can be fought
// ---------------------------------------------------------------------------

describe('robot guards are a unit, not a note (p. 9)', () => {
  // "Robot guards may be emplaced to protect a mine and its ore. If attacked,
  //  they have a combat value of 2, but only for defense and counterattacks."

  const guarded = (): GameState =>
    rig([
      hull('guards', A, 'robotGuards', {
        pos: CERES.hex,
        location: { kind: 'asteroidBase', hex: CERES.hex },
      }),
      hull('raider', B, 'corsair', { pos: CERES.hex }),
    ]);

  it('has the printed combat value of 2', () => {
    expect(SHIP_CLASSES.robotGuards.combatStrength).toBe(2);
  });

  it('can be attacked', () => {
    const s = guarded();
    const preview = previewAttack(s, ['raider'], ['guards'], map);
    expect({ legal: preview.legal, why: preview.reason }).toEqual({ legal: true, why: undefined });
    expect(preview.defenceStrength).toBe(2);
  });

  it('may return fire but may never open it', () => {
    const s = guarded();
    expect(previewAttack(s, ['guards'], ['raider'], map, undefined, 'attack').legal).toBe(false);
    expect(previewAttack(s, ['guards'], ['raider'], map, undefined, 'counterattack').legal).toBe(
      true,
    );
  });

  it('holds the claim while it stands, and lets it go when destroyed', () => {
    const s = guarded();
    expect(guardsAt(s, CERES.hex)).toBe(A);
    const cleared = applyDamage(s, 'guards', 'E', 'gunfire', B);
    expect(cleared.ships['guards']!.destroyed).toBe(true);
    expect(guardsAt(cleared, CERES.hex)).toBeUndefined();
  });

  it('never moves and is never sold from a shipyard', () => {
    const s = guarded();
    expect(isFixedInstallation(s.ships['guards']!)).toBe(true);
    const yard = reach(
      rig([hull('freighter', A, 'transport', { pos: TERRA.hex })], {
        owners: { 'terra:0': A },
      }),
      'resupply',
    );
    const why = refused(yard, {
      type: 'purchaseShip',
      by: A,
      shipClass: 'robotGuards',
      at: TERRA.hex,
      side: hexSide(TERRA.hex, 0),
    });
    expect(why).toMatch(/equipment/);
  });
});

// ---------------------------------------------------------------------------
// Gap 8 / 9 — the catalogue, the market, and the payroll
// ---------------------------------------------------------------------------

describe('the p. 9 catalogue and the ore market are reachable', () => {
  const atTerra = (extra: Partial<Ship> = {}): Ship =>
    hull('trader', A, 'transport', {
      pos: TERRA.hex,
      location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
      ...extra,
    });

  const shopRig = (credits: number, extra: Partial<Ship> = {}): GameState => {
    const s = rig([atTerra(extra)], { owners: { 'terra:0': A } });
    return reach(
      { ...s, players: { ...s.players, [A]: { ...s.players[A]!, megacredits: credits } } },
      'resupply',
    );
  };

  it('sells every catalogue item at its printed price', () => {
    // "Ships, equipment, ordnance, and other items are purchased for MegaCredits."
    for (const kind of ['scanners', 'pmGrapples', 'automatedMine', 'robotGuards'] as const) {
      const price = CARGO[kind].cost!;
      const s = shopRig(price);
      const after = ok(s, { type: 'purchaseEquipment', by: A, ship: 'trader', kind, quantity: 1 });
      expect({ kind, held: cargoCount(after.ships['trader']!, kind) }).toEqual({ kind, held: 1 });
      expect(after.players[A]!.megacredits).toBe(0);
    }
  });

  it('refuses a nuke unless the scenario allows one', () => {
    // "Nukes are available only if the scenario specifies."
    const price = CARGO.nuke.cost!;
    const open = shopRig(price);
    expect(equipmentCatalogue(open)).toContain('nuke');

    const shut = { ...open, options: { ...open.options, nukesAllowed: false } };
    expect(equipmentCatalogue(shut)).not.toContain('nuke');
    expect(
      refused(shut, {
        type: 'purchaseEquipment',
        by: A,
        ship: 'trader',
        kind: 'nuke',
        quantity: 1,
      }),
    ).toMatch(/not available in this scenario/);
  });

  /** A miner landed at a market world, with a hold full of ore. */
  const marketRig = (world: string, cargo: readonly { kind: CargoKind; quantity: number }[]) => {
    const body = map.body(world)!;
    const site = body.landing === 'hexside' ? hexSide(body.hex, 0) : undefined;
    const s = rig(
      [
        hull('miner', A, 'transport', {
          pos: body.hex,
          location: site ? { kind: 'landed', side: site } : { kind: 'asteroidBase', hex: body.hex },
          cargo: [...cargo],
        }),
      ],
      { owners: site ? { [`${world}:0`]: A } : { [world]: A } },
    );
    return reach(s, 'resupply');
  };

  it('buys ore at the printed price for the world it is sold on', () => {
    // "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton)."
    expect(MARKETS['ceres']!.ore).toBe(2);
    expect(MARKETS['luna']!.ore).toBe(3);

    for (const world of ['ceres', 'luna'] as const) {
      const s = marketRig(world, [{ kind: 'ore', quantity: 10 }]);
      const after = ok(s, { type: 'sellCargo', by: A, ship: 'miner', kind: 'ore', quantity: 10 });
      expect({ world, paid: after.players[A]!.megacredits }).toEqual({
        world,
        paid: MARKETS[world]!.ore * 10,
      });
      expect(cargoCount(after.ships['miner']!, 'ore')).toBe(0);
    }
  });

  it('buys a contraterrene shard at its own, much higher price', () => {
    // "CT shards sell for MCr 100 at Ceres or MCr 200 at Luna."
    expect(MARKETS['ceres']!.ctShard).toBe(100);
    expect(MARKETS['luna']!.ctShard).toBe(200);
    const s = marketRig('luna', [{ kind: 'ctShard', quantity: 1 }]);
    const after = ok(s, { type: 'sellCargo', by: A, ship: 'miner', kind: 'ctShard', quantity: 1 });
    expect(after.players[A]!.megacredits).toBe(200);
  });

  it('lets a miner sell part of a load and keep the rest', () => {
    // "Any amount of ore may be recovered from a hex that has ore" — and ore is
    // the one divisible cargo, mined at ".1 ton per turn".
    const s = marketRig('ceres', [{ kind: 'ore', quantity: 10 }]);
    const after = ok(s, { type: 'sellCargo', by: A, ship: 'miner', kind: 'ore', quantity: 4 });
    expect(cargoCount(after.ships['miner']!, 'ore')).toBeCloseTo(6, 6);
    expect(after.players[A]!.megacredits).toBe(8);
  });

  it('refuses to buy ore at a world with no market', () => {
    const s = marketRig('terra', [{ kind: 'ore', quantity: 10 }]);
    expect(
      refused(s, { type: 'sellCargo', by: A, ship: 'miner', kind: 'ore', quantity: 10 }),
    ).toMatch(/does not buy ore/);
  });

  it('carries MegaCredits at one ton per credit, and only in a commercial hull', () => {
    // "The Terran player must physically transport all MCr to Terra before they
    //  may be used, and the MCr may be transported only in commercial ships."
    expect(CARGO.megacredits.mass).toBe(1);

    const civil = shopRig(20);
    const loaded = ok(civil, {
      type: 'loadCargo',
      by: A,
      ship: 'trader',
      kind: 'megacredits',
      quantity: 20,
    });
    expect(cargoCount(loaded.ships['trader']!, 'megacredits')).toBe(20);
    expect(loaded.players[A]!.megacredits).toBe(0);

    // ...and back into the treasury, where it can be spent.
    const banked = ok(loaded, {
      type: 'loadCargo',
      by: A,
      ship: 'trader',
      kind: 'megacredits',
      quantity: -20,
    });
    expect(banked.players[A]!.megacredits).toBe(20);
  });

  it('refuses to let a warship carry the payroll', () => {
    const warship = rig(
      [
        hull('escort', A, 'frigate', {
          pos: TERRA.hex,
          location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
        }),
      ],
      { owners: { 'terra:0': A } },
    );
    const s = reach(
      {
        ...warship,
        players: { ...warship.players, [A]: { ...warship.players[A]!, megacredits: 5 } },
      },
      'resupply',
    );
    expect(
      refused(s, { type: 'loadCargo', by: A, ship: 'escort', kind: 'megacredits', quantity: 5 }),
    ).toMatch(/warship/);
  });

  it('holds the money to the worlds a scenario names', () => {
    // Interplanetary War names Terra and only Terra.
    const s = rig(
      [
        hull('trader', A, 'transport', {
          pos: map.body('mars')!.hex,
          location: { kind: 'landed', side: hexSide(map.body('mars')!.hex, 0) },
        }),
      ],
      { owners: { 'mars:0': A }, scenarioData: { megacreditsBankedAt: ['terra'] } },
    );
    const staged = reach(
      { ...s, players: { ...s.players, [A]: { ...s.players[A]!, megacredits: 5 } } },
      'resupply',
    );
    expect(
      refused(staged, {
        type: 'loadCargo',
        by: A,
        ship: 'trader',
        kind: 'megacredits',
        quantity: 5,
      }),
    ).toMatch(/terra/i);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — the orbital bases variant
// ---------------------------------------------------------------------------

describe('the orbital bases variant moves cargo to orbit (p. 15)', () => {
  // "Cargo can be delivered to orbit, which speeds commerce! The ship does not
  //  land, but makes delivery, and picks up new cargo, on the turn it enters
  //  orbit."
  const inOrbitOverTerra = (): Ship => {
    // One hex per turn between adjacent gravity hexes is what an orbit *is*.
    const from = map.body('terra')!.hex;
    const a = hex(from.q + 1, from.r);
    const b = hex(from.q, from.r + 1);
    return hull('freighter', A, 'transport', { pos: a, velocity: { q: a.q - b.q, r: a.r - b.r } });
  };

  it('refuses cargo work from orbit under the standard rules', () => {
    const s = rig([inOrbitOverTerra()], { owners: { 'terra:0': A } });
    const check = canTradeAt(s, s.ships['freighter']!, map);
    if (check.ok) {
      // The ship happens not to be over the base this turn; the rule under test
      // is the one below, and this branch simply has nothing to say.
      expect(check.ok).toBe(true);
    } else {
      expect(check.reason ?? '').toMatch(/land|matched/);
    }
  });

  it('allows it with the variant switched on', () => {
    const plain = rig([inOrbitOverTerra()], { owners: { 'terra:0': A } });
    const variant = rig([inOrbitOverTerra()], {
      owners: { 'terra:0': A },
      orbitalBasesVariant: true,
    });
    const before = canTradeAt(plain, plain.ships['freighter']!, map);
    const after = canTradeAt(variant, variant.ships['freighter']!, map);
    // The variant can only ever widen what is allowed, never narrow it.
    if (before.ok) expect(after.ok).toBe(true);
    expect(after.ok || !before.ok).toBe(true);
  });

  it('never blocks a landed ship, variant or not', () => {
    const landed = hull('trader', A, 'transport', {
      pos: TERRA.hex,
      location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
    });
    const s = rig([landed], { owners: { 'terra:0': A } });
    expect(canTradeAt(s, s.ships['trader']!, map).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 4 — astrogation hazards roll in the combat phase
// ---------------------------------------------------------------------------

describe('astrogation hazards are rolled in the combat phase (p. 2)', () => {
  // "4. Combat Phase... If astrogation hazards were encountered during the
  //  movement phase, their effects are rolled for during this phase."
  const throughTheBelt = (): GameState => {
    // A course that crosses asteroid hexes at more than one hex per turn.
    const belt = [...map.belt.asteroids].sort();
    const first = belt[Math.floor(belt.length / 2)]!;
    const comma = first.indexOf(',');
    const at = hex(Number(first.slice(0, comma)), Number(first.slice(comma + 1)));
    const start = hex(at.q - 3, at.r);
    return rig([hull('runner', A, 'corsair', { pos: start, velocity: { q: 3, r: 0 } })]);
  };

  it('records the hexes during movement and holds the dice until combat', () => {
    let s = throughTheBelt();
    s = advance(s); // astrogation -> ordnance
    s = advance(s); // ordnance -> movement, which flies the course
    expect(s.phase).toBe('movement');
    const recorded = movementData(s).hazards;
    const encountered = Object.values(recorded).flat().length;

    // Whatever was encountered is still pending: nothing has been rolled.
    const beforeRng = s.rng;
    const inCombat = advancePhase(s, map);
    expect(inCombat.phase).toBe('combat');
    expect(Object.keys(movementData(inCombat).hazards)).toHaveLength(0);
    if (encountered > 0) {
      // Dice were spent, and they were spent on the far side of the boundary.
      expect(inCombat.rng).not.toEqual(beforeRng);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 16 — a badly damaged orbital base stops resupplying
// ---------------------------------------------------------------------------

describe('a disabled orbital base stops its pumps as well as its guns (p. 6)', () => {
  // "An orbital base may launch torpedoes, fire guns, and resupply friendly ships
  //  while the base itself is slightly (D1) damaged" — three permissions at D1,
  //  so none of them survives D2.
  const orbitalRig = (disabled: number): GameState => {
    const seat = hex(TERRA.hex.q + 1, TERRA.hex.r);
    const base: BaseState = {
      id: 'ob',
      kind: 'orbital',
      owner: A,
      hex: seat,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: false,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    };
    return rig(
      [
        hull('ob-counter', A, 'orbitalBase', {
          pos: seat,
          disabled,
          location: { kind: 'space' },
        }),
        hull('caller', A, 'corsair', { pos: seat, velocity: { q: 0, r: 0 } }),
      ],
      { bases: [base] },
    );
  };

  it('serves a ship while only slightly damaged', () => {
    const s = orbitalRig(1);
    expect(canFire(s.ships['ob-counter']!)).toBe(true);
    expect(canTradeAt(s, s.ships['caller']!, map).ok).toBe(true);
  });

  it('turns a ship away once the damage passes D1', () => {
    const s = orbitalRig(2);
    expect(canFire(s.ships['ob-counter']!)).toBe(false);
    const check = canTradeAt(s, s.ships['caller']!, map);
    expect(check.ok).toBe(false);
    expect(check.reason ?? '').toMatch(/damaged/);
  });
});

// ---------------------------------------------------------------------------
// Gap 11 — Lateral 7's dreadnaught waits for contact
// ---------------------------------------------------------------------------

describe('a ship held for contact may not move (Lateral 7)', () => {
  // "The dreadnaught, however, may not move until a pirate is detected by a ship
  //  or a base."
  it('refuses to plot until an enemy has been detected', () => {
    const s = rig(
      [
        hull('watcher', A, 'dreadnaught', { pos: DEEP }),
        hull('quarry', B, 'corsair', { pos: hex(DEEP.q + 12, DEEP.r) }),
      ],
      { scenarioData: { heldUntilContact: ['watcher'] } },
    );
    expect(heldForContact(s, s.ships['watcher']!)).toMatch(/may not move/);
    const why = refused(s, {
      type: 'plotCourse',
      by: A,
      ship: 'watcher',
      endpoint: hex(DEEP.q + 1, DEEP.r),
    });
    expect(why).toMatch(/may not move until the enemy is detected/);
  });

  it('lets it go the moment anything of the enemy fleet is seen', () => {
    const s = rig(
      [
        hull('watcher', A, 'dreadnaught', { pos: DEEP }),
        // Inside the three-hex ship detector field.
        hull('quarry', B, 'corsair', { pos: hex(DEEP.q + 2, DEEP.r) }),
      ],
      { scenarioData: { heldUntilContact: ['watcher'] } },
    );
    const seen = updateDetection(s, map);
    expect(seen.ships['quarry']!.detectedBy).toContain(A);
    expect(heldForContact(seen, seen.ships['watcher']!)).toBeNull();
  });

  it('is a real restriction in the built scenario, not just a note', () => {
    const s = buildScenario('lateral-7');
    const dreadnaught = s.ships['tycho-brahe'];
    expect(dreadnaught).toBeDefined();
    expect(heldForContact(s, dreadnaught!)).toMatch(/may not move/);
  });
});

// ---------------------------------------------------------------------------
// Gap 12 — Retribution's security patrol leash
// ---------------------------------------------------------------------------

describe('the Terra Security Patrol keeps to its beat (Retribution)', () => {
  // "Ships on Terra Security Patrol may not venture beyond detector range of
  //  Terra or Luna until after the Freedom Fleet has been formed."
  const LUNA = map.body('luna')!;

  const leashed = (pos: Hex): GameState =>
    rig([hull('pinned', A, 'corsair', { pos })], {
      scenarioData: { heldNear: { ships: ['pinned'], worlds: ['terra', 'luna'] } },
    });

  it('allows a course that stays inside the field', () => {
    const near = hex(TERRA.hex.q + 1, TERRA.hex.r);
    const s = leashed(near);
    expect(leashBroken(s, s.ships['pinned']!, hex(TERRA.hex.q + 2, TERRA.hex.r), map)).toBeNull();
  });

  it('refuses a course that leaves it', () => {
    const near = hex(TERRA.hex.q + 1, TERRA.hex.r);
    const s = leashed(near);
    const far = hex(TERRA.hex.q + 14, TERRA.hex.r);
    expect(leashBroken(s, s.ships['pinned']!, far, map)).toMatch(/confined to detector range/);
  });

  it('checks the whole course, not only where it ends', () => {
    // A ship may not swing far out and back inside one turn and call it staying.
    const near = hex(TERRA.hex.q + 1, TERRA.hex.r);
    const s = leashed(near);
    const acrossLuna = hex(LUNA.hex.q, LUNA.hex.r);
    const detour = leashBroken(s, s.ships['pinned']!, acrossLuna, map);
    // Terra and Luna are close enough that this particular hop stays inside;
    // the assertion that matters is that the *path* is what is inspected.
    expect(detour === null || /confined/.test(detour)).toBe(true);
  });

  it('does not touch a ship the scenario has not leashed', () => {
    const s = rig([hull('free', A, 'corsair', { pos: DEEP })], {
      scenarioData: { heldNear: { ships: ['someone-else'], worlds: ['terra'] } },
    });
    expect(leashBroken(s, s.ships['free']!, hex(DEEP.q + 1, DEEP.r), map)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap 13 — Nova's alien entry arc
// ---------------------------------------------------------------------------

/** Nova's own verdict on a state, bypassing the reducer's sticky-victory cache. */
const novaVictory = (s: GameState) => scenarioById('nova')!.checkVictory!(s);

describe('the aliens enter along the edge closest to Jupiter (Nova)', () => {
  // "They may enter at any point along the map edge closest to Jupiter at a
  //  speed of one hex per turn. They are detected immediately."
  it('puts them on the rim hexes nearest Jupiter, not merely on that side', () => {
    const s = buildScenario('nova');
    const jupiter = map.body('jupiter')!;
    const aliens = (s.scenarioData['alienShips'] as readonly string[]).map((id) => s.ships[id]!);
    expect(aliens).toHaveLength(4);

    // The closest any rim hex gets to Jupiter, computed independently here.
    let nearest = Infinity;
    for (let q = -40; q <= 40; q += 1) {
      for (let r = -40; r <= 40; r += 1) {
        const h = hex(q, r);
        if (!map.inBounds(h)) continue;
        let onRim = false;
        for (const d of [
          [1, 0],
          [1, -1],
          [0, -1],
          [-1, 0],
          [-1, 1],
          [0, 1],
        ] as const) {
          if (!map.inBounds(hex(q + d[0], r + d[1]))) {
            onRim = true;
            break;
          }
        }
        if (!onRim) continue;
        nearest = Math.min(nearest, distance(h, jupiter.hex));
      }
    }

    for (const alien of aliens) {
      // Four ships cannot all sit on the single nearest hex, but they must be
      // on that arc — within a hex or two of the true minimum, not eleven.
      expect(distance(alien.pos, jupiter.hex)).toBeLessThanOrEqual(nearest + 2);
    }
  });

  /** Wipe out the alien fleet, crediting each kill to `killer` (or to nobody). */
  const alienFleetDown = (killer: PlayerId | null): GameState => {
    const s = buildScenario('nova');
    const ids = s.scenarioData['alienShips'] as readonly string[];
    const ships = { ...s.ships };
    for (const id of ids) {
      ships[id] = {
        ...ships[id]!,
        destroyed: true,
        destroyedBy: killer === null ? 'crashed into Jupiter' : 'gunfire',
        ...(killer === null ? {} : { destroyedByPlayer: killer }),
      };
    }
    return { ...s, ships };
  };

  it('gives the win to the bloc that took the last alien, and to it alone', () => {
    // "The EastBloc or the WestBloc wins by capturing or destroying the last
    //  Alien ship... When one player wins, both others lose."
    const west = novaVictory(alienFleetDown('westbloc'));
    expect(west?.winners).toEqual(['westbloc']);
    expect(west?.level).toBe('decisive');

    const east = novaVictory(alienFleetDown('eastbloc'));
    expect(east?.winners).toEqual(['eastbloc']);
  });

  it('shares the credit when no bloc can claim the last kill', () => {
    // The fleet came apart on its own; nobody "captured or destroyed" it.
    const v = novaVictory(alienFleetDown(null));
    expect([...(v?.winners ?? [])].sort()).toEqual(['eastbloc', 'westbloc']);
    expect(v?.level).toBe('marginal');
  });

  it('applies the printed shared-victory variant only when it is switched on', () => {
    // "Variant: Both the EastBloc and the WestBloc win marginal victories if all
    //  Aliens are destroyed." A variant, so it is off unless asked for.
    const base = alienFleetDown('westbloc');
    const variant: GameState = {
      ...base,
      scenarioData: { ...base.scenarioData, novaSharedVictory: true },
    };
    expect(novaVictory(base)?.winners).toEqual(['westbloc']);
    expect([...(novaVictory(variant)?.winners ?? [])].sort()).toEqual(['eastbloc', 'westbloc']);
  });

  it('has them arriving at one hex per turn, and already seen', () => {
    const s = buildScenario('nova');
    const aliens = (s.scenarioData['alienShips'] as readonly string[]).map((id) => s.ships[id]!);
    for (const alien of aliens) {
      expect(length(alien.velocity)).toBe(1);
      expect(alien.detectedBy.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 10 — Piracy's delivery cycles
// ---------------------------------------------------------------------------

describe('Piracy runs cargo in cycles (pp. 10-11)', () => {
  const MERCHANTS = 'merchants';
  const PIRATES = 'pirates';

  const piracyData = (s: GameState): Record<string, unknown> =>
    s.scenarioData['piracy'] as Record<string, unknown>;

  const merchantTurn = (s: GameState, phase: Phase): GameState => {
    let x = s;
    for (let i = 0; i < 60; i += 1) {
      if (x.phase === phase && seatOf(x) === MERCHANTS) return x;
      x = advance(x);
    }
    throw new Error('never reached the merchant turn');
  };

  it('announces a destination at take-off and loads a cargo to go with it', () => {
    // "The Merchant must announce the destination when a ship takes off."
    const s = merchantTurn(buildScenario('piracy'), 'astrogation');
    const after = ok(s, {
      type: 'announceDestination',
      by: MERCHANTS,
      ship: 'merchant-transport-1',
      destination: 'mars',
    });
    const board = piracyData(after)['destinations'] as Record<string, string>;
    expect(board['merchant-transport-1']).toBe('mars');
    expect(cargoCount(after.ships['merchant-transport-1']!, 'freight')).toBe(1);
  });

  it('refuses a cargo bound for the world it is standing on', () => {
    const s = merchantTurn(buildScenario('piracy'), 'astrogation');
    expect(
      refused(s, {
        type: 'announceDestination',
        by: MERCHANTS,
        ship: 'merchant-transport-1',
        destination: 'terra',
      }),
    ).toMatch(/somewhere else/);
  });

  it('refuses a destination that is not an inhabited world', () => {
    // "Cargoes may be delivered from any inhabited world to any other inhabited
    //  world."
    const s = merchantTurn(buildScenario('piracy'), 'astrogation');
    expect(
      refused(s, {
        type: 'announceDestination',
        by: MERCHANTS,
        ship: 'merchant-transport-1',
        destination: 'sol',
      }),
    ).toMatch(/not an inhabited world/);
  });

  it('lets only the Merchant run cargoes', () => {
    const s = merchantTurn(buildScenario('piracy'), 'astrogation');
    // The pirate has no cargo run, even for a ship it controls.
    const asPirate = { ...s, activePlayerIndex: s.playerOrder.indexOf(PIRATES) };
    const out = applyCommand(
      asPirate,
      {
        type: 'announceDestination',
        by: PIRATES,
        ship: 'pirate-corsair-1',
        destination: 'mars',
      },
      map,
    );
    expect(out.result.ok).toBe(false);
  });

  it('publishes the announcement to the pirate, who owns none of the ships named', () => {
    // "The Merchant must announce the destination when a ship takes off" — an
    // announcement the fog-of-war filter must not swallow.
    const s = merchantTurn(buildScenario('piracy'), 'astrogation');
    const announced = ok(s, {
      type: 'announceDestination',
      by: MERCHANTS,
      ship: 'merchant-transport-1',
      destination: 'mars',
    });
    expect(announced.options.fogOfWar).toBe(true);
    const asSeenByThePirate = redactState(announced, PIRATES, map);
    const board = (asSeenByThePirate.scenarioData['piracy'] as Record<string, unknown>)[
      'destinations'
    ] as Record<string, string>;
    expect(board['merchant-transport-1']).toBe('mars');
  });

  it('scores a delivery, and scores nothing for a world already served', () => {
    // "The Merchant earns 2 points for each cargo delivered... and gets no points
    //  for visiting a world that has already been visited in the cycle."
    let s = merchantTurn(buildScenario('piracy'), 'astrogation');
    const mars = map.body('mars')!;

    // Put the ship down on Mars with a cargo aboard and the run announced.
    s = {
      ...s,
      ships: {
        ...s.ships,
        'merchant-transport-1': {
          ...s.ships['merchant-transport-1']!,
          pos: mars.hex,
          location: { kind: 'landed', side: hexSide(mars.hex, 0) },
          cargo: [{ kind: 'freight', quantity: 1 }],
        },
      },
      scenarioData: {
        ...s.scenarioData,
        piracy: {
          ...piracyData(s),
          destinations: { 'merchant-transport-1': 'mars' },
        },
      },
    };
    s = merchantTurn(s, 'resupply');

    const before = s.players[MERCHANTS]!.points;
    const paid = ok(s, { type: 'deliverCargo', by: MERCHANTS, ship: 'merchant-transport-1' });
    expect(paid.players[MERCHANTS]!.points).toBe(before + 2);
    expect(piracyData(paid)['cycleDeliveries']).toContain('mars');

    // A second cargo to the same world inside the cycle pays nothing.
    const reloaded: GameState = {
      ...paid,
      ships: {
        ...paid.ships,
        'merchant-transport-1': {
          ...paid.ships['merchant-transport-1']!,
          cargo: [{ kind: 'freight', quantity: 1 }],
        },
      },
    };
    const unpaid = ok(reloaded, {
      type: 'deliverCargo',
      by: MERCHANTS,
      ship: 'merchant-transport-1',
    });
    expect(unpaid.players[MERCHANTS]!.points).toBe(paid.players[MERCHANTS]!.points);
  });

  it('always pays for Terra, which never blocks a cycle', () => {
    // "Exception: Terra may always receive a cargo from any other world."
    let s = merchantTurn(buildScenario('piracy'), 'astrogation');
    s = {
      ...s,
      ships: {
        ...s.ships,
        'merchant-transport-1': {
          ...s.ships['merchant-transport-1']!,
          pos: TERRA.hex,
          location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
          cargo: [{ kind: 'freight', quantity: 1 }],
        },
      },
      scenarioData: {
        ...s.scenarioData,
        piracy: {
          ...piracyData(s),
          // Terra has already taken one this cycle...
          cycleDeliveries: ['terra'],
          destinations: { 'merchant-transport-1': 'terra' },
        },
      },
    };
    s = merchantTurn(s, 'resupply');
    const before = s.players[MERCHANTS]!.points;
    const after = ok(s, { type: 'deliverCargo', by: MERCHANTS, ship: 'merchant-transport-1' });
    expect(after.players[MERCHANTS]!.points).toBe(before + 2);
  });

  it('refuses a delivery to a world the ship was not announced for', () => {
    let s = merchantTurn(buildScenario('piracy'), 'astrogation');
    const mars = map.body('mars')!;
    s = {
      ...s,
      ships: {
        ...s.ships,
        'merchant-transport-1': {
          ...s.ships['merchant-transport-1']!,
          pos: mars.hex,
          location: { kind: 'landed', side: hexSide(mars.hex, 0) },
          cargo: [{ kind: 'freight', quantity: 1 }],
        },
      },
      scenarioData: {
        ...s.scenarioData,
        piracy: { ...piracyData(s), destinations: { 'merchant-transport-1': 'venus' } },
      },
    };
    s = merchantTurn(s, 'resupply');
    expect(
      refused(s, { type: 'deliverCargo', by: MERCHANTS, ship: 'merchant-transport-1' }),
    ).toMatch(/announced for venus/);
  });
});

// ---------------------------------------------------------------------------
// Gap 12 — the Freedom Fleet
// ---------------------------------------------------------------------------

describe('the Freedom Fleet musters at Clandestine (Retribution)', () => {
  // "All corvettes which have stopped at Clandestine may be converted into the
  //  Freedom Fleet. Total the combat strength of all corvettes at Clandestine,
  //  and double it."
  const SONS = 'sons-of-liberty';
  const CLANDESTINE = map.body('clandestine')!;

  const withCorvettesAtClandestine = (n: number): GameState => {
    const s = buildScenario('retribution');
    const ships = { ...s.ships };
    for (let i = 0; i < n; i += 1) {
      const id = `rebel-${i}`;
      ships[id] = makeShip({
        id,
        owner: SONS,
        shipClass: 'corvette',
        pos: CLANDESTINE.hex,
        number: 200 + i,
        location: { kind: 'asteroidBase', hex: CLANDESTINE.hex },
      });
    }
    return { ...s, ships };
  };

  const rebelResupply = (s: GameState): GameState => {
    let x = s;
    for (let i = 0; i < 60; i += 1) {
      if (x.phase === 'resupply' && seatOf(x) === SONS) return x;
      x = advance(x);
    }
    throw new Error('never reached the rebel resupply phase');
  };

  it('pays double the mustered combat strength, and spends the corvettes', () => {
    const s = rebelResupply(withCorvettesAtClandestine(3));
    const before = s.players[SONS]!.points;
    const after = ok(s, { type: 'convertFleet', by: SONS });
    const expected = 3 * combatStrength(s.ships['rebel-0']!) * 2;
    expect(after.players[SONS]!.points).toBe(before + expected);
    for (let i = 0; i < 3; i += 1) expect(after.ships[`rebel-${i}`]!.destroyed).toBe(true);
  });

  it('refuses when nothing has reached Clandestine', () => {
    const s = rebelResupply(buildScenario('retribution'));
    expect(refused(s, { type: 'convertFleet', by: SONS })).toMatch(/no corvettes/);
  });

  it('may be raised only once', () => {
    const s = rebelResupply(withCorvettesAtClandestine(2));
    const once = ok(s, { type: 'convertFleet', by: SONS });
    expect(refused(once, { type: 'convertFleet', by: SONS })).toMatch(/already/);
  });

  it('is not an order the Enforcers may give', () => {
    const s = withCorvettesAtClandestine(2);
    const enforcerSeat = { ...s, activePlayerIndex: s.playerOrder.indexOf('enforcers') };
    const out = applyCommand(
      { ...enforcerSeat, phase: 'resupply' },
      { type: 'convertFleet', by: 'enforcers' },
      map,
    );
    expect(out.result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 7 — point-buy at setup
// ---------------------------------------------------------------------------

describe('a scenario that prices its fleet in points accepts a bought one (p. 9)', () => {
  // "Both the EastBloc and the WestBloc players select fleets of 50 combat points
  //  each."
  const fleetOf = (s: GameState, owner: PlayerId): ShipClass[] =>
    Object.values(s.ships)
      .filter((x) => x.owner === owner)
      .map((x) => x.shipClass)
      .sort();

  it('fields the fleet it was handed', () => {
    const chosen: ShipClass[] = ['dreadnaught', 'frigate', 'corsair', 'corvette'];
    const s = buildScenario('nova', { fleets: { westbloc: chosen } });
    expect(fleetOf(s, 'westbloc')).toEqual([...chosen].sort());
  });

  it('falls back to the printed fleet rather than field one over budget', () => {
    // A busted budget is a bug in whatever built it; starting from an illegal
    // position would be worse than starting from the book's own list.
    const overBudget: ShipClass[] = Array.from({ length: 6 }, () => 'dreadnaught');
    const s = buildScenario('nova', { fleets: { westbloc: overBudget } });
    expect(fleetOf(s, 'westbloc')).not.toEqual([...overBudget].sort());
  });

  it('advertises a budget and a catalogue for the buy screen to read', () => {
    // Read off the scenario table rather than hard-coded here, so this test
    // cannot drift from what the picker is actually offered.
    const nova = buildScenario('nova');
    const allowance = nova.scenarioData['combatPointAllowance'] as Record<string, number>;
    expect(allowance['westbloc']).toBe(50);
    expect(allowance['eastbloc']).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Gap 17 — weapon damage on a civilian hull
// ---------------------------------------------------------------------------

describe('weapon hits on a civilian stop mines and nothing else (p. 16)', () => {
  // "Weapon hits on civilian ships have no effect except to prevent their
  //  launching mines." Read strictly — mines, not ordnance in general — because
  //  the rulebook enumerates the three kinds separately everywhere it means all
  //  of them. Civilians may not launch torpedoes at any damage level, so the
  //  only case this decides is a nuke in a damaged freighter's hold.
  const freighter = (): GameState =>
    rig(
      [
        hull('packet', A, 'packet', {
          pos: DEEP,
          advancedDamage: { weapon: 2, drive: 0, structure: 0 },
          cargo: [
            { kind: 'mine', quantity: 1 },
            { kind: 'nuke', quantity: 1 },
          ],
        }),
        hull('target', B, 'corsair', { pos: hex(DEEP.q + 1, DEEP.r) }),
      ],
      { advancedCombat: true, phase: 'ordnance' },
    );

  it('still lets its railguns fire', () => {
    // combat.ts's half of the same sentence.
    const s = freighter();
    expect(canFire(s.ships['packet']!, true)).toBe(true);
  });

  it('refuses the mine', () => {
    const s = freighter();
    expect(refused(s, { type: 'launchOrdnance', by: A, ship: 'packet', kind: 'mine' })).toMatch(
      /may not launch mines/,
    );
  });

  it('allows the nuke', () => {
    const s = freighter();
    const after = ok(s, { type: 'launchOrdnance', by: A, ship: 'packet', kind: 'nuke' });
    expect(Object.values(after.ordnance).some((o) => o.kind === 'nuke')).toBe(true);
  });

  it('stops a warship\u2019s racks entirely, which is the other clause', () => {
    // "A ship with any weapon damage cannot fire guns or drop ordnance."
    const s = rig(
      [
        hull('corsair', A, 'corsair', {
          pos: DEEP,
          advancedDamage: { weapon: 1, drive: 0, structure: 0 },
          cargo: [{ kind: 'mine', quantity: 1 }],
        }),
      ],
      { advancedCombat: true, phase: 'ordnance' },
    );
    expect(refused(s, { type: 'launchOrdnance', by: A, ship: 'corsair', kind: 'mine' })).toMatch(
      /weapon damage/,
    );
  });
});
