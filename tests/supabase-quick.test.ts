/**
 * The quick table's schema, run and attacked in real PostgreSQL.
 *
 * `supabase/quick/schema.sql` is a file somebody pastes into a dashboard and
 * runs once, which means nothing about it is exercised by the game's own build
 * — no typechecker reads it, no bundler resolves it, and the first time it
 * executes is on a stranger's project. So it executes here instead, in PGlite,
 * exactly as pasted, and then the things it claims are tried against it.
 *
 * The claims worth trying, from the file's own header:
 *
 *  - the password is the gate, and the hash never leaves the database;
 *  - a seat is held by a per-browser key, so the password gets you to the
 *    table and not into somebody else's chair;
 *  - fogged setups are refused, because the move list would give them away;
 *  - the dice are drawn by Postgres, never supplied by the caller;
 *  - the move feed is readable and everything else is not.
 *
 * `pgcrypto` arrives as a PGlite contrib extension. The dashboard gets it from
 * Supabase; the file's own `create extension` block handles both.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../supabase/quick/schema.sql', import.meta.url)),
  'utf8',
);

let db: PGlite;

/** The open-information setup a host would send. */
const SETUP = {
  seed: 20250824,
  options: { fogOfWar: false },
  fleets: {},
};

interface Attempt {
  readonly rows: Record<string, unknown>[];
  readonly error: string | null;
}

/**
 * Run as a client role, the way PostgREST would.
 *
 * `set local role` inside a transaction, so row level security and the
 * function grants apply exactly as they do to a browser holding the anon key.
 */
const asClient = async (sql: string, params: readonly unknown[] = []): Promise<Attempt> => {
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.exec("set local role 'anon';");
      const out = await tx.query<Record<string, unknown>>(sql, [...params]);
      return out.rows;
    });
    return { rows: rows ?? [], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
};

const call = async (sql: string, params: readonly unknown[] = []): Promise<unknown> => {
  const out = await asClient(sql, params);
  expect(out.error).toBeNull();
  return Object.values(out.rows[0] ?? {})[0];
};

/** Host a table and return its code. */
const host = async (password = 'hunter2', setup: unknown = SETUP): Promise<string> =>
  String(
    await call('select tri_host($1, $2, $3::jsonb, $4, $5) as code', [
      password,
      'flight-school',
      JSON.stringify(setup),
      'a table',
      true,
    ]),
  );

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  // The roles PostgREST switches into. Supabase ships them; a bare Postgres
  // does not, and the schema file is written for a project that has them.
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

describe('the file itself', () => {
  it('runs as pasted, and again on top of itself', async () => {
    // "Running it again later is safe" is a promise made to somebody who will
    // re-run it to pick up a new feature. Broken, it breaks their project.
    await expect(db.exec(SCHEMA)).resolves.toBeDefined();
  });

  it('offers a client exactly the nine calls the game makes', async () => {
    // `information_schema.routines` lists what the *current role* may execute,
    // so this is the API surface as a browser sees it rather than as the file
    // reads. `tri_roll` is absent on purpose and its absence is the assertion:
    // the dice are drawn inside `tri_play` and are not a call a client makes.
    const out = await asClient(
      `select routine_name from information_schema.routines
        where routine_name like 'tri\\_%' order by routine_name`,
    );
    expect(out.rows.map((r) => r['routine_name'])).toEqual([
      'tri_host',
      'tri_list',
      'tri_open',
      'tri_play',
      'tri_since',
      'tri_sit',
      'tri_stand',
      'tri_sweep',
      'tri_undo',
    ]);
  });

  it('keeps the dice roll out of a client’s reach entirely', async () => {
    const all = await db.query<{ n: string }>(
      `select proname as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and proname = 'tri_roll'`,
    );
    expect(all.rows.map((r) => r.n)).toEqual(['tri_roll']); // it exists...
    const seen = await asClient(
      `select routine_name from information_schema.routines where routine_name = 'tri_roll'`,
    );
    expect(seen.rows).toEqual([]); // ...and a client cannot see or call it.
  });
});

