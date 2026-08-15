/**
 * Gun combat, rule by rule.
 *
 * Each test quotes the rulebook clause it enforces and is written against that
 * clause rather than against the implementation. A test that merely restates
 * what the code already does catches nothing, so every table below is
 * transcribed from the printed page and every expected result is worked out by
 * hand from the wording, not read back off `combat.ts`.
 *
 * Covers pp. 4-6 (odds, limited attacks, multiple-ship attacks, line of sight,
 * range, relative velocity, counterattack, the damage tables, damage control),
 * pp. 7-8 (landed ships, planetary defences, heroism) and p. 16 (the advanced
 * combat system).
 *
 * Dice are loaded rather than mocked: `forceRoll` swaps in a generator seed
 * whose next face is the one the clause needs, so every result below is the one
 * the printed table gives for that face.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type HexSide,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipClass,
  DEFAULT_MAP,
  HIT_LOCATION,
  add,
  applyAdvancedHits,
  applyCommand,
  clampRoll,
  createInitialState,
  createRng,
  gunDamage,
  gunToHit,
  hex,
  hexSide,
  isDisabled,
  makePlayer,
  makeShip,
  oddsColumn,
  otherDamage,
  otherToHit,
  pendingCounterattack,
  previewAttack,
  rollDie,
  sideGravityHex,
} from '../src/engine/index.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';

/** Deep space: inside the belt's inner edge, no body within many hexes. */
const CLEAR = hex(0, 14);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RigOptions {
  readonly seed?: number;
  readonly options?: Partial<GameState['options']>;
  readonly bases?: readonly { readonly id: string; readonly owner: PlayerId }[];
}

const rig = (ships: readonly Ship[], o: RigOptions = {}): GameState => {
  const s = createInitialState({
    scenarioId: 'rules-combat',
    seed: o.seed ?? 4242,
    players: [
      makePlayer(A, 'Player A', 'Alpha', '#e8703a'),
      makePlayer(B, 'Player B', 'Beta', '#4a9fe0'),
    ],
    ships,
    options: o.options ?? {},
  });
  if (!o.bases) return s;
  const bases = { ...s.bases };
  for (const b of o.bases) bases[b.id] = { ...bases[b.id]!, owner: b.owner };
  return { ...s, bases };
};

/** A one-player table, so a player-turn and a game turn coincide. */
const solo = (ships: readonly Ship[], options: Partial<GameState['options']> = {}): GameState =>
  createInitialState({
    scenarioId: 'rules-combat',
    seed: 11,
    players: [makePlayer(A, 'Player A', 'Alpha', '#e8703a')],
    ships,
    options,
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

/**
 * A refusal, and the reason it gave. Callers that care *which* rule fired match
 * on the returned string: a bare `ok: false` is satisfied by any refusal at all,
 * including one from a generic guard that answered before the rule under test
 * was ever consulted.
 */
const refused = (state: GameState, cmd: Command): string => {
  const out = applyCommand(state, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok }).toEqual({ cmd: cmd.type, ok: false });
  expect(out.state).toBe(state); // a refusal is not an event in the game's history
  expect(out.result.reason ?? '').not.toBe('');
  return out.result.reason ?? '';
};

const seat = (s: GameState): PlayerId => s.playerOrder[s.activePlayerIndex]!;

const advance = (s: GameState): GameState => ok(s, { type: 'endPhase', by: seat(s) });

/** Run the phase machine until `phase` comes round for `player`. */
const reach = (s: GameState, phase: Phase, player: PlayerId = A): GameState => {
  let x = s;
  for (let i = 0; i < 40; i++) {
    if (x.phase === phase && seat(x) === player) return x;
    x = advance(x);
  }
  throw new Error(`never reached ${player}'s ${phase} phase`);
};

const combatPhase = (s: GameState, player: PlayerId = A): GameState => reach(s, 'combat', player);

/** Round the table and come back to `player`'s *next* combat phase. */
const nextCombatPhase = (s: GameState, player: PlayerId = A): GameState =>
  reach(advance(s), 'combat', player);

/** Answer, by declining, any counterattack the last attack left outstanding. */
const settle = (s: GameState): GameState => {
  const pending = pendingCounterattack(s);
  if (!pending) return s;
  return ok(s, { type: 'declineCounterattack', by: s.ships[pending.attackers[0]!]!.owner });
};

const seedCache = new Map<number, number>();
/** A generator seed whose next die roll is exactly `want`. */
const seedFor = (want: number): number => {
  const cached = seedCache.get(want);
  if (cached !== undefined) return cached;
  for (let s = 1; s < 200000; s += 1) {
    if (rollDie(createRng(s)).value === want) {
      seedCache.set(want, s);
      return s;
    }
  }
  throw new Error(`no seed rolls ${want}`);
};

/** Load the dice so the next roll taken from `state` is `want`. */
const forceRoll = (state: GameState, want: number): GameState => ({
  ...state,
  rng: createRng(seedFor(want)),
});

/** The die faces this state will produce, in order. */
const upcomingRolls = (state: GameState, n: number): number[] => {
  let r = state.rng;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const roll = rollDie(r);
    r = roll.state;
    out.push(roll.value);
  }
  return out;
};

const ship = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  pos = CLEAR,
  extra: Partial<Ship> = {},
): Ship => ({ ...makeShip({ id, owner, shipClass, pos }), ...extra });

/**
 * A ship that arrived at `pos` having flown `velocity` to get there. The engine
 * reads the course it flew this turn as `pos - velocity -> pos`, which is the
 * line the range rule measures along.
 */
const flew = (
  id: string,
  owner: PlayerId,
  shipClass: ShipClass,
  pos: ReturnType<typeof hex>,
  velocity: ReturnType<typeof hex>,
): Ship => makeShip({ id, owner, shipClass, pos, velocity });

const shipIn = (s: GameState, id: string): Ship => s.ships[id]!;

const TERRA = map.body('terra')!;
const LUNA = map.body('luna')!;
const CERES = map.body('ceres')!;
const SOL = map.body('sol')!;

// ---------------------------------------------------------------------------
// The printed tables (p. 6)
// ---------------------------------------------------------------------------

describe('the gun combat damage table (p. 6)', () => {
  // GUN COMBAT DAMAGE, transcribed from the printed table. Rows are die rolls
  // 1-6, columns are the six odds levels, and `null` is the printed dash.
  const PRINTED: Record<string, (number | 'E' | null)[]> = {
    //      roll:  1     2     3     4     5     6
    '1:4': [null, null, null, null, null, 1],
    '1:2': [null, null, null, null, 2, 3],
    '1:1': [null, null, null, 2, 3, 4],
    '2:1': [null, null, 2, 3, 4, 5],
    '3:1': [null, 2, 3, 4, 5, 'E'],
    '4:1': [2, 3, 4, 5, 'E', 'E'],
  };

  it('matches the printed table cell for cell', () => {
    for (const [column, results] of Object.entries(PRINTED)) {
      for (let roll = 1; roll <= 6; roll += 1) {
        expect({ column, roll, result: gunDamage(column as never, roll) }).toEqual({
          column,
          roll,
          result: results[roll - 1]!,
        });
      }
    }
  });

  it('has no effect below a modified 1, and caps a modified roll at 6', () => {
    // "A die roll modified to less than 1 has no effect. A die roll modified to
    //  more than 6 is 6."
    expect(clampRoll(0)).toBeNull();
    expect(clampRoll(-3)).toBeNull();
    expect(clampRoll(1)).toBe(1);
    expect(clampRoll(6)).toBe(6);
    expect(clampRoll(7)).toBe(6);
    expect(clampRoll(11)).toBe(6);
    expect(gunDamage('4:1', 11)).toBe('E');
    expect(gunDamage('4:1', 0)).toBeNull();
  });

  it('cannot succeed once the range modifier reaches -6', () => {
    // "Note that a range modification of -6 will mean that an attack cannot
    //  succeed."
    for (let face = 1; face <= 6; face += 1) {
      expect({ face, result: gunDamage('4:1', face - 6) }).toEqual({ face, result: null });
    }
  });
});

