/**
 * Two browsers playing each other, against the real schema.
 *
 * `tests/supabase-quick.test.ts` attacks the SQL. This plays a game through
 * it — the actual `QuickTable` client, the actual `schema.sql`, the actual
 * engine — with the network replaced by a function call and nothing else
 * replaced at all. The fake below is not a mock of the database; it is a
 * transport that turns `rpc('tri_play', {...})` into `select tri_play(...)`
 * against PostgreSQL running in WebAssembly, as the role a browser holds.
 *
 * That distinction is the point. A hand-written fake of the referee would
 * agree with whatever this module believed, and the two could be wrong
 * together. Here, a mistake about what `tri_play` returns, what it refuses, or
 * which argument goes where is a failing test.
 *
 * What is genuinely absent is Realtime, which has no WebAssembly equivalent.
 * The client treats a Realtime event as a doorbell and always re-reads through
 * `tri_since`, so ringing the doorbell by hand exercises the same path a live
 * subscription would.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { GameSession } from '../src/net/session.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { buildScenario } from '../src/scenarios/index.js';
import { QuickTable, fingerprint, type QuickLike } from '../src/net/supabase/quick.js';
import type { ChannelLike } from '../src/net/supabase/client.js';
import type { OrderOfBattle } from '../src/campaign/orders.js';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../supabase/quick/schema.sql', import.meta.url)),
  'utf8',
);

let db: PGlite;

/**
 * A `QuickLike` that really talks to PostgreSQL.
 *
 * Named-argument notation (`p_code := $1`) rather than positional, so the
 * argument *names* the client sends are what get checked. A renamed parameter
 * in `schema.sql` fails here rather than in a browser.
 */
