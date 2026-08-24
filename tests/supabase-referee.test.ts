/**
 * The referee, exercised.
 *
 * `src/net/supabase/referee.ts` is the whole of the online rules loop: it judges
 * an order against a seat, rolls the dice the players are not allowed to roll,
 * and decides what each seat may know. It had never been run when these were
 * written, so these tests are written from the properties the design rests on
 * rather than from the code — a test that restates the implementation would have
 * agreed with every bug in it.
 *
 * Four properties matter more than the rest, and each has a section below:
 *
 *  - **The sealed die.** "The generator's entire state is a single 32-bit integer
 *    carried inside `GameState`", so a state handed to a player is a state whose
 *    next roll the player can compute. Nothing leaves the referee unsealed, and
 *    the seed it did roll with is the seed it logged.
 *  - **The audit trail.** A game is its starting position plus an ordered list of
 *    commands, and here that list carries its dice. If `replayLog` does not land
 *    on the state the referee reached, the log is not an audit trail and the open
 *    information design has nothing underneath it.
 *  - **Seat authority.** `by` is a string somebody typed. The referee reads the
 *    seat off the JWT and refuses everything else — and being correctly seated
 *    still does not make an illegal move legal.
 *  - **Fog.** A view is what a seat is entitled to know. Two tests in the fog
 *    section fail: `redactState` ships engine bookkeeping and the game log
 *    verbatim, and both of those name enemy ships the viewer has never detected.
 *    They are marked, and the defect is in `src/net/redact.ts`, not here.
 *
 * Dice are fixed everywhere. Nothing below reads the clock or `Math.random`, so
 * a failure is a failure and never a bad afternoon.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type GameState,
  type PlayerId,
  DEFAULT_MAP,
  areAllied,
  createInitialState,
  hex,
  makePlayer,
  makeShip,
  shipLabel,
} from '../src/engine/index.js';
import { buildScenario } from '../src/scenarios/index.js';
import { ALWAYS_VISIBLE_KEY, sealDie } from '../src/net/redact.js';
import { aiHasMove } from '../src/ai/driver.js';
import type { GameStatus, LoggedCommand } from '../src/net/supabase/protocol.js';
import {
  type SeatRow,
  type StoredGame,
  CODE_ALPHABET,
  CODE_LENGTH,
  PRESENCE_MS,
  codeFrom,
  isCode,
  judge,
  leaveSeat,
  playComputerSeats,
  replayLog,
  seatOf,
  seenNow,
  tableInfo,
  takeSeat,
  viewFor,
  viewsForAll,
} from '../src/net/supabase/referee.js';

const map = DEFAULT_MAP;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TableOptions {
  /** Seat ordinals the computer plays. Everything else is a human account. */
  readonly computer?: readonly number[];
  readonly status?: GameStatus;
  readonly seed?: number;
}

/**
 * A stored table over a real scenario board.
 *
 * `fog` is derived from the built state rather than passed in, because that is
 * the invariant the Edge Function has to maintain: `redactState` keys off
 * `state.options.fogOfWar` while `resolve` keys off the row's `fog` column, and
 * a row that disagrees with its own state writes unredacted views to every seat.
 */
const table = (scenarioId: string, opts: TableOptions = {}): StoredGame => {
  const state = buildScenario(scenarioId, { seed: opts.seed ?? 7 });
  const computer = new Set(opts.computer ?? []);
  const seats: SeatRow[] = state.playerOrder.map((seat, i) => ({
    seat,
    ordinal: i,
    faction: state.players[seat]?.faction ?? seat,
    name: state.players[seat]?.name ?? seat,
    kind: computer.has(i) ? 'computer' : 'human',
    userId: computer.has(i) ? null : `user-${i}`,
    lastSeen: null,
  }));
  return {
    id: 'game-1',
    code: 'ABCDEF',
    scenarioId,
    fog: state.options.fogOfWar,
    status: opts.status ?? 'playing',
    state: sealDie(state),
    commandCount: 0,
    seats,
    hostId: 'user-0',
  };
};

/** All seats computer-played, which is how a whole game runs without a browser. */
const soloTable = (scenarioId: string): StoredGame => {
  const order = buildScenario(scenarioId, { seed: 7 }).playerOrder;
  return table(scenarioId, { computer: order.map((_, i) => i) });
};

/**
 * A fixed source of dice.
 *
 * Stands in for `crypto.getRandomValues`, whose whole job is to be unguessable
 * and which is therefore useless in a test. Any deterministic sequence proves
 * the same thing: the referee rolls with what it is handed and logs what it
 * rolled with.
 */
const dice = (from: number): (() => number) => {
  let s = from >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);
};

