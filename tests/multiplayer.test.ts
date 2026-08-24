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
import {
  type SeatRow,
  type StoredGame,
  leaveSeat,
  playComputerSeats,
  takeSeat,
  viewFor,
  viewsForAll,
} from '../src/net/supabase/referee.js';

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
// The same property, over the Supabase transport
// ---------------------------------------------------------------------------

/**
 * The tests above run the property on a board nobody has moved on yet, and that
 * is where they stop being worth much: a freshly built scenario has an empty
 * `movement.paths`, an empty log and nothing detected, so a redactor that
 * withholds nothing at all still passes. Every leak found in this code so far
 * only existed after somebody had taken a turn.
 *
 * So these play a fog game out through the referee's own loop first, and then
 * ask the same question of the payloads the Supabase transport actually sends:
 * the per-seat snapshot the `views` row carries, and the `snapshot` a `sync`
 * answers with. Both are `viewFor`, which is what makes it one property and not
 * three.
 */
const played = (scenarioId: string, orders: number, seed = 7): StoredGame => {
  const state = buildScenario(scenarioId, { seed });
  const seats: SeatRow[] = state.playerOrder.map((id, ordinal) => ({
    seat: id,
    ordinal,
    faction: id,
    name: id,
    kind: 'computer',
    userId: null,
    lastSeen: null,
  }));
  const game: StoredGame = {
    id: 'game',
    code: 'ABCDEF',
    scenarioId,
    fog: state.options.fogOfWar,
    status: 'playing',
    state,
    commandCount: 0,
    seats,
    hostId: 'host',
  };
  return playComputerSeats(game, () => 0x5eed, map, orders).game;
};

const FOG_SCENARIOS = ['escape', 'lateral-7', 'piracy'] as const;

/** Ships the real board holds that this payload has no business mentioning. */
const forbidden = (game: StoredGame, view: GameState): string[] => {
  const shown = new Set(Object.keys(view.ships));
  const names = allStrings(view);
  return Object.keys(game.state.ships).filter(
    (id) => !shown.has(id) && !game.state.ships[id]!.destroyed && names.has(id),
  );
};

describe('fog of war over the Supabase transport', () => {
  it('never names a hidden ship in a seat’s snapshot, on a board that has been played', () => {
    // What breaks if this fails: `movement.paths` is keyed by ship id and holds
    // the hex-by-hex course of every ship on the board. It is empty at setup,
    // so the fresh-board test above cannot see it, and it travels inside
    // `scenarioData` — which means every seat in a fog game would be handed the
    // exact track of every enemy ship it has never detected.
    for (const scenario of FOG_SCENARIOS) {
      for (const orders of [25, 60, 120]) {
        const game = played(scenario, orders);
        expect(game.state.options.fogOfWar).toBe(true);
        const views = viewsForAll(game, map);
        for (const seat of game.state.playerOrder) {
          expect({ scenario, orders, seat, leaked: forbidden(game, views[seat]!) }).toEqual({
            scenario,
            orders,
            seat,
            leaked: [],
          });
        }
      }
    }
  });

  it('never names a hidden ship to a spectator, on a board that has been played', () => {
    // Separate from the seated case because it is reached by a different branch
    // and defended by a different one. `sync` serves any caller without a seat
    // as a spectator — `viewFor(game, null)` — which is a deliberate widening of
    // the database's "membership, not knowledge, grants a read", and the whole
    // justification for it is that a spectator's payload contains only what is
    // public. What breaks if this fails: anyone signed in who holds a game id
    // reads the position of every ship in a fog game they are not at.
    for (const scenario of FOG_SCENARIOS) {
      for (const orders of [25, 60, 120]) {
        const game = played(scenario, orders);
        const leaked = forbidden(game, viewFor(game, null, map));
        expect({ scenario, orders, leaked }).toEqual({ scenario, orders, leaked: [] });
      }
    }
  });

  it('leaves no hidden ship’s hex in the log entries a seat is sent', () => {
    // `redactLog` matches on the sentence, and `LogEntry.focus` is not a
    // sentence — it is the list of hexes the client flashes on the map when the
    // entry is hovered. An entry that survives the text filter while carrying an
    // undetected ship's hex in `focus` hands over the position in structured
    // form, which is worse than the prose it was filtered for.
    for (const scenario of FOG_SCENARIOS) {
      const game = played(scenario, 120);
      for (const seat of game.state.playerOrder) {
        const view = viewFor(game, seat, map);
        const focused = new Set(
          view.log.flatMap((e) => (e.focus ?? []).map((h) => `${h.q},${h.r}`)),
        );
        const leaked = Object.values(game.state.ships)
          .filter(
            (s) => !(s.id in view.ships) && !s.destroyed && focused.has(`${s.pos.q},${s.pos.r}`),
          )
          .map((s) => s.id);
        expect({ scenario, seat, leaked }).toEqual({ scenario, seat, leaked: [] });
      }
    }
  });

  it('seals the generator in every payload a fog game sends', () => {
    // The sealed die is not a fog rule and applies to the spectator payload too:
    // "a client holding the state can roll the next die before deciding whether
    // to fire", and a spectator is somebody who may be about to sit down.
    const game = played('escape', 40);
    for (const view of [...Object.values(viewsForAll(game, map)), viewFor(game, null, map)]) {
      expect(view.rng.seed).toBe(0);
    }
  });

  it('does not let a player read a seat it vacated its way into', () => {
    // The reconnect rule — "a seat with a live holder is not available; one
    // whose holder left is" — is what makes a dropped player able to resume. It
    // is also, at a table that is already playing, a way to read the enemy's
    // board: wait for an opponent to leave, take their empty chair, read the
    // snapshot the referee keeps refreshed there, and go back to your own. The
    // roster flickers and nothing else records it.
    const game = played('piracy', 40);
    const [mine, , theirs] = game.state.playerOrder as [string, string, string];
    const seats = game.seats.map((s, i) => ({
      ...s,
      kind: 'human' as const,
      userId: `user-${i}`,
      lastSeen: 1,
    }));
    const table: StoredGame = { ...game, seats };

    const before = new Set(Object.keys(viewFor(table, mine, map).ships));
    const vacated: StoredGame = { ...table, seats: leaveSeat(table, 'user-2') };
    const hop = takeSeat(vacated, 'user-0', theirs, undefined, 2);

    const gained = hop.ok
      ? Object.keys(viewFor({ ...vacated, seats: hop.seats! }, theirs, map).ships).filter(
          (id) => !before.has(id),
        )
      : [];
    expect({ hopped: hop.ok, gained }).toEqual({ hopped: false, gained: [] });
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