const backend = (): QuickLike => ({
  async rpc(fn, args) {
    const names = Object.keys(args);
    const params = names.map((n, i) => {
      const v = args[n];
      const cast = v !== null && typeof v === 'object' ? '::jsonb' : '';
      return `${n} := $${String(i + 1)}${cast}`;
    });
    const values = names.map((n) => {
      const v = args[n];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role 'anon';");
        const out = await tx.query<Record<string, unknown>>(
          `select ${fn}(${params.join(', ')}) as v`,
          values,
        );
        return out.rows;
      });
      return { data: Object.values(rows?.[0] ?? {})[0] ?? null, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  },
  channel(): ChannelLike {
    // No Realtime in WebAssembly. The client re-reads on every doorbell, and
    // the tests ring it themselves.
    const ch: ChannelLike = {
      on: () => ch,
      subscribe: () => ch,
      unsubscribe: async () => undefined,
    };
    return ch;
  },
  async removeChannel() {
    return undefined;
  },
});

const vessel = (): GameSession =>
  new GameSession(buildScenario('flight-school', { seed: 1 }), DEFAULT_MAP);

const player = (name: string): { table: QuickTable; session: GameSession } => {
  const session = vessel();
  return { table: new QuickTable(backend(), session, {}, name), session };
};

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated;
  `);
  await db.exec(SCHEMA);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('truncate table tri_tables cascade;');
});

describe('a table, opened and joined', () => {
  it('hosts, seats the host, and hands back a code', async () => {
    const alice = player('Alice');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(alice.table.table?.scenarioId).toBe('flight-school');
  });

  it('lets a second browser join and see the same opening board', async () => {
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({
      scenarioId: 'flight-school',
      password: 'pw',
      setup: { seed: 4242 },
    });
    await bob.table.join(code, 'pw');

    expect(fingerprint(bob.session.state)).toBe(fingerprint(alice.session.state));
    expect(bob.session.state.scenarioId).toBe('flight-school');
  });

  it('shows the board that was hosted, before anybody has moved', async () => {
    // Agreement is not correctness. Both clients start life holding a
    // placeholder scenario, so "Alice and Bob match" was true even while both
    // were showing the wrong board — which is exactly the bug this catches.
    // The assertion is against a board built independently from the host's
    // own setup.
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({
      scenarioId: 'bi-planetary',
      password: 'pw',
      setup: { seed: 4242 },
    });
    await bob.table.join(code, 'pw');

    const expected = fingerprint(buildScenario('bi-planetary', { seed: 4242 }));
    expect(fingerprint(alice.session.state)).toBe(expected);
    expect(fingerprint(bob.session.state)).toBe(expected);
    expect(bob.session.state.scenarioId).toBe('bi-planetary');
  });

  it('carries a campaign order to every browser at the table', async () => {
    // A contested transfer from the campaign: the order rides in the frozen
    // setup, so a joiner rebuilds the order's battle — hulls, freight and
    // terms — not the scenario's printed default.
    const order: OrderOfBattle = {
      battleId: 'b1-mars-space',
      seed: 7,
      scenarioId: 'contested-transfer',
      sides: [
        {
          player: 'combine',
          faction: 'North American Combine',
          forces: { transport: 1, corvette: 1, freight: 3 },
        },
        { player: 'paneuro', faction: 'Paneuropean Federation', forces: { corvette: 2 } },
      ],
      terms: { origin: 'terra', target: 'mars', turnLimit: 20, cargoLots: 3 },
    };
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({
      scenarioId: 'contested-transfer',
      password: 'pw',
      setup: { order },
    });
    await bob.table.join(code, 'pw');

    const expected = fingerprint(buildScenario('contested-transfer', { order }));
    expect(fingerprint(alice.session.state)).toBe(expected);
    expect(fingerprint(bob.session.state)).toBe(expected);
    // Both boards carry the order itself, which is what the result reader
    // needs at whichever browser ends up reporting the battle home.
    expect(bob.session.state.scenarioData['order']).toEqual(order);
  });

  it('seats the host in their own table', async () => {
    // Opening a table does not seat you — the database has no idea who asked.
    // A host left standing can watch their own game and give no orders, which
    // is what "You are not sitting at this table" was reporting.
    const alice = player('Alice');
    await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    expect(alice.table.seat).not.toBeNull();
    expect(alice.session.state.playerOrder).toContain(alice.table.seat);
  });

  it('gives a joiner the next free chair, not the host’s', async () => {
    // A two-sided scenario, necessarily: flight-school seats one, so there the
    // right answer for a second player really is "no chair".
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({ scenarioId: 'bi-planetary', password: 'pw' });
    await bob.table.join(code, 'pw');
    const took = await bob.table.sitAnywhere();

    expect(took).not.toBeNull();
    expect(took).not.toBe(alice.table.seat);
  });

  it('says so plainly when every side is taken', async () => {
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    await bob.table.join(code, 'pw');
    // One seat, and the host is in it.
    expect(await bob.table.sitAnywhere()).toBeNull();
  });

  it('lets the host actually give an order once seated', async () => {
    const alice = player('Alice');
    let refused = '';
    const client = new QuickTable(backend(), alice.session, {
      onRefused: (r) => {
        refused = r;
      },
    });
    await client.host({ scenarioId: 'flight-school', password: 'pw' });
    const ok = await client.send({ type: 'endPhase', by: client.seat! });
    expect(refused).toBe('');
    expect(ok).toBe(true);
  });

  it('refuses the wrong password, in words a player can read', async () => {
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    await expect(bob.table.join(code, 'nope')).rejects.toThrow(/password does not open/i);
  });

  it('shows a hosted table in the browser, and hides an unlisted one', async () => {
    const alice = player('Alice');
    await alice.table.host({ scenarioId: 'flight-school', password: 'pw', name: 'open house' });
    await alice.table.host({ scenarioId: 'flight-school', password: 'pw', listed: false });
    const listed = await alice.table.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe('open house');
  });

  it('will not host a fogged scenario, and says why', async () => {
    const alice = player('Alice');
    await expect(
      alice.table.host({
        scenarioId: 'escape',
        password: 'pw',
        setup: { options: { fogOfWar: true } },
      }),
    ).rejects.toThrow(/refereed mode/i);
  });
});

describe('playing', () => {
  const table = async (): Promise<{
    alice: ReturnType<typeof player>;
    bob: ReturnType<typeof player>;
    code: string;
  }> => {
    const alice = player('Alice');
    const bob = player('Bob');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    await bob.table.join(code, 'pw');
    const seats = alice.session.state.playerOrder;
    await alice.table.sit(seats[0]!);
    if (seats[1] !== undefined) await bob.table.sit(seats[1]);
    return { alice, bob, code };
  };

  it('carries a move from one browser to the other, identically', async () => {
    const { alice, bob } = await table();
    const before = fingerprint(bob.session.state);

    expect(await alice.table.send({ type: 'endPhase', by: alice.table.seat! })).toBe(true);

    // The doorbell. Bob re-reads and applies.
    await bob.table.join(bob.table.table!.code, 'pw');
    expect(fingerprint(bob.session.state)).not.toBe(before);
    expect(fingerprint(bob.session.state)).toBe(fingerprint(alice.session.state));
  });

  it('gives every move a die from the database, not from the browser', async () => {
    const { alice, code } = await table();
    await alice.table.send({ type: 'endPhase', by: alice.table.seat! });
    const rows = await db.query<{ die: string }>('select die from tri_moves where code = $1', [
      code,
    ]);
    const die = Number(rows.rows[0]?.die);
    expect(Number.isInteger(die)).toBe(true);
    expect(die).toBeGreaterThan(0);
    // The client never had this number before it asked.
    expect(die).toBeLessThan(2 ** 32);
  });

  it('refuses to send a move the rules do not allow, without asking the database', async () => {
    // Its own table, because the point is what happens before the network and
    // a contested seat would refuse for the wrong reason.
    const solo = player('Solo');
    let refused = '';
    const client = new QuickTable(backend(), solo.session, {
      onRefused: (r) => {
        refused = r;
      },
    });
    const code = await client.host({ scenarioId: 'flight-school', password: 'pw' });
    const seat = solo.session.state.playerOrder[0]!;
    await client.sit(seat);

    // A ship that is not there cannot burn.
    const ok = await client.send({
      type: 'plotCourse',
      by: seat,
      shipId: 'no-such-ship',
      burn: { q: 1, r: 0 },
    } as never);
    expect(ok).toBe(false);
    expect(refused).not.toBe('');

    // And nothing reached the table.
    const rows = await db.query<{ n: string }>(
      'select count(*) as n from tri_moves where code = $1',
      [code],
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('will not let a browser play a side it is not sitting in', async () => {
    const { alice, bob } = await table();
    const alices = alice.table.seat!;
    // Bob holds his own seat, and signs an order as Alice.
    await expect(
      backend().rpc('tri_play', {
        p_code: bob.table.table!.code,
        p_password: 'pw',
        p_seat: alices,
        p_key: 'bobs-key',
        p_cmd: { type: 'endPhase', by: alices },
        p_after: 0,
      }),
    ).resolves.toMatchObject({ error: { message: expect.stringMatching(/not your side/i) } });
  });

  it('turns a lost race into a catch-up rather than a wrong board', async () => {
    const { alice, bob } = await table();
    // Both believe the log is empty. Alice gets there first.
    await alice.table.send({ type: 'endPhase', by: alice.table.seat! });

    let told = '';
    const racer = new QuickTable(
      backend(),
      bob.session,
      {
        onRefused: (r) => {
          told = r;
        },
      },
      'Bob',
    );
    await racer.join(bob.table.table!.code, 'pw');
    // racer is now current, so force it to look stale by replaying the same
    // index the way a browser that had not heard yet would.
    const answer = await backend().rpc('tri_play', {
      p_code: bob.table.table!.code,
      p_password: 'pw',
      p_seat: alice.table.seat!,
      p_key: 'whatever',
      p_cmd: { type: 'endPhase', by: alice.table.seat! },
      p_after: 0,
    });
    // Refused for the seat before the index is even considered — which is the
    // stronger of the two refusals, and the right order to apply them in.
    expect(answer.error?.message).toMatch(/not your side/i);
    expect(told).toBe('');
  });

  it('undoes back to a chosen point on both sides', async () => {
    const { alice, bob } = await table();
    const seat = alice.table.seat!;
    await alice.table.send({ type: 'endPhase', by: seat });
    await alice.table.send({ type: 'endPhase', by: seat });
    expect(alice.table.index).toBe(2);

    await alice.table.undo(2);
    expect(alice.table.index).toBe(1);

    await bob.table.join(bob.table.table!.code, 'pw');
    expect(fingerprint(bob.session.state)).toBe(fingerprint(alice.session.state));
  });
});

describe('drift', () => {
  it('notices a board that does not match the fingerprint, and rebuilds', async () => {
    const alice = player('Alice');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    const seat = alice.session.state.playerOrder[0]!;
    await alice.table.sit(seat);
    await alice.table.send({ type: 'endPhase', by: seat });

    // Write a fingerprint that cannot be right, the way a client running
    // different rules would have.
    await db.exec(`update tri_moves set hash = 'deadbeef' where code = '${code}'`);

    let drifted = -1;
    const late = player('Late');
    const watcher = new QuickTable(backend(), late.session, {
      onDrift: (i) => {
        drifted = i;
      },
    });
    await watcher.join(code, 'pw');

    expect(drifted).toBe(1);
    // And it still lands on the board the move actually produces, because a
    // rebuild from the scenario is always available.
    expect(fingerprint(late.session.state)).toBe(fingerprint(alice.session.state));
  });

  it('rebuilds from the scenario when moves arrive with a gap', async () => {
    const alice = player('Alice');
    const code = await alice.table.host({ scenarioId: 'flight-school', password: 'pw' });
    const seat = alice.session.state.playerOrder[0]!;
    await alice.table.sit(seat);
    await alice.table.send({ type: 'endPhase', by: seat });
    await alice.table.send({ type: 'endPhase', by: seat });

    const late = player('Late');
    const watcher = new QuickTable(backend(), late.session, {});
    await watcher.join(code, 'pw');
    expect(watcher.index).toBe(2);
    expect(fingerprint(late.session.state)).toBe(fingerprint(alice.session.state));
  });
});

describe('the fingerprint itself', () => {
  it('is the same for the same board and different for a moved ship', () => {
    const a = buildScenario('flight-school', { seed: 7 });
    const b = buildScenario('flight-school', { seed: 7 });
    expect(fingerprint(a)).toBe(fingerprint(b));

    const id = Object.keys(a.ships)[0]!;
    const ship = a.ships[id]!;
    const moved = {
      ...a,
      ships: { ...a.ships, [id]: { ...ship, pos: { q: ship.pos.q + 1, r: ship.pos.r } } },
    };
    expect(fingerprint(moved)).not.toBe(fingerprint(a));
  });

  it('ignores the generator, which is sealed and carries no board state', () => {
    const a = buildScenario('flight-school', { seed: 7 });
    expect(fingerprint({ ...a, rng: { seed: 999 } })).toBe(fingerprint(a));
  });
});
