/**
 * Server-authoritative multiplayer.
 *
 * These drive the real `Room` — the same object the WebSocket server wraps —
 * so they test the actual authority and redaction logic rather than a mock of
 * it. The leak tests below are regressions: Escape shipped its decoy list in
 * plain `scenarioData`, which named two of the three transports and therefore
 * handed the Enforcer the fugitive by elimination.
 */

import { describe, expect, it } from 'vitest';
import { Room } from '../server/room.js';
import { buildScenario } from '../src/scenarios/index.js';
import {
  ALWAYS_VISIBLE_KEY,
  SECRET_KEY,
  commandIsAuthorised,
  redactState,
} from '../src/net/redact.js';
import { DEFAULT_MAP, type GameState } from '../src/engine/index.js';
import { parseClientMsg, SERVER_PROTOCOL_VERSION } from '../src/net/protocol.js';

const map = DEFAULT_MAP;

const room = (scenario: string, seed = 7): Room =>
  new Room('r', buildScenario(scenario, { seed }), map);

/** Every string anywhere in a value — used to hunt leaks in the wire payload. */
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

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

describe('seat authority', () => {
  it('refuses a command issued on another player’s behalf', () => {
    const r = room('bi-planetary');
    const [first, second] = r.state.playerOrder;
    const out = r.accept(second!, { type: 'endPhase', by: first! });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/may not act for/);
  });

  it('refuses commands from spectators', () => {
    const r = room('bi-planetary');
    const out = r.accept(null, { type: 'endPhase', by: r.state.playerOrder[0]! });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/spectator/);
  });

  it('still enforces the rules on a correctly seated player', () => {
    // Seat authority is necessary but not sufficient: the engine has the last word.
    const r = room('bi-planetary');
    const second = r.state.playerOrder[1]!;
    const out = r.accept(second, { type: 'endPhase', by: second });
    expect(out.ok).toBe(false); // not their player-turn yet
  });

  it('accepts a legal command and appends it to the authoritative log', () => {
    const r = room('bi-planetary');
    const first = r.state.playerOrder[0]!;
    expect(r.log).toHaveLength(0);
    const out = r.accept(first, { type: 'endPhase', by: first });
    expect(out.ok).toBe(true);
    expect(out.index).toBe(1);
    expect(r.log).toHaveLength(1);
  });

  it('leaves the state untouched when a command is refused', () => {
    const r = room('bi-planetary');
    const before = JSON.stringify(r.state);
    r.accept(null, { type: 'endPhase', by: r.state.playerOrder[0]! });
    r.accept(r.state.playerOrder[1]!, { type: 'endPhase', by: r.state.playerOrder[0]! });
    expect(JSON.stringify(r.state)).toBe(before);
  });

  it('guards the raw predicate directly', () => {
    expect(commandIsAuthorised('a', 'a')).toBe(true);
    expect(commandIsAuthorised('a', 'b')).toBe(false);
    expect(commandIsAuthorised(null, 'a')).toBe(false);
  });
});

