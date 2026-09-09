/**
 * The referee running the ground game.
 *
 * Same referee, same seats, same sealed die — with the Ogre engine's rules
 * under it. What these prove: a table of the ground game opens with a
 * deployment step and the computer plays its seats through it; a human's
 * order is judged on the seat that the *board* says may act, not merely the
 * phasing player; the log replays roll for roll; the stored board is sealed;
 * and a table password gets a player in and gets their seat back.
 */

import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../src/engine/index.js';
import {
  type AnyState,
  type StateSummary,
  GROUND_SCENARIO_IDS,
  isGroundScenario,
} from '../src/net/kinds.js';
import { OGRE_RULES, actorOf, asOgreState } from '../src/net/ogreRules.js';
import { rulesFor } from '../src/net/rulesAll.js';
import type { LoggedCommand } from '../src/net/supabase/protocol.js';
import {
  type SeatRow,
  type StoredGame,
  hashPassword,
  judge,
  playComputerSeats,
  reclaimSeat,
  replayLog,
  tableInfo,
  takeSeat,
  verifyPassword,
  viewFor,
  reconfigure,
} from '../src/net/supabase/referee.js';

const rules = OGRE_RULES;

const table = (
  scenarioId: string,
  opts: { computer?: readonly number[]; status?: StoredGame['status']; locked?: boolean } = {},
): StoredGame => {
  const state = rules.build(scenarioId, { seed: 7 });
  const summary = rules.summary(state);
  const computer = new Set(opts.computer ?? []);
  const seats: SeatRow[] = summary.playerOrder.map((seat, i) => ({
    seat,
    ordinal: i,
    faction: summary.players[seat]?.faction ?? seat,
    name: summary.players[seat]?.name ?? seat,
    kind: computer.has(i) ? 'computer' : 'human',
    userId: computer.has(i) ? null : `user-${i}`,
    lastSeen: null,
  }));
  return {
    id: 'ogre-1',
    code: 'OGRE22',
    kind: 'ogre',
    locked: opts.locked ?? false,
    scenarioId,
    fog: false,
    status: opts.status ?? 'playing',
    state: rules.seal(state),
    commandCount: 0,
    seats,
    hostId: 'user-0',
  };
};

const dice = (from: number): (() => number) => {
  let n = from;
  return () => (n = (n * 1103515245 + 12345) >>> 0);
};

describe('a table of the ground game', () => {
  it('is picked out by its kind and opens with a deployment step', () => {
    expect(rulesFor('ogre')).toBe(OGRE_RULES);
    const g = table('mark-iii-attack');
    const state = asOgreState(g.state);
    expect(state.setup).not.toBeNull();
    expect(tableInfo(g, 'user-0', 0).kind).toBe('ogre');
    expect(tableInfo(g, 'user-0', 0).seats.map((s) => s.seat)).toEqual(state.playerOrder);
  });

  it('stores the board with the die sealed, and shows every seat the same board', () => {
    const g = table('mark-iii-attack');
    expect(asOgreState(g.state).rng.seed).toBe(0);
    const seatA = viewFor(g, g.seats[0]!.seat, undefined, rules);
    const nobody = viewFor(g, null, undefined, rules);
    expect(JSON.stringify(seatA)).toBe(JSON.stringify(nobody));
  });

  it('judges an order on the seat the board is waiting for', () => {
    const g = table('mark-iii-attack');
    const state = asOgreState(g.state);
    const first = actorOf(state);
    const other = state.playerOrder.find((p) => p !== first)!;
    // The defence sets up first: the Ogre, though it moves first, may not act yet.
    const early = judge(g, other, { type: 'finishSetup', by: other }, 5, undefined, rules);
    expect(early.ok).toBe(false);
    // Nor may the defence act for the Ogre.
    const forged = judge(g, first, { type: 'finishSetup', by: other }, 5, undefined, rules);
    expect(forged.ok).toBe(false);
    const ready = judge(g, first, { type: 'finishSetup', by: first }, 5, undefined, rules);
    expect(ready.ok).toBe(true);
    if (ready.ok) expect(actorOf(asOgreState(ready.game.state))).toBe(other);
  });

  it('plays the computer’s seats through deployment and into the turns', () => {
    const g = table('mark-iii-attack', { computer: [0, 1] });
    const out = playComputerSeats(g, dice(3), undefined, 400, rules);
    expect(out.logged.length).toBeGreaterThan(20);
    const state = asOgreState(out.game.state);
    expect(state.setup).toBeNull();
    expect(state.turn).toBeGreaterThanOrEqual(1);
    // Every logged order carries the die it was rolled with.
    for (const entry of out.logged) expect(entry.die).toBeGreaterThanOrEqual(0);
  });

  it('replays its log roll for roll onto the opening board', () => {
    const g = table('mark-iii-attack', { computer: [0, 1] });
    const out = playComputerSeats(g, dice(11), undefined, 300, rules);
    const initial = rules.seal(rules.build(g.scenarioId, { seed: 7 }));
    const replayed = replayLog(initial, out.logged, undefined, rules);
    expect(replayed.failed).toBeNull();
    expect(JSON.stringify(replayed.state)).toBe(JSON.stringify(out.game.state));
  });

  it('lets a human take a seat, then plays the computer’s reply', () => {
    let g = table('mark-iii-attack', { computer: [0] });
    const human: PlayerId = g.seats[1]!.seat;
    // The defence (seat 1) sets up first and is the human.
    const ready = judge(g, human, { type: 'finishSetup', by: human }, 9, undefined, rules);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    g = ready.game;
    const reply = playComputerSeats(g, dice(21), undefined, 400, rules);
    const state = asOgreState(reply.game.state);
    // The Ogre set up and took its turn; the board now waits on the defence.
    expect(state.setup).toBeNull();
    expect(actorOf(state)).toBe(human);
    expect(reply.logged.length).toBeGreaterThan(1);
  });

  it('refuses the fleet game’s rules at a ground table', () => {
    const g = table('mark-iii-attack');
    expect(() => viewFor(g, null)).toThrow(/no rules supplied/);
  });
});