const accepted = (j: ReturnType<typeof judge>): Extract<ReturnType<typeof judge>, { ok: true }> => {
  if (!j.ok) throw new Error(`expected the referee to accept, got: ${j.reason}`);
  return j;
};

/** Every string anywhere in a value — the leak hunt from `multiplayer.test.ts`. */
const allStrings = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allStrings(v, out);
    }
  }
  return out;
};

/** Where a string sits in a payload, so a leak reports its own address. */
const pathsTo = (value: unknown, target: string, at = '', out: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (value === target) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => pathsTo(v, target, `${at}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === target) out.push(`${at}.${k}`);
      pathsTo(v, target, `${at}.${k}`, out);
    }
  }
  return out;
};

/** Ships a scenario publishes to a given seat regardless of detection. */
const alwaysVisibleTo = (state: GameState, seat: PlayerId): ReadonlySet<string> => {
  const sailings = state.scenarioData[ALWAYS_VISIBLE_KEY];
  if (typeof sailings !== 'object' || sailings === null) return new Set();
  const list = (sailings as Record<string, unknown>)[seat];
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
};

/** Two boards are the same board, dice and all. */
const same = (a: GameState, b: GameState): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Two corvettes in the same deep-space hex, in the combat phase, guns loaded.
 *
 * Hand-built rather than drawn from a scenario because the die tests need a
 * command that certainly rolls, on a board where the roll certainly decides
 * something. A scenario board reaches this position eventually; this one starts
 * there.
 */
const gunfight = (): StoredGame => {
  const state = createInitialState({
    scenarioId: 'referee-gunfight',
    seed: 999,
    players: [
      makePlayer('a', 'Ann', 'Alpha', '#e8703a'),
      makePlayer('b', 'Bob', 'Beta', '#4a9fe0'),
    ],
    ships: [
      makeShip({ id: 'a1', owner: 'a', shipClass: 'corvette', pos: hex(0, 14) }),
      makeShip({ id: 'b1', owner: 'b', shipClass: 'corvette', pos: hex(0, 14) }),
    ],
  });
  return {
    id: 'game-2',
    code: 'BCDEFG',
    scenarioId: 'referee-gunfight',
    fog: false,
    status: 'playing',
    state: { ...state, phase: 'combat' },
    commandCount: 0,
    seats: [
      {
        seat: 'a',
        ordinal: 0,
        faction: 'Alpha',
        name: 'Ann',
        kind: 'human',
        userId: 'u1',
        lastSeen: 0,
      },
      {
        seat: 'b',
        ordinal: 1,
        faction: 'Beta',
        name: 'Bob',
        kind: 'human',
        userId: 'u2',
        lastSeen: 0,
      },
    ],
    hostId: 'u1',
  };
};

const ATTACK: Command = { type: 'attack', by: 'a', attackers: ['a1'], targets: ['b1'] };
const DECLINE: Command = { type: 'declineCounterattack', by: 'b' };

/** Fire once with a given seed, let the damage land, and report the wound. */
const exchange = (die: number): number => {
  const shot = accepted(judge(gunfight(), 'a', ATTACK, die, map));
  const settled = accepted(judge(shot.game, 'b', DECLINE, 1, map));
  return settled.game.state.ships['b1']!.disabled;
};

// ---------------------------------------------------------------------------
// The sealed die
// ---------------------------------------------------------------------------

describe('the sealed die', () => {
  it('never leaves the referee inside a view, for any seat, fogged or not', () => {
    // The one rule that has no exception. A seat holding a live generator can
    // roll the next die before deciding whether to fire, and fog does not help:
    // the number is inside the fogged state.
    for (const scenario of ['bi-planetary', 'escape', 'piracy', 'nova']) {
      const g = table(scenario);
      // Deliberately un-seal the stored state: `viewFor` is the last gate and
      // must not depend on the caller having sealed it already.
      const loaded: StoredGame = { ...g, state: { ...g.state, rng: { seed: 0xdecafbad } } };
      for (const seat of [...loaded.state.playerOrder, null]) {
        expect({ scenario, seat, seed: viewFor(loaded, seat, map).rng.seed }).toEqual({
          scenario,
          seat,
          seed: 0,
        });
      }
      for (const [seat, view] of Object.entries(viewsForAll(loaded, map))) {
        expect({ scenario, seat, seed: view.rng.seed }).toEqual({ scenario, seat, seed: 0 });
      }
    }
  });

  it('is actually used: two seeds, two outcomes from one board', () => {
    // If the referee rolled with the stored generator instead of the seed it was
    // handed, every one of these would come back the same and the seed would be
    // decoration. The printed 1:1 column gives D2 on a 4, D4 on a 6 and nothing
    // on a 1, and these three seeds produce exactly those three faces.
    expect([exchange(1), exchange(4), exchange(7)]).toEqual([2, 4, 0]);
  });

  it('is deterministic: the same seed twice is the same wound twice', () => {
    // The other half of the same property. Unpredictable forward requires a
    // fresh seed per command; reproducible backward requires that the seed be
    // the only thing that decides the roll.
    expect(exchange(4)).toBe(exchange(4));
    expect(exchange(7)).toBe(exchange(7));
  });

  it('seals the stored state after an accepted order', () => {
    const out = accepted(judge(gunfight(), 'a', ATTACK, 0x7fffffff, map));
    expect(out.game.state.rng.seed).toBe(0);
  });

  it('logs the seed it rolled with, normalised the way it rolled it', () => {
    // `resolve` rolls with `die >>> 0` and logs `die >>> 0`. If those two ever
    // drift apart the log stops reproducing the game, so the pair is checked
    // against seeds that are not already unsigned 32-bit.
    for (const [given, normalised] of [
      [1, 1],
      [-1, 0xffffffff],
      [2 ** 32 + 1, 1],
    ] as const) {
      const out = accepted(judge(gunfight(), 'a', ATTACK, given, map));
      expect({ given, die: out.logged.die }).toEqual({ given, die: normalised });
    }
    // ...and the seed that normalised to 1 played out as the seed 1 did.
    expect(exchange(2 ** 32 + 1)).toBe(exchange(1));
  });

  it('numbers the log from one, gaplessly, across judge and the computer alike', () => {
    let g = table('bi-planetary', { computer: [1] });
    const roll = dice(11);
    const idx: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const out = accepted(judge(g, 'mars', { type: 'endPhase', by: 'mars' }, roll(), map));
      g = out.game;
      idx.push(out.logged.idx);
      const ai = playComputerSeats(g, roll, map);
      g = ai.game;
      idx.push(...ai.logged.map((e) => e.idx));
    }
    expect(idx).toEqual(idx.map((_, i) => i + 1));
    expect(g.commandCount).toBe(idx.length);
  });
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

describe('the log as an audit trail', () => {
  it('replays to the exact board the referee reached, dice included', () => {
    // The property the whole open-information design rests on: the client is
    // sent the starting position and the log, and must land on the referee's
    // board. Played here as a real mixed game — a human seat giving orders
    // through `judge`, a computer seat answering through `playComputerSeats` —
    // over a scenario whose ships shoot at each other, so the dice matter.
    for (const scenario of ['bi-planetary', 'lateral-7', 'retribution']) {
      const start = table(scenario, { computer: [1] });
      const human = start.state.playerOrder[0]!;
      const roll = dice(2024);
      const log: LoggedCommand[] = [];
      let g = start;

      for (let i = 0; i < 24 && g.status === 'playing'; i += 1) {
        const out = judge(g, human, { type: 'endPhase', by: human }, roll(), map);
        if (out.ok) {
          g = out.game;
          log.push(out.logged);
        }
        const ai = playComputerSeats(g, roll, map);
        g = ai.game;
        log.push(...ai.logged);
      }

      expect({ scenario, commands: log.length > 12 }).toEqual({ scenario, commands: true });
      const replayed = replayLog(start.state, log, map);
      expect({ scenario, failed: replayed.failed }).toEqual({ scenario, failed: null });
      expect({ scenario, matches: same(replayed.state, g.state) }).toEqual({
        scenario,
        matches: true,
      });
    }
  });

  it('does not care what order the rows arrive in', () => {
    // Rows come back from Postgres, not from an array. `replayLog` sorts by
    // `idx`, which is what makes the log the game's canonical order rather than
    // whatever order the client happened to read.
    const start = soloTable('lateral-7');
    const played = playComputerSeats(start, dice(5), map, 60);
    const forwards = replayLog(start.state, played.logged, map);
    const backwards = replayLog(start.state, [...played.logged].reverse(), map);
    expect(same(backwards.state, forwards.state)).toBe(true);
    expect(same(forwards.state, played.game.state)).toBe(true);
  });

  it('replays differently when a logged die is tampered with', () => {
    // The dice are load-bearing in the log, not ornamental. Change one seed on
    // one shot and the game diverges — which is also what makes the log worth
    // auditing: a doctored row cannot reproduce the board every seat saw.
    // Retribution, far enough in that the corvettes have started shooting: most
    // orders roll nothing at all, so a short log proves nothing either way.
    const start = soloTable('retribution');
    const played = playComputerSeats(start, dice(5), map, 120);
    const diverged = played.logged.filter((entry) => {
      const tampered = played.logged.map((e) =>
        e.idx === entry.idx ? { ...e, die: (e.die ^ 0x5f5f5f5f) >>> 0 } : e,
      );
      const out = replayLog(start.state, tampered, map);
      return out.failed !== null || !same(out.state, played.game.state);
    });
    expect(diverged.length).toBeGreaterThan(0);
  });

  it('stops at the entry it could not apply and names it', () => {
    // A log the client cannot replay is a desync, and the client has to be able
    // to say which row it choked on rather than silently rendering a wrong board.
    const start = soloTable('bi-planetary');
    const played = playComputerSeats(start, dice(5), map, 10);
    const poison: LoggedCommand = {
      idx: 0,
      cmd: { type: 'endPhase', by: 'nobody-at-this-table' },
      die: 1,
    };
    const out = replayLog(start.state, [poison, ...played.logged], map);
    expect(out.failed).toEqual(poison);
    expect(same(out.state, start.state)).toBe(true);
  });

  it('seals the die on the board it hands back', () => {
    const start = soloTable('bi-planetary');
    const played = playComputerSeats(start, dice(5), map, 10);
    expect(replayLog(start.state, played.logged, map).state.rng.seed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seat authority
// ---------------------------------------------------------------------------

describe('seat authority', () => {
  it('turns a spectator away before it looks at the command', () => {
    const out = judge(table('bi-planetary'), null, { type: 'endPhase', by: 'mars' }, 1, map);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/spectator/);
  });

  it('refuses a seated player acting for another seat', () => {
    // The check a relay cannot do: over a relay `by` is just a string somebody
    // typed, and without this any client can end another player's turn.
    const out = judge(table('bi-planetary'), 'venus', { type: 'endPhase', by: 'mars' }, 1, map);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/hold the seat "venus".*may not act for "mars"/);
  });

  it('still refuses an illegal move from the right seat, in the rules’ own words', () => {
    // Being correctly seated is necessary and not sufficient. The refusal has to
    // come from the engine, with the engine's reason, or the seat check has
    // quietly become the only gate.
    const out = judge(table('bi-planetary'), 'venus', { type: 'endPhase', by: 'venus' }, 1, map);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('it is not your player-turn');
  });

  it('refuses everything in the lobby and everything after the game is decided', () => {
    for (const [status, reason] of [
      ['lobby', /has not started/],
      ['finished', /is over/],
    ] as const) {
      const g = table('bi-planetary', { status });
      const out = judge(g, 'mars', { type: 'endPhase', by: 'mars' }, 1, map);
      expect({ status, ok: out.ok }).toEqual({ status, ok: false });
      expect(out.ok === false && out.reason).toMatch(reason);
    }
  });

  it('checks the status before the seat, so a spectator cannot probe a lobby', () => {
    // Order of the gates. A refusal that leaks *which* gate fired tells a
    // stranger whether a game exists and has started; both refusals here should
    // be the status one.
    const g = table('bi-planetary', { status: 'lobby' });
    const out = judge(g, null, { type: 'endPhase', by: 'mars' }, 1, map);
    expect(out.ok === false && out.reason).toMatch(/has not started/);
  });

  it('leaves the stored table byte-identical when it refuses', () => {
    // A refusal is not an event in the game's history. A partial mutation here
    // would be written back to Postgres and become the board.
    const g = table('bi-planetary');
    const before = JSON.stringify(g);
    judge(g, null, { type: 'endPhase', by: 'mars' }, 1, map);
    judge(g, 'venus', { type: 'endPhase', by: 'mars' }, 2, map);
    judge(g, 'venus', { type: 'endPhase', by: 'venus' }, 3, map);
    judge({ ...g, status: 'finished' }, 'mars', { type: 'endPhase', by: 'mars' }, 4, map);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('closes the table when the board says somebody won', () => {
    // `status` is what the lobby, the roster and every later `judge` read, so it
    // has to follow `state.victory` in the same write, not in a later sweep.
    const played = playComputerSeats(soloTable('bi-planetary'), dice(5), map, 400);
    expect(played.game.state.victory).not.toBeNull();
    expect(played.game.status).toBe('finished');
    const after = judge(played.game, 'mars', { type: 'endPhase', by: 'mars' }, 1, map);
    expect(after.ok === false && after.reason).toMatch(/is over/);
  });

  it('reads the seat off the table and nothing else', () => {
    const g = table('bi-planetary');
    expect(seatOf(g, 'user-0')).toBe('mars');
    expect(seatOf(g, 'user-1')).toBe('venus');
    expect(seatOf(g, 'somebody-else')).toBeNull();
    expect(seatOf(g, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fog
// ---------------------------------------------------------------------------

describe('fog of war', () => {
  it('writes one view per seat in a fog game and none in an open one', () => {
    const fogged = table('escape');
    const shot = accepted(judge(fogged, 'pilgrims', { type: 'endPhase', by: 'pilgrims' }, 3, map));
    expect(Object.keys(shot.views).sort()).toEqual(['enforcers', 'pilgrims']);

    // Open information takes the other branch entirely: the command goes in the
    // log, every seat replays it, and no snapshot is written at all.
    const open = table('bi-planetary');
    const step = accepted(judge(open, 'mars', { type: 'endPhase', by: 'mars' }, 3, map));
    expect(step.views).toEqual({});
  });

  it('shows a seat no enemy ship record it has not detected', () => {
    // The `ships` table itself, checked mid-game rather than at setup: detection
    // is earned during play, so a redaction that is right on turn one can still
    // be wrong on turn three. Three ways to be entitled to a record: it is
    // yours or an ally's — Piracy's patrol and merchants share what they see —
    // it is dead, since "their loss is public", or you have detected it. The
    // fourth is Lateral 7's: "Because ship sailings are published, the pirate
    // knows the location of the liner", which the scenario declares by name.
    for (const scenario of ['escape', 'lateral-7', 'piracy']) {
      const played = playComputerSeats(soloTable(scenario), dice(5), map, 25);
      for (const [seat, view] of Object.entries(viewsForAll(played.game, map))) {
        const published = alwaysVisibleTo(played.game.state, seat);
        for (const ship of Object.values(view.ships)) {
          const entitled =
            areAllied(played.game.state, seat, ship.owner) ||
            ship.destroyed ||
            ship.detectedBy.includes(seat) ||
            published.has(ship.id);
          expect({ scenario, seat, ship: ship.id, entitled }).toEqual({
            scenario,
            seat,
            ship: ship.id,
            entitled: true,
          });
        }
      }
    }
  });

  it('never names an undetected enemy ship anywhere in the payload', () => {
    // FAILS — and the defect is in `src/net/redact.ts`, not in the referee.
    //
    // `multiplayer.test.ts` proves this for a freshly built board. It is not
    // true once a movement phase has run: `movement.ts` keeps its per-turn
    // bookkeeping under `scenarioData.movement`, whose keys are `paths`,
    // `landing`, `rams` and `hazards` rather than ship ids — so
    // `filterOwnedEntries` declines to split it, `mentionsOnlyOtherPlayersShips`
    // passes it because the viewer's own ships are in there too, and every seat
    // is handed the hex-by-hex course of every enemy ship it cannot see.
    const leaks: string[] = [];
    for (const scenario of ['escape', 'lateral-7', 'piracy']) {
      const played = playComputerSeats(soloTable(scenario), dice(5), map, 25);
      for (const [seat, view] of Object.entries(viewsForAll(played.game, map))) {
        const named = allStrings(view);
        for (const [id, ship] of Object.entries(played.game.state.ships)) {
          if (ship.owner === seat || id in view.ships) continue;
          if (named.has(id)) leaks.push(`${scenario}/${seat}: ${id} at ${pathsTo(view, id)[0]}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('does not narrate a move the seat could not have watched', () => {
    // FAILS — same file, second hole. `redactState` filters `ships`, `ordnance`
    // and `scenarioData` and passes `state.log` through untouched, so a fog view
    // carries the running commentary of the whole game: every takeoff, plot and
    // burn of every enemy ship, by name, with the hex printed in the sentence.
    const leaks: string[] = [];
    for (const scenario of ['escape', 'lateral-7', 'piracy']) {
      const played = playComputerSeats(soloTable(scenario), dice(5), map, 25);
      for (const [seat, view] of Object.entries(viewsForAll(played.game, map))) {
        for (const ship of Object.values(played.game.state.ships)) {
          if (ship.owner === seat || ship.id in view.ships) continue;
          const label = shipLabel(ship);
          const heard = view.log.find((e) => e.text.includes(label));
          if (heard) leaks.push(`${scenario}/${seat}: "${heard.text}"`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('gives a spectator of a fog game nothing at all', () => {
    const g = table('escape');
    const view = viewFor(g, null, map);
    expect(Object.keys(view.ships)).toHaveLength(0);
    expect(view.rng.seed).toBe(0);
  });

  it('hands an open game the same board to everybody', () => {
    // No fog means no redaction, which is the point: one state, one broadcast,
    // and every client replays the log to the identical position.
    const g = table('bi-planetary');
    const views = viewsForAll(g, map);
    expect(same(views['mars']!, views['venus']!)).toBe(true);
    expect(same(views['mars']!, viewFor(g, null, map))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The computer's seats
// ---------------------------------------------------------------------------

describe('the computer’s seats', () => {
  it('advances a solo table and logs every order it gave', () => {
    // One human, one computer. The human ends their five phases; the computer
    // then plays its whole player-turn, and each of its orders is a row in the
    // same log a human's order goes into — a client is never asked to drive an
    // opponent it could lie about.
    let g = table('bi-planetary', { computer: [1] });
    const roll = dice(5);
    const orders: Command[] = [];
    for (let i = 0; i < 5; i += 1) {
      g = accepted(judge(g, 'mars', { type: 'endPhase', by: 'mars' }, roll(), map)).game;
      const ai = playComputerSeats(g, roll, map);
      g = ai.game;
      orders.push(...ai.logged.map((e) => e.cmd));
    }
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((c) => c.by === 'venus')).toBe(true);
    expect(g.commandCount).toBe(5 + orders.length);
    expect(g.state.turn).toBe(2);
  });

  it('stops because it is finished, never because it was refused', () => {
    // `playComputerSeats` breaks the loop on a refusal and reports nothing, so
    // "did it swallow one?" cannot be read off its return value. It can be read
    // off the board: if the loop had stopped on a refusal the policy would still
    // be offering that same order, and `aiHasMove` would be true.
    let g = table('bi-planetary', { computer: [1] });
    const computers = new Set<PlayerId>(['venus']);
    const roll = dice(5);
    for (let i = 0; i < 12; i += 1) {
      g = accepted(judge(g, 'mars', { type: 'endPhase', by: 'mars' }, roll(), map)).game;
      const ai = playComputerSeats(g, roll, map);
      g = ai.game;
      expect({ step: i, owed: aiHasMove(g.state, computers, map) }).toEqual({
        step: i,
        owed: false,
      });
    }
  });

  it('plays a whole game out and stops at victory', () => {
    const played = playComputerSeats(soloTable('bi-planetary'), dice(5), map, 400);
    expect(played.game.state.victory?.winners.length).toBeGreaterThan(0);
    expect(played.game.status).toBe('finished');
    // Well short of the budget: hitting the limit would mean the loop stopped
    // for the one reason that is always a bug.
    expect(played.logged.length).toBeLessThan(400);
  });

  it('gives no order once the board is decided', () => {
    const g = soloTable('bi-planetary');
    const decided: StoredGame = {
      ...g,
      state: { ...g.state, victory: { winners: ['mars'], level: 'decisive', reason: 'test' } },
    };
    expect(playComputerSeats(decided, dice(5), map).logged).toHaveLength(0);
  });

  it('gives no order while the table is in the lobby or already closed', () => {
    for (const status of ['lobby', 'finished'] as const) {
      const g = { ...soloTable('bi-planetary'), status };
      const out = playComputerSeats(g, dice(5), map);
      expect({ status, orders: out.logged.length, game: out.game }).toEqual({
        status,
        orders: 0,
        game: g,
      });
    }
  });

  it('gives no order at a table with no computer seats', () => {
    const g = table('bi-planetary');
    expect(playComputerSeats(g, dice(5), map).logged).toHaveLength(0);
  });

  it('is deterministic given the same dice, and not given different ones', () => {
    // The first half is what makes a solo game replayable from its log. The
    // second is the same sealed-die property as above, checked through the AI
    // path: if the referee were rolling with the stored generator, changing the
    // dice would change nothing.
    const start = soloTable('retribution');
    const a = playComputerSeats(start, dice(5), map, 120);
    const b = playComputerSeats(start, dice(5), map, 120);
    expect(same(a.game.state, b.game.state)).toBe(true);
    expect(a.logged).toEqual(b.logged);

    const c = playComputerSeats(start, dice(9999), map, 120);
    expect(same(a.game.state, c.game.state)).toBe(false);
  });

  it('writes the fog snapshots only when it actually moved', () => {
    const fogged = soloTable('escape');
    expect(Object.keys(playComputerSeats(fogged, dice(5), map, 10).views).sort()).toEqual([
      'enforcers',
      'pilgrims',
    ]);
    expect(playComputerSeats(soloTable('bi-planetary'), dice(5), map, 10).views).toEqual({});
    // Nothing done, nothing to publish.
    const decided: StoredGame = {
      ...fogged,
      state: { ...fogged.state, victory: { winners: ['pilgrims'], level: 'moral', reason: 'x' } },
    };
    expect(playComputerSeats(decided, dice(5), map).views).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

const openTable = (): StoredGame => {
  const g = table('bi-planetary', { status: 'lobby' });
  return {
    ...g,
    seats: g.seats.map((s) => ({ ...s, kind: 'open', userId: null, lastSeen: null })),
  };
};

const withSeats = (g: StoredGame, seats: readonly SeatRow[] | undefined): StoredGame => ({
  ...g,
  seats: seats ?? g.seats,
});

describe('seating', () => {
  it('takes the lowest open seat by ordinal when none is asked for', () => {
    // The friend-follows-a-link case, which has to be one click. Ordinal, not
    // insertion order: the row order out of Postgres is not the seating plan.
    const g = withSeats(openTable(), undefined);
    const shuffled: StoredGame = { ...g, seats: [...g.seats].reverse() };
    const first = takeSeat(shuffled, 'user-a', undefined, 'Ann', 1000);
    expect(first.seat).toBe('mars');
    const second = takeSeat(withSeats(shuffled, first.seats), 'user-b', undefined, 'Bob', 1000);
    expect(second.seat).toBe('venus');
  });

  it('refuses a seat somebody else is holding', () => {
    const g = withSeats(openTable(), takeSeat(openTable(), 'user-a', 'mars', 'Ann', 1000).seats);
    const out = takeSeat(g, 'user-b', 'mars', 'Bob', 1000);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/taken/);
  });

  it('refuses a full table', () => {
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', undefined, 'Ann', 1000).seats);
    g = withSeats(g, takeSeat(g, 'user-b', undefined, 'Bob', 1000).seats);
    const out = takeSeat(g, 'user-c', undefined, 'Cid', 1000);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/full/);
  });

  it('gives a returning account its own seat back rather than a second one', () => {
    // This is what makes a reconnect resume the game instead of starting a
    // spectator session, and it is also the "one account, one seat" rule: the
    // rejoin must not consume the last free chair.
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    const again = takeSeat(g, 'user-a', undefined, 'Ann', 5000);
    expect(again.seat).toBe('mars');
    g = withSeats(g, again.seats);
    expect(g.seats.filter((s) => s.userId === 'user-a')).toHaveLength(1);
    expect(g.seats.find((s) => s.seat === 'mars')?.lastSeen).toBe(5000);
    expect(g.seats.find((s) => s.seat === 'venus')?.userId).toBeNull();
  });

  it('vacates the old seat when one account moves to another', () => {
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    const moved = takeSeat(g, 'user-a', 'venus', 'Ann', 2000);
    expect(moved.seat).toBe('venus');
    g = withSeats(g, moved.seats);
    expect(g.seats.filter((s) => s.userId === 'user-a').map((s) => s.seat)).toEqual(['venus']);
    expect(g.seats.find((s) => s.seat === 'mars')?.kind).toBe('open');
  });

  it('will not sit a person down in a computer seat', () => {
    // A seat the referee plays itself is not a chair. If a person could take it
    // the table would silently lose its opponent mid-game.
    const g = table('bi-planetary', { computer: [1], status: 'lobby' });
    const out = takeSeat(g, 'user-new', 'venus', 'Cid', 1000);
    expect(out.ok).toBe(false);
  });

  it('frees a seat on leaving, for anybody to take', () => {
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    g = withSeats(g, leaveSeat(g, 'user-a'));
    const left = g.seats.find((s) => s.seat === 'mars')!;
    expect({ userId: left.userId, kind: left.kind, lastSeen: left.lastSeen }).toEqual({
      userId: null,
      kind: 'open',
      lastSeen: null,
    });
    expect(takeSeat(g, 'user-b', 'mars', 'Bob', 2000).seat).toBe('mars');
  });

  it('leaves everybody else alone when somebody stands up', () => {
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    g = withSeats(g, takeSeat(g, 'user-b', 'venus', 'Bob', 1000).seats);
    g = withSeats(g, leaveSeat(g, 'user-a'));
    expect(g.seats.find((s) => s.seat === 'venus')?.userId).toBe('user-b');
  });
});

describe('presence', () => {
  it('counts a seat heard from just now, and not one heard from PRESENCE_MS ago', () => {
    // The dot in the roster answers "is somebody there?", so the boundary is the
    // whole rule. Half a window ago is present; exactly a window ago is not.
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    const at = (now: number): boolean =>
      tableInfo(g, 'user-a', now).seats.find((s) => s.seat === 'mars')!.present;
    expect(at(1000)).toBe(true);
    expect(at(1000 + PRESENCE_MS / 2)).toBe(true);
    expect(at(1000 + PRESENCE_MS - 1)).toBe(true);
    expect(at(1000 + PRESENCE_MS)).toBe(false);
  });

  it('counts a computer seat as always present', () => {
    // It has no browser to hear from, and a roster that greys it out would be
    // telling the table its opponent had gone.
    const g = table('bi-planetary', { computer: [1] });
    const venus = tableInfo(g, 'user-0', 10 ** 12).seats.find((s) => s.seat === 'venus')!;
    expect({ kind: venus.kind, lastSeen: g.seats[1]!.lastSeen, present: venus.present }).toEqual({
      kind: 'computer',
      lastSeen: null,
      present: true,
    });
  });

  it('counts nobody at an open seat', () => {
    const g = openTable();
    expect(tableInfo(g, null, 1000).seats.every((s) => !s.present)).toBe(true);
  });

  it('does not leave a vacated seat looking occupied', () => {
    // FAILS — `referee.ts:341`. Moving accounts clears `userId` and `kind` on
    // the seat left behind but not `lastSeen`, so the roster shows an open,
    // unheld seat with a live presence dot and the departed player's name on it.
    // `leaveSeat` clears `lastSeen`; this path should too.
    let g = openTable();
    g = withSeats(g, takeSeat(g, 'user-a', 'mars', 'Ann', 1000).seats);
    g = withSeats(g, takeSeat(g, 'user-a', 'venus', 'Ann', 1000).seats);
    const mars = tableInfo(g, 'user-a', 1000).seats.find((s) => s.seat === 'mars')!;
    expect({ kind: mars.kind, present: mars.present }).toEqual({ kind: 'open', present: false });
  });

  it('marks a seat heard from, and ignores a spectator', () => {
    const g = openTable();
    const touched = seenNow(g, 'mars', 4242);
    expect(touched.find((s) => s.seat === 'mars')?.lastSeen).toBe(4242);
    expect(touched.find((s) => s.seat === 'venus')?.lastSeen).toBeNull();
    expect(seenNow(g, null, 4242)).toBe(g.seats);
  });

  it('tells each caller which seat is theirs and nothing about whose is whose', () => {
    const g = table('bi-planetary');
    const mine = tableInfo(g, 'user-1', 1000)
      .seats.filter((s) => s.mine)
      .map((s) => s.seat);
    expect(mine).toEqual(['venus']);
    expect(tableInfo(g, null, 1000).seats.some((s) => s.mine)).toBe(false);
    // The roster is a public object: it must not carry the accounts holding the
    // seats, only whether one of them is the caller's.
    expect(allStrings(tableInfo(g, 'user-1', 1000)).has('user-0')).toBe(false);
  });

  it('reports the seats in ordinal order however the rows arrive', () => {
    const g = table('bi-planetary');
    const shuffled: StoredGame = { ...g, seats: [...g.seats].reverse() };
    expect(tableInfo(shuffled, null, 1000).seats.map((s) => s.ordinal)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Join codes
// ---------------------------------------------------------------------------

describe('join codes', () => {
  it('leaves out the characters people confuse', () => {
    // A code exists to be typed off somebody else's screen or repeated down a
    // phone. `0/O` and `1/I/L` are the pairs that come back wrong.
    for (const c of ['0', 'O', '1', 'I', 'L']) {
      expect({ c, inAlphabet: CODE_ALPHABET.includes(c) }).toEqual({ c, inAlphabet: false });
    }
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
    expect(CODE_ALPHABET).toBe(CODE_ALPHABET.toUpperCase());
  });

  it('builds a code of exactly CODE_LENGTH from the alphabet, whatever the bytes', () => {
    for (const bytes of [
      new Uint8Array([0, 1, 2, 3, 4, 5]),
      new Uint8Array([255, 255, 255, 255, 255, 255]),
      new Uint8Array(32).fill(200),
      new Uint8Array([]),
    ]) {
      const code = codeFrom(bytes);
      expect({ length: code.length, valid: isCode(code) }).toEqual({
        length: CODE_LENGTH,
        valid: true,
      });
    }
  });

  it('is a function of the bytes it was handed', () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
    expect(codeFrom(bytes)).toBe(codeFrom(bytes));
    expect(codeFrom(new Uint8Array([9, 8, 7, 6, 5, 4]))).not.toBe(
      codeFrom(new Uint8Array([9, 8, 7, 6, 5, 3])),
    );
  });

  it('rejects the wrong length, lowercase, and the confusables', () => {
    // A code that only *nearly* matches must be refused rather than repaired:
    // silently mapping `0` to `O` would let two different codes name one table.
    expect(isCode('ABCDEF')).toBe(true);
    for (const bad of [
      'abcdef',
      'ABCDE',
      'ABCDEFG',
      '',
      'ABCDE0',
      'ABCDEO',
      'ABCDEI',
      'ABCDEL',
      'ABC DE',
    ]) {
      expect({ bad, valid: isCode(bad) }).toEqual({ bad, valid: false });
    }
  });
});