describe('hosting and joining', () => {
  it('gives a six-character code a person can read out', async () => {
    const code = await host();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    // No I, O, U or 0/1 — the characters that get misheard or mistyped.
    expect(code).not.toMatch(/[IOU01]/);
  });

  it('opens with the password and hands back the setup', async () => {
    const code = await host();
    const table = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      scenarioId: string;
      setup: typeof SETUP;
      moves: unknown[];
    };
    expect(table.scenarioId).toBe('flight-school');
    expect(table.setup.seed).toBe(SETUP.seed);
    expect(table.moves).toEqual([]);
  });

  it('refuses the wrong password', async () => {
    const code = await host();
    const out = await asClient('select tri_open($1, $2)', [code, 'wrong']);
    expect(out.error).toMatch(/password does not open/i);
  });

  it('refuses a code that does not exist, the same way', async () => {
    const out = await asClient('select tri_open($1, $2)', ['ZZZZZZ', 'hunter2']);
    expect(out.error).toMatch(/No table with that code/i);
  });

  it('refuses a table with no password', async () => {
    const out = await asClient('select tri_host($1, $2, $3::jsonb)', [
      '',
      'flight-school',
      JSON.stringify(SETUP),
    ]);
    expect(out.error).toMatch(/needs a password/i);
  });

  it('accepts a lowercase code, because people type it that way', async () => {
    const code = await host();
    const out = await asClient('select tri_open($1, $2)', [code.toLowerCase(), 'hunter2']);
    expect(out.error).toBeNull();
  });
});

describe('fog of war is refused, not half-kept', () => {
  it('turns away a fogged setup with a reason', async () => {
    const out = await asClient('select tri_host($1, $2, $3::jsonb)', [
      'hunter2',
      'escape',
      JSON.stringify({ ...SETUP, options: { fogOfWar: true } }),
    ]);
    expect(out.error).toMatch(/refereed mode/i);
  });

  it('still allows the same scenario with fog off', async () => {
    const out = await asClient('select tri_host($1, $2, $3::jsonb)', [
      'hunter2',
      'escape',
      JSON.stringify({ ...SETUP, options: { fogOfWar: false } }),
    ]);
    expect(out.error).toBeNull();
  });
});

describe('seats', () => {
  it('lets a browser take a side and keeps its key out of the reply', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    const table = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      seats: Record<string, Record<string, unknown>>;
    };
    expect(table.seats['p1']?.['name']).toBe('Alice');
    // The key is the whole seat security model. It must not come back out.
    expect(JSON.stringify(table.seats)).not.toContain('key-alice');
  });

  it('refuses a side somebody else is sitting in', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    const out = await asClient('select tri_sit($1, $2, $3, $4, $5)', [
      code,
      'hunter2',
      'p1',
      'key-bob',
      'Bob',
    ]);
    expect(out.error).toMatch(/somebody else is playing/i);
  });

  it('gives a chair back after five minutes of silence', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    await db.exec(`update tri_tables
                      set seats = jsonb_set(seats, '{p1,at}', to_jsonb(now() - interval '10 minutes'))`);
    const out = await asClient('select tri_sit($1, $2, $3, $4, $5)', [
      code,
      'hunter2',
      'p1',
      'key-bob',
      'Bob',
    ]);
    expect(out.error).toBeNull();
  });

  it('one browser, one seat — taking a second gives up the first', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p2', 'key-alice', 'Alice']);
    const table = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      seats: Record<string, unknown>;
    };
    expect(Object.keys(table.seats)).toEqual(['p2']);
  });

  it('lets a seat be given up on purpose', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    await call('select tri_stand($1, $2, $3)', [code, 'hunter2', 'key-alice']);
    const table = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      seats: Record<string, unknown>;
    };
    expect(Object.keys(table.seats)).toEqual([]);
  });
});