describe('the other damage table (p. 6)', () => {
  // OTHER DAMAGE, transcribed from the printed table.
  const PRINTED: Record<string, (number | null)[]> = {
    //          roll: 1     2     3     4     5   6
    torpedo: [null, 1, 1, 1, 2, 3],
    mine: [null, null, null, null, 2, 2],
    asteroid: [null, null, null, null, 1, 2],
    ram: [null, null, 1, 1, 3, 5],
  };

  it('matches the printed table cell for cell', () => {
    for (const [kind, results] of Object.entries(PRINTED)) {
      for (let roll = 1; roll <= 6; roll += 1) {
        expect({ kind, roll, result: otherDamage(kind as never, roll) }).toEqual({
          kind,
          roll,
          result: results[roll - 1]!,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Odds (p. 4)
// ---------------------------------------------------------------------------

describe('odds', () => {
  it('resolves the rulebook’s own worked example', () => {
    // "Example: A corsair (combat strength 4) attacks a corvette (combat
    //  strength 2). 4 to 2 reduces to 2-to-1, so the attack is rolled on the
    //  2-to-1 column."
    expect(oddsColumn(4, 2)).toBe('2:1');
  });

  it('always rounds the ratio in favour of the defender', () => {
    // "This ratio is then reduced (if necessary) to one of the odds levels given
    //  on the combat results table. If rounding is necessary, it is always done
    //  in favor of the defender."
    //
    // Every expectation is the printed odds level immediately *below* the true
    // ratio, worked out by hand.
    const cases: [number, number, string][] = [
      [2, 2, '1:1'], //  1.00 — exactly 1:1
      [16, 15, '1:1'], //  1.07 — a shade over 1:1 is still 1:1
      [8, 6, '1:1'], //  1.33
      [3, 2, '1:1'], //  1.50 — halfway to 2:1 stays at 1:1
      [15, 8, '1:1'], //  1.88 — nearly 2:1, but not 2:1
      [4, 2, '2:1'], //  2.00
      [15, 6, '2:1'], //  2.50
      [8, 3, '2:1'], //  2.67
      [6, 2, '3:1'], //  3.00
      [15, 4, '3:1'], //  3.75
      [8, 2, '4:1'], //  4.00
      [15, 2, '4:1'], //  7.50 — capped
      [16, 1, '4:1'], // 16.00 — capped
      [15, 16, '1:2'], //  0.94 — just under 1:1 drops a whole column
      [15, 20, '1:2'], //  0.75
      [2, 3, '1:2'], //  0.67
      [4, 8, '1:2'], //  0.50
      [8, 17, '1:4'], //  0.47 — under 1:2, so down to 1:4
      [2, 6, '1:4'], //  0.33
      [4, 15, '1:4'], //  0.27
      [2, 8, '1:4'], //  0.25
      [1, 4, '1:4'], //  0.25
    ];
    for (const [attack, defence, column] of cases) {
      expect({ attack, defence, column: oddsColumn(attack, defence) }).toEqual({
        attack,
        defence,
        column,
      });
    }
  });

  it('caps at 4:1 and has no effect below 1:4', () => {
    // "Attacks at better than 4:1 are 4:1." / "Attacks at less than 1:4 have no
    //  effect."
    expect(oddsColumn(1000, 1)).toBe('4:1');
    expect(oddsColumn(2, 9)).toBeNull(); // 0.22
    expect(oddsColumn(2, 15)).toBeNull(); // 0.13
    expect(oddsColumn(1, 5)).toBeNull(); // 0.20
    expect(oddsColumn(4, 16)).toBe('1:4'); // the boundary is still an attack
  });

  it('pools every attacker and sums every defender', () => {
    // "Multiple attacking ships, in the same or different hexes, may attack with
    //  the sum of their combat strengths." / "Any combination of ships attacked
    //  together defends with the sum of their combat strengths."
    //
    // Two corvettes (2 + 2 = 4) in *different* hexes against a corsair and a
    // corvette sharing one hex (4 + 2 = 6): 4 to 6 is 0.67, so 1:2.
    const s = rig([
      ship('a1', A, 'corvette', CLEAR),
      ship('a2', A, 'corvette', add(CLEAR, hex(1, 0))),
      ship('d1', B, 'corsair', add(CLEAR, hex(2, 0))),
      ship('d2', B, 'corvette', add(CLEAR, hex(2, 0))),
    ]);
    const p = previewAttack(s, ['a1', 'a2'], ['d1', 'd2'], map);
    expect({ ok: p.legal, atk: p.attackStrength, def: p.defenceStrength, col: p.column }).toEqual({
      ok: true,
      atk: 4,
      def: 6,
      col: '1:2',
    });
  });

  it('lets a ship attack with less than its rated strength', () => {
    // "A ship may always attack or counterattack with less than its rated combat
    //  strength, if it hopes to disable a target without destroying it."
    const s = rig([
      ship('atk', A, 'dreadnaught', CLEAR), // 15
      ship('def', B, 'corvette', add(CLEAR, hex(1, 0))), // 2
    ]);
    expect(previewAttack(s, ['atk'], ['def'], map).column).toBe('4:1');
    expect(previewAttack(s, ['atk'], ['def'], map, 2).column).toBe('1:1');
    expect(previewAttack(s, ['atk'], ['def'], map, 1).column).toBe('1:2');
    // "LESS than its rated combat strength" — never more.
    expect(previewAttack(s, ['atk'], ['def'], map, 40).attackStrength).toBe(15);
    // And an attack has to be made with something.
    expect(previewAttack(s, ['atk'], ['def'], map, 0).legal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Range (p. 5)
// ---------------------------------------------------------------------------

describe('range', () => {
  it('is measured from the attacker’s closest approach, not from where it stopped', () => {
    // "Range (the distance between the two ships) is used as a die modifier in
    //  combat... This range is always measured from the attacker's closest
    //  approach to the target's final position."
    //
    // Figure 8: the attacker swept past the defender and carried on. It finished
    // three hexes away, but its course took it right alongside, so the range is 1.
    const s = rig([
      flew('atk', A, 'corsair', add(CLEAR, hex(5, 0)), hex(5, 0)),
      ship('def', B, 'corvette', add(CLEAR, hex(2, 1))),
    ]);
    const p = previewAttack(s, ['atk'], ['def'], map);
    expect({ range: p.range, mod: p.modifiers.range }).toEqual({ range: 1, mod: -1 });
  });

  it('ignores the defender’s own vector', () => {
    // Figure 8: "The defender's vector does not matter."
    const target = add(CLEAR, hex(3, 0));
    const still = rig([
      flew('atk', A, 'corsair', CLEAR, hex(1, 0)),
      flew('def', B, 'corvette', target, hex(0, 0)),
    ]);
    const racing = rig([
      flew('atk', A, 'corsair', CLEAR, hex(1, 0)),
      flew('def', B, 'corvette', target, hex(4, -2)),
    ]);
    expect(previewAttack(still, ['atk'], ['def'], map).range).toBe(3);
    expect(previewAttack(racing, ['atk'], ['def'], map).range).toBe(3);
  });

  it('subtracts one from the die roll for every hex of range', () => {
    // "Subtract 1 from the die roll for each hex of range separating the
    //  attacker and the target. Example: If the range is 4 and the die roll is a
    //  6, the result is 2 (6 minus 4 is 2)."
    for (let d = 0; d <= 6; d += 1) {
      const s = rig([
        ship('atk', A, 'corsair', CLEAR),
        ship('def', B, 'corvette', add(CLEAR, hex(d, 0))),
      ]);
      const p = previewAttack(s, ['atk'], ['def'], map);
      // -1 per hex; range 0 is the only case that costs nothing.
      expect({ d, range: p.range, mod: p.modifiers.range }).toEqual({
        d,
        range: d,
        mod: d === 0 ? 0 : -d,
      });
    }
  });

  it('uses the greatest range applicable, over targets and over attackers alike', () => {
    // "In multiple ship attacks, use the greatest range applicable." / "In any
    //  combat with multiple targets or attackers, use the greatest possible
    //  penalties for range and relative velocity."
    const spread = rig([
      ship('atk', A, 'frigate', CLEAR),
      ship('d1', B, 'corvette', add(CLEAR, hex(3, 0))),
      ship('d2', B, 'corvette', add(CLEAR, hex(3, 0))),
    ]);
    expect(previewAttack(spread, ['atk'], ['d1', 'd2'], map).range).toBe(3);

    // Two attackers, one alongside the target and one four hexes off: pooling
    // costs the near ship, because the worst range is the one that counts.
    const pair = rig([
      ship('a1', A, 'corvette', add(CLEAR, hex(1, 0))),
      ship('a2', A, 'corvette', add(CLEAR, hex(4, 0))),
      ship('def', B, 'corvette', CLEAR),
    ]);
    expect(previewAttack(pair, ['a1'], ['def'], map).range).toBe(1);
    expect(previewAttack(pair, ['a1', 'a2'], ['def'], map).range).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Relative velocity (p. 5)
// ---------------------------------------------------------------------------

describe('relative velocity', () => {
  const diff = (va: ReturnType<typeof hex>, vb: ReturnType<typeof hex>) => {
    const s = rig([
      flew('atk', A, 'corsair', CLEAR, va),
      flew('def', B, 'corvette', add(CLEAR, hex(1, 0)), vb),
    ]);
    return previewAttack(s, ['atk'], ['def'], map);
  };

  it('is the gap between the two course vectors drawn from a common point', () => {
    // "Relative velocity is determined by plotting both ships' course vectors
    //  from a common point and counting the hexes separating the two course end
    //  points."
    //
    // Figure 9: one ship runs A->B, the other C->D; replot the second from A and
    // its head lands at E, two hexes from B — a difference of 2.
    expect(diff(hex(2, 0), hex(0, 0)).relativeVelocity).toBe(2);
    expect(diff(hex(3, 0), hex(3, 0)).relativeVelocity).toBe(0);
    expect(diff(hex(2, 0), hex(0, 2)).relativeVelocity).toBe(2);
    // Closing head-on: +2 against -2 is a gap of four, not zero.
    expect(diff(hex(2, 0), hex(-2, 0)).relativeVelocity).toBe(4);
    // Same speed, sixty degrees apart.
    expect(diff(hex(3, 0), hex(0, 3)).relativeVelocity).toBe(3);
  });

  it('costs nothing up to a difference of two, then one per further hex', () => {
    // "Subtract 1 from the combat die roll for each hex of velocity difference
    //  greater than 2. For example, in Figure 9, the velocity difference is 2;
    //  there is no die modifier for velocity difference in this combat
    //  situation."
    const expected: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: -1, 4: -2, 5: -3, 6: -4 };
    for (let v = 0; v <= 6; v += 1) {
      const p = diff(hex(v, 0), hex(0, 0));
      expect({ v, gap: p.relativeVelocity, mod: p.modifiers.relativeVelocity }).toEqual({
        v,
        gap: v,
        mod: expected[v]!,
      });
    }
  });

  it('uses the greatest velocity difference applicable', () => {
    // "In multiple ship attacks, use the greatest applicable velocity
    //  difference."
    const s = rig([
      flew('a1', A, 'corvette', CLEAR, hex(1, 0)),
      flew('a2', A, 'corvette', CLEAR, hex(5, 0)),
      flew('d1', B, 'corvette', add(CLEAR, hex(1, 0)), hex(1, 0)),
      flew('d2', B, 'corvette', add(CLEAR, hex(1, 0)), hex(0, 0)),
    ]);
    expect(previewAttack(s, ['a1'], ['d1'], map).relativeVelocity).toBe(0);
    // a2 differs from d1 by 4 and from d2 by 5; the worst pair wins.
    const pooled = previewAttack(s, ['a1', 'a2'], ['d1', 'd2'], map);
    expect({ gap: pooled.relativeVelocity, mod: pooled.modifiers.relativeVelocity }).toEqual({
      gap: 5,
      mod: -3,
    });
  });
});

// ---------------------------------------------------------------------------
// Line of sight (p. 5)
// ---------------------------------------------------------------------------

describe('line of sight', () => {
  const across = (centre: ReturnType<typeof hex>, extra: readonly Ship[] = []) =>
    rig([
      ship('atk', A, 'corsair', add(centre, hex(-3, 0))),
      ship('def', B, 'corvette', add(centre, hex(3, 0))),
      ...extra,
    ]);

  it('is blocked by moons, planets and Sol', () => {
    // "Attacks may be made 'through' other ships, ordnance, and asteroids, but
    //  not through moons, planets, or Sol. If a straight line between the
    //  attacker and target intersects the printed image of the astral body, the
    //  attack is not possible."
    for (const body of [TERRA, LUNA, SOL]) {
      const p = previewAttack(across(body.hex), ['atk'], ['def'], map);
      expect({ body: body.name, legal: p.legal, blockedBy: p.blockedBy }).toEqual({
        body: body.name,
        legal: false,
        blockedBy: body.name,
      });
    }
  });

  it('is not blocked by asteroids — not even Ceres', () => {
    // The clause names only "moons, planets, or Sol". Ceres is a major asteroid,
    // and its hex sits in the belt, so this covers ordinary rock too.
    expect(previewAttack(across(CERES.hex), ['atk'], ['def'], map).legal).toBe(true);
  });

  it('is not blocked by ships standing in the way', () => {
    // "Attacks may be made 'through' other ships..."
    const s = across(CLEAR, [
      ship('screen1', B, 'frigate', add(CLEAR, hex(-1, 0))),
      ship('screen2', A, 'frigate', add(CLEAR, hex(1, 0))),
    ]);
    expect(previewAttack(s, ['atk'], ['def'], map).legal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Who may shoot (pp. 1, 4)
// ---------------------------------------------------------------------------

describe('who may fire', () => {
  it('refuses every D-suffix ship as an attacker', () => {
    // "Ships with a D after their combat strength may not attack or
    //  counterattack; their strength is defensive only." The ship table prints
    //  Transport 1D, Tanker 1D and Liner 2D.
    for (const cls of ['transport', 'tanker', 'liner'] as const) {
      const s = combatPhase(rig([ship('atk', A, cls, CLEAR), ship('def', B, 'corvette', CLEAR)]));
      expect(
        refused(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
      ).toBeTruthy();
    }
  });

  it('lets a packet fire — its 2 carries no D', () => {
    // "Packet – A transport with extra armor and reinforcement, and a couple of
    //  railguns for self-defense." The table prints its strength as a plain 2.
    const s = combatPhase(
      rig([ship('atk', A, 'packet', CLEAR), ship('def', B, 'corvette', CLEAR)]),
    );
    ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
  });

  it('lets only the phasing player open fire', () => {
    // "Only ships of the phasing player may initiate attacks. Ships of the
    //  non-phasing player, if attacked, may counterattack."
    const s = combatPhase(
      rig([ship('atk', A, 'corsair', CLEAR), ship('def', B, 'corvette', CLEAR)]),
    );
    expect(
      refused(s, { type: 'attack', by: B, attackers: ['def'], targets: ['atk'] }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Multiple-ship attacks (p. 4)
// ---------------------------------------------------------------------------

describe('multiple-ship attacks', () => {
  it('requires ships attacked together to share a hex', () => {
    // "If more than one ship occupies a hex, the attacker may attack one, some,
    //  or all of them in one attack."
    const s = rig([
      ship('atk', A, 'frigate', CLEAR),
      ship('d1', B, 'corvette', add(CLEAR, hex(1, 0))),
      ship('d2', B, 'corvette', add(CLEAR, hex(2, 0))),
    ]);
    expect(previewAttack(s, ['atk'], ['d1', 'd2'], map).legal).toBe(false);
    expect(previewAttack(s, ['atk'], ['d1'], map).legal).toBe(true);
  });

  it('lets attackers pool from different hexes', () => {
    // "Multiple attacking ships, IN THE SAME OR DIFFERENT HEXES, may attack with
    //  the sum of their combat strengths."
    const s = rig([
      ship('a1', A, 'corvette', CLEAR),
      ship('a2', A, 'corvette', add(CLEAR, hex(2, 0))),
      ship('def', B, 'corvette', add(CLEAR, hex(1, 0))),
    ]);
    expect(previewAttack(s, ['a1', 'a2'], ['def'], map).legal).toBe(true);
  });

  it('stops a ship attacking twice in one combat phase', () => {
    // "No ship may attack or be attacked more than once per combat phase."
    let s = combatPhase(
      rig([
        ship('atk', A, 'corsair', CLEAR),
        ship('d1', B, 'corvette', CLEAR),
        ship('d2', B, 'corvette', add(CLEAR, hex(1, 0))),
      ]),
    );
    s = settle(ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['d1'] }));
    expect(refused(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['d2'] })).toMatch(
      /already/i,
    );
  });

  it('stops a ship being attacked twice in one combat phase', () => {
    // The other half of the same sentence: a fresh attacker may not finish off a
    // target that has already been shot at this phase.
    let s = combatPhase(
      rig([
        ship('a1', A, 'corsair', CLEAR),
        ship('a2', A, 'corsair', add(CLEAR, hex(1, 0))),
        ship('def', B, 'corvette', add(CLEAR, hex(2, 0))),
      ]),
    );
    s = settle(ok(s, { type: 'attack', by: A, attackers: ['a1'], targets: ['def'] }));
    expect(refused(s, { type: 'attack', by: A, attackers: ['a2'], targets: ['def'] })).toMatch(
      /already/i,
    );
  });

  it('opens the restriction again in the next combat phase', () => {
    // The limit is "per combat phase", not per game: the same guns fire again on
    // the next player-turn.
    let s = combatPhase(rig([ship('atk', A, 'corsair', CLEAR), ship('def', B, 'corvette', CLEAR)]));
    s = settle(ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }));
    refused(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
    s = nextCombatPhase(s, A);
    ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] });
  });
});

// ---------------------------------------------------------------------------
// Counterattack (p. 5)
// ---------------------------------------------------------------------------

describe('counterattack', () => {
  it('is resolved before the attack’s damage is implemented', () => {
    // "Ships which are attacked may return fire against any or all of their
    //  attackers during the combat phase, BEFORE ANY DAMAGE IS IMPLEMENTED."
    //
    // A dreadnaught (15) against a frigate (8) is 1.88, so 1:1, and a 5 there is
    // D3. The frigate answers at 8 against 15 — 0.53, so 1:2 — where a 6 is D3.
    // The return fire must be rolled with the frigate's strength untouched.
    let s = combatPhase(
      rig([ship('atk', A, 'dreadnaught', CLEAR), ship('vic', B, 'frigate', CLEAR)]),
    );
    s = ok(forceRoll(s, 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect(shipIn(s, 'vic').disabled).toBe(0); // nothing implemented yet
    expect(pendingCounterattack(s)).toEqual({ attackers: ['vic'], targets: ['atk'] });

    const back = previewAttack(s, ['vic'], ['atk'], map, undefined, 'counterattack');
    expect({ atk: back.attackStrength, def: back.defenceStrength, col: back.column }).toEqual({
      atk: 8,
      def: 15,
      col: '1:2',
    });

    s = ok(forceRoll(s, 6), { type: 'counterattack', by: B, attackers: ['vic'], targets: ['atk'] });
    expect({ victim: shipIn(s, 'vic').disabled, attacker: shipIn(s, 'atk').disabled }).toEqual({
      victim: 3,
      attacker: 3,
    });
  });

  it('lets a ship the attack eliminates still fire back', () => {
    // The sharpest reading of "before any damage is implemented": an E result.
    // 15 against 4 is 3.75, so 3:1, where a 6 is E. The dying corsair answers at
    // 4 against 15 — 0.27, so 1:4 — where a 6 is D1.
    let s = combatPhase(
      rig([ship('atk', A, 'dreadnaught', CLEAR), ship('vic', B, 'corsair', CLEAR)]),
    );
    s = ok(forceRoll(s, 6), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect(shipIn(s, 'vic').destroyed).toBe(false);
    s = ok(forceRoll(s, 6), { type: 'counterattack', by: B, attackers: ['vic'], targets: ['atk'] });
    expect({ victim: shipIn(s, 'vic').destroyed, attacker: shipIn(s, 'atk').disabled }).toEqual({
      victim: true,
      attacker: 1,
    });
  });

  it('recomputes the odds in favour of the new defender', () => {
    // "Odds are recomputed, ROUNDED IN FAVOR OF THE NEW DEFENDER, and new values
    //  for range and relative velocity are determined."
    //
    // Out: frigate 8 against corsair 4 + corvette 2 = 6, i.e. 1.33 -> 1:1.
    // Back: 6 against 8 is 0.75, which must fall to 1:2, not round up to 1:1.
    const s = combatPhase(
      rig([
        ship('atk', A, 'frigate', CLEAR),
        ship('v1', B, 'corsair', add(CLEAR, hex(1, 0))),
        ship('v2', B, 'corvette', add(CLEAR, hex(1, 0))),
      ]),
    );
    expect(previewAttack(s, ['atk'], ['v1', 'v2'], map).column).toBe('1:1');
    const out = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['v1', 'v2'] });
    expect(previewAttack(out, ['v1', 'v2'], ['atk'], map, undefined, 'counterattack').column).toBe(
      '1:2',
    );
  });

  it('admits only ships in the victim’s hex and sharing its course', () => {
    // "Any ships in the victim's hex AND SHARING ITS COURSE may participate in
    //  the counterattack."
    //
    // Only the phasing player's ships move in the movement phase, so B's ships
    // are still exactly where they were placed when A's combat phase opens.
    const course = hex(1, 0);
    const s = combatPhase(
      rig([
        ship('atk', A, 'frigate', add(CLEAR, hex(4, 0))),
        flew('vic', B, 'corvette', CLEAR, course),
        flew('mate', B, 'corvette', CLEAR, course), // same hex, same course
        flew('drifter', B, 'corvette', CLEAR, hex(0, 1)), // same hex, other course
        flew('outrider', B, 'corvette', add(CLEAR, hex(1, 0)), course), // same course, other hex
        flew('freighter', B, 'transport', CLEAR, course), // same hex and course, but 1D
      ]),
    );
    const out = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect([...pendingCounterattack(out)!.attackers].sort()).toEqual(['mate', 'vic']);
    for (const id of ['drifter', 'outrider', 'freighter']) {
      expect(
        refused(out, { type: 'counterattack', by: B, attackers: [id], targets: ['atk'] }),
      ).toMatch(/counterattack|return fire/i);
    }
  });

  it('never lets a D-suffix ship return fire', () => {
    // "Commercial ships have a suffix D in their combat strengths and may not
    //  attack OR COUNTERATTACK."
    const s = combatPhase(
      rig([ship('atk', A, 'corsair', CLEAR), ship('vic', B, 'transport', CLEAR)]),
    );
    const out = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect(pendingCounterattack(out)).toBeNull();
    expect(
      refused(out, { type: 'counterattack', by: B, attackers: ['vic'], targets: ['atk'] }),
    ).toBeTruthy();
  });

  it('may only be aimed at the ships that did the attacking', () => {
    // "...may return fire against any or all of THEIR ATTACKERS."
    const s = combatPhase(
      rig([
        ship('a1', A, 'corsair', CLEAR),
        ship('bystander', A, 'corsair', add(CLEAR, hex(1, 0))),
        ship('vic', B, 'corsair', CLEAR),
      ]),
    );
    const out = ok(s, { type: 'attack', by: A, attackers: ['a1'], targets: ['vic'] });
    expect(
      refused(out, { type: 'counterattack', by: B, attackers: ['vic'], targets: ['bystander'] }),
    ).toMatch(/attack/i);
    ok(out, { type: 'counterattack', by: B, attackers: ['vic'], targets: ['a1'] });
  });

  it('may be made with less than the returning ship’s rated strength', () => {
    // "A ship may always attack OR COUNTERATTACK with less than its rated combat
    //  strength."
    const s = combatPhase(
      rig([ship('atk', A, 'corvette', CLEAR), ship('vic', B, 'dreadnaught', CLEAR)]),
    );
    const out = ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect(previewAttack(out, ['vic'], ['atk'], map, undefined, 'counterattack').column).toBe(
      '4:1',
    );
    expect(previewAttack(out, ['vic'], ['atk'], map, 2, 'counterattack').column).toBe('1:1');
    ok(out, { type: 'counterattack', by: B, attackers: ['vic'], targets: ['atk'], strength: 2 });
  });

  it('uses the largest range and velocity modifiers when several ships are counterattacked', () => {
    // "If several ships are counterattacked, the largest possible velocity
    //  difference and range modifiers are used."
    const s = rig([
      flew('a1', A, 'corvette', add(CLEAR, hex(1, 0)), hex(0, 0)),
      flew('a2', A, 'corvette', add(CLEAR, hex(4, 0)), hex(4, 0)),
      flew('vic', B, 'frigate', CLEAR, hex(0, 0)),
    ]);
    const one = previewAttack(s, ['vic'], ['a1'], map, undefined, 'counterattack');
    const both = previewAttack(s, ['vic'], ['a1', 'a2'], map, undefined, 'counterattack');
    expect({ range: one.range, vel: one.relativeVelocity }).toEqual({ range: 1, vel: 0 });
    expect({ range: both.range, vel: both.relativeVelocity }).toEqual({ range: 4, vel: 4 });
    expect(both.modifiers.total).toBe(-6); // -4 for range, -2 for the velocity over 2
  });

  it('spends the returning ship’s one shot for the phase', () => {
    // Return fire is an attack, and "No ship may attack or be attacked more than
    //  once per combat phase." Once a ship has answered, it has no shot left to
    //  join a later victim's return fire.
    const course = hex(1, 0);
    let s = combatPhase(
      rig([
        ship('a1', A, 'corsair', add(CLEAR, hex(4, 0))),
        ship('a2', A, 'corsair', add(CLEAR, hex(5, 0))),
        flew('v1', B, 'corvette', CLEAR, course),
        flew('v2', B, 'corvette', CLEAR, course),
      ]),
    );
    s = ok(s, { type: 'attack', by: A, attackers: ['a1'], targets: ['v1'] });
    expect([...pendingCounterattack(s)!.attackers].sort()).toEqual(['v1', 'v2']);
    s = ok(s, { type: 'counterattack', by: B, attackers: ['v1', 'v2'], targets: ['a1'] });

    // v2 is a fresh target — but it has already fired, so nobody may answer.
    s = ok(s, { type: 'attack', by: A, attackers: ['a2'], targets: ['v2'] });
    expect(pendingCounterattack(s)).toBeNull();
    expect(
      refused(s, { type: 'counterattack', by: B, attackers: ['v2'], targets: ['a2'] }),
    ).toBeTruthy();
  });

  it('lands the attack’s damage untouched when the defender declines', () => {
    let s = combatPhase(rig([ship('atk', A, 'corsair', CLEAR), ship('vic', B, 'corvette', CLEAR)]));
    // 4 against 2 is 2:1, where a 5 is D4.
    s = ok(forceRoll(s, 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] });
    expect(shipIn(s, 'vic').disabled).toBe(0);
    s = ok(s, { type: 'declineCounterattack', by: B });
    expect(shipIn(s, 'vic').disabled).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Damage results (p. 6)
// ---------------------------------------------------------------------------

describe('damage results', () => {
  it('is cumulative, and D6 or greater destroys', () => {
    // "Damage is cumulative; if a ship is already disabled, any new results are
    //  added to its current period of disablement. If a ship ever reaches a
    //  condition of D6 or greater, it is destroyed. For example, if a ship which
    //  will be disabled for 3 more turns receives a D3 result, it is destroyed."
    //
    // A corsair (4) against a transport (1) is 4:1, where a 1 is D2 and a 2 is
    // D3. Two freighters already sitting at D3: one takes the rulebook's own D3
    // and dies, the other takes D2 and lives on 5.
    let s = combatPhase(
      rig([
        ship('a1', A, 'corsair', CLEAR),
        ship('a2', A, 'corsair', add(CLEAR, hex(3, 0))),
        ship('doomed', B, 'transport', CLEAR, { disabled: 3 }),
        ship('lucky', B, 'transport', add(CLEAR, hex(3, 0)), { disabled: 3 }),
      ]),
    );
    s = settle(
      ok(forceRoll(s, 2), { type: 'attack', by: A, attackers: ['a1'], targets: ['doomed'] }),
    );
    expect(shipIn(s, 'doomed').destroyed).toBe(true);

    s = settle(
      ok(forceRoll(s, 1), { type: 'attack', by: A, attackers: ['a2'], targets: ['lucky'] }),
    );
    expect({ d: shipIn(s, 'lucky').disabled, dead: shipIn(s, 'lucky').destroyed }).toEqual({
      d: 5,
      dead: false,
    });
  });

  it('leaves a ship alive at D5 — the threshold is D6', () => {
    let s = combatPhase(
      rig([ship('atk', A, 'dreadnaught', CLEAR), ship('vic', B, 'transport', CLEAR)]),
    );
    // 15 against 1 is capped at 4:1, where a 4 is D5.
    s = settle(
      ok(forceRoll(s, 4), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] }),
    );
    expect({ d: shipIn(s, 'vic').disabled, dead: shipIn(s, 'vic').destroyed }).toEqual({
      d: 5,
      dead: false,
    });
  });

  it('eliminates outright on an E', () => {
    // "E – Eliminated. The target ship is destroyed."
    let s = combatPhase(
      rig([ship('atk', A, 'dreadnaught', CLEAR), ship('vic', B, 'transport', CLEAR)]),
    );
    s = settle(
      ok(forceRoll(s, 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] }),
    );
    expect(shipIn(s, 'vic').destroyed).toBe(true);
  });

  it('applies the one gun result to every ship attacked together', () => {
    // An inference, not a quotation, and the largest one in this file: no printed
    // sentence says a gun result reaches the whole group. What the rules do say
    // is that a group "defends with the sum of their combat strengths" and that
    // "A torpedo hits only a single target" — flagged as an exception, which
    // means nothing unless gunfire is the rule it departs from. Pinned here
    // because one die taking three corvettes to D5 at once is too consequential
    // to leave unrecorded either way.
    //
    // 15 against three corvettes (6) is 2.5, so 2:1, where a 6 is D5.
    let s = combatPhase(
      rig([
        ship('atk', A, 'dreadnaught', CLEAR),
        ship('d1', B, 'corvette', CLEAR),
        ship('d2', B, 'corvette', CLEAR),
        ship('d3', B, 'corvette', CLEAR),
      ]),
    );
    s = settle(
      ok(forceRoll(s, 6), {
        type: 'attack',
        by: A,
        attackers: ['atk'],
        targets: ['d1', 'd2', 'd3'],
      }),
    );
    for (const id of ['d1', 'd2', 'd3']) {
      expect({ id, d: shipIn(s, id).disabled }).toEqual({ id, d: 5 });
    }
  });

  it('stops a disabled ship manoeuvring, launching ordnance or attacking', () => {
    // "A disabled ship cannot maneuver, launch ordnance, or attack. It may only
    //  drift on its current course."
    const s = rig([
      ship('v', A, 'corsair', CLEAR, { disabled: 2, cargo: [{ kind: 'torpedo', quantity: 1 }] }),
      ship('def', B, 'corvette', CLEAR),
    ]);
    expect(
      refused(s, { type: 'plotCourse', by: A, ship: 'v', endpoint: add(CLEAR, hex(1, 0)) }),
    ).toBeTruthy();
    expect(
      refused(reach(s, 'ordnance', A), {
        type: 'launchOrdnance',
        by: A,
        ship: 'v',
        kind: 'torpedo',
      }),
    ).toBeTruthy();
    expect(
      refused(combatPhase(s, A), { type: 'attack', by: A, attackers: ['v'], targets: ['def'] }),
    ).toBeTruthy();
  });

  it('lets a disabled dreadnaught fire its guns, and nothing else', () => {
    // "Exceptions: Dreadnaughts may still fire their guns (ONLY) even though
    //  disabled."
    const s = rig([
      ship('dn', A, 'dreadnaught', CLEAR, {
        disabled: 3,
        cargo: [{ kind: 'torpedo', quantity: 1 }],
      }),
      ship('def', B, 'corvette', CLEAR),
    ]);
    ok(combatPhase(s, A), { type: 'attack', by: A, attackers: ['dn'], targets: ['def'] });
    expect(
      refused(s, { type: 'plotCourse', by: A, ship: 'dn', endpoint: add(CLEAR, hex(1, 0)) }),
    ).toBeTruthy();
    expect(
      refused(reach(s, 'ordnance', A), {
        type: 'launchOrdnance',
        by: A,
        ship: 'dn',
        kind: 'torpedo',
      }),
    ).toBeTruthy();
  });

  // Arguments from silence, and flagged as such: nothing printed says that
  // damage leaves a ship's defensive strength intact. The basis is that combat
  // strength is a number printed on the counter, and the rules supply no
  // mechanism at all that alters it — the D suffix is the only qualifier they
  // attach to one.
  it('leaves a disabled ship defending at its full printed strength', () => {
    // "The combat strength of a ship represents both the high-velocity guns it
    //  carries AND THE STRUCTURAL ABILITY OF THE SHIP TO WITHSTAND DAMAGE." One
    //  number does both jobs, and nothing in the damage rules scales it down —
    //  disablement is a period of helplessness, not a loss of armour.
    const s = rig([
      ship('atk', A, 'corsair', CLEAR),
      ship('def', B, 'corsair', CLEAR, { disabled: 4 }),
    ]);
    const p = previewAttack(s, ['atk'], ['def'], map);
    expect({ def: p.defenceStrength, col: p.column }).toEqual({ def: 4, col: '1:1' });
  });

  it('keeps an orbital base fighting while only slightly damaged', () => {
    // "An orbital base may launch torpedoes, fire guns, and resupply friendly
    //  ships while the base itself is slightly (D1) damaged."
    const at = (d: number): GameState =>
      rig([
        ship('ob', A, 'orbitalBase', CLEAR, {
          disabled: d,
          cargo: [{ kind: 'torpedo', quantity: 1 }],
        }),
        ship('def', B, 'corvette', CLEAR),
      ]);
    ok(combatPhase(at(1), A), { type: 'attack', by: A, attackers: ['ob'], targets: ['def'] });
    ok(reach(at(1), 'ordnance', A), { type: 'launchOrdnance', by: A, ship: 'ob', kind: 'torpedo' });
    // D2 is past "slightly (D1) damaged".
    expect(
      refused(combatPhase(at(2), A), {
        type: 'attack',
        by: A,
        attackers: ['ob'],
        targets: ['def'],
      }),
    ).toBeTruthy();
    expect(
      refused(reach(at(2), 'ordnance', A), {
        type: 'launchOrdnance',
        by: A,
        ship: 'ob',
        kind: 'torpedo',
      }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Damage control (p. 6)
// ---------------------------------------------------------------------------

describe('damage control', () => {
  it('repairs exactly one D per turn', () => {
    // "A damaged ship will repair itself at the rate of one 'D' per turn."
    let s = solo([ship('v', A, 'corvette', CLEAR, { disabled: 3 })]);
    const seen: number[] = [shipIn(s, 'v').disabled];
    for (let t = 0; t < 4; t += 1) {
      for (let i = 0; i < 5; i += 1) s = advance(s);
      seen.push(shipIn(s, 'v').disabled);
    }
    expect(seen).toEqual([3, 2, 1, 0, 0]);
  });

  it('recovers at the end of the resupply phase, not before', () => {
    // "It recovers at the end of the Resupply phase." The ship is still at D3
    // right through its combat phase and its resupply phase.
    let s = solo([ship('v', A, 'corvette', CLEAR, { disabled: 3 })]);
    const trace: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      trace.push(`${s.phase}=${shipIn(s, 'v').disabled}`);
      s = advance(s);
    }
    trace.push(`${s.phase}=${shipIn(s, 'v').disabled}`);
    expect(trace).toEqual([
      'astrogation=3',
      'ordnance=3',
      'movement=3',
      'combat=3',
      'resupply=3',
      'astrogation=2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Heroism (p. 8)
// ---------------------------------------------------------------------------

describe('heroism', () => {
  // A corsair (4) against a frigate (8) is 0.5 — the 1:2 column, "less than
  // 1:1". There a 4 is a dash, a 5 is D2 and a 6 is D3.
  const longOdds = (): GameState =>
    combatPhase(rig([ship('atk', A, 'corsair', CLEAR), ship('def', B, 'frigate', CLEAR)]));

  it('is earned by attacking at worse than 1:1 and scoring D2 or better', () => {
    // "In combat, any ship which attacks at less than 1:1 and achieves a result
    //  of D2 or greater becomes heroic."
    const s = settle(
      ok(forceRoll(longOdds(), 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect({ heroic: shipIn(s, 'atk').heroic, d: shipIn(s, 'def').disabled }).toEqual({
      heroic: true,
      d: 2,
    });
  });

  it('is not earned by a lesser result at the same long odds', () => {
    // A 4 on the 1:2 column is a dash — no result, so no heroism.
    const s = settle(
      ok(forceRoll(longOdds(), 4), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect({ heroic: shipIn(s, 'atk').heroic, d: shipIn(s, 'def').disabled }).toEqual({
      heroic: false,
      d: 0,
    });
  });

  it('is not earned at 1:1 or better, however good the result', () => {
    // "attacks at LESS THAN 1:1". Corsair against corsair is exactly 1:1, and a
    // 6 there is D4 — a fine result, but not a heroic one.
    let s = combatPhase(rig([ship('atk', A, 'corsair', CLEAR), ship('def', B, 'corsair', CLEAR)]));
    s = settle(
      ok(forceRoll(s, 6), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect({ heroic: shipIn(s, 'atk').heroic, d: shipIn(s, 'def').disabled }).toEqual({
      heroic: false,
      d: 4,
    });
  });

  it('adds +1 to every later gun attack, permanently', () => {
    // "Heroic ships always add +1 to the die roll for gun combat when
    //  attacking."
    let s = settle(
      ok(forceRoll(longOdds(), 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect(shipIn(s, 'atk').heroic).toBe(true);

    // Next combat phase, the same shot one pip better: a 4 on 1:2 was a dash,
    // and with the bonus it resolves as a 5, which is D2.
    s = nextCombatPhase(s, A);
    expect(previewAttack(s, ['atk'], ['def'], map).modifiers).toMatchObject({
      heroic: true,
      total: 1,
    });
    const before = shipIn(s, 'def').disabled;
    s = settle(
      ok(forceRoll(s, 4), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect(shipIn(s, 'def').disabled - before).toBe(2);
  });

  it('is granted once and once only', () => {
    // "A ship may not become heroic more than once." A second qualifying result
    // buys no second bonus: the modifier stays at exactly +1.
    let s = settle(
      ok(forceRoll(longOdds(), 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    s = nextCombatPhase(s, A);
    // A second qualifying result at the same long odds.
    s = settle(
      ok(forceRoll(s, 5), { type: 'attack', by: A, attackers: ['atk'], targets: ['def'] }),
    );
    expect(shipIn(s, 'atk').heroic).toBe(true);
    // Still exactly +1 next time out, not +2.
    s = nextCombatPhase(s, A);
    expect(previewAttack(s, ['atk'], ['def'], map).modifiers.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Landed ships (p. 7)
// ---------------------------------------------------------------------------

describe('ships landed at a planetary base', () => {
  const side: HexSide = hexSide(TERRA.hex, 0);
  const above = sideGravityHex(side);

  const grounded = (owner: PlayerId): Ship =>
    makeShip({
      id: 'grounded',
      owner,
      shipClass: 'corvette',
      pos: TERRA.hex,
      location: { kind: 'landed', side },
    });

  it('cannot be shot at', () => {
    // "Once landed at a planetary base, a ship is immune from gunfire, mines,
    //  torpedoes, and ramming, but not from nukes."
    const s = combatPhase(rig([ship('atk', A, 'corsair', above), grounded(B)]));
    expect(
      refused(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['grounded'] }),
    ).toMatch(/immune/);
  });

  it('cannot fire its own guns', () => {
    // "Ships landed at planetary bases may not fire guns or launch ordnance."
    const s = rig([grounded(A), ship('def', B, 'corvette', above)]);
    expect(previewAttack(s, ['grounded'], ['def'], map).legal).toBe(false);
  });

  it('does not shield a ship stopped at an asteroid base', () => {
    // "Ships at asteroid bases may attack and be attacked normally."
    const s = combatPhase(
      rig([
        ship('atk', A, 'corsair', CERES.hex),
        makeShip({
          id: 'parked',
          owner: B,
          shipClass: 'corvette',
          pos: CERES.hex,
          location: { kind: 'asteroidBase', hex: CERES.hex },
        }),
      ]),
    );
    ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['parked'] });
  });
});

// ---------------------------------------------------------------------------
// Planetary defences (p. 8)
// ---------------------------------------------------------------------------

describe('planetary defences', () => {
  const side: HexSide = hexSide(TERRA.hex, 0);
  const above = sideGravityHex(side);
  const baseId = map.planetaryBaseAt(side)!.id;

  const emplaced = (ships: readonly Ship[]): GameState =>
    combatPhase(rig(ships, { bases: [{ id: baseId, owner: A }] }), A);

  it('fires at 2:1 whatever the target’s strength, with no range or velocity modifier', () => {
    // "The attack is performed on the gunfire table using 2:1 odds, REGARDLESS OF
    //  the target's combat strength. THERE IS NO MODIFICATION for range or
    //  relative velocity."
    //
    // The raider is a dreadnaught (15) tearing past at five hexes a turn. Real
    // odds would be 1:4 at best; the velocity difference of 5 would cost -3 and
    // the one hex of range another -1. On the 2:1 column a 3 is D2 — had either
    // modifier been applied the roll would have fallen to nothing at all.
    let s = emplaced([flew('raider', B, 'dreadnaught', above, hex(5, 0))]);
    s = ok(forceRoll(s, 3), { type: 'firePlanetaryDefence', by: A, base: baseId, targets: [] });
    expect(shipIn(s, 'raider').disabled).toBe(2);
  });

  it('is still 2:1 against a lone 1D freighter', () => {
    // "regardless of the target's combat strength" cuts both ways. A base has no
    // printed combat strength of its own, so there are no "real" odds to compare
    // against; what the clause fixes is that the column never moves off 2:1,
    // where a 1 is a dash — while every column above it turns that same 1 into
    // damage.
    let weak = emplaced([ship('freighter', B, 'transport', above)]);
    weak = ok(forceRoll(weak, 1), {
      type: 'firePlanetaryDefence',
      by: A,
      base: baseId,
      targets: [],
    });
    expect(shipIn(weak, 'freighter').disabled).toBe(0);

    // ...and a 3 is the D2 the 2:1 column prints.
    let hit = emplaced([ship('freighter', B, 'transport', above)]);
    hit = ok(forceRoll(hit, 3), { type: 'firePlanetaryDefence', by: A, base: baseId, targets: [] });
    expect(shipIn(hit, 'freighter').disabled).toBe(2);
  });

  it('reaches only the gravity hex directly above its own hexside', () => {
    // "Planetary bases may fire at enemy ships in the gravity hex directly above
    //  the base's hex side."
    const elsewhere = sideGravityHex(hexSide(TERRA.hex, 3));
    const s = emplaced([ship('raider', B, 'corvette', elsewhere)]);
    expect(
      refused(s, { type: 'firePlanetaryDefence', by: A, base: baseId, targets: ['raider'] }),
    ).toBeTruthy();
    expect(
      refused(s, { type: 'firePlanetaryDefence', by: A, base: baseId, targets: [] }),
    ).toBeTruthy();
  });

  it('sweeps all the enemy ships in that hex with one attack', () => {
    // "each of that player's bases may fire at ALL enemy ships in the gravity hex
    //  directly above it."
    let s = emplaced([ship('r1', B, 'corvette', above), ship('r2', B, 'corsair', above)]);
    s = ok(forceRoll(s, 3), { type: 'firePlanetaryDefence', by: A, base: baseId, targets: [] });
    expect({ r1: shipIn(s, 'r1').disabled, r2: shipIn(s, 'r2').disabled }).toEqual({
      r1: 2,
      r2: 2,
    });
  });

  it('fires once per its owner’s combat phase', () => {
    // "In a player's combat phase, EACH of that player's bases may fire..."
    let s = emplaced([ship('r1', B, 'corvette', above), ship('r2', B, 'corvette', above)]);
    s = ok(s, { type: 'firePlanetaryDefence', by: A, base: baseId, targets: ['r1'] });
    expect(
      refused(s, { type: 'firePlanetaryDefence', by: A, base: baseId, targets: ['r2'] }),
    ).toBeTruthy();
  });

  it('obeys the once-per-phase rule like any other gunfire', () => {
    // "All other normal gunfire combat rules apply" — including "No ship may
    //  attack or be attacked more than once per combat phase."
    let s = emplaced([ship('raider', B, 'corvette', above), ship('escort', A, 'corsair', above)]);
    s = settle(ok(s, { type: 'attack', by: A, attackers: ['escort'], targets: ['raider'] }));
    expect(
      refused(s, { type: 'firePlanetaryDefence', by: A, base: baseId, targets: ['raider'] }),
    ).toBeTruthy();
  });

  it('is not offered to a base someone else owns', () => {
    // "In a player's combat phase, each of *that player's* bases may fire at all
    //  enemy ships in the gravity hex directly above it."
    //
    // Run in B's own combat phase, or the generic seat check answers first and
    // the ownership guard is never reached.
    const s = emplaced([ship('raider', B, 'corvette', above)]);
    const bTurn = nextCombatPhase(s, B);
    expect(
      refused(bTurn, { type: 'firePlanetaryDefence', by: B, base: baseId, targets: [] }),
    ).toMatch(/not yours/i);
  });
});

// ---------------------------------------------------------------------------
// Advanced combat system (p. 16): the printed tables
// ---------------------------------------------------------------------------

describe('advanced combat: the printed tables', () => {
  it('matches the gun to-hit table cell for cell', () => {
    // "To-Hit Roll – Guns", transcribed from p. 16.
    const PRINTED: Record<string, number[]> = {
      //      roll: 1  2  3  4  5  6
      '1:4': [0, 0, 0, 0, 0, 1],
      '1:2': [0, 0, 0, 0, 1, 1],
      '1:1': [0, 0, 0, 1, 1, 2],
      '2:1': [0, 0, 1, 1, 2, 2],
      '3:1': [0, 1, 1, 2, 2, 3],
      '4:1': [1, 1, 2, 2, 3, 3],
    };
    for (const [column, hits] of Object.entries(PRINTED)) {
      for (let roll = 1; roll <= 6; roll += 1) {
        expect({ column, roll, hits: gunToHit(column as never, roll) }).toEqual({
          column,
          roll,
          hits: hits[roll - 1]!,
        });
      }
    }
  });

  it('matches the other to-hit table cell for cell', () => {
    // "To-Hit Roll – Other Damage", transcribed from p. 16.
    const PRINTED: Record<string, number[]> = {
      //          roll: 1  2  3  4  5  6
      torpedo: [0, 1, 1, 1, 1, 3],
      mine: [0, 0, 0, 0, 1, 2],
      asteroid: [0, 0, 0, 0, 1, 2],
      ram: [0, 0, 1, 1, 2, 3],
    };
    for (const [kind, hits] of Object.entries(PRINTED)) {
      for (let roll = 1; roll <= 6; roll += 1) {
        expect({ kind, roll, hits: otherToHit(kind as never, roll) }).toEqual({
          kind,
          roll,
          hits: hits[roll - 1]!,
        });
      }
    }
  });

  it('matches the hit location table', () => {
    // "Damage – Roll one die:
    //   1 – 1 weapon D
    //   2 – 1 drive D
    //   3 – 1 structure D
    //   4 – 1 weapon D, 1 structure D
    //   5 – 1 weapon D, 1 drive D
    //   6 – 1 structure D, 1 drive D"
    expect([...HIT_LOCATION]).toEqual([
      { weapon: 1, drive: 0, structure: 0 },
      { weapon: 0, drive: 1, structure: 0 },
      { weapon: 0, drive: 0, structure: 1 },
      { weapon: 1, drive: 0, structure: 1 },
      { weapon: 1, drive: 1, structure: 0 },
      { weapon: 0, drive: 1, structure: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Advanced combat: resolving an attack
// ---------------------------------------------------------------------------

/** The printed Damage list, as data, so the tests can add hits up by hand. */
const DAMAGE_ROW: Record<number, { weapon: number; drive: number; structure: number }> = {
  1: { weapon: 1, drive: 0, structure: 0 },
  2: { weapon: 0, drive: 1, structure: 0 },
  3: { weapon: 0, drive: 0, structure: 1 },
  4: { weapon: 1, drive: 0, structure: 1 },
  5: { weapon: 1, drive: 1, structure: 0 },
  6: { weapon: 0, drive: 1, structure: 1 },
};

const sumRows = (faces: readonly number[]) =>
  faces.reduce(
    (acc, face) => ({
      weapon: acc.weapon + DAMAGE_ROW[face]!.weapon,
      drive: acc.drive + DAMAGE_ROW[face]!.drive,
      structure: acc.structure + DAMAGE_ROW[face]!.structure,
    }),
    { weapon: 0, drive: 0, structure: 0 },
  );

describe('advanced combat: resolving an attack', () => {
  const advancedRig = (ships: readonly Ship[]): GameState =>
    rig(ships, { options: { advancedCombat: true } });

  it('makes two rolls: one for hits, then one per hit for where they land', () => {
    // "Two die rolls are made for each attack. The first roll determines if any
    //  hits are scored; use the appropriate table for the type of attack. Then a
    //  damage roll is made for each hit to determine where the damage goes." /
    //  "Each hit scored gives you one roll on the Damage table."
    //
    // A dreadnaught (15) against a frigate (8) is 1.88, so 1:1. A 6 there scores
    // two hits, so exactly two location rolls must follow and the damage must be
    // the sum of those two printed rows.
    let s = combatPhase(
      advancedRig([ship('atk', A, 'dreadnaught', CLEAR), ship('vic', B, 'frigate', CLEAR)]),
    );
    s = forceRoll(s, 6);
    expect(gunToHit('1:1', 6)).toBe(2);
    const [first, ...locations] = upcomingRolls(s, 3);
    expect(first).toBe(6);

    s = settle(ok(s, { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] }));
    expect(shipIn(s, 'vic').advancedDamage).toEqual(sumRows(locations));
    // Three separate tracks, not the basic single one.
    expect(shipIn(s, 'vic').disabled).toBe(0);
  });

  it('scores nothing when the to-hit roll scores nothing', () => {
    // The 1:1 column's first three rows are dashes.
    let s = combatPhase(
      advancedRig([ship('atk', A, 'corsair', CLEAR), ship('vic', B, 'corsair', CLEAR)]),
    );
    expect(gunToHit('1:1', 3)).toBe(0);
    s = settle(
      ok(forceRoll(s, 3), { type: 'attack', by: A, attackers: ['atk'], targets: ['vic'] }),
    );
    expect(shipIn(s, 'vic').advancedDamage).toEqual({ weapon: 0, drive: 0, structure: 0 });
  });
});

// ---------------------------------------------------------------------------
// Advanced combat: what the damage does
// ---------------------------------------------------------------------------

describe('advanced combat: what the damage does', () => {
  const hurt = (
    id: string,
    owner: PlayerId,
    cls: ShipClass,
    damage: { weapon?: number; drive?: number; structure?: number },
  ): Ship =>
    ship(id, owner, cls, CLEAR, {
      advancedDamage: { weapon: 0, drive: 0, structure: 0, ...damage },
    });

  const arena = (ships: readonly Ship[]): GameState =>
    rig(ships, { options: { advancedCombat: true } });

  it('silences the guns of any warship with weapon damage', () => {
    // "A ship with ANY weapon damage cannot fire guns or drop ordnance."
    for (const w of [1, 2, 5]) {
      const s = arena([
        hurt('atk', A, 'corvette', { weapon: w }),
        ship('def', B, 'corvette', CLEAR),
      ]);
      expect({ w, legal: previewAttack(s, ['atk'], ['def'], map).legal }).toEqual({
        w,
        legal: false,
      });
    }
  });

  it('lets a dreadnaught keep firing at weapon D1 through D3, and no further', () => {
    // "Exception: A dreadnaught can still fire if its weapon damage status is D1
    //  through D3."
    const expected: [number, boolean][] = [
      [0, true],
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, false],
    ];
    for (const [w, legal] of expected) {
      const s = arena([
        hurt('atk', A, 'dreadnaught', { weapon: w }),
        ship('def', B, 'corvette', CLEAR),
      ]);
      expect({ w, legal: previewAttack(s, ['atk'], ['def'], map).legal }).toEqual({ w, legal });
    }
  });

  it('leaves a civilian ship’s guns alone', () => {
    // "Weapon hits on civilian ships have no effect except to prevent their
    //  launching mines."
    //
    // Two readings live inside that one sentence and the engine has not settled
    // on either. "Civilian" is nowhere defined: a packet is commercial by the
    // overload rule ("Commercial ships (transports, packets, tankers, liners)")
    // but is grouped with the warships for combat ("Warships and packets have a
    // combat strength without the D suffix; they may attack normally"). And the
    // carve-out itself may be exhaustive (mines only) or loose shorthand for the
    // ordnance a civilian carries — combat.ts reads it strictly, ordnance.ts
    // loosely, and today they cannot both be right. Recorded in
    // docs/RULES-MAPPING.md; this pins only what the engine does.
    const s = arena([hurt('pkt', A, 'packet', { weapon: 4 }), ship('def', B, 'corvette', CLEAR)]);
    expect(previewAttack(s, ['pkt'], ['def'], map).legal).toBe(true);
  });

  it('stops a ship with any drive damage manoeuvring', () => {
    // "A ship with any drive damage cannot maneuver."
    const s = arena([hurt('v', A, 'corvette', { drive: 1 })]);
    expect(
      refused(s, { type: 'plotCourse', by: A, ship: 'v', endpoint: add(CLEAR, hex(1, 0)) }),
    ).toBeTruthy();
  });

  it('loses the ship when structure reaches D6, and not before', () => {
    // "Structure hits have no immediate effect on weapons or drives . . . but if
    //  structure reaches D6 or below, the ship explodes or falls apart, and is
    //  lost."
    const s = arena([hurt('v', B, 'corvette', { structure: 5 })]);
    expect(shipIn(s, 'v').destroyed).toBe(false);
    // A location roll of 3 is "1 structure D" — the sixth point.
    const hit = applyAdvancedHits(forceRoll(s, 3), 'v', 1, 'a test hit').state;
    expect(shipIn(hit, 'v').advancedDamage.structure).toBe(6);
    expect(shipIn(hit, 'v').destroyed).toBe(true);
  });

  it('leaves a badly holed ship able to shoot and steer', () => {
    // "Structure hits have NO IMMEDIATE EFFECT on weapons or drives."
    const s = arena([
      hurt('v', A, 'corvette', { structure: 5 }),
      ship('def', B, 'corvette', CLEAR),
    ]);
    expect(previewAttack(s, ['v'], ['def'], map).legal).toBe(true);
    ok(s, { type: 'plotCourse', by: A, ship: 'v', endpoint: add(CLEAR, hex(1, 0)) });
  });

  it('repairs one D a turn, and never repairs a track that has reached D6', () => {
    // "A ship recovers from 1 D a turn, just as in regular combat." / "A ship
    //  whose weapons reach D6 or below can no longer repair them; it must get
    //  back to a base to recover its weapon capability." / "A ship whose drive
    //  reaches D6 or below may not be repaired."
    let s = solo([hurt('v', A, 'corvette', { weapon: 2, drive: 1, structure: 2 })], {
      advancedCombat: true,
    });
    const total = (x: GameState): number => {
      const d = shipIn(x, 'v').advancedDamage;
      return d.weapon + d.drive + d.structure;
    };
    const seen: number[] = [total(s)];
    for (let t = 0; t < 6; t += 1) {
      for (let i = 0; i < 5; i += 1) s = advance(s);
      seen.push(total(s));
    }
    expect(seen).toEqual([5, 4, 3, 2, 1, 0, 0]);

    let stuck = solo([hurt('v', A, 'corvette', { weapon: 6, drive: 6 })], { advancedCombat: true });
    for (let t = 0; t < 3; t += 1) for (let i = 0; i < 5; i += 1) stuck = advance(stuck);
    expect(shipIn(stuck, 'v').advancedDamage).toEqual({ weapon: 6, drive: 6, structure: 0 });
  });

  it('lets a ship with wrecked weapons still defend normally', () => {
    // "A ship whose weapons reach D6 or below can no longer repair them; it must
    //  get back to a base to recover its weapon capability. IT STILL DEFENDS
    //  NORMALLY." A gutted corsair is still a 4 on the defending side of the
    //  ratio, so a corsair attacking it is at 1:1, not better.
    const s = arena([
      ship('atk', A, 'corsair', CLEAR),
      hurt('def', B, 'corsair', { weapon: 6, drive: 6, structure: 3 }),
    ]);
    const p = previewAttack(s, ['atk'], ['def'], map);
    expect({ def: p.defenceStrength, col: p.column }).toEqual({ def: 4, col: '1:1' });
  });

  it('restores a ship to full operating status when it reaches a base', () => {
    // "A ship which reaches a base is immediately restored to full operating
    //  status" — including the weapon track that damage control could not touch.
    const side: HexSide = hexSide(TERRA.hex, 0);
    const baseId = map.planetaryBaseAt(side)!.id;
    let s = createInitialState({
      scenarioId: 'rules-combat',
      seed: 11,
      players: [makePlayer(A, 'Player A', 'Alpha', '#e8703a')],
      ships: [
        {
          ...makeShip({
            id: 'v',
            owner: A,
            shipClass: 'corsair',
            pos: TERRA.hex,
            fuel: 3,
            location: { kind: 'landed', side },
          }),
          advancedDamage: { weapon: 6, drive: 2, structure: 3 },
        },
      ],
      options: { advancedCombat: true },
    });
    s = { ...s, bases: { ...s.bases, [baseId]: { ...s.bases[baseId]!, owner: A } } };
    s = reach(s, 'resupply', A);
    s = ok(s, { type: 'resupply', by: A, ship: 'v' });
    expect(shipIn(s, 'v').advancedDamage).toEqual({ weapon: 0, drive: 0, structure: 0 });
  });

  it('counts a ship as disabled only when it can neither manoeuvre nor fire', () => {
    // "A ship is considered 'disabled' and lootable/capturable ONLY IF it can
    //  neither maneuver nor fire. Structure damage does not make a ship any more
    //  or less lootable."
    const cases: [Record<string, number>, boolean][] = [
      [{ weapon: 2, drive: 2 }, true],
      [{ weapon: 2 }, false], // can still manoeuvre
      [{ drive: 2 }, false], // can still shoot
      [{ structure: 5 }, false], // structure alone never counts
      [{ weapon: 2, drive: 2, structure: 5 }, true],
    ];
    for (const [damage, expected] of cases) {
      const s = arena([hurt('prize', B, 'corsair', damage)]);
      expect({ damage, disabled: isDisabled(shipIn(s, 'prize'), true) }).toEqual({
        damage,
        disabled: expected,
      });
    }
  });
});
