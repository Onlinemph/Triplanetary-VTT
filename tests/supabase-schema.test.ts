/**
 * The database, attacked.
 *
 * Row level security is the kind of thing that reads correctly and is wrong.
 * A policy that quietly matches no rows looks exactly like a policy that works
 * until somebody sits down at a table and sees nothing; a policy that quietly
 * matches every row looks exactly like a policy that works until somebody reads
 * the seed. Neither failure shows up in a typecheck, and neither shows up in
 * SQL review as reliably as it shows up here.
 *
 * So these tests boot a real PostgreSQL — PGlite, which is the actual server
 * compiled to WebAssembly, roles and policies and all — run the migration files
 * from disk, and then behave like a player who has read the schema and would
 * like the other side's fleet positions. Each case is named after the attack it
 * fails to carry out.
 *
 * ## What is faked, exactly
 *
 * Nothing in the migrations is rewritten, filtered or skipped: the files are
 * read as bytes and executed as they are, and {@link HARNESS_SQL} adds only the
 * three things a Supabase project already has when a migration reaches it —
 * the `anon`/`authenticated`/`service_role` roles, the `auth` schema, and
 * `auth.uid()`. Two of the cases below assert that, so a future migration that
 * needs a stripped-out statement to pass cannot pretend it was tested.
 *
 * ## What this cannot prove
 *
 * PostgREST and Realtime are not here. This proves what the database will
 * answer; it does not prove what Realtime asks it. See the notes on the
 * publication case.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// ---------------------------------------------------------------------------
// The bit of Supabase that is not in the migrations
// ---------------------------------------------------------------------------

/**
 * Everything a Supabase database has before the first migration runs.
 *
 * `auth.uid()` is copied from Supabase's own definition rather than simplified,
 * because the fail-closed behaviour the policies lean on lives in it: with no
 * JWT the setting is absent, `nullif` turns the empty string into null, and the
 * cast of null is null. A policy comparing a seat to null matches nothing,
 * which is the behaviour several cases below rely on.
 *
 * `service_role` is created with `bypassrls` because that is how Supabase
 * creates it — the referee is outside row level security by design, and a test
 * suite where it is not would be testing a different system.
 */
const HARNESS_SQL = `
  create role anon          nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role  nologin noinherit bypassrls;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid;
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

/**
 * Every migration, in order, discovered rather than listed.
 *
 * Listing them meant the next one was untested by default, which is the wrong
 * default for the file that decides who may read the board. A migration added
 * to the directory is a migration this suite runs.
 */
const MIGRATIONS = readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const migrationText = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

const ALICE = '0a11ce00-0000-4000-8000-000000000001'; // seat p1, fog game
const BOB = '0b0b0000-0000-4000-8000-000000000002'; // seat p2, fog game
const CAROL = '0ca7c000-0000-4000-8000-000000000003'; // seat p1, open game
const DAVE = '0da7e000-0000-4000-8000-000000000004'; // seat p2, open game

/**
 * Signed in, seated nowhere.
 *
 * A spectator and an outside attacker are the same account to the database, and
 * that is not an oversight — a spectator is served by the Edge Function, which
 * decides what a seatless viewer may see by calling `viewFor(game, null)`. The
 * database's answer to both is the same: no rows.
 */
const SPECTATOR = '5bec7a70-0000-4000-8000-000000000005';

const FOG = '9f0f9a11-0000-4000-8000-00000000000f';
const OPEN = '90fe1000-0000-4000-8000-0000000000e0';

/** The canary in `game_secrets.state`. If a test ever sees this, stop shipping. */
const WHOLE_BOARD = 'every undetected ship on the map';

const SEED_SQL = `
  insert into public.games (id, code, scenario_id, fog, status, turn, host_id) values
    ('${FOG}',  'FGKM24', 'escape',       true,  'playing', 3, '${ALICE}'),
    ('${OPEN}', 'PNTR39', 'bi-planetary', false, 'playing', 2, '${CAROL}');

  insert into public.game_secrets (game_id, seed, state) values
    ('${FOG}',  424242, '{"canary":"${WHOLE_BOARD}","rng":{"seed":0}}'),
    ('${OPEN}', 515151, '{"canary":"${WHOLE_BOARD}","rng":{"seed":0}}');

  insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id) values
    ('${FOG}',  'p1', 0, 'Pilgrims',  'Alice', 'human', '${ALICE}'),
    ('${FOG}',  'p2', 1, 'Enforcers', 'Bob',   'human', '${BOB}'),
    ('${OPEN}', 'p1', 0, 'Terran',    'Carol', 'human', '${CAROL}'),
    ('${OPEN}', 'p2', 1, 'Martian',   'Dave',  'human', '${DAVE}');

  insert into public.commands (game_id, idx, by, cmd, die) values
    ('${FOG}',  1, 'p1', '{"type":"endPhase","by":"p1"}', 111),
    ('${FOG}',  2, 'p2', '{"type":"endPhase","by":"p2"}', 222),
    ('${OPEN}', 1, 'p1', '{"type":"endPhase","by":"p1"}', 333),
    ('${OPEN}', 2, 'p2', '{"type":"endPhase","by":"p2"}', 444);

  insert into public.views (game_id, seat, idx, state) values
    ('${FOG}', 'p1', 2, '{"onlyFor":"p1"}'),
    ('${FOG}', 'p2', 2, '{"onlyFor":"p2"}');
