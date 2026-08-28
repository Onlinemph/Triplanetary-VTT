/**
 * This app's half of the campaign boundary: the codec both apps must agree
 * on, the Contested Transfer scenario that builds from an `OrderOfBattle`,
 * and the reader that turns a finished battle back into a `BattleResult`.
 */

import { describe, expect, it } from 'vitest';
import { hexSide } from '../src/engine/hex.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import type { GameState, Ship } from '../src/engine/types.js';
import { decodeOrder, decodeResult, encodeOrder, encodeResult } from '../src/campaign/codec.js';
import type { BattleResult, OrderOfBattle } from '../src/campaign/orders.js';
import { deliveredLots, readBattleResult } from '../src/campaign/result.js';
import { buildScenario, checkScenarioVictory, contestedTransfer } from '../src/scenarios/index.js';

const map = DEFAULT_MAP;

const ORDER: OrderOfBattle = {
  battleId: 'b3-mars-space',
  seed: 41,
  scenarioId: 'contested-transfer',
  sides: [
    {
      player: 'combine',
      faction: 'North American Combine',
      forces: { transport: 2, corvette: 1, freight: 8 },
    },
    { player: 'paneuro', faction: 'Paneuropean Federation', forces: { corvette: 2 } },
  ],
  terms: { origin: 'terra', target: 'mars', turnLimit: 12, cargoLots: 8 },
};

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

describe('the codec', () => {
  it('round-trips an order and a result', () => {
    expect(decodeOrder(encodeOrder(ORDER))).toEqual(ORDER);
    const result: BattleResult = {
      battleId: 'b3-mars-space',
      winners: ['paneuro'],
      level: 'standard',
      survivors: { combine: { corvette: 1 }, paneuro: { corvette: 2 } },
      victoryPoints: { combine: 3, paneuro: 0 },
      replay: { seed: 41, log: [{ type: 'endPhase', by: 'combine' }] },
    };
    expect(decodeResult(encodeResult(result))).toEqual(result);
  });

  it('refuses a token in the wrong box, and garbage anywhere', () => {
    expect(() => decodeResult(encodeOrder(ORDER))).toThrow(/battle order/);
    expect(() => decodeOrder('not a token!')).toThrow(/not a campaign token/);
  });
});

// ---------------------------------------------------------------------------
// Contested Transfer, built from an order
// ---------------------------------------------------------------------------

const shipsOf = (state: GameState, owner: string): Ship[] =>
  Object.values(state.ships).filter((s) => s.owner === owner);

const countByClass = (ships: readonly Ship[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of ships) out[s.shipClass] = (out[s.shipClass] ?? 0) + 1;
  return out;
};

const freightAboard = (ships: readonly Ship[]): number =>
  ships.reduce((n, s) => n + (s.cargo.find((c) => c.kind === 'freight')?.quantity ?? 0), 0);

/** Put a ship on the ground at a world, the way a landing leaves it. */
const landOn = (state: GameState, ship: Ship, bodyId: string): GameState => {
  const body = map.body(bodyId)!;
  const down: Ship = {
    ...ship,
    pos: body.hex,
    location: { kind: 'landed', side: hexSide(body.hex, 0) },
  };
  return { ...state, ships: { ...state.ships, [ship.id]: down } };
};

const sink = (state: GameState, ship: Ship): GameState => ({
  ...state,
  ships: { ...state.ships, [ship.id]: { ...ship, destroyed: true, destroyedBy: 'test' } },
});