describe('playing', () => {
  const seated = async (): Promise<string> => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    return code;
  };

  const play = (code: string, after: number, key = 'key-alice', seat = 'p1', by = seat) =>
    asClient('select tri_play($1, $2, $3, $4, $5::jsonb, $6) as r', [
      code,
      'hunter2',
      seat,
      key,
      JSON.stringify({ type: 'endPhase', by }),
      after,
    ]);

  it('accepts an order and numbers it from one', async () => {
    const code = await seated();
    const out = await play(code, 0);
    expect(out.error).toBeNull();
    expect((out.rows[0]?.['r'] as { ok: boolean; index: number }).index).toBe(1);
  });

  it('rolls the die itself, and does not take one from the caller', async () => {
    const code = await seated();
    // There is no parameter for it — the signature is the guarantee.
    const args = await asClient(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where p.proname = 'tri_play' and n.nspname = 'public'`,
    );
    expect(String(args.rows[0]?.['args'])).not.toMatch(/\bdie\b/);

    const r = (await play(code, 0)).rows[0]?.['r'] as { die: number };
    expect(Number.isInteger(r.die)).toBe(true);
    expect(r.die).toBeGreaterThanOrEqual(0);
    expect(r.die).toBeLessThan(2 ** 32);
  });

  it('draws a different die each time', async () => {
    const code = await seated();
    const dice = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      dice.add(((await play(code, i)).rows[0]?.['r'] as { die: number }).die);
    }
    // Twelve draws from 2^32 colliding would be a broken generator, not luck.
    expect(dice.size).toBe(12);
  });

  it('refuses an order for a seat the caller does not hold', async () => {
    const code = await seated();
    const out = await play(code, 0, 'key-mallory');
    expect(out.error).toMatch(/not your side/i);
  });

  it('refuses an order signed by another side', async () => {
    const code = await seated();
    // Holding p1 legitimately, but the order claims to come from p2 — the one
    // check a plain relay cannot make.
    const out = await play(code, 0, 'key-alice', 'p1', 'p2');
    expect(out.error).toMatch(/signed by another side/i);
  });

  it('refuses a second order racing the first, instead of interleaving', async () => {
    const code = await seated();
    await play(code, 0);
    const out = await play(code, 0);
    expect(out.error).toBeNull();
    const r = out.rows[0]?.['r'] as { ok: boolean; reason: string; index: number };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('behind');
    expect(r.index).toBe(1);
  });

  it('hands the log back in order, with its dice', async () => {
    const code = await seated();
    await play(code, 0);
    await play(code, 1);
    const table = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      moves: { idx: number; die: number; seat: string }[];
    };
    expect(table.moves.map((m) => m.idx)).toEqual([1, 2]);
    expect(table.moves.every((m) => typeof m.die === 'number')).toBe(true);
  });

  it('catches a client up from where it left off', async () => {
    const code = await seated();
    await play(code, 0);
    await play(code, 1);
    const since = (await call('select tri_since($1, $2, $3) as m', [code, 'hunter2', 1])) as {
      idx: number;
    }[];
    expect(since.map((m) => m.idx)).toEqual([2]);
  });

  it('takes moves back', async () => {
    const code = await seated();
    await play(code, 0);
    await play(code, 1);
    const left = await call('select tri_undo($1, $2, $3) as n', [code, 'hunter2', 2]);
    expect(Number(left)).toBe(1);
  });
});

describe('what a client can reach directly', () => {
  it('cannot read the table row, and so cannot read the password hash', async () => {
    await host();
    const out = await asClient('select * from tri_tables');
    // Either refused outright or filtered to nothing by row level security.
    expect(out.error !== null || out.rows.length === 0).toBe(true);
    expect(JSON.stringify(out.rows)).not.toContain('$2a$');
  });

  it('cannot write a move directly, bypassing the seat check', async () => {
    const code = await host();
    const out = await asClient(
      `insert into tri_moves (code, idx, seat, cmd, die) values ($1, 1, 'p1', '{}'::jsonb, 7)`,
      [code],
    );
    expect(out.error).not.toBeNull();
  });

  it('cannot rewrite a move that has been made', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    await call('select tri_play($1, $2, $3, $4, $5::jsonb, $6)', [
      code,
      'hunter2',
      'p1',
      'key-alice',
      JSON.stringify({ type: 'endPhase', by: 'p1' }),
      0,
    ]);
    const out = await asClient(`update tri_moves set die = 1 where code = $1`, [code]);
    expect(out.error).not.toBeNull();
  });

  it('cannot roll a die on its own', async () => {
    // Not because a random number is precious, but because the grant list is
    // the API surface, and tri_roll is not part of it.
    const out = await asClient('select tri_roll()');
    expect(out.error).toMatch(/permission denied/i);
  });

  it('can read the move feed, which is what Realtime needs', async () => {
    // Stated in the file's header rather than hidden: this is readable, and
    // fogged setups are refused precisely because of it.
    const out = await asClient('select code, idx from tri_moves');
    expect(out.error).toBeNull();
  });

  it('lists public tables without leaking a setup or a hash', async () => {
    await host();
    const listed = (await call('select tri_list(10) as l')) as Record<string, unknown>[];
    expect(listed.length).toBe(1);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'code',
      // Which game it is: a browser choosing a table has to know before it
      // joins, because the two games are not the same download.
      'kind',
      'name',
      'scenarioId',
      'seats',
      'turn',
      'updatedAt',
    ]);
  });

  it('keeps an unlisted table out of the browser', async () => {
    await call('select tri_host($1, $2, $3::jsonb, $4, $5)', [
      'hunter2',
      'flight-school',
      JSON.stringify(SETUP),
      'quiet',
      false,
    ]);
    expect((await call('select tri_list(10) as l')) as unknown[]).toEqual([]);
  });
});

describe('housekeeping', () => {
  it('sweeps tables nobody has touched, and spares the rest', async () => {
    const old = await host();
    const fresh = await host();
    await db.exec(
      `update tri_tables set updated_at = now() - interval '90 days' where code = '${old}'`,
    );
    expect(Number(await call('select tri_sweep(30) as n'))).toBe(1);
    const left = await asClient('select tri_list(10) as l');
    expect(JSON.stringify(left.rows)).toContain(fresh);
    expect(JSON.stringify(left.rows)).not.toContain(old);
  });

  it('takes a swept table’s moves with it', async () => {
    const code = await host();
    await call('select tri_sit($1, $2, $3, $4, $5)', [code, 'hunter2', 'p1', 'key-alice', 'Alice']);
    await call('select tri_play($1, $2, $3, $4, $5::jsonb, $6)', [
      code,
      'hunter2',
      'p1',
      'key-alice',
      JSON.stringify({ type: 'endPhase', by: 'p1' }),
      0,
    ]);
    await db.exec(`update tri_tables set updated_at = now() - interval '90 days'`);
    await call('select tri_sweep(30) as n');
    const left = await asClient('select count(*) as n from tri_moves');
    expect(Number(left.rows[0]?.['n'])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Two games, and a code a browser worked out for itself
// ---------------------------------------------------------------------------

describe('both games at a quick table', () => {
  /** Straight at the table, as the owner rather than the browser. */
  const rows = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await db.query<Record<string, unknown>>(sql)).rows;

  const hostKind = async (kind: string, code: string | null = null): Promise<Attempt> =>
    asClient('select tri_host($1, $2, $3::jsonb, $4, $5, $6, $7) as code', [
      'hunter2',
      kind === 'ogre' ? 'mark-iii-attack' : 'flight-school',
      JSON.stringify({ seed: 7 }),
      'a table',
      true,
      kind,
      code,
    ]);

  it('opens a table of the ground game and says so when it is opened', async () => {
    const made = await hostKind('ogre');
    expect(made.error).toBeNull();
    const code = String(Object.values(made.rows[0] ?? {})[0]);
    const opened = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      kind: string;
      scenarioId: string;
    };
    expect(opened.kind).toBe('ogre');
    expect(opened.scenarioId).toBe('mark-iii-attack');
  });

  it('calls a table opened without a kind the fleet game, as every old row is', async () => {
    const code = await host();
    const opened = (await call('select tri_open($1, $2) as t', [code, 'hunter2'])) as {
      kind: string;
    };
    expect(opened.kind).toBe('tri');
    expect(await rows(`select kind from tri_tables where code = '${code}'`)).toEqual([
      { kind: 'tri' },
    ]);
  });

  it('refuses a game it does not carry', async () => {
    const made = await hostKind('chess');
    expect(made.error).toMatch(/no game by that name/i);
  });

  it('opens a table under a code the caller worked out', async () => {
    const made = await hostKind('ogre', 'FGKMNP');
    expect(made.error).toBeNull();
    expect(String(Object.values(made.rows[0] ?? {})[0])).toBe('FGKMNP');
  });

  it('says the code is taken rather than opening a second table on it', async () => {
    await hostKind('ogre', 'FGKMNP');
    const again = await hostKind('ogre', 'FGKMNP');
    expect(again.error).toMatch(/code-taken/);
    expect(await rows('select count(*)::int as n from tri_tables')).toEqual([{ n: 1 }]);
  });

  it('still refuses a fogged setup, whichever game asks', async () => {
    const fogged = await asClient('select tri_host($1, $2, $3::jsonb, $4, $5, $6, $7) as code', [
      'hunter2',
      'escape',
      JSON.stringify({ options: { fogOfWar: true } }),
      '',
      true,
      'tri',
      null,
    ]);
    expect(fogged.error).toMatch(/fog of war/i);
  });
});