describe('seats', () => {
  it('grants a free seat and refuses one already held', () => {
    const r = room('bi-planetary');
    const seat = r.state.playerOrder[0]!;
    expect(r.claimSeat(seat, 'client-1')).toBe(seat);
    expect(r.claimSeat(seat, 'client-2')).toBeNull();
  });

  it('lets the original client reclaim its seat after a drop', () => {
    // This is what makes a reconnect resume the game instead of spectating.
    const r = room('bi-planetary');
    const seat = r.state.playerOrder[0]!;
    r.claimSeat(seat, 'client-1');
    r.releaseClient('client-1');
    expect(r.roster().find((x) => x.seat === seat)?.connected).toBe(false);
    expect(r.claimSeat(seat, 'client-1')).toBe(seat);
    expect(r.roster().find((x) => x.seat === seat)?.connected).toBe(true);
  });

  it('reports spectators as holding no seat', () => {
    const r = room('bi-planetary');
    expect(r.claimSeat(null, 'watcher')).toBeNull();
    expect(r.seatOf('watcher')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('open-information games', () => {
  it('send the identical state to everyone', () => {
    const r = room('bi-planetary');
    expect(r.usesSnapshots).toBe(false);
    const a = r.viewFor(r.state.playerOrder[0]!);
    const b = r.viewFor(r.state.playerOrder[1]!);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('fog of war', () => {
  it('withholds undetected enemy ships', () => {
    const r = room('escape');
    expect(r.usesSnapshots).toBe(true);
    const [pilgrims, enforcers] = r.state.playerOrder as [string, string];

    const pilgrimView = r.viewFor(pilgrims);
    const enforcerView = r.viewFor(enforcers);

    for (const ship of Object.values(pilgrimView.ships)) {
      expect({ viewer: pilgrims, owner: ship.owner }).toEqual({
        viewer: pilgrims,
        owner: pilgrims,
      });
    }
    for (const ship of Object.values(enforcerView.ships)) {
      expect({ viewer: enforcers, owner: ship.owner }).toEqual({
        viewer: enforcers,
        owner: enforcers,
      });
    }
  });

  it('sends Escape’s secret only to the Pilgrims', () => {
    const r = room('escape');
    const [pilgrims, enforcers] = r.state.playerOrder as [string, string];
    expect(r.viewFor(pilgrims).scenarioData[SECRET_KEY]).toBeDefined();
    expect(r.viewFor(enforcers).scenarioData[SECRET_KEY]).toBeUndefined();
  });

  it('never names another player’s ships anywhere in a wire payload', () => {
    // Regression: the decoy list used to travel in plain scenarioData, naming
    // two of three transports and giving away the third by elimination.
    for (const scenario of ['escape', 'lateral-7', 'piracy']) {
      const r = room(scenario);
      if (!r.usesSnapshots) continue;

      for (const viewer of r.state.playerOrder) {
        const view = r.viewFor(viewer);
        const names = allStrings(view);
        const visibleHere = new Set(Object.keys(view.ships));

        for (const [id, ship] of Object.entries(r.state.ships)) {
          if (ship.owner === viewer || visibleHere.has(id)) continue;
          expect({ scenario, viewer, leaked: id, present: names.has(id) }).toEqual({
            scenario,
            viewer,
            leaked: id,
            present: false,
          });
        }
      }
    }
  });

  it('withholds a secret from a spectator too', () => {
    const r = room('escape');
    expect(r.viewFor(null).scenarioData[SECRET_KEY]).toBeUndefined();
    expect(Object.keys(r.viewFor(null).ships)).toHaveLength(0);
  });

  it('honours a scenario’s always-visible list, and shows each player only their own', () => {
    // "Because ship sailings are published, the pirate knows the location of
    //  the liner." Detection alone would not give the pirate that.
    const r = room('lateral-7');
    const table = r.state.scenarioData[ALWAYS_VISIBLE_KEY] as Record<string, string[]> | undefined;
    expect(table).toBeDefined();

    const [owner] = Object.keys(table!);
    const view = r.viewFor(owner!);
    for (const id of table![owner!]!) {
      expect({ viewer: owner, ship: id, visible: id in view.ships }).toEqual({
        viewer: owner,
        ship: id,
        visible: true,
      });
    }

    for (const other of r.state.playerOrder) {
      if (other === owner) continue;
      const seen = r.viewFor(other).scenarioData[ALWAYS_VISIBLE_KEY] as
        Record<string, unknown> | undefined;
      expect(seen === undefined || !(owner! in seen)).toBe(true);
    }
  });

  it('produces a state the engine still accepts', () => {
    // A redacted view must remain a valid GameState, or the client cannot
    // render or preview against it.
    const r = room('escape');
    const view: GameState = r.viewFor(r.state.playerOrder[0]!);
    expect(view.turn).toBe(r.state.turn);
    expect(view.phase).toBe(r.state.phase);
    expect(view.playerOrder).toEqual(r.state.playerOrder);
    expect(redactState(view, r.state.playerOrder[0]!, map).turn).toBe(view.turn);
  });
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

describe('protocol parsing', () => {
  const v = SERVER_PROTOCOL_VERSION;

  it('accepts well-formed frames', () => {
    expect(
      parseClientMsg(JSON.stringify({ t: 'hello', v, room: 'r', seat: 'a', clientId: 'c' })),
    ).not.toBeNull();
    expect(
      parseClientMsg(JSON.stringify({ t: 'cmd', v, seq: 1, cmd: { type: 'endPhase', by: 'a' } })),
    ).not.toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'resync', v }))).not.toBeNull();
  });

  it('rejects malformed, mistyped and wrong-version frames', () => {
    expect(parseClientMsg('not json')).toBeNull();
    expect(
      parseClientMsg(
        JSON.stringify({ t: 'hello', v: v + 99, room: 'r', seat: null, clientId: 'c' }),
      ),
    ).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'nonsense', v }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'cmd', v, seq: 1, cmd: { by: 'a' } }))).toBeNull();
    expect(
      parseClientMsg(JSON.stringify({ t: 'hello', v, room: 5, seat: null, clientId: 'c' })),
    ).toBeNull();
  });
});