describe('Contested Transfer builds from an order of battle', () => {
  const state = buildScenario('contested-transfer', { order: ORDER });

  it('fields exactly the hulls the order names, with the freight aboard', () => {
    expect(countByClass(shipsOf(state, 'combine'))).toEqual({ transport: 2, corvette: 1 });
    expect(countByClass(shipsOf(state, 'paneuro'))).toEqual({ corvette: 2 });
    expect(freightAboard(shipsOf(state, 'combine'))).toBe(8);
  });

  it('gives the convoy the first move and the computer its errand', () => {
    expect(state.playerOrder).toEqual(['combine', 'paneuro']);
    expect(state.scenarioData['targets']).toEqual({ combine: 'mars' });
  });

  it('seeds the game from the order', () => {
    const again = buildScenario('contested-transfer', { order: ORDER });
    expect(JSON.stringify(again)).toBe(JSON.stringify(state));
  });

  it('refuses a convoy that cannot lift its freight', () => {
    const heavy: OrderOfBattle = {
      ...ORDER,
      sides: [{ ...ORDER.sides[0]!, forces: { corvette: 2, freight: 8 } }, ORDER.sides[1]!],
    };
    expect(() => buildScenario('contested-transfer', { order: heavy })).toThrow(/lifts/);
  });

  it('refuses a hull the table does not know, and one that cannot sail', () => {
    const unknown: OrderOfBattle = {
      ...ORDER,
      sides: [{ ...ORDER.sides[0]!, forces: { galleon: 1, freight: 1 } }, ORDER.sides[1]!],
    };
    expect(() => buildScenario('contested-transfer', { order: unknown })).toThrow(/galleon/);
    const emplaced: OrderOfBattle = {
      ...ORDER,
      sides: [
        { ...ORDER.sides[0]!, forces: { transport: 1, robotGuards: 1, freight: 1 } },
        ORDER.sides[1]!,
      ],
    };
    expect(() => buildScenario('contested-transfer', { order: emplaced })).toThrow(/robotGuards/);
  });

  it('plays a printed default when no order is given', () => {
    const plain = buildScenario('contested-transfer', { seed: 5 });
    expect(freightAboard(shipsOf(plain, 'combine'))).toBe(4);
    expect(checkScenarioVictory(plain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deciding the transfer
// ---------------------------------------------------------------------------

describe('the transfer is decided by what gets down', () => {
  /** The convoy's hulls, heaviest holds first: 5 lots, 3 lots, 0 lots. */
  const carriers = (state: GameState): Ship[] =>
    shipsOf(state, 'combine').sort(
      (a, b) => freightAboard([b]) - freightAboard([a]) || a.id.localeCompare(b.id),
    );

  it('is undecided while freight is still in play', () => {
    const state = buildScenario('contested-transfer', { order: ORDER });
    expect(contestedTransfer.checkVictory!(state)).toBeNull();
  });

  it('all lots down is a decisive convoy win', () => {
    let state = buildScenario('contested-transfer', { order: ORDER });
    for (const ship of carriers(state)) state = landOn(state, state.ships[ship.id]!, 'mars');
    const v = contestedTransfer.checkVictory!(state);
    expect(v?.winners).toEqual(['combine']);
    expect(v?.level).toBe('decisive');
    expect(deliveredLots(state, map, 'combine', 'mars')).toBe(8);
  });

  it('half the lots down is a marginal convoy win; less is the patrol’s', () => {
    let state = buildScenario('contested-transfer', { order: ORDER });
    const [big, small] = carriers(state);
    // The five-lot transport lands; the three-lot one is sunk on the way in.
    state = landOn(state, state.ships[big!.id]!, 'mars');
    state = sink(state, state.ships[small!.id]!);
    let v = contestedTransfer.checkVictory!(state);
    expect(v?.winners).toEqual(['combine']);
    expect(v?.level).toBe('marginal');

    // The other way round: three lots ashore of eight is a broken landing.
    let other = buildScenario('contested-transfer', { order: ORDER });
    const [big2, small2] = carriers(other);
    other = sink(other, other.ships[big2!.id]!);
    other = landOn(other, other.ships[small2!.id]!, 'mars');
    v = contestedTransfer.checkVictory!(other);
    expect(v?.winners).toEqual(['paneuro']);
    expect(v?.level).toBe('marginal');
  });

  it('time running out decides against everything still aboard', () => {
    let state = buildScenario('contested-transfer', { order: ORDER });
    state = { ...state, turn: 13 };
    const v = contestedTransfer.checkVictory!(state);
    expect(v?.winners).toEqual(['paneuro']);
    expect(v?.level).toBe('decisive');
  });

  it('keeps the scoreboard on the convoy’s delivered lots', () => {
    let state = buildScenario('contested-transfer', { order: ORDER });
    const [big] = carriers(state);
    state = landOn(state, state.ships[big!.id]!, 'mars');
    const scored = contestedTransfer.endPlayerTurn!(state, map);
    expect(scored.players['combine']!.points).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The result reader
// ---------------------------------------------------------------------------

describe('readBattleResult', () => {
  it('returns null while the battle is undecided, and throws off an order-less game', () => {
    const state = buildScenario('contested-transfer', { order: ORDER });
    expect(readBattleResult(state, map, [])).toBeNull();
    const other = buildScenario('bi-planetary', {});
    expect(() => readBattleResult(other, map, [])).toThrow(/order of battle/);
  });

  it('reports survivors by hull, delivery as the attacker’s points, and ranks the level', () => {
    let state = buildScenario('contested-transfer', { order: ORDER });
    const [big, small] = shipsOf(state, 'combine')
      .filter((s) => s.shipClass === 'transport')
      .sort((a, b) => freightAboard([b]) - freightAboard([a]));
    state = landOn(state, state.ships[big!.id]!, 'mars');
    state = sink(state, state.ships[small!.id]!);
    state = { ...state, victory: contestedTransfer.checkVictory!(state) };

    const log = [{ type: 'endPhase', by: 'combine' }];
    const result = readBattleResult(state, map, log)!;
    expect(result.battleId).toBe('b3-mars-space');
    expect(result.winners).toEqual(['combine']);
    // Triplanetary's "marginal" is its middle level, so it crosses as standard.
    expect(result.level).toBe('standard');
    expect(result.survivors['combine']).toEqual({ transport: 1, corvette: 1, freight: 5 });
    expect(result.survivors['paneuro']).toEqual({ corvette: 2 });
    // Five lots are ashore; the campaign reads that number, not the scoreboard.
    expect(result.victoryPoints['combine']).toBe(5);
    expect(result.replay).toEqual({ seed: 41, log });
    expect(decodeResult(encodeResult(result))).toEqual(result);
  });
});