`;

// ---------------------------------------------------------------------------
// Driving the database as somebody
// ---------------------------------------------------------------------------

type Role = 'anon' | 'authenticated' | 'service_role';

interface Attempt {
  readonly rows: readonly Record<string, unknown>[];
  readonly error: string | null;
}

/** Zero rows or a refusal. Both are a denial; which one depends on the layer. */
const denied = (a: Attempt): boolean => a.error !== null || a.rows.length === 0;

/**
 * PostgreSQL's two wire protocols disagree about `bigint`, so flatten it here.
 *
 * The extended protocol hands back a JavaScript `BigInt` and the simple one a
 * `number`, and this suite uses both — one carries parameters, the other
 * carries more than one statement. Which protocol a case happens to use is not
 * a thing any expectation below should have an opinion about.
 */
const plain = (rows: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
    ),
  );

let db: PGlite;
const executed = new Map<string, string>();

/**
 * Run one statement wearing somebody's role and somebody's JWT.
 *
 * `set local role` and `set_config(..., true)` are both transaction-scoped, so
 * the identity cannot outlive the statement and leak into the next case. This
 * is how PostgREST does it too, which is the point: the policies are evaluated
 * against exactly the settings production supplies.
 */
const attempt = async (
  role: Role,
  sub: string | null,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Attempt> => {
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      // The extended protocol carries parameters but refuses more than one
      // statement; the simple one is the other way round. Several cases here
      // need a multi-statement body to reach a state a single statement cannot.
      if (params.length > 0) {
        return (await tx.query<Record<string, unknown>>(sql, [...params])).rows;
      }
      const results = await tx.exec(sql);
      return (results[results.length - 1]?.rows ?? []) as Record<string, unknown>[];
    });
    return { rows: plain(rows ?? []), error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
};

/** As above, for the referee. It bypasses row level security, as it must. */
const asReferee = (sql: string, params: readonly unknown[] = []): Promise<Attempt> =>
  attempt('service_role', null, sql, params);

const rowsFor = async (
  sub: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> => {
  const out = await attempt('authenticated', sub, sql, params);
  expect(out.error).toBeNull();
  return out.rows;
};

// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(HARNESS_SQL);
  for (const name of MIGRATIONS) {
    const sql = migrationText(name);
    executed.set(name, sql);
    await db.exec(sql);
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // `truncate` skips per-row triggers, which is the only way to clear a log
  // that is append-only on purpose.
  await db.exec('truncate table public.games cascade;');
  const seeded = await asReferee(`${SEED_SQL} select 1 as ok`);
  expect(seeded.error).toBeNull();
});

// ---------------------------------------------------------------------------
// What this suite is actually running
// ---------------------------------------------------------------------------

describe('the harness', () => {
  it('runs the migration files byte for byte, stripping nothing', () => {
    // If this fails, every other case below is testing a schema that does not
    // exist on disk, which is worse than having no tests at all.
    for (const name of MIGRATIONS) {
      expect({ name, verbatim: executed.get(name) === migrationText(name) }).toEqual({
        name,
        verbatim: true,
      });
    }
  });

  it('fakes only the roles and auth.uid(), and touches none of the schema', () => {
    // The preamble is allowed to supply what Supabase supplies. The moment it
    // starts supplying a grant or a policy, the suite is grading its own paper.
    expect(HARNESS_SQL).not.toMatch(/\b(games|game_secrets|seats|commands|views|policy)\b/i);
    expect(HARNESS_SQL).toMatch(/create role service_role[^;]*bypassrls/);
  });
});

// ---------------------------------------------------------------------------
// game_secrets: the seed and the whole board
// ---------------------------------------------------------------------------

describe('attack: read game_secrets', () => {
  it('is refused to the player who created the game', async () => {
    // Being the host buys nothing. Alice opened this table and still may not
    // read the board it is played on.
    const out = await attempt('authenticated', ALICE, 'select * from public.game_secrets');
    expect({ denied: denied(out), rows: out.rows.length }).toEqual({ denied: true, rows: 0 });
  });

  it('is refused when asked for one column of one row', async () => {
    // The interesting columns by name, in case a policy was written per-row and
    // a grant was left per-table.
    for (const column of ['seed', 'state', 'fleets', 'options']) {
      const out = await attempt(
        'authenticated',
        BOB,
        `select ${column} from public.game_secrets where game_id = $1`,
        [FOG],
      );
      expect({ column, denied: denied(out) }).toEqual({ column, denied: true });
    }
  });

  it('is refused to a spectator and to anonymous callers', async () => {
    for (const [role, sub] of [
      ['authenticated', SPECTATOR],
      ['anon', null],
    ] as const) {
      const out = await attempt(role, sub, 'select count(*) from public.game_secrets');
      expect({ role, denied: denied(out) }).toEqual({ role, denied: true });
    }
  });

  it('does not leak through a join from a table that is readable', async () => {
    // The one shape a row-only policy misses: read the permitted table, drag
    // the forbidden one along behind it.
    const out = await attempt(
      'authenticated',
      ALICE,
      `select s.seed from public.games g join public.game_secrets s on s.game_id = g.id`,
    );
    expect(denied(out)).toBe(true);
  });

  it('cannot be written by a seated player', async () => {
    for (const sql of [
      `insert into public.game_secrets (game_id, seed, state) values ('${OPEN}', 1, '{}')`,
      `update public.game_secrets set seed = 1 where game_id = '${FOG}'`,
      `delete from public.game_secrets where game_id = '${FOG}'`,
    ]) {
      const out = await attempt('authenticated', ALICE, sql);
      expect({ sql, refused: out.error !== null }).toEqual({ sql, refused: true });
    }
    // And the row is still exactly what the referee wrote.
    const after = await asReferee(`select seed from public.game_secrets where game_id = '${FOG}'`);
    expect(after.rows).toEqual([{ seed: 424242 }]);
  });
});

// ---------------------------------------------------------------------------
// views: one seat, one snapshot
// ---------------------------------------------------------------------------

describe('attack: read another seat’s view', () => {
  it('gives a seat its own snapshot and no other', async () => {
    // The whole point of a fog game. Bob asking for everything gets his row;
    // Bob asking for Alice's row by name gets nothing.
    const all = await rowsFor(BOB, 'select seat, state from public.views');
    expect(all).toEqual([{ seat: 'p2', state: { onlyFor: 'p2' } }]);

    const targeted = await attempt(
      'authenticated',
      BOB,
      `select state from public.views where game_id = $1 and seat = 'p1'`,
      [FOG],
    );
    expect({ denied: denied(targeted), rows: targeted.rows }).toEqual({ denied: true, rows: [] });
  });

  it('is refused to a spectator, who holds no seat to match', async () => {
    const out = await attempt('authenticated', SPECTATOR, 'select * from public.views');
    expect(out.rows).toEqual([]);
  });

  it('is refused to a player at another table', async () => {
    // Carol is seated at `p1` of the open game. The fog game also has a `p1`,
    // and a policy keyed on the seat name alone would hand her Alice's board.
    const out = await attempt(
      'authenticated',
      CAROL,
      `select state from public.views where game_id = $1`,
      [FOG],
    );
    expect(out.rows).toEqual([]);
  });

  it('cannot be rewritten by the seat that owns it', async () => {
    // Reading your own view is legitimate; editing it is how you would give
    // yourself a fleet.
    const out = await attempt(
      'authenticated',
      BOB,
      `update public.views set state = '{"cheat":true}' where seat = 'p2'`,
    );
    expect(out.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// commands: the log is the board, when the board is hidden
// ---------------------------------------------------------------------------

describe('attack: read the command log of a fog game', () => {
  it('is refused even to the players sitting at that table', async () => {
    // Not a paranoid extra. Initial position plus the ordered commands replays
    // to the exact board, undetected ships included, so a fog game that streams
    // its log has no fog.
    for (const who of [ALICE, BOB]) {
      const out = await attempt(
        'authenticated',
        who,
        `select idx, cmd, die from public.commands where game_id = $1`,
        [FOG],
      );
      expect({ who, rows: out.rows.length }).toEqual({ who, rows: 0 });
    }
  });

  it('is refused when asked for the dice alone', async () => {
    // `die` is the sealed seed. Reading the log's seeds is reading the log.
    const out = await attempt('authenticated', ALICE, 'select die from public.commands');
    expect(out.rows).toEqual([]);
  });
});

describe('attack: read the command log of somebody else’s open game', () => {
  it('is refused to a player at a different table', async () => {
    const out = await attempt(
      'authenticated',
      ALICE,
      `select * from public.commands where game_id = $1`,
      [OPEN],
    );
    expect(out.rows).toEqual([]);
  });

  it('is refused to a spectator', async () => {
    const out = await attempt('authenticated', SPECTATOR, 'select * from public.commands');
    expect(out.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The log is append-only, for everybody
// ---------------------------------------------------------------------------

describe('attack: write the command log', () => {
  it('is refused to a seated player, who must go through the referee', async () => {
    // "A client may not insert a command; row level security refuses it. That
    //  is what makes `by` mean something."
    const out = await attempt(
      'authenticated',
      CAROL,
      `insert into public.commands (game_id, idx, by, cmd, die)
       values ('${OPEN}', 3, 'p1', '{"type":"endPhase","by":"p1"}', 7)`,
    );
    expect(out.error).not.toBeNull();
  });

  it('is refused to a seated player editing a command already in the log', async () => {
    for (const sql of [
      `update public.commands set die = 0 where game_id = '${OPEN}' and idx = 1`,
      `delete from public.commands where game_id = '${OPEN}'`,
    ]) {
      const out = await attempt('authenticated', CAROL, sql);
      expect({ sql, refused: out.error !== null }).toEqual({ sql, refused: true });
    }
  });

  it('is refused to the referee too, which is the only defence against a rewrite', async () => {
    // The service role bypasses every policy in the schema, so the one thing
    // policies cannot protect is the log against the process that writes it.
    // A trigger binds everybody.
    const update = await asReferee(
      `update public.commands set die = 0 where game_id = '${OPEN}' and idx = 1`,
    );
    const remove = await asReferee(`delete from public.commands where game_id = '${OPEN}'`);
    expect({
      update: update.error?.includes('append-only') ?? false,
      remove: remove.error?.includes('append-only') ?? false,
    }).toEqual({ update: true, remove: true });
  });

  it('still lets a whole game be deleted, log and all', async () => {
    // The append-only trigger must not turn every finished table into a
    // permanent one.
    const gone = await asReferee(`delete from public.games where id = '${OPEN}'`);
    expect(gone.error).toBeNull();
    const left = await asReferee(
      `select (select count(*) from public.commands) as commands,
              (select count(*) from public.seats) as seats,
              (select count(*) from public.game_secrets) as secrets`,
    );
    expect(left.rows).toEqual([{ commands: 2, seats: 2, secrets: 1 }]); // the fog game's
  });
});

// ---------------------------------------------------------------------------
// seats and games: the table you are at, and no other
// ---------------------------------------------------------------------------

describe('attack: reach a table you are not at', () => {
  it('cannot read its games row', async () => {
    const out = await attempt('authenticated', ALICE, `select * from public.games where id = $1`, [
      OPEN,
    ]);
    expect(out.rows).toEqual([]);
  });

  it('cannot find it by its join code', async () => {
    // Membership grants a read, not knowledge. Guessing a six-character code —
    // or reading one off somebody's screen — has to be worth nothing, because
    // the code is printed in the lobby for people to type.
    const out = await attempt(
      'authenticated',
      ALICE,
      `select id, scenario_id from public.games where code = 'PNTR39'`,
    );
    expect(out.rows).toEqual([]);
  });

  it('cannot enumerate tables by asking for all of them', async () => {
    const out = await rowsFor(ALICE, 'select code from public.games order by code');
    expect(out).toEqual([{ code: 'FGKM24' }]);
  });

  it('cannot read its roster', async () => {
    const out = await attempt(
      'authenticated',
      ALICE,
      `select seat, name from public.seats where game_id = $1`,
      [OPEN],
    );
    expect(out.rows).toEqual([]);
  });

  it('cannot use the membership helpers as an oracle', async () => {
    // `seat_at` and `is_seated` are `security definer`, so they read `seats`
    // outside row level security. They are safe only because every answer they
    // give is about the caller.
    const out = await rowsFor(
      ALICE,
      `select public.is_seated($1) as seated, public.seat_at($1) as seat,
              public.is_seated($2) as seated_here, public.seat_at($2) as seat_here`,
      [OPEN, FOG],
    );
    expect(out).toEqual([{ seated: false, seat: null, seated_here: true, seat_here: 'p1' }]);
  });
});

describe('attack: write a seat directly', () => {
  it('cannot take a seat by claiming it in the seats table', async () => {
    // Seating is `takeSeat`, behind the Edge Function, because "a seat with a
    // live holder is not available" is a rule and a row update is not.
    const steal = await attempt(
      'authenticated',
      SPECTATOR,
      `update public.seats set user_id = '${SPECTATOR}' where game_id = '${FOG}' and seat = 'p1'`,
    );
    expect(steal.error).not.toBeNull();

    const still = await asReferee(
      `select user_id from public.seats where game_id = '${FOG}' and seat = 'p1'`,
    );
    expect(still.rows).toEqual([{ user_id: ALICE }]);
  });

  it('cannot hand an opponent’s seat to the computer', async () => {
    // A player who can set `kind = 'computer'` can have the referee play the
    // other side, which is a win condition rather than a data breach.
    const out = await attempt(
      'authenticated',
      ALICE,
      `update public.seats set kind = 'computer', user_id = null
        where game_id = '${FOG}' and seat = 'p2'`,
    );
    expect(out.error).not.toBeNull();
  });

  it('cannot insert itself into a table it has never joined', async () => {
    const out = await attempt(
      'authenticated',
      SPECTATOR,
      `insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id)
       values ('${OPEN}', 'p3', 2, 'Belter', 'Mallory', 'human', '${SPECTATOR}')`,
    );
    expect(out.error).not.toBeNull();
  });

  it('cannot open a game of its own, with a code that collides', async () => {
    const out = await attempt(
      'authenticated',
      SPECTATOR,
      `insert into public.games (code, scenario_id, host_id)
       values ('ZZZZ99', 'escape', '${SPECTATOR}')`,
    );
    expect(out.error).not.toBeNull();
  });

  it('cannot delete the game it is losing', async () => {
    const out = await attempt('authenticated', BOB, `delete from public.games where id = '${FOG}'`);
    expect(out.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Not signed in
// ---------------------------------------------------------------------------

describe('attack: read anything without signing in', () => {
  it('is refused on every table', async () => {
    for (const table of ['games', 'seats', 'commands', 'views', 'game_secrets']) {
      const out = await attempt('anon', null, `select * from public.${table}`);
      expect({ table, refused: out.error !== null }).toEqual({ table, refused: true });
    }
  });

  it('is refused to an authenticated role carrying no subject claim', async () => {
    // The shape of a forged or malformed token: the role is right and the claim
    // is missing. `auth.uid()` is null, so no seat matches and nothing returns.
    for (const table of ['games', 'seats', 'commands', 'views']) {
      const out = await attempt('authenticated', null, `select * from public.${table}`);
      expect({ table, rows: out.rows.length, error: out.error }).toEqual({
        table,
        rows: 0,
        error: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The reads the game actually needs. A schema that denies everything passes
// every case above and is useless.
// ---------------------------------------------------------------------------

describe('the game still works', () => {
  it('lets a seated player read their own table', async () => {
    const rows = await rowsFor(
      ALICE,
      'select code, scenario_id, fog, status, turn from public.games',
    );
    expect(rows).toEqual([
      { code: 'FGKM24', scenario_id: 'escape', fog: true, status: 'playing', turn: 3 },
    ]);
  });

  it('lets a seated player read the whole roster of their own table', async () => {
    // The roster is `TableInfo.seats`, and it needs every seat, not just yours.
    const rows = await rowsFor(BOB, 'select seat, name, kind from public.seats order by ordinal');
    expect(rows).toEqual([
      { seat: 'p1', name: 'Alice', kind: 'human' },
      { seat: 'p2', name: 'Bob', kind: 'human' },
    ]);
  });

  it('lets every seat at an open table replay the log', async () => {
    // This is the transport for an open game. If it fails, nobody sees a move.
    for (const who of [CAROL, DAVE]) {
      const rows = await rowsFor(who, 'select idx, by, die from public.commands order by idx');
      expect({ who, rows }).toEqual({
        who,
        rows: [
          { idx: 1, by: 'p1', die: 333 },
          { idx: 2, by: 'p2', die: 444 },
        ],
      });
    }
  });

  it('lets a fog seat read its own snapshot and the index it reflects', async () => {
    const rows = await rowsFor(ALICE, 'select seat, idx, state from public.views');
    expect(rows).toEqual([{ seat: 'p1', idx: 2, state: { onlyFor: 'p1' } }]);
  });

  it('lets the referee see everything, because it is the referee', async () => {
    const rows = await asReferee(
      `select (select count(*) from public.games) as games,
              (select count(*) from public.game_secrets) as secrets,
              (select count(*) from public.commands) as commands,
              (select count(*) from public.views) as views`,
    );
    expect(rows.rows).toEqual([{ games: 2, secrets: 2, commands: 4, views: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// The schema's own posture, checked rather than assumed
// ---------------------------------------------------------------------------

describe('the schema’s posture', () => {
  it('has row level security on every table in public', async () => {
    // Written as a scan rather than a list so it also fails for the next table
    // somebody adds. A table with row level security off is world-readable
    // through PostgREST the moment the default grants apply.
    const out = await asReferee(`
      select c.relname as table, c.relrowsecurity as rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname
    `);
    expect(out.rows).toEqual([
      { table: 'commands', rls: true },
      { table: 'game_secrets', rls: true },
      { table: 'games', rls: true },
      { table: 'join_attempts', rls: true },
      { table: 'seats', rls: true },
      { table: 'views', rls: true },
    ]);
  });

  it('grants clients SELECT and nothing else, and grants anon nothing at all', async () => {
    // Supabase's defaults hand `anon` and `authenticated` full DML on new
    // tables in `public`. Policies filter rows within a grant; they cannot take
    // a grant away. If this list ever grows an INSERT, the policies stop being
    // the last word.
    // Read straight out of `relacl` rather than `information_schema`, whose
    // grant views hide rows the current role is not party to and would report
    // an empty, reassuring nothing.
    const out = await asReferee(`
      select r.rolname as grantee, c.relname as "table", a.privilege_type as priv
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
        join pg_roles r on r.oid = a.grantee
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and r.rolname in ('anon', 'authenticated')
       order by r.rolname, c.relname, a.privilege_type
    `);
    expect(out.rows).toEqual([
      { grantee: 'authenticated', table: 'commands', priv: 'SELECT' },
      { grantee: 'authenticated', table: 'games', priv: 'SELECT' },
      { grantee: 'authenticated', table: 'seats', priv: 'SELECT' },
      { grantee: 'authenticated', table: 'views', priv: 'SELECT' },
    ]);
  });

  it('has no policy that permits a write', async () => {
    const out = await asReferee(`
      select tablename as "table", policyname as policy, cmd, roles::text, qual, with_check
        from pg_policies where schemaname = 'public' and cmd <> 'SELECT'
       order by tablename, policyname
    `);
    // The one non-SELECT policy is the explicit refusal on game_secrets.
    expect(out.rows).toEqual([
      {
        table: 'game_secrets',
        policy: 'game_secrets_nobody',
        cmd: 'ALL',
        roles: '{anon,authenticated}',
        qual: 'false',
        with_check: 'false',
      },
    ]);
  });

  it('streams the four tables a client subscribes to, and not the secrets', async () => {
    // A row reaches a subscriber only if the publication carries the table AND
    // row level security lets that subscriber select the row. This proves the
    // first half. The second half is every case above.
    const out = await asReferee(`
      select tablename as "table" from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
       order by tablename
    `);
    expect(out.rows).toEqual([
      { table: 'commands' },
      { table: 'games' },
      { table: 'seats' },
      { table: 'views' },
    ]);
  });

  it('leaves replica identity at the primary key on the tables it streams', async () => {
    // `views` is rewritten in place and `full` is the tempting answer. Logical
    // decoding already emits the complete new tuple for an update — replica
    // identity governs the old one — so `full` would only put a second copy of
    // a whole redacted board into the WAL on every command.
    const out = await asReferee(`
      select c.relname as "table", c.relreplident as identity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname
    `);
    expect(out.rows).toEqual([
      { table: 'commands', identity: 'd' },
      { table: 'game_secrets', identity: 'd' },
      { table: 'games', identity: 'd' },
      { table: 'join_attempts', identity: 'd' },
      { table: 'seats', identity: 'd' },
      { table: 'views', identity: 'd' },
    ]);
  });

  it('pins the search path of every security definer function', async () => {
    // A `security definer` function without a pinned search path can be aimed
    // at a table the caller created. Every one of these runs as the owner and
    // touches a table the caller could shadow, so an unpinned one would hand out
    // any answer the caller likes. Written as a scan for the same reason as the
    // row-level-security one above: it must fail for the next helper added.
    const out = await asReferee(`
      select p.proname as fn, coalesce(p.proconfig::text, '') as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
       order by p.proname
    `);
    const pinned = '{"search_path=\\"\\""}';
    // Every function, not only the `security definer` ones. The definer ones
    // are the dangerous ones, but a scan that only looked at those would pass
    // the day somebody adds an unpinned helper and makes it a definer later.
    expect(out.rows.filter((r) => r['config'] !== pinned)).toEqual([]);
    expect(out.rows.length).toBeGreaterThanOrEqual(9);
  });

  it('does not leave the security definer helpers executable by the world', async () => {
    const out = await attempt('anon', null, `select public.is_seated('${FOG}')`);
    expect(out.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constraints the referee's correctness rests on
// ---------------------------------------------------------------------------

describe('constraints the referee relies on', () => {
  it('refuses a command index that skips a slot', async () => {
    // `LoggedCommand.idx` is "gapless, and the game's canonical order". Replay
    // is only exact if that holds, and a hole in the log is silent otherwise.
    const gap = await asReferee(
      `insert into public.commands (game_id, idx, by, cmd, die)
       values ('${OPEN}', 4, 'p1', '{"type":"endPhase","by":"p1"}', 9)`,
    );
    expect(gap.error).toMatch(/expects index 3/);

    const next = await asReferee(
      `insert into public.commands (game_id, idx, by, cmd, die)
       values ('${OPEN}', 3, 'p1', '{"type":"endPhase","by":"p1"}', 9)`,
    );
    expect(next.error).toBeNull();
  });

  it('keeps games.command_count equal to the length of the log', async () => {
    // Two places that both remember how long the log is will eventually
    // disagree, and a client trusting the stale one thinks it is caught up.
    const before = await asReferee(`select command_count from public.games where id = '${OPEN}'`);
    expect(before.rows).toEqual([{ command_count: 2 }]);

    await asReferee(
      `insert into public.commands (game_id, idx, by, cmd, die)
       values ('${OPEN}', 3, 'p2', '{"type":"endPhase","by":"p2"}', 9)`,
    );
    const after = await asReferee(`select command_count from public.games where id = '${OPEN}'`);
    expect(after.rows).toEqual([{ command_count: 3 }]);
  });

  it('refuses a die outside the 32-bit range the sealed generator produces', async () => {
    // The referee normalises with `die >>> 0`, so anything else got into the
    // log without going through it.
    const out = await asReferee(
      `insert into public.commands (game_id, idx, by, cmd, die)
       values ('${OPEN}', 3, 'p1', '{"type":"endPhase","by":"p1"}', 4294967296)`,
    );
    expect(out.error).not.toBeNull();
  });

  it('refuses a join code containing the characters the alphabet leaves out', async () => {
    // "No 0/O, no 1/I/L." A code exists to be read aloud, and a code the
    // database accepts but `isCode` rejects is a table nobody can join.
    for (const code of ['FOG124', 'ABCDE1', 'abc234', 'ABC23']) {
      const out = await asReferee(
        `insert into public.games (code, scenario_id, host_id) values ($1, 'escape', '${ALICE}')`,
        [code],
      );
      expect({ code, refused: out.error !== null }).toEqual({ code, refused: true });
    }
  });

  it('refuses a seat that is held by nobody but claims to be human', async () => {
    // `kind` and `user_id` are two spellings of the same fact, and `takeSeat`
    // and `leaveSeat` always move them together.
    const orphan = await asReferee(
      `insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id)
       values ('${OPEN}', 'p3', 2, 'Belter', 'Ghost', 'human', null)`,
    );
    const haunted = await asReferee(
      `insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id)
       values ('${OPEN}', 'p4', 3, 'Belter', 'Robot', 'computer', '${SPECTATOR}')`,
    );
    expect({ orphan: orphan.error !== null, haunted: haunted.error !== null }).toEqual({
      orphan: true,
      haunted: true,
    });
  });

  it('lets one account move between seats inside a single transaction', async () => {
    // "One account, one seat: taking a new one vacates the old." The constraint
    // has to be deferred, or the legal end state is unreachable through the two
    // row updates that produce it.
    const out = await asReferee(`
      update public.seats set user_id = null, kind = 'open'
        where game_id = '${OPEN}' and seat = 'p2';
      update public.seats set user_id = '${DAVE}', kind = 'human'
        where game_id = '${OPEN}' and seat = 'p1';
      update public.seats set user_id = '${CAROL}', kind = 'human'
        where game_id = '${OPEN}' and seat = 'p2';
      select seat, name from public.seats where game_id = '${OPEN}' order by ordinal
    `);
    expect(out.error).toBeNull();

    // ...and still refuses the same account in two seats at commit.
    const doubled = await asReferee(`
      update public.seats set user_id = '${CAROL}', kind = 'human'
        where game_id = '${OPEN}' and seat = 'p1'
    `);
    expect(doubled.error).not.toBeNull();
  });

  it('refuses a view for a seat that does not exist', async () => {
    // A snapshot belongs to a seat, not to a game. An unseated one would be a
    // board with no reader and no policy that matches it.
    const out = await asReferee(
      `insert into public.views (game_id, seat, idx, state) values ('${FOG}', 'p9', 1, '{}')`,
    );
    expect(out.error).not.toBeNull();
  });
});

describe('reaping abandoned lobbies', () => {
  // `reap_stale_lobbies` was written, indexed for, and documented as "called by
  // the referee" — and then never called, so none of this had ever run. These
  // cases pin what it must and must not touch, because the failure mode of
  // getting it wrong is deleting somebody's game out from under them.
  const STALE = 'a0000000-0000-4000-8000-00000000aaaa';
  const FRESH = 'b0000000-0000-4000-8000-00000000bbbb';
  const OLD_PLAYING = 'c0000000-0000-4000-8000-00000000cccc';
  const OLD_DONE = 'd0000000-0000-4000-8000-00000000dddd';

  beforeEach(async () => {
    // Backdating has to go around `games_touch_updated_at`, which rewrites
    // `updated_at` to `now()` on every update — including the update trying to
    // set it. That is the trigger working: age is a fact about when the table
    // was last touched, and nothing at the table's own privilege level gets to
    // lie about it. Only the migration owner can suspend it, which is why this
    // is in the harness and not reachable from a seat.
    // Straight through `db.exec`, as the migration owner, because suspending a
    // trigger is an owner's privilege and `service_role` is deliberately not
    // one — it got "must be owner of table games" when this went through the
    // referee, which is itself the right answer.
    await db.exec(`
      insert into public.games (id, code, scenario_id, fog, status, turn, host_id) values
        ('${STALE}',       'AAAAAA', 'flight-school', false, 'lobby',    1, '${ALICE}'),
        ('${FRESH}',       'BBBBBB', 'flight-school', false, 'lobby',    1, '${ALICE}'),
        ('${OLD_PLAYING}', 'CCCCCC', 'flight-school', false, 'playing',  9, '${ALICE}'),
        ('${OLD_DONE}',    'DDDDDD', 'flight-school', false, 'finished', 9, '${ALICE}');
      alter table public.games disable trigger games_touch_updated_at;
      update public.games set updated_at = now() - interval '30 days'
        where id in ('${STALE}', '${OLD_PLAYING}', '${OLD_DONE}');
      -- FRESH gets a definite age too, and the reason is a flake this suite
      -- shipped. It used to stay at its insert-time default, and the sweep
      -- test asked for everything older than *now* — a question the clock
      -- cannot reliably answer about a row written in the same millisecond,
      -- which on a fast CI runner it sometimes was. Two seconds is old enough
      -- to be strictly older than any later statement on a millisecond clock,
      -- and young enough that the default 12-hour sweep still spares it.
      update public.games set updated_at = now() - interval '2 seconds'
        where id = '${FRESH}';
      alter table public.games enable trigger games_touch_updated_at;
    `);
  });

  const survivors = async (): Promise<string[]> => {
    const out = await asReferee(
      `select id from public.games where id in
         ('${STALE}', '${FRESH}', '${OLD_PLAYING}', '${OLD_DONE}') order by code`,
    );
    expect(out.error).toBeNull();
    return out.rows.map((r) => String(r['id']));
  };

  it('deletes a lobby nobody came back to', async () => {
    const swept = await asReferee(`select public.reap_stale_lobbies() as gone`);
    expect(swept.error).toBeNull();
    expect(Number(swept.rows[0]?.['gone'])).toBeGreaterThanOrEqual(1);
    expect(await survivors()).not.toContain(STALE);
  });

  it('leaves a lobby somebody is still sitting in', async () => {
    await asReferee(`select public.reap_stale_lobbies()`);
    expect(await survivors()).toContain(FRESH);
  });

  it('never touches a game in progress, however old', async () => {
    // The one that would be unforgivable. A long game — play-by-email pace, a
    // table left open over a weekend — is not abandoned, and `updated_at` says
    // nothing about that. Only `status` does.
    await asReferee(`select public.reap_stale_lobbies()`);
    expect(await survivors()).toContain(OLD_PLAYING);
  });

  it('leaves a finished game as a record of itself', async () => {
    await asReferee(`select public.reap_stale_lobbies()`);
    expect(await survivors()).toContain(OLD_DONE);
  });

  it('takes an age, so the referee can sweep harder if it needs to', async () => {
    // One second against a lobby aged two: the fresh lobby is spared by the
    // default twelve hours and taken by this, which is the parameter doing
    // something — and both facts hold whatever the clock's granularity. The
    // previous version swept at '0 seconds' and raced the clock instead; see
    // the note on the backdate above.
    const out = await asReferee(`select public.reap_stale_lobbies(interval '1 second') as gone`);
    expect(out.error).toBeNull();
    const left = await survivors();
    expect(left).not.toContain(STALE);
    expect(left).not.toContain(FRESH);
    // Still not the ones that are not lobbies.
    expect(left).toContain(OLD_PLAYING);
    expect(left).toContain(OLD_DONE);
  });

  it('cannot be run by a client', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      const out = await attempt(role, ALICE, `select public.reap_stale_lobbies()`);
      expect(out.error, `${role} executed the reaper`).not.toBeNull();
    }
    expect(await survivors()).toContain(STALE);
  });
});