describe('the table password', () => {
  it('hashes with a fresh salt and verifies only the password it was made from', async () => {
    const a = await hashPassword('ogre rules');
    const b = await hashPassword('ogre rules');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1$')).toBe(true);
    expect(await verifyPassword(a, 'ogre rules')).toBe(true);
    expect(await verifyPassword(b, 'ogre rules')).toBe(true);
    expect(await verifyPassword(a, 'ogre rule')).toBe(false);
    expect(await verifyPassword(a, '')).toBe(false);
  });

  it('opens a table with no password to anything', async () => {
    expect(await verifyPassword(null, '')).toBe(true);
    expect(await verifyPassword(null, 'whatever')).toBe(true);
  });

  it('takes a seat back with the password, dropping whoever held it', () => {
    const g = table('mark-iii-attack', { locked: true });
    const seat = g.seats[0]!.seat;
    // A new device: a new account, the password, the seat's name.
    const back = reclaimSeat(g, 'user-0-phone', seat, 'Sam', 100);
    expect(back.ok).toBe(true);
    const row = back.seats!.find((s) => s.seat === seat)!;
    expect(row.userId).toBe('user-0-phone');
    expect(row.name).toBe('Sam');
    // The old device holds nothing now.
    expect(back.seats!.some((s) => s.userId === 'user-0')).toBe(false);
    // The ordinary join would have refused: the seat looked taken.
    expect(takeSeat(g, 'user-0-phone', seat, undefined, 100).ok).toBe(false);
  });

  it('will not reclaim on a table with no password, nor a computer’s seat', () => {
    const open = table('mark-iii-attack');
    expect(reclaimSeat(open, 'x', open.seats[0]!.seat, undefined, 0).ok).toBe(false);
    const solo = table('mark-iii-attack', { locked: true, computer: [0] });
    expect(reclaimSeat(solo, 'x', solo.seats[0]!.seat, undefined, 0).ok).toBe(false);
    expect(reclaimSeat(solo, 'x', 'nobody', undefined, 0).ok).toBe(false);
  });

  it('gives the game log entries the referee can replay whichever game it is', () => {
    const g = table('mark-iii-attack', { computer: [0, 1] });
    const out = playComputerSeats(g, dice(5), undefined, 60, rules);
    const log: LoggedCommand[] = out.logged;
    expect(log.every((e) => typeof (e.cmd as { by: string }).by === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Changing the setup from the lobby
// ---------------------------------------------------------------------------

describe('changing a ground table’s setup from its lobby', () => {
  const lobby = (opts: { computer?: readonly number[] } = {}): StoredGame => {
    const g = table('mark-iii-attack', { ...opts, status: 'lobby' });
    // The host holds the first human seat; a friend has taken the second.
    const seats = g.seats.map((s, i) =>
      s.kind === 'computer'
        ? s
        : {
            ...s,
            kind: 'human' as const,
            userId: i === 0 ? 'user-0' : 'user-1',
            name: i === 0 ? 'Host' : 'Friend',
            lastSeen: 5,
          },
    );
    return { ...g, seats };
  };
  const custom = (): { opening: AnyState; summary: StateSummary } => {
    const opening = rules.seal(rules.build('custom', { seed: 3 }));
    return { opening, summary: rules.summary(opening) };
  };

  it('rebuilds the roster from the new board and keeps whoever held each ordinal', () => {
    const g = lobby();
    const { opening, summary } = custom();
    const out = reconfigure(g, 'custom', opening, summary, [], 99);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.game.scenarioId).toBe('custom');
    expect(out.game.state).toBe(opening);
    expect(out.game.seats.map((s) => s.seat)).toEqual(summary.playerOrder);
    expect(out.game.seats.map((s) => [s.kind, s.userId, s.name])).toEqual([
      ['human', 'user-0', 'Host'],
      ['human', 'user-1', 'Friend'],
    ]);
    // The factions are the new board's, not the old one's.
    expect(out.game.seats.map((s) => s.faction)).toEqual(
      summary.playerOrder.map((id) => summary.players[id]?.faction),
    );
  });

  it('stands up a player whose seat went to the computer, and reseats the host if it was theirs', () => {
    const g = lobby();
    const { opening, summary } = custom();
    const friendOut = reconfigure(g, 'custom', opening, summary, [1], 99);
    expect(friendOut.ok && friendOut.game.seats.map((s) => [s.kind, s.userId])).toEqual([
      ['human', 'user-0'],
      ['computer', null],
    ]);
    // With the friend gone, a host whose seat went to the computer takes the other.
    const alone: StoredGame = {
      ...g,
      seats: g.seats.map((s, i) =>
        i === 1 ? { ...s, kind: 'open', userId: null, lastSeen: null } : s,
      ),
    };
    const hostMoved = reconfigure(alone, 'custom', opening, summary, [0], 99);
    expect(hostMoved.ok && hostMoved.game.seats.map((s) => [s.kind, s.userId, s.name])).toEqual([
      ['computer', null, summary.players[summary.playerOrder[0]!]?.name],
      ['human', 'user-0', 'Host'],
    ]);
    // With the friend still there, the host has nowhere to go.
    expect(reconfigure(g, 'custom', opening, summary, [0], 99).ok).toBe(false);
    const nowhere = reconfigure(g, 'custom', opening, summary, [0, 1], 99);
    expect(nowhere.ok).toBe(false);
  });

  it('refuses once the table has begun', () => {
    const g = { ...lobby(), status: 'playing' as const };
    const { opening, summary } = custom();
    expect(reconfigure(g, 'custom', opening, summary, [], 99).ok).toBe(false);
  });

  it('describes a custom table for the lobby: title and brief', () => {
    const { opening, summary } = custom();
    expect(summary.title).toBe('Custom battle');
    expect(summary.brief[0]).toMatch(/^Map: /);
    expect(summary.brief.some((l) => /attacking/.test(l))).toBe(true);
    const info = tableInfo({ ...table('custom'), state: opening }, 'user-0', 0, rules);
    expect(info.title).toBe('Custom battle');
    expect(info.brief).toEqual(summary.brief);
  });
});

// ---------------------------------------------------------------------------
// The list the shell keeps so it need not load the ground engine to recognise one
// ---------------------------------------------------------------------------

describe('the ground game’s scenario ids', () => {
  it('are the ids the scenario table actually holds', async () => {
    const { SCENARIOS } = await import('../src/ogre/scenarios/index.js');
    expect([...GROUND_SCENARIO_IDS].sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  it('are what the inbound door recognises, and nothing else', () => {
    for (const id of GROUND_SCENARIO_IDS) expect(isGroundScenario(id)).toBe(true);
    expect(isGroundScenario('bi-planetary')).toBe(false);
    expect(isGroundScenario('')).toBe(false);
  });
});
